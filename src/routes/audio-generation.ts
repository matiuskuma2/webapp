// src/routes/audio-generation.ts
import { Hono } from 'hono';
import type { Bindings } from '../types/bindings';
import { GENERATION_STATUS, ERROR_CODES } from '../constants';
import { createErrorResponse } from '../utils/error-response';
import { base64ToUint8Array, generateR2Key, getR2PublicUrl } from '../utils/r2-helper';
import { generateFishTTS } from '../utils/fish-audio'; // Phase X-1: Fish Audio integration

const audioGeneration = new Hono<{ Bindings: Bindings }>();

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
    const provider = (body.provider as string | undefined) ?? 'google';
    const format = (body.format as string | undefined) ?? 'mp3';
    const sampleRate = Number(body.sample_rate ?? 24000);
    // Phase1.7: text_override で任意のテキストを指定可能（漫画発話用）
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

    // 1) scene 取得（idx, project_id, dialogue）
    const scene = await c.env.DB.prepare(`
      SELECT id, project_id, idx, dialogue
      FROM scenes
      WHERE id = ?
    `).bind(sceneId).first<any>();

    if (!scene) {
      return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND, 'Scene not found'), 404);
    }
    // Phase1.7: text_override が指定されている場合はそちらを使用（漫画発話用）
    const dialogue = textOverride?.trim() || (scene.dialogue ?? '').trim();
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
 * - active は削除不可
 * - R2も削除
 */
audioGeneration.delete('/audio/:audioId', async (c) => {
  try {
    const audioId = Number(c.req.param('audioId'));
    if (!Number.isFinite(audioId)) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Invalid audio id'), 400);
    }

    const audio = await c.env.DB.prepare(`
      SELECT id, is_active, r2_key
      FROM audio_generations
      WHERE id = ?
    `).bind(audioId).first<any>();

    if (!audio) {
      return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND, 'Audio not found'), 404);
    }

    if (audio.is_active === 1) {
      return c.json(createErrorResponse(ERROR_CODES.ACTIVE_AUDIO_DELETE, 'Cannot delete active audio'), 400);
    }

    if (audio.r2_key) {
      try {
        await c.env.R2.delete(audio.r2_key);
      } catch (e) {
        console.warn('[Audio] R2 delete failed (ignored):', e);
      }
    }

    await c.env.DB.prepare(`DELETE FROM audio_generations WHERE id = ?`).bind(audioId).run();
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
    if (provider === 'fish') {
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

    // completed 定義: r2_url 必須
    await env.DB.prepare(`
      UPDATE audio_generations
      SET status = ?, r2_key = ?, r2_url = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(GENERATION_STATUS.COMPLETED, r2Key, r2Url, audioId).run();

    const verify = await env.DB.prepare(`SELECT r2_url FROM audio_generations WHERE id = ?`)
      .bind(audioId).first<any>();

    if (!verify?.r2_url) {
      await env.DB.prepare(`
        UPDATE audio_generations
        SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(GENERATION_STATUS.FAILED, 'R2 upload verification failed', audioId).run();
    }
  } catch (err: any) {
    console.error(`[Audio] generation failed audioId=${audioId}`, err);
    await env.DB.prepare(`
      UPDATE audio_generations
      SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(GENERATION_STATUS.FAILED, String(err?.message ?? 'Unknown error'), audioId).run();
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
    const isFishVoice = voice_id.startsWith('fish:');
    const provider = isFishVoice ? 'fish' : 'google';

    if (provider === 'fish') {
      // Fish Audio
      if (!c.env.FISH_AUDIO_API_TOKEN) {
        return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'FISH_AUDIO_API_TOKEN is not set'), 500);
      }
      
      const referenceId = voice_id.replace('fish:', '');
      const audioBuffer = await generateFishTTS(sampleText, referenceId, c.env.FISH_AUDIO_API_TOKEN);
      
      // Return as base64 data URL
      const base64 = btoa(String.fromCharCode(...new Uint8Array(audioBuffer)));
      return c.json({
        success: true,
        audio_url: `data:audio/mpeg;base64,${base64}`
      });
    } else {
      // Google TTS
      const googleTtsKey = c.env.GOOGLE_TTS_API_KEY || c.env.GEMINI_API_KEY;
      if (!googleTtsKey) {
        return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'GOOGLE_TTS_API_KEY is not set'), 500);
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

export default audioGeneration;
