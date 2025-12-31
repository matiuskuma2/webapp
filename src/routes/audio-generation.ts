// src/routes/audio-generation.ts
import { Hono } from 'hono';
import type { Bindings } from '../types/bindings';
import { GENERATION_STATUS, ERROR_CODES } from '../constants';
import { createErrorResponse } from '../utils/error-response';
import { base64ToUint8Array, generateR2Key, getR2PublicUrl } from '../utils/r2-helper';

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
    const voiceId = body.voice_id as string | undefined;
    const provider = (body.provider as string | undefined) ?? 'google';
    const format = (body.format as string | undefined) ?? 'mp3';
    const sampleRate = Number(body.sample_rate ?? 24000);

    if (!voiceId) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'voice_id is required'), 400);
    }
    if (!c.env.GOOGLE_TTS_API_KEY) {
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
    const dialogue = (scene.dialogue ?? '').trim();
    if (!dialogue) {
      return c.json(createErrorResponse(ERROR_CODES.NO_DIALOGUE, 'Scene has no dialogue'), 400);
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

async function generateAndUploadAudio(args: {
  env: Bindings;
  audioId: number;
  projectId: number;
  sceneIndex: number;
  text: string;
  voiceId: string;
  format: string;
  sampleRate: number;
}) {
  const { env, audioId, projectId, sceneIndex, text, voiceId, format, sampleRate } = args;

  try {
    // Google TTS REST
    const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_TTS_API_KEY,
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

    const bytes = base64ToUint8Array(audioContent);

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

export default audioGeneration;
