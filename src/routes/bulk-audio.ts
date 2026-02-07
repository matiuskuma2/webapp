// src/routes/bulk-audio.ts
// Step3-PR2: Bulk Audio Generation API
// SSOT: project_audio_jobs table tracks job state
// 
// Design decisions (per user confirmation 2025-02-05):
// - Unit: utterance-level generation (not scene-level)
// - Failure handling: continue to end, collect all failures for final report
// - Default mode: 'missing' (only generate for utterances without completed audio)
// - Force regenerate: explicit opt-in only

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Bindings } from '../types/bindings';
import { createErrorResponse } from '../utils/error-response';
import { generateFishTTS } from '../utils/fish-audio';
import { generateElevenLabsTTS, resolveElevenLabsVoiceId } from '../utils/elevenlabs';
import { getMp3Duration, estimateMp3Duration } from '../utils/mp3-duration'; // MP3 duration parser

const bulkAudio = new Hono<{ Bindings: Bindings }>();

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

interface ErrorDetail {
  utterance_id: number;
  scene_id: number;
  error_message: string;
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
// Helper: Resolve voice for utterance (SSOT priority)
// =============================================================================

interface VoiceResolution {
  provider: string;
  voiceId: string;
  source: 'character' | 'project_default' | 'fallback';
}

async function resolveVoiceForUtterance(
  db: D1Database,
  utterance: UtteranceForGeneration,
  projectSettings: { default_narration_voice?: { provider?: string; voice_id: string } } | null
): Promise<VoiceResolution> {
  // Priority 1: Character voice for dialogue
  if (utterance.role === 'dialogue' && utterance.character_key) {
    const character = await db.prepare(`
      SELECT voice_preset_id FROM project_character_models
      WHERE project_id = ? AND character_key = ?
    `).bind(utterance.project_id, utterance.character_key).first<{ voice_preset_id: string | null }>();
    
    if (character?.voice_preset_id) {
      let provider = 'google';
      const voiceId = character.voice_preset_id;
      
      if (voiceId.startsWith('elevenlabs:') || voiceId.startsWith('el-')) {
        provider = 'elevenlabs';
      } else if (voiceId.startsWith('fish:') || voiceId.startsWith('fish-')) {
        provider = 'fish';
      }
      
      return { provider, voiceId, source: 'character' };
    }
  }
  
  // Priority 2: Project default narration voice
  if (projectSettings?.default_narration_voice?.voice_id) {
    let provider = projectSettings.default_narration_voice.provider || 'google';
    const voiceId = projectSettings.default_narration_voice.voice_id;
    
    // Re-detect provider if not explicitly set
    if (!projectSettings.default_narration_voice.provider) {
      if (voiceId.startsWith('elevenlabs:') || voiceId.startsWith('el-')) {
        provider = 'elevenlabs';
      } else if (voiceId.startsWith('fish:') || voiceId.startsWith('fish-')) {
        provider = 'fish';
      }
    }
    
    return { provider, voiceId, source: 'project_default' };
  }
  
  // Priority 3: Ultimate fallback
  return { provider: 'google', voiceId: 'ja-JP-Neural2-B', source: 'fallback' };
}

// =============================================================================
// Helper: Generate audio for single utterance (isolated, async)
// =============================================================================

async function generateSingleUtteranceAudio(
  env: Bindings,
  utterance: UtteranceForGeneration,
  voice: VoiceResolution,
  jobId: number
): Promise<{ success: boolean; audioId?: number; error?: string }> {
  const { provider, voiceId } = voice;
  const format = 'mp3';
  const sampleRate = provider === 'fish' ? 44100 : 24000;
  
  try {
    // Create audio_generation record
    const insert = await env.DB.prepare(`
      INSERT INTO audio_generations
        (scene_id, provider, voice_id, model, format, sample_rate, text, status, is_active)
      VALUES
        (?, ?, ?, NULL, ?, ?, ?, 'generating', 0)
    `).bind(
      utterance.scene_id,
      provider,
      voiceId,
      format,
      sampleRate,
      utterance.text
    ).run();
    
    const audioId = insert.meta.last_row_id as number;
    
    // Link utterance to audio_generation
    await env.DB.prepare(`
      UPDATE scene_utterances
      SET audio_generation_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(audioId, utterance.id).run();
    
    // Generate audio
    let bytes: Uint8Array;
    
    if (provider === 'google') {
      const googleTtsKey = env.GOOGLE_TTS_API_KEY || env.GEMINI_API_KEY;
      if (!googleTtsKey) {
        throw new Error('GOOGLE_TTS_API_KEY is not set');
      }
      
      const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': googleTtsKey,
        },
        body: JSON.stringify({
          input: { text: utterance.text },
          voice: {
            languageCode: 'ja-JP',
            name: voiceId,
          },
          audioConfig: {
            audioEncoding: 'MP3',
            sampleRateHertz: sampleRate,
          },
        }),
      });
      
      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`TTS API error: ${res.status} ${errorText}`);
      }
      
      const data: any = await res.json();
      const audioContent = data?.audioContent;
      if (!audioContent) {
        throw new Error('TTS API returned empty audioContent');
      }
      
      const binaryString = atob(audioContent);
      bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
    } else if (provider === 'fish') {
      const fishApiToken = (env as any).FISH_AUDIO_API_TOKEN;
      if (!fishApiToken) {
        throw new Error('FISH_AUDIO_API_TOKEN is not configured');
      }
      
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
      if (!elevenLabsApiKey) {
        throw new Error('ELEVENLABS_API_KEY is not configured');
      }
      
      const resolvedVoiceId = await resolveElevenLabsVoiceId(elevenLabsApiKey, voiceId);
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
    
    // Upload to R2
    const timestamp = Date.now();
    const r2Key = `audio/${utterance.project_id}/scene_${utterance.scene_idx}/utt_${utterance.id}_${audioId}_${timestamp}.mp3`;
    
    await env.R2.put(r2Key, bytes, {
      httpMetadata: { contentType: 'audio/mpeg' },
    });
    
    const r2Url = (env as any).R2_PUBLIC_URL 
      ? `${(env as any).R2_PUBLIC_URL}/${r2Key}`
      : `/${r2Key}`;
    
    // Calculate duration: MP3ヘッダーを解析して正確なdurationを取得
    const bytesLength = bytes.length;
    let estimatedDurationMs: number;
    
    const parsedDurationMs = getMp3Duration(bytes.buffer);
    if (parsedDurationMs && parsedDurationMs > 0) {
      estimatedDurationMs = parsedDurationMs;
      console.log(`[BulkAudio Job ${jobId}] MP3 parsed duration: ${parsedDurationMs}ms (${(parsedDurationMs/1000).toFixed(2)}s)`);
    } else {
      // フォールバック: 64kbpsを仮定
      const calculatedDurationMs = estimateMp3Duration(bytesLength, 64);
      estimatedDurationMs = Math.max(2000, calculatedDurationMs);
      console.log(`[BulkAudio Job ${jobId}] MP3 fallback duration: ${bytesLength} bytes @ 64kbps = ${calculatedDurationMs}ms`);
    }
    
    // Update audio_generation to completed
    await env.DB.prepare(`
      UPDATE audio_generations
      SET status = 'completed', r2_key = ?, r2_url = ?, duration_ms = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(r2Key, r2Url, estimatedDurationMs, audioId).run();
    
    // Update utterance with duration
    await env.DB.prepare(`
      UPDATE scene_utterances
      SET duration_ms = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(estimatedDurationMs, utterance.id).run();
    
    console.log(`[BulkAudio Job ${jobId}] Utterance ${utterance.id} completed: ${r2Url}`);
    
    return { success: true, audioId };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[BulkAudio Job ${jobId}] Utterance ${utterance.id} failed:`, error);
    
    // Mark any created audio_generation as failed
    await env.DB.prepare(`
      UPDATE audio_generations
      SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE scene_id = ? AND status = 'generating'
    `).bind(errorMsg, utterance.scene_id).run();
    
    return { success: false, error: errorMsg };
  }
}

// =============================================================================
// Helper: Run bulk generation job (in waitUntil)
// =============================================================================

async function runBulkGenerationJob(
  env: Bindings,
  jobId: number,
  projectId: number,
  mode: JobMode,
  forceRegenerate: boolean,
  narrationProvider: string,
  narrationVoiceId: string
): Promise<void> {
  console.log(`[BulkAudio] Starting job ${jobId} for project ${projectId}, mode=${mode}, force=${forceRegenerate}`);
  
  const errorDetails: ErrorDetail[] = [];
  let processedCount = 0;
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  
  try {
    // Update job status to running
    await env.DB.prepare(`
      UPDATE project_audio_jobs
      SET status = 'running', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(jobId).run();
    
    // Get project settings for voice resolution
    const project = await env.DB.prepare(`
      SELECT settings_json FROM projects WHERE id = ?
    `).bind(projectId).first<{ settings_json: string | null }>();
    
    let projectSettings: { default_narration_voice?: { provider?: string; voice_id: string } } | null = null;
    if (project?.settings_json) {
      try {
        projectSettings = JSON.parse(project.settings_json);
      } catch (e) {
        console.warn(`[BulkAudio Job ${jobId}] Failed to parse project settings`);
      }
    }
    
    // Build query based on mode
    let filterClause = '';
    if (mode === 'missing') {
      filterClause = 'AND (u.audio_generation_id IS NULL OR ag.status IS NULL OR ag.status != \'completed\')';
    } else if (mode === 'pending') {
      filterClause = 'AND (ag.status IS NULL OR ag.status IN (\'failed\', \'generating\'))';
    }
    // mode === 'all' has no filter
    
    if (forceRegenerate) {
      filterClause = ''; // Regenerate all regardless of status
    }
    
    // Get utterances to generate
    const { results: utterances } = await env.DB.prepare(`
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
    console.log(`[BulkAudio Job ${jobId}] Found ${totalUtterances} utterances to process`);
    
    // Update total count
    await env.DB.prepare(`
      UPDATE project_audio_jobs
      SET total_utterances = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(totalUtterances, jobId).run();
    
    if (totalUtterances === 0) {
      // No work to do
      await env.DB.prepare(`
        UPDATE project_audio_jobs
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(jobId).run();
      
      console.log(`[BulkAudio Job ${jobId}] No utterances to generate, marking completed`);
      return;
    }
    
    // Process utterances with controlled concurrency (2 parallel)
    const CONCURRENCY = 2;
    
    for (let i = 0; i < totalUtterances; i += CONCURRENCY) {
      // Check if job was canceled
      const jobCheck = await env.DB.prepare(`
        SELECT status FROM project_audio_jobs WHERE id = ?
      `).bind(jobId).first<{ status: JobStatus }>();
      
      if (jobCheck?.status === 'canceled') {
        console.log(`[BulkAudio Job ${jobId}] Job canceled, stopping`);
        break;
      }
      
      // Get batch of utterances
      const batch = utterances.slice(i, i + CONCURRENCY);
      
      // Process batch in parallel
      const results = await Promise.all(
        batch.map(async (utterance) => {
          // Skip if already completed (for 'missing' mode safety)
          if (!forceRegenerate && utterance.audio_status === 'completed') {
            return { utteranceId: utterance.id, skipped: true };
          }
          
          // Resolve voice
          const voice = await resolveVoiceForUtterance(env.DB, utterance, projectSettings);
          
          // Generate audio
          const result = await generateSingleUtteranceAudio(env, utterance, voice, jobId);
          
          return {
            utteranceId: utterance.id,
            sceneId: utterance.scene_id,
            success: result.success,
            error: result.error,
            skipped: false
          };
        })
      );
      
      // Tally results
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
    
    // Determine final status
    const finalStatus: JobStatus = failedCount === totalUtterances && totalUtterances > 0 
      ? 'failed' 
      : 'completed';
    
    // Save final state
    await env.DB.prepare(`
      UPDATE project_audio_jobs
      SET status = ?, 
          processed_utterances = ?, 
          success_count = ?, 
          failed_count = ?, 
          skipped_count = ?,
          error_details_json = ?,
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      finalStatus,
      processedCount,
      successCount,
      failedCount,
      skippedCount,
      errorDetails.length > 0 ? JSON.stringify(errorDetails.slice(0, 50)) : null, // Limit stored errors
      jobId
    ).run();
    
    console.log(`[BulkAudio Job ${jobId}] Completed: status=${finalStatus}, success=${successCount}, failed=${failedCount}, skipped=${skippedCount}`);
    
    // Step3-PR4: Audit log for bulk audio job completion
    try {
      await env.DB.prepare(`
        INSERT INTO api_usage_logs (user_id, project_id, api_type, provider, model, estimated_cost_usd, metadata_json, created_at)
        VALUES (NULL, ?, 'bulk_audio_generation', 'internal', ?, 0, ?, CURRENT_TIMESTAMP)
      `).bind(
        projectId,
        finalStatus,
        JSON.stringify({
          job_id: jobId,
          mode: mode,
          force_regenerate: forceRegenerate,
          total_utterances: processedCount,
          success_count: successCount,
          failed_count: failedCount,
          skipped_count: skippedCount,
          narration_provider: narrationProvider,
          narration_voice_id: narrationVoiceId,
        })
      ).run();
    } catch (logError) {
      console.warn(`[BulkAudio Job ${jobId}] Failed to log audit:`, logError);
    }
    
  } catch (error) {
    console.error(`[BulkAudio Job ${jobId}] Critical error:`, error);
    
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    await env.DB.prepare(`
      UPDATE project_audio_jobs
      SET status = 'failed', 
          last_error = ?,
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(errorMsg, jobId).run();
  }
}

// =============================================================================
// POST /api/projects/:projectId/audio/bulk-generate
// Start a new bulk audio generation job
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
    
    // Create job record
    const insert = await c.env.DB.prepare(`
      INSERT INTO project_audio_jobs (
        project_id, mode, force_regenerate,
        narration_provider, narration_voice_id,
        status, started_by_user_id
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?)
    `).bind(
      projectId,
      mode,
      forceRegenerate ? 1 : 0,
      narrationProvider,
      narrationVoiceId,
      user?.id || null
    ).run();
    
    const jobId = insert.meta.last_row_id as number;
    
    console.log(`[BulkAudio] Created job ${jobId} for project ${projectId}: mode=${mode}, force=${forceRegenerate}`);
    
    // Start job execution in background
    c.executionCtx.waitUntil(
      runBulkGenerationJob(
        c.env,
        jobId,
        projectId,
        mode,
        forceRegenerate,
        narrationProvider,
        narrationVoiceId
      )
    );
    
    return c.json({
      success: true,
      job_id: jobId,
      project_id: projectId,
      mode,
      force_regenerate: forceRegenerate,
      status: 'queued',
      message: 'Bulk audio generation job started'
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
        stack: process.env.NODE_ENV === 'development' ? errorStack : undefined
      }
    }, 500);
  }
});

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
    let errorDetails: ErrorDetail[] = [];
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
    await c.env.DB.prepare(`
      UPDATE project_audio_jobs
      SET status = 'canceled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(activeJob.id).run();
    
    console.log(`[BulkAudio] Job ${activeJob.id} canceled for project ${projectId}`);
    
    return c.json({
      success: true,
      job_id: activeJob.id,
      message: 'Bulk audio job canceled'
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
