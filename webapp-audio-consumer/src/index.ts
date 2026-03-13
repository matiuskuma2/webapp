/**
 * webapp-audio-consumer - Cloudflare Queue Consumer Worker
 *
 * Architecture:
 *   Pages Function (producer) → Cloudflare Queue → This Worker (consumer)
 *
 * Purpose:
 *   Process TTS generation jobs that exceed waitUntil()'s 30s limit.
 *   Queue consumer has 15 minute wall time — ideal for bulk audio.
 *
 * Message format (1 message = 1 utterance):
 *   {
 *     job_id: number,
 *     project_id: number,
 *     utterance_id: number,
 *     scene_id: number,
 *     scene_idx: number,
 *     text: string,
 *     role: 'narration' | 'dialogue',
 *     character_key: string | null,
 *     provider: string,
 *     voice_id: string,
 *     voice_source: string,
 *     enqueued_at: string,
 *   }
 *
 * Ref: docs/QUEUE_CONSUMER_ARCHITECTURE.md (Phase Q1)
 */

// ============================================================
// Types
// ============================================================

export interface Env {
  DB: D1Database
  R2: R2Bucket
  GOOGLE_TTS_API_KEY?: string
  GEMINI_API_KEY?: string
  FISH_AUDIO_API_TOKEN?: string
  ELEVENLABS_API_KEY?: string
  ELEVENLABS_MODEL_ID?: string
  R2_PUBLIC_URL?: string
}

export interface AudioQueueMessage {
  job_id: number
  project_id: number
  utterance_id: number
  scene_id: number
  scene_idx: number
  text: string
  role: 'narration' | 'dialogue'
  character_key: string | null
  provider: string
  voice_id: string
  voice_source: string
  enqueued_at: string
}

// ============================================================
// ElevenLabs Voice Presets (must match main app's ELEVENLABS_VOICES)
// ============================================================

const ELEVENLABS_VOICES: Record<string, string> = {
  'el-aria': '9BWtsMINqrJLrRacOk9x',
  'el-river': 'SAz9YHcvj6GT2YYXdXww',
  'el-shimmer': 'cgSgspJ2msm6clMCkdW9',
  'el-alloy': 'nPczCjzI2devNBz1zQrb',
  'el-echo': 'CwhRBWXzGAHq8TQ4Fs17',
  'el-onyx': '7p2er1VIBGrSMNBEqZVn',
  'el-nova': 'EXAVITQu4vr4xnSDxMaL',
  'el-fable': 'CYw49ThSjY15MhEiIEhE',
  'el-hinata': 'Lz7V6FlE34PmJFMqCmFO',
  'el-yumi': 'T5zZhOYp2nr6YMG0xepT',
}

/**
 * Resolve ElevenLabs voice key to actual API voice_id
 * Supports:
 * - Preset key: 'el-yumi' → 'T5zZhOYp2nr6YMG0xepT'
 * - Direct ID: 'elevenlabs:T5zZhOYp2nr6YMG0xepT' → 'T5zZhOYp2nr6YMG0xepT'
 * - Raw UUID: 'T5zZhOYp2nr6YMG0xepT' → 'T5zZhOYp2nr6YMG0xepT'
 */
function resolveElevenLabsVoiceId(voiceKey: string): string {
  // Check for elevenlabs: prefix
  if (voiceKey.startsWith('elevenlabs:')) {
    return voiceKey.substring(11)
  }
  // Check for preset key (el-xxx)
  if (ELEVENLABS_VOICES[voiceKey]) {
    return ELEVENLABS_VOICES[voiceKey]
  }
  // Check for raw voice ID (20+ alphanumeric chars)
  if (voiceKey.length >= 20 && /^[a-zA-Z0-9]+$/.test(voiceKey)) {
    return voiceKey
  }
  // Fallback: strip prefix and return (may fail at API level)
  console.warn(`[AudioConsumer] Unknown ElevenLabs voice key: ${voiceKey}, using as-is`)
  return voiceKey
}

// ============================================================
// TTS Providers
// ============================================================

async function generateGoogleTTS(
  apiKey: string,
  text: string,
  voiceId: string,
  sampleRate: number
): Promise<Uint8Array> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)

  try {
    const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
      },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: 'ja-JP', name: voiceId },
        audioConfig: { audioEncoding: 'MP3', sampleRateHertz: sampleRate },
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      throw new Error(`Google TTS API error: ${res.status} ${errorText}`)
    }

    const data: any = await res.json()
    const audioContent = data?.audioContent
    if (!audioContent) throw new Error('Google TTS returned empty audioContent')

    const binaryString = atob(audioContent)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    return bytes
  } finally {
    clearTimeout(timeout)
  }
}

async function generateFishTTS(
  apiToken: string,
  text: string,
  voiceId: string,
  sampleRate: number
): Promise<Uint8Array> {
  const referenceId = voiceId.replace(/^fish[-:]/, '')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)

  try {
    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        reference_id: referenceId,
        format: 'mp3',
        sample_rate: sampleRate,
        mp3_bitrate: 128,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      throw new Error(`Fish TTS API error: ${res.status} ${errorText}`)
    }

    return new Uint8Array(await res.arrayBuffer())
  } finally {
    clearTimeout(timeout)
  }
}

async function generateElevenLabsTTS(
  apiKey: string,
  text: string,
  voiceId: string,
  modelId: string
): Promise<Uint8Array> {
  // Fix-5: Use proper voice resolution instead of simple prefix stripping
  const resolvedVoiceId = resolveElevenLabsVoiceId(voiceId)
  console.log(`[AudioConsumer] ElevenLabs voice resolved: ${voiceId} → ${resolvedVoiceId}`)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${resolvedVoiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
        }),
        signal: controller.signal,
      }
    )

    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      throw new Error(`ElevenLabs TTS API error: ${res.status} ${errorText}`)
    }

    return new Uint8Array(await res.arrayBuffer())
  } finally {
    clearTimeout(timeout)
  }
}

// ============================================================
// MP3 Duration Estimation
// ============================================================

/**
 * Parse MP3 frame header to estimate duration.
 * Simple approach: find first valid frame, calculate from file size.
 */
function estimateMp3Duration(bytes: Uint8Array): number {
  // Try to find MPEG frame sync (0xFFE0 or higher)
  for (let i = 0; i < Math.min(bytes.length, 4096); i++) {
    if (bytes[i] === 0xFF && (bytes[i + 1] & 0xE0) === 0xE0) {
      // Found frame sync — extract bitrate from header
      const header = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]
      const version = (header >> 19) & 0x03
      const layer = (header >> 17) & 0x03
      const bitrateIndex = (header >> 12) & 0x0F

      // MPEG1 Layer3 bitrate table (kbps)
      const bitrateTable: Record<number, number> = {
        1: 32, 2: 40, 3: 48, 4: 56, 5: 64, 6: 80,
        7: 96, 8: 112, 9: 128, 10: 160, 11: 192,
        12: 224, 13: 256, 14: 320,
      }

      const bitrate = bitrateTable[bitrateIndex]
      if (bitrate && version === 3 && layer === 1) {
        // MPEG1 Layer3
        const durationMs = Math.round((bytes.length * 8) / (bitrate * 1000) * 1000)
        return Math.max(durationMs, 100)
      }
    }
  }

  // Fallback: assume 128kbps
  return Math.max(Math.round((bytes.length * 8) / (128 * 1000) * 1000), 2000)
}

// ============================================================
// Core: Process a single utterance message
// ============================================================

/**
 * Returns 'skip' if this utterance was already processed for this job,
 * meaning the message is a Queue re-delivery.  Returns 'proceed' otherwise.
 */
async function idempotencyCheck(
  env: Env,
  jobId: number,
  utteranceId: number
): Promise<'skip' | 'proceed'> {
  // Check if this utterance already has a generating/completed audio_generation
  // linked via scene_utterances.audio_generation_id.
  const existing = await env.DB.prepare(`
    SELECT ag.id, ag.status
    FROM scene_utterances su
    JOIN audio_generations ag ON ag.id = su.audio_generation_id
    WHERE su.id = ? AND ag.status IN ('generating', 'completed')
  `).bind(utteranceId).first<{ id: number; status: string }>()

  if (existing) {
    console.log(
      `[AudioConsumer] Idempotency: utt=${utteranceId} already has audio_generation ${existing.id} (${existing.status}), skipping`
    )
    return 'skip'
  }
  return 'proceed'
}

async function processUtteranceMessage(
  env: Env,
  msg: AudioQueueMessage
): Promise<void> {
  const { job_id, project_id, utterance_id, scene_id, scene_idx, text, provider, voice_id } = msg

  console.log(`[AudioConsumer] Processing utt=${utterance_id} job=${job_id} provider=${provider}`)

  // 1. Check if job is still active (not canceled)
  const jobCheck = await env.DB.prepare(
    `SELECT status FROM project_audio_jobs WHERE id = ?`
  ).bind(job_id).first<{ status: string }>()

  if (!jobCheck || jobCheck.status === 'canceled') {
    console.log(`[AudioConsumer] Job ${job_id} is ${jobCheck?.status ?? 'missing'}, skipping utt=${utterance_id}`)
    return // Ack message, don't retry
  }

  // 1b. Idempotency: skip if already processed (Queue re-delivery)
  if ((await idempotencyCheck(env, job_id, utterance_id)) === 'skip') {
    return
  }

  // 2. Create audio_generation record
  const format = 'mp3'
  const sampleRate = provider === 'fish' ? 44100 : 24000

  const insert = await env.DB.prepare(`
    INSERT INTO audio_generations
      (scene_id, provider, voice_id, model, format, sample_rate, text, status, is_active)
    VALUES (?, ?, ?, NULL, ?, ?, ?, 'generating', 0)
  `).bind(scene_id, provider, voice_id, format, sampleRate, text).run()

  const audioId = insert.meta.last_row_id as number

  // Link utterance to audio_generation
  await env.DB.prepare(`
    UPDATE scene_utterances
    SET audio_generation_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(audioId, utterance_id).run()

  // 3. Call TTS API
  let bytes: Uint8Array

  if (provider === 'google') {
    const apiKey = env.GOOGLE_TTS_API_KEY || env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GOOGLE_TTS_API_KEY is not set')
    bytes = await generateGoogleTTS(apiKey, text, voice_id, sampleRate)
  } else if (provider === 'fish') {
    if (!env.FISH_AUDIO_API_TOKEN) throw new Error('FISH_AUDIO_API_TOKEN is not set')
    bytes = await generateFishTTS(env.FISH_AUDIO_API_TOKEN, text, voice_id, sampleRate)
  } else if (provider === 'elevenlabs') {
    if (!env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set')
    const model = env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2'
    bytes = await generateElevenLabsTTS(env.ELEVENLABS_API_KEY, text, voice_id, model)
  } else {
    throw new Error(`Unknown TTS provider: ${provider}`)
  }

  // 4. Upload to R2
  const timestamp = Date.now()
  const r2Key = `audio/${project_id}/scene_${scene_idx}/utt_${utterance_id}_${audioId}_${timestamp}.mp3`

  await env.R2.put(r2Key, bytes, {
    httpMetadata: { contentType: 'audio/mpeg' },
  })

  const r2Url = env.R2_PUBLIC_URL
    ? `${env.R2_PUBLIC_URL}/${r2Key}`
    : `/${r2Key}`

  // 5. Calculate duration
  const durationMs = estimateMp3Duration(bytes)
  console.log(`[AudioConsumer] utt=${utterance_id} audio=${audioId} duration=${durationMs}ms size=${bytes.length}`)

  // 6. Update audio_generation → completed
  await env.DB.prepare(`
    UPDATE audio_generations
    SET status = 'completed', r2_key = ?, r2_url = ?, duration_ms = ?,
        is_active = 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(r2Key, r2Url, durationMs, audioId).run()

  // 7. Update utterance with duration
  await env.DB.prepare(`
    UPDATE scene_utterances
    SET duration_ms = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(durationMs, utterance_id).run()

  // 8. Update job progress (atomic increment)
  await env.DB.prepare(`
    UPDATE project_audio_jobs
    SET processed_utterances = processed_utterances + 1,
        success_count = success_count + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(job_id).run()

  console.log(`[AudioConsumer] utt=${utterance_id} completed → ${r2Url}`)
}

// ============================================================
// Error Handler: Mark utterance as failed in DB
// ============================================================

async function handleMessageFailure(
  env: Env,
  msg: AudioQueueMessage,
  error: unknown
): Promise<void> {
  const errorMsg = error instanceof Error ? error.message : String(error)
  console.error(`[AudioConsumer] utt=${msg.utterance_id} FAILED:`, errorMsg)

  try {
    // Mark any generating audio_generations as failed
    await env.DB.prepare(`
      UPDATE audio_generations
      SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE scene_id = ? AND status = 'generating'
    `).bind(errorMsg, msg.scene_id).run()

    // Update job progress (atomic increment failed count)
    // Guard: only increment if this utterance has NOT been counted yet.
    // Use a CAS-like check: only increment when processed < total
    // to prevent re-delivery from inflating counts beyond total.
    await env.DB.prepare(`
      UPDATE project_audio_jobs
      SET processed_utterances = CASE
            WHEN processed_utterances < total_utterances THEN processed_utterances + 1
            ELSE processed_utterances
          END,
          failed_count = CASE
            WHEN processed_utterances < total_utterances THEN failed_count + 1
            ELSE failed_count
          END,
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(errorMsg, msg.job_id).run()
  } catch (dbError) {
    console.error(`[AudioConsumer] Failed to update DB on error:`, dbError)
  }
}

// ============================================================
// Job Finalization: Check if all utterances are processed
// ============================================================

async function checkAndFinalizeJob(
  env: Env,
  jobId: number
): Promise<void> {
  const job = await env.DB.prepare(`
    SELECT id, total_utterances, processed_utterances, success_count, failed_count, status
    FROM project_audio_jobs
    WHERE id = ?
  `).bind(jobId).first<{
    id: number
    total_utterances: number
    processed_utterances: number
    success_count: number
    failed_count: number
    status: string
  }>()

  if (!job) return
  if (job.status !== 'running') return

  // Check if all utterances have been processed
  if (job.processed_utterances >= job.total_utterances) {
    // Determine final status:
    //   - success_count === 0 AND failed_count > 0 → 'failed'  (all failed)
    //   - success_count > 0 AND failed_count > 0  → 'completed' (partial success)
    //   - success_count > 0 AND failed_count === 0 → 'completed' (all success)
    const finalStatus = (job.success_count === 0 && job.failed_count > 0)
      ? 'failed'
      : 'completed'

    await env.DB.prepare(`
      UPDATE project_audio_jobs
      SET status = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running'
    `).bind(finalStatus, jobId).run()

    console.log(`[AudioConsumer] Job ${jobId} finalized → ${finalStatus} (success=${job.success_count}, failed=${job.failed_count})`)

    // Audit log
    try {
      await env.DB.prepare(`
        INSERT INTO api_usage_logs (user_id, project_id, api_type, provider, model, estimated_cost_usd, metadata_json, created_at)
        VALUES (NULL, (SELECT project_id FROM project_audio_jobs WHERE id = ?), 'bulk_audio_generation', 'queue_consumer', ?, 0, ?, CURRENT_TIMESTAMP)
      `).bind(
        jobId,
        finalStatus,
        JSON.stringify({
          job_id: jobId,
          total_utterances: job.total_utterances,
          success_count: job.success_count,
          failed_count: job.failed_count,
          processor: 'webapp-audio-consumer',
        })
      ).run()
    } catch (logError) {
      console.warn(`[AudioConsumer] Audit log failed:`, logError)
    }
  }
}

// ============================================================
// Cloudflare Queue Consumer Handler
// ============================================================

export default {
  /**
   * Queue consumer: batch of messages from AUDIO_QUEUE.
   * Each message = 1 utterance to generate TTS for.
   *
   * Wall time: up to 15 minutes (vs waitUntil's 30s).
   * max_batch_size: 5 (configured in wrangler.toml).
   */
  async queue(
    batch: MessageBatch<AudioQueueMessage>,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    console.log(`[AudioConsumer] Received batch: ${batch.messages.length} messages from ${batch.queue}`)

    const jobIds = new Set<number>()

    for (const message of batch.messages) {
      const msg = message.body

      try {
        await processUtteranceMessage(env, msg)
        message.ack()  // Success → acknowledge
        jobIds.add(msg.job_id)
      } catch (error) {
        // Record failure in DB but let Queue handle retry
        await handleMessageFailure(env, msg, error)

        // If retriable (e.g. network error, 429), retry via Queue
        const errorMsg = error instanceof Error ? error.message : ''
        const isRetriable = errorMsg.includes('429') ||
          errorMsg.includes('timeout') ||
          errorMsg.includes('abort') ||
          errorMsg.includes('network') ||
          errorMsg.includes('ECONNRESET')

        if (isRetriable && message.attempts < 3) {
          console.log(`[AudioConsumer] utt=${msg.utterance_id} → retry (attempt ${message.attempts})`)
          message.retry({ delaySeconds: 30 * message.attempts }) // Backoff: 30s, 60s, 90s
        } else {
          // Non-retriable or max retries reached → ack to send to DLQ
          console.log(`[AudioConsumer] utt=${msg.utterance_id} → ack (non-retriable or max retries)`)
          message.ack()
          jobIds.add(msg.job_id)
        }
      }
    }

    // After batch: check if any jobs are now complete
    for (const jobId of jobIds) {
      await checkAndFinalizeJob(env, jobId)
    }
  },

  /**
   * HTTP handler for health checks and manual triggers.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'webapp-audio-consumer',
        description: 'Queue consumer for bulk TTS generation',
        queue: 'webapp-audio-queue',
        timestamp: new Date().toISOString(),
      }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response('Not Found', { status: 404 })
  },
}
