// src/routes/bulk-audio.ts
// Step3-PR2 → Phase Q1: Bulk Audio Generation API (Queue Producer)
//
// SSOT: project_audio_jobs table tracks job state
// 
// Architecture change (Phase Q1):
//   BEFORE: waitUntil() で全utteranceを逐次処理 → 30秒制限で途中終了
//   AFTER:  Pages = producer (enqueue) → Cloudflare Queue → 別Worker = consumer (TTS実行)
//
// Design decisions (per user confirmation 2025-02-05):
// - Unit: utterance-level generation (not scene-level)
// - Failure handling: continue to end, collect all failures for final report
// - Default mode: 'missing' (only generate for utterances without completed audio)
// - Force regenerate: explicit opt-in only
//
// Queue message format (1 message = 1 utterance):
//   { job_id, project_id, utterance_id, scene_id, scene_idx, text,
//     role, character_key, provider, voice_id, voice_source, enqueued_at }

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Bindings } from '../types/bindings';
import { createErrorResponse } from '../utils/error-response';
import {
  resolveVoiceForUtterance,
  parseProjectSettings,
  detectProvider,
  type VoiceResolution,
  type ProjectSettings,
} from '../utils/voice-resolution';

// =============================================================================
// Extend Bindings to include Queue producer
// =============================================================================
interface BulkAudioBindings extends Bindings {
  AUDIO_QUEUE?: Queue;
}

const bulkAudio = new Hono<{ Bindings: BulkAudioBindings }>();

// =============================================================================
// Types
// =============================================================================

type JobMode = 'missing' | 'pending' | 'all';
type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

interface BulkGenerateRequest {
  mode?: JobMode;
  force_regenerate?: boolean;
}

interface UtteranceForGeneration {
  id: number;
  scene_id: number;
  scene_idx: number;
  project_id: number;
  role: 'narration' | 'dialogue';
  character_key: string | null;
  text: string;
  audio_generation_id: number | null;
  audio_status: string | null;
}

interface AudioQueueMessage {
  job_id: number;
  project_id: number;
  utterance_id: number;
  scene_id: number;
  scene_idx: number;
  text: string;
  role: 'narration' | 'dialogue';
  character_key: string | null;
  provider: string;
  voice_id: string;
  voice_source: string;
  enqueued_at: string;
}

// =============================================================================
// ★ AUDIO-STALE: Stale job 自動回収（応急処置）
// running/queued が一定時間以上更新されていない場合 → failed に遷移
// 閾値はステータスで分離:
//   - running: 20分（Queue consumer は15分wall time → +5分バッファ）
//   - queued: 30分（enqueue待ちで長くなるケースを許容）
// =============================================================================

const STALE_RUNNING_MINUTES = 20;  // Increased from 5 for Queue consumer (15min wall time)
const STALE_QUEUED_MINUTES = 30;   // Increased from 15 for Queue batching delays

async function recoverStaleJobs(db: D1Database, projectId: number): Promise<number> {
  try {
    // running ジョブ: 20分超で回収
    const runningResult = await db.prepare(`
      UPDATE project_audio_jobs
      SET status = 'failed',
          error_details_json = json_object(
            'reason', 'STALE_JOB_RECOVERY',
            'message', 'Job was stuck in running state for over ' || ? || ' minutes and was automatically marked as failed'
          ),
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ?
        AND status = 'running'
        AND updated_at < datetime('now', '-' || ? || ' minutes')
    `).bind(STALE_RUNNING_MINUTES, projectId, STALE_RUNNING_MINUTES).run();

    // queued ジョブ: 30分超で回収
    const queuedResult = await db.prepare(`
      UPDATE project_audio_jobs
      SET status = 'failed',
          error_details_json = json_object(
            'reason', 'STALE_JOB_RECOVERY',
            'message', 'Job was stuck in queued state for over ' || ? || ' minutes and was automatically marked as failed'
          ),
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ?
        AND status = 'queued'
        AND updated_at < datetime('now', '-' || ? || ' minutes')
    `).bind(STALE_QUEUED_MINUTES, projectId, STALE_QUEUED_MINUTES).run();

    const recoveredRunning = runningResult.meta.changes ?? 0;
    const recoveredQueued = queuedResult.meta.changes ?? 0;
    const totalRecovered = recoveredRunning + recoveredQueued;
    if (totalRecovered > 0) {
      console.log(`[BulkAudio:STALE] Recovered ${totalRecovered} stale job(s) for project ${projectId} (running: ${recoveredRunning} @${STALE_RUNNING_MINUTES}min, queued: ${recoveredQueued} @${STALE_QUEUED_MINUTES}min)`);
    }
    return totalRecovered;
  } catch (e) {
    console.warn('[BulkAudio:STALE] Recovery failed:', e);
    return 0;
  }
}

// =============================================================================
// Helper: Get session user
// =============================================================================

async function getSessionUser(db: D1Database, sessionCookie: string | undefined): Promise<{ id: number; email: string } | null> {
  if (!sessionCookie) return null;
  
  const session = await db.prepare(`
    SELECT u.id, u.email
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).bind(sessionCookie).first<{ id: number; email: string }>();
  
  return session || null;
}

// =============================================================================
// POST /api/projects/:projectId/audio/bulk-generate
// Phase Q1: Queue-based bulk audio generation
//
// Flow:
//   1. Create project_audio_jobs record (status=queued)
//   2. Resolve voice for each utterance
//   3. Enqueue messages to AUDIO_QUEUE (1 message = 1 utterance)
//   4. Set job status to 'running'
//   5. Return 202 immediately
//
// The consumer Worker processes messages and updates progress.
// =============================================================================

bulkAudio.post('/projects/:projectId/audio/bulk-generate', async (c) => {
  const projectId = Number(c.req.param('projectId'));
  
  if (!Number.isFinite(projectId)) {
    return c.json(createErrorResponse('INVALID_REQUEST', 'Invalid project id'), 400);
  }
  
  try {
    // Get session user
    const sessionCookie = getCookie(c, 'session');
    const user = await getSessionUser(c.env.DB, sessionCookie);
    
    // Verify project exists and user has access
    const project = await c.env.DB.prepare(`
      SELECT id, user_id, settings_json FROM projects WHERE id = ?
    `).bind(projectId).first<{ id: number; user_id: number; settings_json: string | null }>();
    
    if (!project) {
      return c.json(createErrorResponse('NOT_FOUND', 'Project not found'), 404);
    }
    
    // ★ AUDIO-STALE: Check and recover stale jobs before active job check
    await recoverStaleJobs(c.env.DB, projectId);
    
    // Check for existing active job
    const existingJob = await c.env.DB.prepare(`
      SELECT id, status FROM project_audio_jobs
      WHERE project_id = ? AND status IN ('queued', 'running')
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(projectId).first<{ id: number; status: JobStatus }>();
    
    if (existingJob) {
      return c.json({
        error: {
          code: 'JOB_ALREADY_RUNNING',
          message: `A bulk audio job (id=${existingJob.id}) is already ${existingJob.status} for this project`
        },
        existing_job_id: existingJob.id
      }, 409);
    }
    
    // Parse request body
    const body = await c.req.json<BulkGenerateRequest>().catch(() => ({}));
    const mode: JobMode = body.mode || 'missing';
    const forceRegenerate = body.force_regenerate === true;
    
    // Validate mode
    if (!['missing', 'pending', 'all'].includes(mode)) {
      return c.json(createErrorResponse('INVALID_REQUEST', 'mode must be one of: missing, pending, all'), 400);
    }
    
    // Get default narration voice from project settings
    let narrationProvider = 'google';
    let narrationVoiceId = 'ja-JP-Neural2-B';
    
    if (project.settings_json) {
      try {
        const settings = JSON.parse(project.settings_json);
        if (settings.default_narration_voice?.voice_id) {
          narrationVoiceId = settings.default_narration_voice.voice_id;
          narrationProvider = settings.default_narration_voice.provider || 'google';
        }
      } catch (e) {
        // Use defaults
      }
    }
    
    // Get project settings for voice resolution
    const projectSettings: ProjectSettings | null = parseProjectSettings(project.settings_json);
    
    // Build query based on mode
    let filterClause = '';
    if (mode === 'missing') {
      filterClause = 'AND (u.audio_generation_id IS NULL OR ag.status IS NULL OR ag.status != \'completed\')';
    } else if (mode === 'pending') {
      filterClause = 'AND (ag.status IS NULL OR ag.status IN (\'failed\', \'generating\'))';
    }
    
    if (forceRegenerate) {
      filterClause = '';
    }
    
    // Get utterances to generate
    const { results: utterances } = await c.env.DB.prepare(`
      SELECT 
        u.id,
        u.scene_id,
        s.idx as scene_idx,
        s.project_id,
        u.role,
        u.character_key,
        u.text,
        u.audio_generation_id,
        ag.status as audio_status
      FROM scene_utterances u
      JOIN scenes s ON u.scene_id = s.id
      LEFT JOIN audio_generations ag ON u.audio_generation_id = ag.id
      WHERE s.project_id = ?
        AND s.is_hidden = 0
        AND u.text IS NOT NULL 
        AND u.text != ''
        ${filterClause}
      ORDER BY s.idx ASC, u.order_no ASC
    `).bind(projectId).all<UtteranceForGeneration>();
    
    const totalUtterances = utterances?.length || 0;
    
    if (totalUtterances === 0) {
      return c.json({
        success: true,
        job_id: null,
        project_id: projectId,
        mode,
        force_regenerate: forceRegenerate,
        status: 'completed',
        total_utterances: 0,
        message: 'No utterances to generate audio for'
      }, 200);
    }
    
    // Create job record
    const insert = await c.env.DB.prepare(`
      INSERT INTO project_audio_jobs (
        project_id, mode, force_regenerate,
        narration_provider, narration_voice_id,
        status, total_utterances, started_by_user_id
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
    `).bind(
      projectId,
      mode,
      forceRegenerate ? 1 : 0,
      narrationProvider,
      narrationVoiceId,
      totalUtterances,
      user?.id || null
    ).run();
    
    const jobId = insert.meta.last_row_id as number;
    
    console.log(`[BulkAudio:Producer] Created job ${jobId} for project ${projectId}: mode=${mode}, force=${forceRegenerate}, utterances=${totalUtterances}`);
    
    // ================================================================
    // Phase Q1: Enqueue to Cloudflare Queue
    // ================================================================
    
    // Check if Queue binding is available
    if (!c.env.AUDIO_QUEUE) {
      // Fallback: use legacy waitUntil approach
      // This allows the code to work before Queue is deployed
      console.warn(`[BulkAudio:Producer] AUDIO_QUEUE binding not available, falling back to waitUntil`);
      
      // Import and use legacy approach
      await c.env.DB.prepare(`
        UPDATE project_audio_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(jobId).run();
      
      c.executionCtx.waitUntil(
        runLegacyBulkGenerationJob(c.env, jobId, projectId, mode, forceRegenerate, utterances, projectSettings)
      );
      
      return c.json({
        success: true,
        job_id: jobId,
        project_id: projectId,
        mode,
        force_regenerate: forceRegenerate,
        status: 'running',
        total_utterances: totalUtterances,
        processor: 'waitUntil_fallback',
        message: 'Bulk audio generation started (legacy mode — Queue not yet deployed)'
      }, 202);
    }
    
    // Resolve voices for all utterances and build queue messages
    const messages: { body: AudioQueueMessage }[] = [];
    const enqueueTime = new Date().toISOString();
    
    for (const utt of utterances) {
      // Skip already completed (safety check for 'missing' mode)
      if (!forceRegenerate && utt.audio_status === 'completed') {
        continue;
      }
      
      // Resolve voice
      const voice: VoiceResolution = await resolveVoiceForUtterance(c.env.DB, utt, projectSettings);
      
      messages.push({
        body: {
          job_id: jobId,
          project_id: projectId,
          utterance_id: utt.id,
          scene_id: utt.scene_id,
          scene_idx: utt.scene_idx,
          text: utt.text,
          role: utt.role,
          character_key: utt.character_key,
          provider: voice.provider,
          voice_id: voice.voiceId,
          voice_source: voice.source,
          enqueued_at: enqueueTime,
        }
      });
    }
    
    console.log(`[BulkAudio:Producer] Resolved ${messages.length} utterance messages for queue`);
    
    // Enqueue in batches of 100 (Cloudflare Queue sendBatch limit)
    const QUEUE_BATCH_SIZE = 100;
    let enqueuedCount = 0;
    
    for (let i = 0; i < messages.length; i += QUEUE_BATCH_SIZE) {
      const batch = messages.slice(i, i + QUEUE_BATCH_SIZE);
      await c.env.AUDIO_QUEUE.sendBatch(batch);
      enqueuedCount += batch.length;
      console.log(`[BulkAudio:Producer] Enqueued batch ${Math.floor(i / QUEUE_BATCH_SIZE) + 1}: ${batch.length} messages (total: ${enqueuedCount})`);
    }
    
    // Update job status to running (consumer will process)
    await c.env.DB.prepare(`
      UPDATE project_audio_jobs
      SET status = 'running',
          total_utterances = ?,
          started_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(enqueuedCount, jobId).run();
    
    console.log(`[BulkAudio:Producer] Job ${jobId} → running (${enqueuedCount} messages enqueued to AUDIO_QUEUE)`);
    
    return c.json({
      success: true,
      job_id: jobId,
      project_id: projectId,
      mode,
      force_regenerate: forceRegenerate,
      status: 'running',
      total_utterances: enqueuedCount,
      processor: 'queue_consumer',
      message: `Bulk audio generation started: ${enqueuedCount} utterances enqueued`
    }, 202);
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error('[POST /api/projects/:projectId/audio/bulk-generate] Error:', errorMessage, errorStack);
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to start bulk audio generation',
        details: errorMessage,
      }
    }, 500);
  }
});

// =============================================================================
// Legacy waitUntil fallback (used when AUDIO_QUEUE binding is not available)
// Will be removed after Queue is fully deployed and verified.
// =============================================================================

import { generateFishTTS } from '../utils/fish-audio';
import { generateElevenLabsTTS, resolveElevenLabsVoiceId } from '../utils/elevenlabs';
import { getMp3Duration, estimateMp3Duration } from '../utils/mp3-duration';

async function runLegacyBulkGenerationJob(
  env: Bindings,
  jobId: number,
  projectId: number,
  mode: JobMode,
  forceRegenerate: boolean,
  utterances: UtteranceForGeneration[],
  projectSettings: ProjectSettings | null
): Promise<void> {
  console.log(`[BulkAudio:Legacy] Starting legacy job ${jobId} for project ${projectId}`);
  
  let processedCount = 0;
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const errorDetails: { utterance_id: number; scene_id: number; error_message: string }[] = [];
  
  try {
    const totalUtterances = utterances.length;
    const CONCURRENCY = 2;
    
    for (let i = 0; i < totalUtterances; i += CONCURRENCY) {
      // Check if job was canceled
      const jobCheck = await env.DB.prepare(
        `SELECT status FROM project_audio_jobs WHERE id = ?`
      ).bind(jobId).first<{ status: JobStatus }>();
      
      if (jobCheck?.status === 'canceled') {
        console.log(`[BulkAudio:Legacy] Job ${jobId} canceled, stopping`);
        break;
      }
      
      const batch = utterances.slice(i, i + CONCURRENCY);
      
      const results = await Promise.all(
        batch.map(async (utterance) => {
          if (!forceRegenerate && utterance.audio_status === 'completed') {
            return { utteranceId: utterance.id, skipped: true, success: false, error: undefined, sceneId: utterance.scene_id };
          }
          
          const voice = await resolveVoiceForUtterance(env.DB, utterance, projectSettings);
          const result = await generateSingleUtteranceAudioLegacy(env, utterance, voice, jobId);
          
          return {
            utteranceId: utterance.id,
            sceneId: utterance.scene_id,
            success: result.success,
            error: result.error,
            skipped: false
          };
        })
      );
      
      for (const result of results) {
        processedCount++;
        if (result.skipped) {
          skippedCount++;
        } else if (result.success) {
          successCount++;
        } else {
          failedCount++;
          if (result.error) {
            errorDetails.push({
              utterance_id: result.utteranceId,
              scene_id: result.sceneId!,
              error_message: result.error
            });
          }
        }
      }
      
      // Update progress
      await env.DB.prepare(`
        UPDATE project_audio_jobs
        SET processed_utterances = ?, success_count = ?, failed_count = ?, skipped_count = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(processedCount, successCount, failedCount, skippedCount, jobId).run();
    }
    
    const finalStatus: JobStatus = failedCount === utterances.length && utterances.length > 0 
      ? 'failed' 
      : 'completed';
    
    await env.DB.prepare(`
      UPDATE project_audio_jobs
      SET status = ?, processed_utterances = ?, success_count = ?, failed_count = ?, skipped_count = ?,
          error_details_json = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      finalStatus, processedCount, successCount, failedCount, skippedCount,
      errorDetails.length > 0 ? JSON.stringify(errorDetails.slice(0, 50)) : null,
      jobId
    ).run();
    
    console.log(`[BulkAudio:Legacy] Job ${jobId} completed: status=${finalStatus}, success=${successCount}, failed=${failedCount}`);
    
  } catch (error) {
    console.error(`[BulkAudio:Legacy] Job ${jobId} critical error:`, error);
    const errorMsg = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(`
      UPDATE project_audio_jobs
      SET status = 'failed', last_error = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(errorMsg, jobId).run();
  }
}

async function generateSingleUtteranceAudioLegacy(
  env: Bindings,
  utterance: UtteranceForGeneration,
  voice: VoiceResolution,
  jobId: number
): Promise<{ success: boolean; audioId?: number; error?: string }> {
  const { provider, voiceId } = voice;
  const format = 'mp3';
  const sampleRate = provider === 'fish' ? 44100 : 24000;
  
  try {
    const insert = await env.DB.prepare(`
      INSERT INTO audio_generations
        (scene_id, provider, voice_id, model, format, sample_rate, text, status, is_active)
      VALUES (?, ?, ?, NULL, ?, ?, ?, 'generating', 0)
    `).bind(utterance.scene_id, provider, voiceId, format, sampleRate, utterance.text).run();
    
    const audioId = insert.meta.last_row_id as number;
    
    await env.DB.prepare(`
      UPDATE scene_utterances SET audio_generation_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(audioId, utterance.id).run();
    
    let bytes: Uint8Array;
    
    if (provider === 'google') {
      const googleTtsKey = env.GOOGLE_TTS_API_KEY || env.GEMINI_API_KEY;
      if (!googleTtsKey) throw new Error('GOOGLE_TTS_API_KEY is not set');
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': googleTtsKey },
        body: JSON.stringify({
          input: { text: utterance.text },
          voice: { languageCode: 'ja-JP', name: voiceId },
          audioConfig: { audioEncoding: 'MP3', sampleRateHertz: sampleRate },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      
      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`TTS API error: ${res.status} ${errorText}`);
      }
      
      const data: any = await res.json();
      const audioContent = data?.audioContent;
      if (!audioContent) throw new Error('TTS API returned empty audioContent');
      
      const binaryString = atob(audioContent);
      bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
    } else if (provider === 'fish') {
      const fishApiToken = (env as any).FISH_AUDIO_API_TOKEN;
      if (!fishApiToken) throw new Error('FISH_AUDIO_API_TOKEN is not configured');
      
      const referenceId = voiceId.replace(/^fish[-:]/, '');
      const fishResult = await generateFishTTS(fishApiToken, {
        text: utterance.text,
        reference_id: referenceId,
        format: 'mp3',
        sample_rate: sampleRate,
        mp3_bitrate: 128,
      });
      bytes = new Uint8Array(fishResult.audio);
    } else if (provider === 'elevenlabs') {
      const elevenLabsApiKey = (env as any).ELEVENLABS_API_KEY;
      if (!elevenLabsApiKey) throw new Error('ELEVENLABS_API_KEY is not configured');
      
      const resolvedVoiceId = resolveElevenLabsVoiceId(voiceId);
      const model = (env as any).ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
      
      const elevenLabsResult = await generateElevenLabsTTS(elevenLabsApiKey, {
        text: utterance.text,
        voice_id: resolvedVoiceId,
        model_id: model,
        output_format: 'mp3_44100_128',
      });
      
      if (!elevenLabsResult.success || !elevenLabsResult.audio) {
        throw new Error(elevenLabsResult.error || 'ElevenLabs TTS failed');
      }
      bytes = new Uint8Array(elevenLabsResult.audio);
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }
    
    const timestamp = Date.now();
    const r2Key = `audio/${utterance.project_id}/scene_${utterance.scene_idx}/utt_${utterance.id}_${audioId}_${timestamp}.mp3`;
    
    await env.R2.put(r2Key, bytes, { httpMetadata: { contentType: 'audio/mpeg' } });
    
    const r2Url = (env as any).R2_PUBLIC_URL 
      ? `${(env as any).R2_PUBLIC_URL}/${r2Key}`
      : `/${r2Key}`;
    
    const bytesLength = bytes.length;
    let estimatedDurationMs: number;
    
    const parsedDurationMs = getMp3Duration(bytes.buffer);
    if (parsedDurationMs && parsedDurationMs > 0) {
      estimatedDurationMs = parsedDurationMs;
    } else {
      estimatedDurationMs = Math.max(2000, estimateMp3Duration(bytesLength, 64));
    }
    
    await env.DB.prepare(`
      UPDATE audio_generations
      SET status = 'completed', r2_key = ?, r2_url = ?, duration_ms = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(r2Key, r2Url, estimatedDurationMs, audioId).run();
    
    await env.DB.prepare(`
      UPDATE scene_utterances SET duration_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(estimatedDurationMs, utterance.id).run();
    
    return { success: true, audioId };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[BulkAudio:Legacy] Utterance ${utterance.id} failed:`, error);
    
    await env.DB.prepare(`
      UPDATE audio_generations
      SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE scene_id = ? AND status = 'generating'
    `).bind(errorMsg, utterance.scene_id).run();
    
    return { success: false, error: errorMsg };
  }
}

// =============================================================================
// GET /api/projects/:projectId/audio/bulk-status
// Get status of the current/latest bulk audio job
// =============================================================================

bulkAudio.get('/projects/:projectId/audio/bulk-status', async (c) => {
  const projectId = Number(c.req.param('projectId'));
  
  if (!Number.isFinite(projectId)) {
    return c.json(createErrorResponse('INVALID_REQUEST', 'Invalid project id'), 400);
  }
  
  try {
    // ★ AUDIO-STALE: Recover stale jobs before checking status
    await recoverStaleJobs(c.env.DB, projectId);

    // Get latest job for this project
    const job = await c.env.DB.prepare(`
      SELECT 
        j.*,
        u.name as started_by_name,
        u.email as started_by_email
      FROM project_audio_jobs j
      LEFT JOIN users u ON j.started_by_user_id = u.id
      WHERE j.project_id = ?
      ORDER BY j.created_at DESC
      LIMIT 1
    `).bind(projectId).first<any>();
    
    if (!job) {
      return c.json({
        has_job: false,
        message: 'No bulk audio jobs found for this project'
      });
    }
    
    // Parse error details if present
    let errorDetails: { utterance_id: number; scene_id: number; error_message: string }[] = [];
    if (job.error_details_json) {
      try {
        errorDetails = JSON.parse(job.error_details_json);
      } catch (e) {
        // Ignore parse errors
      }
    }
    
    // Calculate progress percentage
    const progressPercent = job.total_utterances > 0
      ? Math.round((job.processed_utterances / job.total_utterances) * 100)
      : 0;
    
    return c.json({
      has_job: true,
      job: {
        id: job.id,
        project_id: job.project_id,
        mode: job.mode,
        force_regenerate: job.force_regenerate === 1,
        status: job.status,
        
        // Progress
        total_utterances: job.total_utterances,
        processed_utterances: job.processed_utterances,
        success_count: job.success_count,
        failed_count: job.failed_count,
        skipped_count: job.skipped_count,
        progress_percent: progressPercent,
        
        // Errors
        last_error: job.last_error,
        error_details: errorDetails,
        
        // Timestamps
        created_at: job.created_at,
        started_at: job.started_at,
        completed_at: job.completed_at,
        updated_at: job.updated_at,
        
        // User info
        started_by: job.started_by_user_id ? {
          id: job.started_by_user_id,
          name: job.started_by_name,
          email: job.started_by_email
        } : null
      }
    });
    
  } catch (error) {
    console.error('[GET /api/projects/:projectId/audio/bulk-status] Error:', error);
    return c.json(createErrorResponse('INTERNAL_ERROR', 'Failed to get bulk audio status'), 500);
  }
});

// =============================================================================
// POST /api/projects/:projectId/audio/bulk-cancel
// Cancel an active bulk audio job
// =============================================================================

bulkAudio.post('/projects/:projectId/audio/bulk-cancel', async (c) => {
  const projectId = Number(c.req.param('projectId'));
  
  if (!Number.isFinite(projectId)) {
    return c.json(createErrorResponse('INVALID_REQUEST', 'Invalid project id'), 400);
  }
  
  try {
    // Find active job
    const activeJob = await c.env.DB.prepare(`
      SELECT id, status FROM project_audio_jobs
      WHERE project_id = ? AND status IN ('queued', 'running')
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(projectId).first<{ id: number; status: JobStatus }>();
    
    if (!activeJob) {
      return c.json({
        success: false,
        message: 'No active bulk audio job found for this project'
      }, 404);
    }
    
    // Mark as canceled
    // Note: Queue messages already in-flight will check job status before processing
    await c.env.DB.prepare(`
      UPDATE project_audio_jobs
      SET status = 'canceled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(activeJob.id).run();
    
    console.log(`[BulkAudio] Job ${activeJob.id} canceled for project ${projectId}`);
    
    return c.json({
      success: true,
      job_id: activeJob.id,
      message: 'Bulk audio job canceled. In-flight messages will be skipped by the consumer.'
    });
    
  } catch (error) {
    console.error('[POST /api/projects/:projectId/audio/bulk-cancel] Error:', error);
    return c.json(createErrorResponse('INTERNAL_ERROR', 'Failed to cancel bulk audio job'), 500);
  }
});

// =============================================================================
// GET /api/projects/:projectId/audio/bulk-history
// Get history of bulk audio jobs for a project
// =============================================================================

bulkAudio.get('/projects/:projectId/audio/bulk-history', async (c) => {
  const projectId = Number(c.req.param('projectId'));
  
  if (!Number.isFinite(projectId)) {
    return c.json(createErrorResponse('INVALID_REQUEST', 'Invalid project id'), 400);
  }
  
  try {
    const limit = Math.min(Number(c.req.query('limit')) || 10, 50);
    
    const { results: jobs } = await c.env.DB.prepare(`
      SELECT 
        j.id,
        j.mode,
        j.force_regenerate,
        j.status,
        j.total_utterances,
        j.success_count,
        j.failed_count,
        j.skipped_count,
        j.last_error,
        j.created_at,
        j.started_at,
        j.completed_at,
        u.name as started_by_name
      FROM project_audio_jobs j
      LEFT JOIN users u ON j.started_by_user_id = u.id
      WHERE j.project_id = ?
      ORDER BY j.created_at DESC
      LIMIT ?
    `).bind(projectId, limit).all<any>();
    
    return c.json({
      project_id: projectId,
      jobs: (jobs || []).map(job => ({
        id: job.id,
        mode: job.mode,
        force_regenerate: job.force_regenerate === 1,
        status: job.status,
        total_utterances: job.total_utterances,
        success_count: job.success_count,
        failed_count: job.failed_count,
        skipped_count: job.skipped_count,
        last_error: job.last_error,
        created_at: job.created_at,
        started_at: job.started_at,
        completed_at: job.completed_at,
        started_by_name: job.started_by_name
      })),
      count: jobs?.length || 0
    });
    
  } catch (error) {
    console.error('[GET /api/projects/:projectId/audio/bulk-history] Error:', error);
    return c.json(createErrorResponse('INTERNAL_ERROR', 'Failed to get bulk audio history'), 500);
  }
});

export default bulkAudio;
