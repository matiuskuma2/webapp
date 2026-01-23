/**
 * R3-A: Project Audio Tracks API（通しBGM）
 * 
 * プロジェクト全体を通して流れるBGMを管理
 * 
 * エンドポイント:
 * - GET    /api/projects/:projectId/audio-tracks
 * - POST   /api/projects/:projectId/audio-tracks/bgm/upload
 * - PUT    /api/projects/:projectId/audio-tracks/:id
 * - DELETE /api/projects/:projectId/audio-tracks/:id
 */

import { Hono } from 'hono';
import { logBgmUpload } from '../utils/usage-logger';

interface Bindings {
  DB: D1Database;
  R2: R2Bucket;
  SITE_URL?: string;
}

const projectAudioTracks = new Hono<{ Bindings: Bindings }>();

const DEFAULT_SITE_URL = 'https://webapp-c7n.pages.dev';

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

// ====================================================================
// GET /api/projects/:projectId/audio-tracks
// ====================================================================
projectAudioTracks.get('/projects/:projectId/audio-tracks', async (c) => {
  try {
    const projectId = parseInt(c.req.param('projectId'), 10);
    if (!Number.isFinite(projectId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project id' } }, 400);
    }

    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;

    const { results } = await c.env.DB.prepare(`
      SELECT 
        id, project_id, track_type,
        r2_key, r2_url, duration_ms,
        volume, loop, fade_in_ms, fade_out_ms,
        ducking_enabled, ducking_volume, ducking_attack_ms, ducking_release_ms,
        is_active, created_at, updated_at
      FROM project_audio_tracks
      WHERE project_id = ?
      ORDER BY is_active DESC, created_at DESC
    `).bind(projectId).all();

    const tracks = (results || []).map((t: any) => ({
      ...t,
      r2_url: toAbsoluteUrl(t.r2_url, siteUrl),
      loop: t.loop === 1,
      is_active: t.is_active === 1,
      ducking_enabled: t.ducking_enabled === 1,
    }));

    // アクティブなBGMを別途返す（便宜上）
    const activeBgm = tracks.find((t: any) => t.track_type === 'bgm' && t.is_active) || null;

    return c.json({ 
      tracks,
      active_bgm: activeBgm,
    });
  } catch (error) {
    console.error('[ProjectAudioTracks] GET error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get audio tracks' } }, 500);
  }
});

// ====================================================================
// POST /api/projects/:projectId/audio-tracks/bgm/upload
// ====================================================================
projectAudioTracks.post('/projects/:projectId/audio-tracks/bgm/upload', async (c) => {
  try {
    const projectId = parseInt(c.req.param('projectId'), 10);
    if (!Number.isFinite(projectId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project id' } }, 400);
    }

    // multipart/form-data を解析
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    
    if (!file) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'No file provided' } }, 400);
    }

    // ファイル形式チェック（mp3, wav, m4a, ogg）
    const allowedTypes = ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'audio/ogg'];
    const allowedExtensions = ['.mp3', '.wav', '.m4a', '.ogg'];
    const fileName = file.name.toLowerCase();
    const hasValidExtension = allowedExtensions.some(ext => fileName.endsWith(ext));
    
    if (!allowedTypes.includes(file.type) && !hasValidExtension) {
      return c.json({ 
        error: { 
          code: 'INVALID_REQUEST', 
          message: `Invalid file type. Allowed: ${allowedExtensions.join(', ')}`
        } 
      }, 400);
    }

    // R2にアップロード
    const timestamp = Date.now();
    const ext = fileName.split('.').pop() || 'mp3';
    const r2Key = `audio/bgm/project_${projectId}/${timestamp}.${ext}`;
    
    const arrayBuffer = await file.arrayBuffer();
    await c.env.R2.put(r2Key, arrayBuffer, {
      httpMetadata: {
        contentType: file.type || 'audio/mpeg',
      },
    });

    const r2Url = `/${r2Key}`;

    // 追加パラメータを取得
    const volume = parseFloat(formData.get('volume') as string) || 0.25;
    const loop = (formData.get('loop') as string) !== 'false';
    const fadeInMs = parseInt(formData.get('fade_in_ms') as string) || 800;
    const fadeOutMs = parseInt(formData.get('fade_out_ms') as string) || 800;

    // 既存のactive BGMを非アクティブに
    await c.env.DB.prepare(`
      UPDATE project_audio_tracks 
      SET is_active = 0, updated_at = datetime('now')
      WHERE project_id = ? AND track_type = 'bgm' AND is_active = 1
    `).bind(projectId).run();

    // 新しいBGMを挿入
    const result = await c.env.DB.prepare(`
      INSERT INTO project_audio_tracks (
        project_id, track_type, r2_key, r2_url, 
        volume, loop, fade_in_ms, fade_out_ms,
        is_active, created_at, updated_at
      ) VALUES (?, 'bgm', ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    `).bind(
      projectId, r2Key, r2Url,
      volume, loop ? 1 : 0, fadeInMs, fadeOutMs
    ).run();

    const trackId = result.meta.last_row_id;
    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;

    // Log usage event
    // Note: user_id=1 is used as default; in production, get from session
    await logBgmUpload(c.env.DB, {
      userId: 1, // TODO: Get from session
      projectId,
      trackId: trackId as number,
      bytes: arrayBuffer.byteLength,
      durationMs: null, // Audio duration detection would require ffprobe/web-audio
      format: ext,
      status: 'success',
    });

    return c.json({
      success: true,
      track: {
        id: trackId,
        project_id: projectId,
        track_type: 'bgm',
        r2_key: r2Key,
        r2_url: toAbsoluteUrl(r2Url, siteUrl),
        volume,
        loop,
        fade_in_ms: fadeInMs,
        fade_out_ms: fadeOutMs,
        is_active: true,
      },
    });
  } catch (error) {
    console.error('[ProjectAudioTracks] Upload error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to upload BGM' } }, 500);
  }
});

// ====================================================================
// PUT /api/projects/:projectId/audio-tracks/:id
// ====================================================================
projectAudioTracks.put('/projects/:projectId/audio-tracks/:id', async (c) => {
  try {
    const projectId = parseInt(c.req.param('projectId'), 10);
    const trackId = parseInt(c.req.param('id'), 10);
    
    if (!Number.isFinite(projectId) || !Number.isFinite(trackId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project or track id' } }, 400);
    }

    const body = await c.req.json();

    // 更新するフィールドを構築
    const updates: string[] = [];
    const values: any[] = [];

    if (body.volume !== undefined) {
      updates.push('volume = ?');
      values.push(Math.max(0, Math.min(1, parseFloat(body.volume))));
    }
    if (body.loop !== undefined) {
      updates.push('loop = ?');
      values.push(body.loop ? 1 : 0);
    }
    if (body.fade_in_ms !== undefined) {
      updates.push('fade_in_ms = ?');
      values.push(Math.max(0, parseInt(body.fade_in_ms)));
    }
    if (body.fade_out_ms !== undefined) {
      updates.push('fade_out_ms = ?');
      values.push(Math.max(0, parseInt(body.fade_out_ms)));
    }
    if (body.ducking_enabled !== undefined) {
      updates.push('ducking_enabled = ?');
      values.push(body.ducking_enabled ? 1 : 0);
    }
    if (body.ducking_volume !== undefined) {
      updates.push('ducking_volume = ?');
      values.push(Math.max(0, Math.min(1, parseFloat(body.ducking_volume))));
    }
    if (body.ducking_attack_ms !== undefined) {
      updates.push('ducking_attack_ms = ?');
      values.push(Math.max(0, parseInt(body.ducking_attack_ms)));
    }
    if (body.ducking_release_ms !== undefined) {
      updates.push('ducking_release_ms = ?');
      values.push(Math.max(0, parseInt(body.ducking_release_ms)));
    }

    // is_active の処理（排他制御）
    if (body.is_active !== undefined) {
      if (body.is_active) {
        // 他のアクティブなBGMを非アクティブに
        await c.env.DB.prepare(`
          UPDATE project_audio_tracks 
          SET is_active = 0, updated_at = datetime('now')
          WHERE project_id = ? AND track_type = 'bgm' AND id != ? AND is_active = 1
        `).bind(projectId, trackId).run();
      }
      updates.push('is_active = ?');
      values.push(body.is_active ? 1 : 0);
    }

    if (updates.length === 0) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'No fields to update' } }, 400);
    }

    updates.push("updated_at = datetime('now')");
    values.push(trackId, projectId);

    await c.env.DB.prepare(`
      UPDATE project_audio_tracks 
      SET ${updates.join(', ')}
      WHERE id = ? AND project_id = ?
    `).bind(...values).run();

    // 更新後のデータを取得
    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;
    const track = await c.env.DB.prepare(`
      SELECT * FROM project_audio_tracks WHERE id = ?
    `).bind(trackId).first();

    if (!track) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Track not found' } }, 404);
    }

    return c.json({
      success: true,
      track: {
        ...track,
        r2_url: toAbsoluteUrl(track.r2_url as string, siteUrl),
        loop: (track as any).loop === 1,
        is_active: (track as any).is_active === 1,
        ducking_enabled: (track as any).ducking_enabled === 1,
      },
    });
  } catch (error) {
    console.error('[ProjectAudioTracks] PUT error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update track' } }, 500);
  }
});

// ====================================================================
// DELETE /api/projects/:projectId/audio-tracks/:id
// ====================================================================
projectAudioTracks.delete('/projects/:projectId/audio-tracks/:id', async (c) => {
  try {
    const projectId = parseInt(c.req.param('projectId'), 10);
    const trackId = parseInt(c.req.param('id'), 10);
    
    if (!Number.isFinite(projectId) || !Number.isFinite(trackId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project or track id' } }, 400);
    }

    // トラックを取得（R2削除用）
    const track = await c.env.DB.prepare(`
      SELECT r2_key FROM project_audio_tracks WHERE id = ? AND project_id = ?
    `).bind(trackId, projectId).first<{ r2_key: string }>();

    if (!track) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Track not found' } }, 404);
    }

    // R2からファイル削除
    if (track.r2_key) {
      try {
        await c.env.R2.delete(track.r2_key);
      } catch (r2Error) {
        console.warn('[ProjectAudioTracks] Failed to delete R2 file:', r2Error);
      }
    }

    // DBから削除
    await c.env.DB.prepare(`
      DELETE FROM project_audio_tracks WHERE id = ? AND project_id = ?
    `).bind(trackId, projectId).run();

    return c.json({ success: true });
  } catch (error) {
    console.error('[ProjectAudioTracks] DELETE error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete track' } }, 500);
  }
});

export default projectAudioTracks;
