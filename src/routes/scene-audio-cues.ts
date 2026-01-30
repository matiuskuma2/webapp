/**
 * R3-B: Scene Audio Cues API（SFX/効果音）
 * 
 * シーン内の特定タイミングで再生される効果音を管理
 * 
 * 設計思想（Audio SSOT 3層構造）:
 * - BGM: project_audio_tracks（通し再生）
 * - SFX: scene_audio_cues（シーン内タイミング指定）← このAPI
 * - Voice: scene_utterances（音声パーツ）
 * 
 * エンドポイント:
 * - GET    /api/scenes/:sceneId/audio-cues          - シーンのSFX一覧取得
 * - POST   /api/scenes/:sceneId/audio-cues/upload   - SFXアップロード
 * - PUT    /api/scenes/:sceneId/audio-cues/:id      - SFX設定更新
 * - DELETE /api/scenes/:sceneId/audio-cues/:id      - SFX削除
 */

import { Hono } from 'hono';
import { logSfxUpload } from '../utils/usage-logger';

interface Bindings {
  DB: D1Database;
  R2: R2Bucket;
  SITE_URL?: string;
}

const sceneAudioCues = new Hono<{ Bindings: Bindings }>();

const DEFAULT_SITE_URL = 'https://app.marumuviai.com';

import { getCookie } from 'hono/cookie';

/**
 * 相対URLを絶対URLに変換
 */
function toAbsoluteUrl(relativeUrl: string | null | undefined, siteUrl: string | undefined): string | null {
  if (!relativeUrl) return null;
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
    return relativeUrl;
  }
  const baseUrl = (siteUrl || DEFAULT_SITE_URL).replace(/\/$/, '');
  const path = relativeUrl.startsWith('/') ? relativeUrl : `/${relativeUrl}`;
  return `${baseUrl}${path}`;
}

/**
 * SSOT: セッションからユーザーIDを取得
 */
async function getUserIdFromSession(c: any): Promise<number | null> {
  try {
    const sessionId = getCookie(c, 'session');
    if (!sessionId) {
      console.log('[SceneAudioCues] No session cookie found');
      return null;
    }
    
    const session = await c.env.DB.prepare(`
      SELECT user_id FROM sessions 
      WHERE id = ? AND expires_at > datetime('now')
    `).bind(sessionId).first<{ user_id: number }>();
    
    if (!session) {
      console.log('[SceneAudioCues] Session not found or expired');
      return null;
    }
    
    return session.user_id;
  } catch (error) {
    console.error('[SceneAudioCues] Session lookup error:', error);
    return null;
  }
}

/**
 * SSOT: シーンの存在確認とプロジェクト所有確認
 */
async function validateSceneAccess(c: any, sceneId: number, userId: number): Promise<{ valid: boolean; projectId?: number; error?: string }> {
  try {
    const scene = await c.env.DB.prepare(`
      SELECT s.id, s.project_id, p.user_id as project_user_id
      FROM scenes s
      JOIN projects p ON s.project_id = p.id
      WHERE s.id = ?
    `).bind(sceneId).first<{ id: number; project_id: number; project_user_id: number }>();
    
    if (!scene) {
      return { valid: false, error: 'Scene not found' };
    }
    
    if (scene.project_user_id !== userId) {
      return { valid: false, error: 'Access denied' };
    }
    
    return { valid: true, projectId: scene.project_id };
  } catch (error) {
    console.error('[SceneAudioCues] Scene validation error:', error);
    return { valid: false, error: 'Validation failed' };
  }
}

// ====================================================================
// GET /api/scenes/:sceneId/audio-cues
// ====================================================================
// SSOT: 認証必須（Cookie必須）
// - 未ログイン → 401 UNAUTHORIZED
// - ログイン済み＋他人のシーン → 404 NOT_FOUND（存在隠し）
// - ログイン済み＋自分のシーン → 200 OK
sceneAudioCues.get('/scenes/:sceneId/audio-cues', async (c) => {
  try {
    // SSOT: 認証必須 - 未ログインは401
    const userId = await getUserIdFromSession(c);
    if (!userId) {
      console.log('[SceneAudioCues] GET: No session - returning 401');
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const sceneId = parseInt(c.req.param('sceneId'), 10);
    if (!Number.isFinite(sceneId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid scene id' } }, 400);
    }

    // SSOT: 所有者チェック - 他人のシーンは404（存在隠し）
    const access = await validateSceneAccess(c, sceneId, userId);
    if (!access.valid) {
      console.log(`[SceneAudioCues] GET: Access denied for scene ${sceneId}, user ${userId}`);
      return c.json({ error: { code: 'NOT_FOUND', message: access.error } }, 404);
    }

    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;

    const { results } = await c.env.DB.prepare(`
      SELECT 
        id, scene_id, cue_type, name,
        r2_key, r2_url, duration_ms,
        volume, start_ms, end_ms,
        loop, fade_in_ms, fade_out_ms,
        is_active, created_at, updated_at
      FROM scene_audio_cues
      WHERE scene_id = ?
      ORDER BY start_ms ASC, created_at ASC
    `).bind(sceneId).all();

    const cues = (results || []).map((cue: any) => ({
      ...cue,
      r2_url: toAbsoluteUrl(cue.r2_url, siteUrl),
      loop: cue.loop === 1,
      is_active: cue.is_active === 1,
    }));

    // アクティブなSFXのみをフィルタ
    const activeCues = cues.filter((cue: any) => cue.is_active);

    return c.json({ 
      cues,
      active_cues: activeCues,
      summary: {
        total: cues.length,
        active: activeCues.length,
      }
    });
  } catch (error) {
    console.error('[SceneAudioCues] GET error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get audio cues' } }, 500);
  }
});

// ====================================================================
// POST /api/scenes/:sceneId/audio-cues/upload
// ====================================================================
// SSOT: 認証必須
sceneAudioCues.post('/scenes/:sceneId/audio-cues/upload', async (c) => {
  try {
    // SSOT: 認証必須
    const userId = await getUserIdFromSession(c);
    if (!userId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const sceneId = parseInt(c.req.param('sceneId'), 10);
    if (!Number.isFinite(sceneId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid scene id' } }, 400);
    }

    // SSOT: 所有者チェック
    const access = await validateSceneAccess(c, sceneId, userId);
    if (!access.valid) {
      return c.json({ error: { code: 'NOT_FOUND', message: access.error } }, 404);
    }

    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'No file provided' } }, 400);
    }

    // ファイルタイプ検証
    if (!file.type.startsWith('audio/')) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'File must be an audio file' } }, 400);
    }

    // パラメータ取得
    const name = formData.get('name') as string || 'SFX';
    const volume = parseFloat(formData.get('volume') as string || '0.8');
    const startMs = parseInt(formData.get('start_ms') as string || '0', 10);
    const endMs = formData.get('end_ms') ? parseInt(formData.get('end_ms') as string, 10) : null;
    const loop = formData.get('loop') === '1' || formData.get('loop') === 'true' ? 1 : 0;
    const fadeInMs = parseInt(formData.get('fade_in_ms') as string || '0', 10);
    const fadeOutMs = parseInt(formData.get('fade_out_ms') as string || '0', 10);

    // R2にアップロード
    const timestamp = Date.now();
    const ext = file.name.split('.').pop() || 'mp3';
    const r2Key = `audio/sfx/project_${scene.project_id}/scene_${sceneId}/${timestamp}.${ext}`;
    
    const arrayBuffer = await file.arrayBuffer();
    await c.env.R2.put(r2Key, arrayBuffer, {
      httpMetadata: { contentType: file.type },
    });

    // 相対URLを生成
    const r2Url = `/${r2Key}`;
    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;

    // DBに保存
    const result = await c.env.DB.prepare(`
      INSERT INTO scene_audio_cues (
        scene_id, cue_type, name,
        r2_key, r2_url,
        volume, start_ms, end_ms,
        loop, fade_in_ms, fade_out_ms,
        is_active
      ) VALUES (?, 'sfx', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(
      sceneId, name,
      r2Key, r2Url,
      volume, startMs, endMs,
      loop, fadeInMs, fadeOutMs
    ).run();

    const cueId = result.meta.last_row_id;

    // Log usage event
    await logSfxUpload(c.env.DB, {
      userId: 1, // TODO: Get from session
      projectId: scene.project_id,
      sceneId,
      cueId: cueId as number,
      bytes: arrayBuffer.byteLength,
      durationMs: null, // Audio duration detection requires ffprobe
      format: ext,
      status: 'success',
    });

    // 作成したレコードを取得
    const cue = await c.env.DB.prepare(`
      SELECT * FROM scene_audio_cues WHERE id = ?
    `).bind(cueId).first();

    return c.json({
      ...cue,
      r2_url: toAbsoluteUrl(cue?.r2_url as string, siteUrl),
      loop: cue?.loop === 1,
      is_active: cue?.is_active === 1,
    }, 201);

  } catch (error) {
    console.error('[SceneAudioCues] Upload error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to upload audio cue' } }, 500);
  }
});

// ====================================================================
// PUT /api/scenes/:sceneId/audio-cues/:id
// ====================================================================
// SSOT: 認証必須
sceneAudioCues.put('/scenes/:sceneId/audio-cues/:id', async (c) => {
  try {
    // SSOT: 認証必須
    const userId = await getUserIdFromSession(c);
    if (!userId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const sceneId = parseInt(c.req.param('sceneId'), 10);
    const cueId = parseInt(c.req.param('id'), 10);
    
    if (!Number.isFinite(sceneId) || !Number.isFinite(cueId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid scene or cue id' } }, 400);
    }

    // SSOT: 所有者チェック
    const access = await validateSceneAccess(c, sceneId, userId);
    if (!access.valid) {
      return c.json({ error: { code: 'NOT_FOUND', message: access.error } }, 404);
    }

    const body = await c.req.json();
    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;

    // 既存レコード確認
    const existing = await c.env.DB.prepare(`
      SELECT * FROM scene_audio_cues WHERE id = ? AND scene_id = ?
    `).bind(cueId, sceneId).first();

    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Audio cue not found' } }, 404);
    }

    // 更新可能フィールド
    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.volume !== undefined) {
      updates.push('volume = ?');
      values.push(parseFloat(body.volume));
    }
    if (body.start_ms !== undefined) {
      updates.push('start_ms = ?');
      values.push(parseInt(body.start_ms, 10));
    }
    if (body.end_ms !== undefined) {
      updates.push('end_ms = ?');
      values.push(body.end_ms === null ? null : parseInt(body.end_ms, 10));
    }
    if (body.loop !== undefined) {
      updates.push('loop = ?');
      values.push(body.loop ? 1 : 0);
    }
    if (body.fade_in_ms !== undefined) {
      updates.push('fade_in_ms = ?');
      values.push(parseInt(body.fade_in_ms, 10));
    }
    if (body.fade_out_ms !== undefined) {
      updates.push('fade_out_ms = ?');
      values.push(parseInt(body.fade_out_ms, 10));
    }
    if (body.is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(body.is_active ? 1 : 0);
    }

    if (updates.length === 0) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'No fields to update' } }, 400);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(cueId, sceneId);

    await c.env.DB.prepare(`
      UPDATE scene_audio_cues 
      SET ${updates.join(', ')}
      WHERE id = ? AND scene_id = ?
    `).bind(...values).run();

    // 更新後のレコード取得
    const updated = await c.env.DB.prepare(`
      SELECT * FROM scene_audio_cues WHERE id = ?
    `).bind(cueId).first();

    return c.json({
      ...updated,
      r2_url: toAbsoluteUrl(updated?.r2_url as string, siteUrl),
      loop: updated?.loop === 1,
      is_active: updated?.is_active === 1,
    });

  } catch (error) {
    console.error('[SceneAudioCues] Update error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update audio cue' } }, 500);
  }
});

// ====================================================================
// DELETE /api/scenes/:sceneId/audio-cues/:id
// ====================================================================
// SSOT: 認証必須
sceneAudioCues.delete('/scenes/:sceneId/audio-cues/:id', async (c) => {
  try {
    // SSOT: 認証必須
    const userId = await getUserIdFromSession(c);
    if (!userId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const sceneId = parseInt(c.req.param('sceneId'), 10);
    const cueId = parseInt(c.req.param('id'), 10);
    
    if (!Number.isFinite(sceneId) || !Number.isFinite(cueId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid scene or cue id' } }, 400);
    }

    // SSOT: 所有者チェック
    const access = await validateSceneAccess(c, sceneId, userId);
    if (!access.valid) {
      return c.json({ error: { code: 'NOT_FOUND', message: access.error } }, 404);
    }

    // 既存レコード確認
    const existing = await c.env.DB.prepare(`
      SELECT * FROM scene_audio_cues WHERE id = ? AND scene_id = ?
    `).bind(cueId, sceneId).first<{ id: number; r2_key: string | null }>();

    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Audio cue not found' } }, 404);
    }

    // R2から削除
    if (existing.r2_key) {
      try {
        await c.env.R2.delete(existing.r2_key);
      } catch (e) {
        console.warn('[SceneAudioCues] Failed to delete R2 object:', e);
      }
    }

    // DBから削除
    await c.env.DB.prepare(`
      DELETE FROM scene_audio_cues WHERE id = ? AND scene_id = ?
    `).bind(cueId, sceneId).run();

    return c.json({ success: true });

  } catch (error) {
    console.error('[SceneAudioCues] Delete error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete audio cue' } }, 500);
  }
});

export { sceneAudioCues };
