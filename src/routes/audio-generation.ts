// src/routes/audio-generation.ts
import { Hono } from 'hono';
import type { Bindings } from '../types/bindings';
import { GENERATION_STATUS, ERROR_CODES } from '../constants';
import { createErrorResponse } from '../utils/error-response';
import { base64ToUint8Array, generateR2Key, getR2PublicUrl } from '../utils/r2-helper';
import { generateFishTTS } from '../utils/fish-audio'; // Phase X-1: Fish Audio integration
import { generateElevenLabsTTS, resolveElevenLabsVoiceId, isElevenLabsVoice, getElevenLabsVoiceList, ELEVENLABS_MODELS } from '../utils/elevenlabs'; // ElevenLabs TTS

const audioGeneration = new Hono<{ Bindings: Bindings }>();

// ===== Phase 4: TTS Usage Logging =====
// SSOT: docs/TTS_USAGE_LIMITS_SPEC.md

interface TTSUsageLogParams {
  env: Bindings;
  userId?: number;
  projectId?: number;
  sceneId?: number;
  characterKey?: string;
  provider: string;
  voiceId: string;
  model?: string;
  textLength: number;
  audioBytes?: number;
  audioDurationMs?: number;
  status: 'success' | 'failed' | 'cached';
  cacheHit?: boolean;
  errorMessage?: string;
}

// コスト推定関数
function estimateTTSCost(provider: string, textLength: number, model?: string): number {
  switch (provider) {
    case 'google':
      // WaveNet: $16/1M chars, Standard: $4/1M chars
      const ratePerMillion = model?.toLowerCase().includes('wavenet') ? 16 : 4;
      return (textLength / 1_000_000) * ratePerMillion;
    case 'fish':
      // $0.015/1000 chars
      return (textLength / 1000) * 0.015;
    case 'elevenlabs':
      // $0.24/1000 chars (average)
      return (textLength / 1000) * 0.24;
    default:
      return 0;
  }
}

// TTS使用量ログ記録
async function logTTSUsage(params: TTSUsageLogParams): Promise<void> {
  try {
    const estimatedCost = estimateTTSCost(params.provider, params.textLength, params.model);
    const billingUnit = params.provider === 'google' ? 'characters' : 'characters';
    
    await params.env.DB.prepare(`
      INSERT INTO tts_usage_logs (
        user_id, project_id, scene_id, character_key,
        provider, voice_id, model,
        text_length, audio_duration_ms, audio_bytes,
        estimated_cost_usd, billing_unit, billing_amount,
        status, cache_hit, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      params.userId ?? 1, // デフォルトユーザー
      params.projectId ?? null,
      params.sceneId ?? null,
      params.characterKey ?? null,
      params.provider,
      params.voiceId,
      params.model ?? null,
      params.textLength,
      params.audioDurationMs ?? null,
      params.audioBytes ?? null,
      estimatedCost,
      billingUnit,
      params.textLength, // 課金単位での使用量
      params.status,
      params.cacheHit ? 1 : 0,
      params.errorMessage ?? null
    ).run();
    
    console.log(`[TTS Usage] Logged: provider=${params.provider}, chars=${params.textLength}, cost=$${estimatedCost.toFixed(6)}, status=${params.status}`);
  } catch (error) {
    // ログ記録の失敗は無視（本体処理に影響させない）
    console.error('[TTS Usage] Failed to log:', error);
  }
}

/**
 * POST /api/scenes/:id/generate-audio
 * - 競合(生成中)は 409
 * - generating レコードを作って即返す
 * - 生成→R2→DB更新は waitUntil で非同期実行
 */
audioGeneration.post('/scenes/:id/generate-audio', async (c) => {
  try {
    const sceneId = Number(c.req.param('id'));
    if (!Number.isFinite(sceneId)) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Invalid scene id'), 400);
    }

    const body = await c.req.json().catch(() => ({} as any));
    // Phase1.7: voice_preset_id もサポート（フロントエンド互換性）
    const voiceId = (body.voice_id || body.voice_preset_id) as string | undefined;
    // Auto-detect provider from voice_id if not explicitly set
    let provider = body.provider as string | undefined;
    if (!provider) {
      if (voiceId.startsWith('elevenlabs:') || voiceId.startsWith('el-')) {
        provider = 'elevenlabs';
      } else if (voiceId.startsWith('fish:') || voiceId.startsWith('fish-')) {
        provider = 'fish';
      } else {
        provider = 'google';
      }
    }
    const format = (body.format as string | undefined) ?? 'mp3';
    // Fish Audio requires 32000 or 44100 Hz for mp3, Google TTS uses 24000 Hz
    const defaultSampleRate = provider === 'fish' ? 44100 : 24000;
    const sampleRate = Number(body.sample_rate ?? defaultSampleRate);
    // Phase1.7: text_override で任意のテキストを指定可能（漫画音声パーツ用）
    const textOverride = body.text_override as string | undefined;

    if (!voiceId) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'voice_id is required'), 400);
    }

    // Phase X-1: Provider-specific API key validation
    if (provider === 'fish' && !c.env.FISH_AUDIO_API_TOKEN) {
      return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'FISH_AUDIO_API_TOKEN is not set'), 500);
    }
    // Google TTS can use either GOOGLE_TTS_API_KEY or GEMINI_API_KEY
    const googleTtsKey = c.env.GOOGLE_TTS_API_KEY || c.env.GEMINI_API_KEY;
    if (provider === 'google' && !googleTtsKey) {
      return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'GOOGLE_TTS_API_KEY is not set'), 500);
    }
    // ElevenLabs API key validation
    if (provider === 'elevenlabs' && !c.env.ELEVENLABS_API_KEY) {
      return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'ELEVENLABS_API_KEY is not set'), 500);
    }

    // 1) scene 取得（idx, project_id, dialogue）
    const scene = await c.env.DB.prepare(`
      SELECT id, project_id, idx, dialogue
      FROM scenes
      WHERE id = ?
    `).bind(sceneId).first<any>();

    if (!scene) {
      return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND, 'Scene not found'), 404);
    }
    
    // R1.6+: scene_utterances のテキストを優先（ユーザーが編集した最新テキスト）
    // text_override > scene_utterances.text > scene.dialogue の優先順
    let dialogue = '';
    
    if (textOverride?.trim()) {
      // Phase1.7: 漫画音声パーツ用の text_override を最優先
      dialogue = textOverride.trim();
    } else {
      // scene_utterances から最新のテキストを取得
      const utterance = await c.env.DB.prepare(`
        SELECT text FROM scene_utterances
        WHERE scene_id = ?
        ORDER BY order_no ASC
        LIMIT 1
      `).bind(sceneId).first<{ text: string }>();
      
      if (utterance?.text?.trim()) {
        dialogue = utterance.text.trim();
        console.log(`[Audio] Using text from scene_utterances for scene ${sceneId}`);
      } else {
        // フォールバック: scenes.dialogue を使用
        dialogue = (scene.dialogue ?? '').trim();
        console.log(`[Audio] Using text from scenes.dialogue for scene ${sceneId} (fallback)`);
      }
    }
    
    if (!dialogue) {
      return c.json(createErrorResponse(ERROR_CODES.NO_DIALOGUE, 'Scene has no dialogue or text_override'), 400);
    }

    // 2) 競合チェック（同一sceneで generating が残っている）
    const existing = await c.env.DB.prepare(`
      SELECT id FROM audio_generations
      WHERE scene_id = ? AND status = ?
      LIMIT 1
    `).bind(sceneId, GENERATION_STATUS.GENERATING).first();

    if (existing) {
      return c.json(createErrorResponse(ERROR_CODES.AUDIO_GENERATING, 'Audio generation already in progress'), 409);
    }

    // 3) generating レコード作成
    const insert = await c.env.DB.prepare(`
      INSERT INTO audio_generations
        (scene_id, provider, voice_id, model, format, sample_rate, text, status, is_active)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).bind(
      sceneId,
      provider,
      voiceId,
      null,
      format,
      sampleRate,
      dialogue,
      GENERATION_STATUS.GENERATING
    ).run();

    const audioId = insert.meta.last_row_id as number;
    
    // ============================================================
    // R1.6+: utterances 自動作成（旧式音声生成からの移行サポート）
    // ============================================================
    // scene_utterances が0件の場合、自動でナレーション utterance を作成
    // これにより、「音声作ったのに音声パーツなし」問題を解消
    try {
      const existingUtterances = await c.env.DB.prepare(`
        SELECT COUNT(*) as count FROM scene_utterances WHERE scene_id = ?
      `).bind(sceneId).first<{ count: number }>();
      
      if (!existingUtterances || existingUtterances.count === 0) {
        // utterance がないので自動作成
        await c.env.DB.prepare(`
          INSERT INTO scene_utterances 
            (scene_id, order_no, role, text, audio_generation_id, created_at, updated_at)
          VALUES 
            (?, 1, 'narration', ?, ?, datetime('now'), datetime('now'))
        `).bind(sceneId, dialogue, audioId).run();
        console.log(`[Audio] Auto-created utterance for scene ${sceneId} (legacy migration)`);
      } else {
        // utterance がある場合、audio_generation_id を新しいものに更新
        // ★ FIX: IS NULL 条件を削除して、常に最新の audio_generation_id に更新
        // order_no=1 の utterance を更新（再生成時も新しい音声に紐付け）
        const updateResult = await c.env.DB.prepare(`
          UPDATE scene_utterances 
          SET audio_generation_id = ?, updated_at = datetime('now')
          WHERE scene_id = ? AND order_no = 1
        `).bind(audioId, sceneId).run();
        console.log(`[Audio] Updated utterance audio_generation_id=${audioId} for scene ${sceneId} (changes: ${updateResult.meta.changes})`);
      }
    } catch (utteranceError) {
      // utterance 作成失敗は警告ログのみ（音声生成自体は続行）
      console.warn('[Audio] Failed to auto-create utterance:', utteranceError);
    }

    // 4) waitUntilで生成を継続（レスポンスは即返す）
    c.executionCtx.waitUntil(
      generateAndUploadAudio({
        env: c.env,
        audioId,
        projectId: Number(scene.project_id),
        sceneIndex: Number(scene.idx),
        text: dialogue,
        provider,
        voiceId,
        format,
        sampleRate,
      })
    );

    return c.json({
      audio_generation: {
        id: audioId,
        scene_id: sceneId,
        provider,
        voice_id: voiceId,
        text: dialogue,
        status: GENERATION_STATUS.GENERATING,
        r2_url: null,
        is_active: false,
      },
    });
  } catch (error) {
    console.error('[Audio] generate-audio error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to start audio generation'), 500);
  }
});

/**
 * GET /api/scenes/:id/audio
 */
audioGeneration.get('/scenes/:id/audio', async (c) => {
  try {
    const sceneId = Number(c.req.param('id'));
    if (!Number.isFinite(sceneId)) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Invalid scene id'), 400);
    }

    const { results } = await c.env.DB.prepare(`
      SELECT id, scene_id, provider, voice_id, model, format, sample_rate, text,
             status, error_message, r2_key, r2_url, is_active, created_at, updated_at
      FROM audio_generations
      WHERE scene_id = ?
      ORDER BY created_at DESC
    `).bind(sceneId).all();

    const list = (results ?? []).map((a: any) => ({ ...a, is_active: a.is_active === 1 }));
    const active = list.find((a: any) => a.is_active) ?? null;

    return c.json({ audio_generations: list, active_audio: active });
  } catch (error) {
    console.error('[Audio] get audio history error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to get audio'), 500);
  }
});

/**
 * POST /api/audio/:audioId/activate
 */
audioGeneration.post('/audio/:audioId/activate', async (c) => {
  try {
    const audioId = Number(c.req.param('audioId'));
    if (!Number.isFinite(audioId)) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Invalid audio id'), 400);
    }

    const audio = await c.env.DB.prepare(`
      SELECT id, scene_id, r2_url, status
      FROM audio_generations
      WHERE id = ?
    `).bind(audioId).first<any>();

    if (!audio) {
      return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND, 'Audio not found'), 404);
    }
    if (audio.status !== GENERATION_STATUS.COMPLETED || !audio.r2_url) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Audio is not completed'), 400);
    }

    // deactivate all for this scene
    await c.env.DB.prepare(`
      UPDATE audio_generations SET is_active = 0, updated_at = CURRENT_TIMESTAMP
      WHERE scene_id = ?
    `).bind(audio.scene_id).run();

    // activate target
    await c.env.DB.prepare(`
      UPDATE audio_generations SET is_active = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(audioId).run();

    const updated = await c.env.DB.prepare(`
      SELECT id, scene_id, r2_url, is_active
      FROM audio_generations
      WHERE id = ?
    `).bind(audioId).first<any>();

    return c.json({
      success: true,
      active_audio: { ...updated, is_active: true },
    });
  } catch (error) {
    console.error('[Audio] activate error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to activate audio'), 500);
  }
});

/**
 * DELETE /api/audio/:audioId
 * - active は通常削除不可
 * - force=true クエリパラメータで採用中の音声も削除可能
 * - R2も削除
 */
audioGeneration.delete('/audio/:audioId', async (c) => {
  try {
    const audioId = Number(c.req.param('audioId'));
    const forceDelete = c.req.query('force') === 'true';
    
    if (!Number.isFinite(audioId)) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Invalid audio id'), 400);
    }

    const audio = await c.env.DB.prepare(`
      SELECT id, is_active, r2_key, scene_id
      FROM audio_generations
      WHERE id = ?
    `).bind(audioId).first<any>();

    if (!audio) {
      return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND, 'Audio not found'), 404);
    }

    // 採用中の音声は通常削除不可、force=trueで許可
    if (audio.is_active === 1 && !forceDelete) {
      return c.json(createErrorResponse(ERROR_CODES.ACTIVE_AUDIO_DELETE, 'Cannot delete active audio. Use force=true to override.'), 400);
    }

    // R2ファイル削除
    if (audio.r2_key) {
      try {
        await c.env.R2.delete(audio.r2_key);
      } catch (e) {
        console.warn('[Audio] R2 delete failed (ignored):', e);
      }
    }

    // DB削除
    await c.env.DB.prepare(`DELETE FROM audio_generations WHERE id = ?`).bind(audioId).run();
    
    console.log(`[Audio] Deleted audio id=${audioId}, was_active=${audio.is_active}, force=${forceDelete}`);
    return c.json({ success: true });
  } catch (error) {
    console.error('[Audio] delete error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to delete audio'), 500);
  }
});

/**
 * Voice presets cache (Phase X-1)
 * Hardcoded for now to avoid fetch issues in Worker environment
 */
const VOICE_PRESETS: Record<string, { provider: string; reference_id?: string }> = {
  'fish-nanamin': {
    provider: 'fish',
    reference_id: '71bf4cb71cd44df6aa603d51db8f92ff'
  },
  // Google TTS presets (no reference_id)
  'ja-JP-Standard-A': { provider: 'google' },
  'ja-JP-Standard-B': { provider: 'google' },
  'ja-JP-Standard-C': { provider: 'google' },
  'ja-JP-Standard-D': { provider: 'google' },
  'ja-JP-Wavenet-A': { provider: 'google' },
  'ja-JP-Wavenet-B': { provider: 'google' },
  'ja-JP-Wavenet-C': { provider: 'google' },
  'ja-JP-Wavenet-D': { provider: 'google' },
};

/**
 * Get Fish Audio reference_id from voice preset or voice ID
 * Supports:
 * - Preset name lookup: 'fish-nanamin' -> '71bf4cb71cd44df6aa603d51db8f92ff'
 * - Direct fish:ID format: 'fish:71bf4cb71cd44df6aa603d51db8f92ff' -> '71bf4cb71cd44df6aa603d51db8f92ff'
 */
async function getFishReferenceId(voiceId: string): Promise<string | null> {
  try {
    // Check if voiceId is in format 'fish:REFERENCE_ID'
    if (voiceId.startsWith('fish:')) {
      return voiceId.substring(5); // Extract the reference_id after 'fish:'
    }
    
    // Otherwise, look up in presets
    const preset = VOICE_PRESETS[voiceId];
    return preset?.reference_id || null;
  } catch (error) {
    console.error('[Audio] Failed to get voice preset:', error);
    return null;
  }
}

async function generateAndUploadAudio(args: {
  env: Bindings;
  audioId: number;
  projectId: number;
  sceneIndex: number;
  text: string;
  provider: string;
  voiceId: string;
  format: string;
  sampleRate: number;
}) {
  const { env, audioId, projectId, sceneIndex, text, provider, voiceId, format, sampleRate } = args;

  try {
    let bytes: Uint8Array;

    // Phase X-1: Provider-based audio generation
    if (provider === 'elevenlabs') {
      // ElevenLabs TTS
      const elevenLabsVoiceId = resolveElevenLabsVoiceId(voiceId);
      if (!elevenLabsVoiceId) {
        throw new Error(`ElevenLabs voice_id not found for: ${voiceId}`);
      }

      const modelId = (env as any).ELEVENLABS_DEFAULT_MODEL || ELEVENLABS_MODELS.MULTILINGUAL_V2;
      const elevenLabsResult = await generateElevenLabsTTS(env.ELEVENLABS_API_KEY, {
        text,
        voice_id: elevenLabsVoiceId,
        model_id: modelId,
        output_format: 'mp3_44100_128',
      });

      if (!elevenLabsResult.success || !elevenLabsResult.audio) {
        throw new Error(elevenLabsResult.error || 'ElevenLabs TTS failed');
      }

      bytes = new Uint8Array(elevenLabsResult.audio);
      console.log(`[ElevenLabs] Generated ${bytes.length} bytes, ${elevenLabsResult.character_count} chars`);
    } else if (provider === 'fish') {
      // Fish Audio TTS
      const referenceId = await getFishReferenceId(voiceId);
      if (!referenceId) {
        throw new Error(`Fish Audio reference_id not found for voice: ${voiceId}`);
      }

      const fishResult = await generateFishTTS(env.FISH_AUDIO_API_TOKEN, {
        text,
        reference_id: referenceId,
        format: format as 'mp3' | 'wav',
        sample_rate: sampleRate,
        mp3_bitrate: 128,
      });

      bytes = new Uint8Array(fishResult.audio);
    } else {
      // Google TTS (default) - can use either GOOGLE_TTS_API_KEY or GEMINI_API_KEY
      const googleTtsKey = env.GOOGLE_TTS_API_KEY || env.GEMINI_API_KEY;
      const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': googleTtsKey,
        },
        body: JSON.stringify({
          input: { text },
          voice: {
            languageCode: 'ja-JP',
            name: voiceId,
          },
          audioConfig: {
            audioEncoding: format === 'wav' ? 'LINEAR16' : 'MP3',
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

      bytes = base64ToUint8Array(audioContent);
    }

    const timestamp = Date.now();
    const ext = format === 'wav' ? 'wav' : 'mp3';
    const r2Key = generateR2Key('audio', projectId, sceneIndex, audioId, timestamp, ext);

    await env.R2.put(r2Key, bytes, {
      httpMetadata: {
        contentType: format === 'wav' ? 'audio/wav' : 'audio/mpeg',
      },
    });

    const r2Url = getR2PublicUrl(r2Key, (env as any).R2_PUBLIC_URL);

    // 先にこの音声のscene_idを取得
    const audioRecord = await env.DB.prepare(`
      SELECT scene_id FROM audio_generations WHERE id = ?
    `).bind(audioId).first<{ scene_id: number }>();
    
    const sceneId = audioRecord?.scene_id;
    
    // 同じシーンの他の音声を非アクティブにしてから、この音声を完了&アクティブにする
    if (sceneId) {
      await env.DB.prepare(`
        UPDATE audio_generations SET is_active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE scene_id = ? AND id != ?
      `).bind(sceneId, audioId).run();
    }

    // FIX: MP3ファイルサイズからdurationを計算（概算より正確）
    // MP3 128kbps: duration_seconds = file_size_bytes / (128 * 1000 / 8) = file_size_bytes / 16000
    // MP3 44100Hz 128kbps の場合は bytes / 16000 が秒数
    // 安全マージンとして少し長めに計算（最低2秒保証）
    const bytesLength = bytes.length;
    const bitrate = format === 'wav' ? 176400 : 16000; // WAV 44.1kHz 16bit stereo or MP3 128kbps
    const calculatedDurationMs = Math.round((bytesLength / bitrate) * 1000);
    const estimatedDurationMs = Math.max(2000, calculatedDurationMs);
    console.log(`[Audio] Duration calculation: ${bytesLength} bytes / ${bitrate} = ${calculatedDurationMs}ms (using ${estimatedDurationMs}ms)`);
    
    // completed 定義: r2_url 必須 + 自動でis_active = 1に設定 + duration_ms追加
    await env.DB.prepare(`
      UPDATE audio_generations
      SET status = ?, r2_key = ?, r2_url = ?, is_active = 1, duration_ms = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(GENERATION_STATUS.COMPLETED, r2Key, r2Url, estimatedDurationMs, audioId).run();

    const verify = await env.DB.prepare(`SELECT r2_url FROM audio_generations WHERE id = ?`)
      .bind(audioId).first<any>();

    if (!verify?.r2_url) {
      await env.DB.prepare(`
        UPDATE audio_generations
        SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(GENERATION_STATUS.FAILED, 'R2 upload verification failed', audioId).run();
      
      // Phase 4: ログ記録（失敗）
      await logTTSUsage({
        env,
        projectId,
        sceneId: audioId, // scene_id は後で取得が必要
        provider,
        voiceId,
        textLength: text.length,
        status: 'failed',
        errorMessage: 'R2 upload verification failed'
      });
    } else {
      // ============================================================
      // FIX: scene_utterances の duration_ms も更新
      // ============================================================
      try {
        // この audio_generation_id を持つ scene_utterances を更新
        await env.DB.prepare(`
          UPDATE scene_utterances 
          SET duration_ms = ?, updated_at = datetime('now')
          WHERE audio_generation_id = ?
        `).bind(estimatedDurationMs, audioId).run();
        
        console.log(`[Audio] Updated utterance duration_ms=${estimatedDurationMs} for audioId=${audioId}`);
      } catch (uttErr) {
        console.warn('[Audio] Failed to update utterance duration_ms:', uttErr);
      }
      
      // Phase 4: ログ記録（成功）
      await logTTSUsage({
        env,
        projectId,
        provider,
        voiceId,
        textLength: text.length,
        audioBytes: bytes.length,
        status: 'success'
      });
    }
  } catch (err: any) {
    console.error(`[Audio] generation failed audioId=${audioId}`, err);
    await env.DB.prepare(`
      UPDATE audio_generations
      SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(GENERATION_STATUS.FAILED, String(err?.message ?? 'Unknown error'), audioId).run();
    
    // Phase 4: ログ記録（失敗）
    await logTTSUsage({
      env,
      projectId,
      provider,
      voiceId,
      textLength: text.length,
      status: 'failed',
      errorMessage: String(err?.message ?? 'Unknown error')
    });
  }
}

/**
 * POST /api/tts/preview
 * 音声プリセットのプレビュー再生用（短いサンプルテキスト）
 */
audioGeneration.post('/tts/preview', async (c) => {
  try {
    const body = await c.req.json();
    const { text, voice_id } = body;

    if (!voice_id) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'voice_id is required'), 400);
    }

    const sampleText = text || 'こんにちは、これはサンプル音声です。';
    
    // Determine provider from voice_id
    // Note: isElevenLabsVoice is imported function, use different variable name
    const isElevenLabs = voice_id.startsWith('elevenlabs:') || voice_id.startsWith('el-') || isElevenLabsVoice(voice_id);
    const isFish = voice_id.startsWith('fish:') || voice_id.startsWith('fish-');
    const provider = isElevenLabs ? 'elevenlabs' : isFish ? 'fish' : 'google';

    if (provider === 'elevenlabs') {
      // ElevenLabs TTS
      if (!c.env.ELEVENLABS_API_KEY) {
        return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'ELEVENLABS_API_KEY is not set'), 500);
      }
      
      const elevenLabsVoiceId = resolveElevenLabsVoiceId(voice_id);
      if (!elevenLabsVoiceId) {
        return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Invalid ElevenLabs voice_id'), 400);
      }
      
      const modelId = (c.env as any).ELEVENLABS_DEFAULT_MODEL || ELEVENLABS_MODELS.MULTILINGUAL_V2;
      const elevenLabsResult = await generateElevenLabsTTS(c.env.ELEVENLABS_API_KEY, {
        text: sampleText,
        voice_id: elevenLabsVoiceId,
        model_id: modelId,
        output_format: 'mp3_44100_128',
      });
      
      if (!elevenLabsResult.success || !elevenLabsResult.audio) {
        console.error('[TTS Preview] ElevenLabs error:', elevenLabsResult.error);
        return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, elevenLabsResult.error || 'ElevenLabs TTS failed'), 500);
      }
      
      // Return as base64 data URL
      const base64 = btoa(String.fromCharCode(...new Uint8Array(elevenLabsResult.audio)));
      return c.json({
        success: true,
        audio_url: `data:audio/mpeg;base64,${base64}`,
        character_count: elevenLabsResult.character_count,
      });
    } else if (provider === 'fish') {
      // Fish Audio
      if (!c.env.FISH_AUDIO_API_TOKEN) {
        return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'FISH_AUDIO_API_TOKEN is not set'), 500);
      }
      
      // Use preset lookup for reference_id (e.g., 'fish-nanamin' -> '71bf4cb71cd44df6aa603d51db8f92ff')
      const referenceId = await getFishReferenceId(voice_id);
      if (!referenceId) {
        return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, `Unknown Fish Audio voice: ${voice_id}`), 400);
      }
      const fishResult = await generateFishTTS(c.env.FISH_AUDIO_API_TOKEN, {
        text: sampleText,
        reference_id: referenceId,
        format: 'mp3',
        sample_rate: 44100,
        mp3_bitrate: 128,
      });
      
      // Return as base64 data URL
      const base64 = btoa(String.fromCharCode(...new Uint8Array(fishResult.audio)));
      return c.json({
        success: true,
        audio_url: `data:audio/mpeg;base64,${base64}`
      });
    } else {
      // Google TTS - can use either GOOGLE_TTS_API_KEY or GEMINI_API_KEY (same as actual TTS generation)
      const googleTtsKey = c.env.GOOGLE_TTS_API_KEY || c.env.GEMINI_API_KEY;
      if (!googleTtsKey) {
        // Fallback: Return informative message that Google TTS preview is not available
        console.warn('[TTS Preview] Neither GOOGLE_TTS_API_KEY nor GEMINI_API_KEY is set.');
        return c.json({
          success: false,
          error: {
            code: 'TTS_NOT_CONFIGURED',
            message: 'Google TTS preview is not available. Please configure GOOGLE_TTS_API_KEY or GEMINI_API_KEY.'
          }
        }, 400);
      }

      const ttsUrl = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${googleTtsKey}`;
      const ttsResponse = await fetch(ttsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text: sampleText },
          voice: {
            languageCode: 'ja-JP',
            name: voice_id,
          },
          audioConfig: {
            audioEncoding: 'MP3',
            sampleRateHertz: 24000,
          },
        }),
      });

      if (!ttsResponse.ok) {
        const errorText = await ttsResponse.text();
        console.error('[TTS Preview] Google TTS error:', errorText);
        // Check for specific API blocked error
        if (errorText.includes('API_KEY_SERVICE_BLOCKED')) {
          return c.json({
            success: false,
            error: {
              code: 'TTS_API_BLOCKED',
              message: 'Google TTS API is blocked for this key. Please enable Cloud Text-to-Speech API in Google Cloud Console.'
            }
          }, 403);
        }
        return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'TTS generation failed'), 500);
      }

      const ttsData = await ttsResponse.json() as { audioContent?: string };
      if (!ttsData.audioContent) {
        return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'No audio content returned'), 500);
      }

      return c.json({
        success: true,
        audio_url: `data:audio/mpeg;base64,${ttsData.audioContent}`
      });
    }
  } catch (error) {
    console.error('[TTS Preview] Error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'TTS preview failed'), 500);
  }
});

/**
 * GET /api/tts/voices
 * 利用可能なTTSボイス一覧を取得
 */
audioGeneration.get('/tts/voices', async (c) => {
  try {
    // ElevenLabs voices
    const elevenLabsVoices = getElevenLabsVoiceList().map(v => ({
      id: v.key,
      voice_id: v.voice_id,
      name: v.name,
      provider: 'elevenlabs',
      gender: v.gender,
      description: v.description,
      language: 'ja-JP',
    }));

    // Google TTS voices (existing)
    const googleVoices = [
      { id: 'ja-JP-Standard-A', name: 'Standard A（女性）', provider: 'google', gender: 'female', language: 'ja-JP' },
      { id: 'ja-JP-Standard-B', name: 'Standard B（女性）', provider: 'google', gender: 'female', language: 'ja-JP' },
      { id: 'ja-JP-Standard-C', name: 'Standard C（男性）', provider: 'google', gender: 'male', language: 'ja-JP' },
      { id: 'ja-JP-Standard-D', name: 'Standard D（男性）', provider: 'google', gender: 'male', language: 'ja-JP' },
      { id: 'ja-JP-Wavenet-A', name: 'Wavenet A（女性・自然）', provider: 'google', gender: 'female', language: 'ja-JP' },
      { id: 'ja-JP-Wavenet-B', name: 'Wavenet B（女性・自然）', provider: 'google', gender: 'female', language: 'ja-JP' },
      { id: 'ja-JP-Wavenet-C', name: 'Wavenet C（男性・自然）', provider: 'google', gender: 'male', language: 'ja-JP' },
      { id: 'ja-JP-Wavenet-D', name: 'Wavenet D（男性・自然）', provider: 'google', gender: 'male', language: 'ja-JP' },
    ];

    // Fish Audio voices (if available)
    const fishVoices = c.env.FISH_AUDIO_API_TOKEN ? [
      { id: 'fish-nanamin', name: 'Nanamin（女性・アニメ）', provider: 'fish', gender: 'female', language: 'ja-JP' },
    ] : [];

    return c.json({
      success: true,
      voices: {
        elevenlabs: elevenLabsVoices,
        google: googleVoices,
        fish: fishVoices,
      },
      // Indicate which providers are configured
      providers: {
        elevenlabs: !!c.env.ELEVENLABS_API_KEY,
        google: !!(c.env.GOOGLE_TTS_API_KEY || c.env.GEMINI_API_KEY),
        fish: !!c.env.FISH_AUDIO_API_TOKEN,
      },
    });
  } catch (error) {
    console.error('[TTS Voices] Error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to get voice list'), 500);
  }
});

// ===== Phase 4: TTS Usage Summary API =====
// SSOT: docs/TTS_USAGE_LIMITS_SPEC.md

const TTS_LIMITS = {
  MONTHLY_LIMIT_USD: 100,
  WARNING_70_PERCENT: 70,
  WARNING_85_PERCENT: 85,
  WARNING_95_PERCENT: 95,
  DAILY_LIMIT_CHARACTERS: 500_000,
};

function getWarningLevel(percentage: number): string {
  if (percentage >= 100) return 'limit_reached';
  if (percentage >= 95) return 'warning_95';
  if (percentage >= 85) return 'warning_85';
  if (percentage >= 70) return 'warning_70';
  return 'none';
}

/**
 * GET /api/tts/usage
 * TTS使用量サマリー（月間/日次/プロバイダ別）
 */
audioGeneration.get('/tts/usage', async (c) => {
  try {
    const userId = 1; // TODO: 認証から取得

    // 今月の開始日（UTC）
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthStartStr = monthStart.toISOString().slice(0, 10);
    
    // 今日の開始日（UTC）
    const todayStart = now.toISOString().slice(0, 10);
    
    // 次月1日（リセット日）
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const nextResetStr = nextMonth.toISOString();

    // 月間使用量（プロバイダ別）
    const { results: monthlyByProvider } = await c.env.DB.prepare(`
      SELECT 
        provider,
        SUM(text_length) as total_characters,
        SUM(estimated_cost_usd) as total_cost,
        COUNT(*) as request_count
      FROM tts_usage_logs
      WHERE created_at >= ? AND status = 'success'
      GROUP BY provider
    `).bind(monthStartStr).all();

    // 日次使用量
    const dailyResult = await c.env.DB.prepare(`
      SELECT 
        SUM(text_length) as total_characters,
        COUNT(*) as request_count
      FROM tts_usage_logs
      WHERE created_at >= ? AND status = 'success'
    `).bind(todayStart).first<any>();

    // プロバイダ別集計
    const byProvider = {
      google: { characters: 0, cost_usd: 0, requests: 0 },
      fish: { characters: 0, cost_usd: 0, requests: 0 },
      elevenlabs: { characters: 0, cost_usd: 0, requests: 0 },
    };

    let monthlyTotalCost = 0;
    let monthlyTotalChars = 0;

    for (const row of monthlyByProvider || []) {
      const provider = (row as any).provider as keyof typeof byProvider;
      if (byProvider[provider]) {
        byProvider[provider].characters = Number((row as any).total_characters) || 0;
        byProvider[provider].cost_usd = Number((row as any).total_cost) || 0;
        byProvider[provider].requests = Number((row as any).request_count) || 0;
      }
      monthlyTotalCost += Number((row as any).total_cost) || 0;
      monthlyTotalChars += Number((row as any).total_characters) || 0;
    }

    const percentage = Math.round((monthlyTotalCost / TTS_LIMITS.MONTHLY_LIMIT_USD) * 100);
    const warningLevel = getWarningLevel(percentage);

    const dailyChars = Number(dailyResult?.total_characters) || 0;

    return c.json({
      monthly: {
        used_usd: Math.round(monthlyTotalCost * 1000) / 1000,
        limit_usd: TTS_LIMITS.MONTHLY_LIMIT_USD,
        remaining_usd: Math.round((TTS_LIMITS.MONTHLY_LIMIT_USD - monthlyTotalCost) * 1000) / 1000,
        percentage,
        characters_used: monthlyTotalChars,
      },
      daily: {
        characters_used: dailyChars,
        limit_characters: TTS_LIMITS.DAILY_LIMIT_CHARACTERS,
        remaining_characters: Math.max(0, TTS_LIMITS.DAILY_LIMIT_CHARACTERS - dailyChars),
      },
      by_provider: byProvider,
      warning_level: warningLevel,
      next_reset: nextResetStr,
      limits: TTS_LIMITS,
    });
  } catch (error) {
    console.error('[TTS Usage] Error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to get TTS usage'), 500);
  }
});

/**
 * GET /api/tts/usage/check
 * TTS生成前の上限チェック（生成可否判定）
 */
audioGeneration.get('/tts/usage/check', async (c) => {
  try {
    const textLength = Number(c.req.query('text_length')) || 0;
    const provider = c.req.query('provider') || 'google';

    // 月間使用量を取得
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthStartStr = monthStart.toISOString().slice(0, 10);

    const result = await c.env.DB.prepare(`
      SELECT SUM(estimated_cost_usd) as total_cost
      FROM tts_usage_logs
      WHERE created_at >= ? AND status = 'success'
    `).bind(monthStartStr).first<any>();

    const currentCost = Number(result?.total_cost) || 0;
    const estimatedCost = estimateTTSCost(provider, textLength);
    const newTotalCost = currentCost + estimatedCost;
    const percentage = Math.round((newTotalCost / TTS_LIMITS.MONTHLY_LIMIT_USD) * 100);

    const allowed = newTotalCost < TTS_LIMITS.MONTHLY_LIMIT_USD;
    const warningLevel = getWarningLevel(percentage);

    return c.json({
      allowed,
      warning_level: warningLevel,
      current_usage_usd: Math.round(currentCost * 1000) / 1000,
      estimated_cost_usd: Math.round(estimatedCost * 10000) / 10000,
      new_total_usd: Math.round(newTotalCost * 1000) / 1000,
      limit_usd: TTS_LIMITS.MONTHLY_LIMIT_USD,
      percentage,
      message: allowed 
        ? (warningLevel === 'none' ? null : `使用量が${percentage}%に達しています`)
        : '月間上限に達しました。来月までお待ちください。',
    });
  } catch (error) {
    console.error('[TTS Usage Check] Error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to check TTS usage'), 500);
  }
});

// ============================================================
// FIX: Patch endpoint to update existing audio duration_ms
// ============================================================
/**
 * POST /api/audio/fix-durations
 * シーンのaudio_generationsとscene_utterancesのduration_msを一括修正
 * - 対象: status='completed' かつ duration_ms IS NULL
 * - 計算: テキスト長 * 130ms（最低2秒）
 */
audioGeneration.post('/audio/fix-durations', async (c) => {
  try {
    // 1. duration_ms が NULL で completed な audio_generations を取得
    const { results: audioList } = await c.env.DB.prepare(`
      SELECT ag.id, ag.scene_id, ag.text, ag.duration_ms, ag.is_active, s.project_id
      FROM audio_generations ag
      JOIN scenes s ON ag.scene_id = s.id
      WHERE ag.status = 'completed' AND ag.r2_url IS NOT NULL
      ORDER BY ag.id ASC
    `).all<{
      id: number;
      scene_id: number;
      text: string;
      duration_ms: number | null;
      is_active: number;
      project_id: number;
    }>();
    
    let updatedAudio = 0;
    let updatedUtterances = 0;
    let activatedAudio = 0;
    
    for (const audio of audioList) {
      // duration_ms を計算
      const textLength = audio.text?.length || 20; // デフォルト20文字
      const estimatedDurationMs = Math.max(2000, textLength * 130);
      
      // audio_generations を更新（duration_ms が NULL の場合のみ）
      if (audio.duration_ms === null) {
        await c.env.DB.prepare(`
          UPDATE audio_generations 
          SET duration_ms = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(estimatedDurationMs, audio.id).run();
        updatedAudio++;
      }
      
      // is_active が 0 なら 1 に更新（同シーンの他の音声を非アクティブにしてから）
      if (audio.is_active === 0) {
        await c.env.DB.prepare(`
          UPDATE audio_generations 
          SET is_active = 0, updated_at = CURRENT_TIMESTAMP
          WHERE scene_id = ? AND id != ?
        `).bind(audio.scene_id, audio.id).run();
        
        await c.env.DB.prepare(`
          UPDATE audio_generations 
          SET is_active = 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(audio.id).run();
        activatedAudio++;
      }
      
      // scene_utterances も更新
      const uttResult = await c.env.DB.prepare(`
        UPDATE scene_utterances 
        SET duration_ms = ?, updated_at = datetime('now')
        WHERE audio_generation_id = ? AND (duration_ms IS NULL OR duration_ms = 0)
      `).bind(estimatedDurationMs, audio.id).run();
      
      if (uttResult.meta?.changes && uttResult.meta.changes > 0) {
        updatedUtterances += uttResult.meta.changes;
      }
    }
    
    return c.json({
      success: true,
      message: 'Audio durations fixed',
      stats: {
        total_audio_checked: audioList.length,
        updated_audio_duration: updatedAudio,
        activated_audio: activatedAudio,
        updated_utterances_duration: updatedUtterances,
      },
    });
  } catch (error) {
    console.error('[Audio Fix Durations] Error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to fix audio durations'), 500);
  }
});

export default audioGeneration;
