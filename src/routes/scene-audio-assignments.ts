/**
 * P2: Scene Audio Assignments API
 * 
 * シーンへのBGM/SFX割当を管理するAPI
 * 
 * 設計思想（Audio SSOT）:
 * - system_audio_library: 管理者が登録したシステム音素材
 * - user_audio_library: ユーザーが登録した個人音素材
 * - scene_audio_assignments: シーンへの割当（このAPI）
 * 
 * エンドポイント:
 * - GET    /api/scenes/:sceneId/audio-assignments         - シーンの音割当一覧
 * - POST   /api/scenes/:sceneId/audio-assignments         - 新規割当作成
 * - PUT    /api/scenes/:sceneId/audio-assignments/:id     - 割当更新
 * - DELETE /api/scenes/:sceneId/audio-assignments/:id     - 割当削除
 * - POST   /api/scenes/:sceneId/audio-assignments/direct  - 直接アップロードして割当
 * - POST   /api/scenes/:sceneId/audio-assignments/upload  - /direct のエイリアス（互換性）
 * 
 * ルール:
 * - BGM: 1シーンに最大1つ（新規追加時は既存をis_active=0に）
 * - SFX: 1シーンに複数可能（start_msでタイミング指定）
 */

import { Hono } from 'hono';
import { getUserFromSession, validateSceneAccess as validateSceneAccessHelper, type AuthUser } from '../utils/auth-helper';

interface Bindings {
  DB: D1Database;
  R2: R2Bucket;
  SITE_URL?: string;
}

const sceneAudioAssignments = new Hono<{ Bindings: Bindings }>();

const DEFAULT_SITE_URL = 'https://app.marumuviai.com';

// ====================================================================
// Helper Functions
// ====================================================================

/**
 * 相対URLを絶対URLに変換
 */
function toAbsoluteUrl(relativeUrl: string | null | undefined, siteUrl: string): string | null {
  if (!relativeUrl) return null;
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
    return relativeUrl;
  }
  const baseUrl = siteUrl.replace(/\/$/, '');
  const path = relativeUrl.startsWith('/') ? relativeUrl : `/${relativeUrl}`;
  return `${baseUrl}${path}`;
}

/**
 * シーンアクセス検証ラッパー（共通ヘルパーを使用）
 * SSOT: Superadmin は全データにアクセス可能
 */
async function validateSceneAccess(c: any, sceneId: number, user: AuthUser): Promise<{ valid: boolean; projectId?: number; error?: string; details?: any }> {
  return validateSceneAccessHelper(c, sceneId, user);
}

/**
 * タグをJSONからパース
 */
function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson) return [];
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 割当レスポンスを整形（ライブラリ情報を含む）
 */
async function formatAssignmentWithLibrary(c: any, assignment: any, siteUrl: string): Promise<any> {
  const result: any = {
    id: assignment.id,
    scene_id: assignment.scene_id,
    audio_library_type: assignment.audio_library_type,
    audio_type: assignment.audio_type,
    start_ms: assignment.start_ms,
    end_ms: assignment.end_ms,
    volume_override: assignment.volume_override,
    loop_override: assignment.loop_override !== null ? assignment.loop_override === 1 : null,
    fade_in_ms_override: assignment.fade_in_ms_override,
    fade_out_ms_override: assignment.fade_out_ms_override,
    is_active: assignment.is_active === 1,
    created_at: assignment.created_at,
    updated_at: assignment.updated_at,
  };

  // ライブラリタイプに応じて詳細情報を取得
  if (assignment.audio_library_type === 'system' && assignment.system_audio_id) {
    const systemAudio = await c.env.DB.prepare(`
      SELECT id, audio_type, name, description, category, mood, tags,
             r2_key, r2_url, duration_ms, default_volume, default_loop,
             default_fade_in_ms, default_fade_out_ms
      FROM system_audio_library WHERE id = ?
    `).bind(assignment.system_audio_id).first();
    
    if (systemAudio) {
      result.library = {
        type: 'system',
        id: systemAudio.id,
        name: systemAudio.name,
        description: systemAudio.description,
        category: systemAudio.category,
        mood: systemAudio.mood,
        tags: parseTags(systemAudio.tags),
        r2_url: toAbsoluteUrl(systemAudio.r2_url, siteUrl),
        duration_ms: systemAudio.duration_ms,
        default_volume: systemAudio.default_volume,
        default_loop: systemAudio.default_loop === 1,
        default_fade_in_ms: systemAudio.default_fade_in_ms,
        default_fade_out_ms: systemAudio.default_fade_out_ms,
      };
    }
  } else if (assignment.audio_library_type === 'user' && assignment.user_audio_id) {
    const userAudio = await c.env.DB.prepare(`
      SELECT id, audio_type, name, description, category, mood, tags,
             r2_key, r2_url, duration_ms, default_volume, default_loop,
             default_fade_in_ms, default_fade_out_ms
      FROM user_audio_library WHERE id = ?
    `).bind(assignment.user_audio_id).first();
    
    if (userAudio) {
      result.library = {
        type: 'user',
        id: userAudio.id,
        name: userAudio.name,
        description: userAudio.description,
        category: userAudio.category,
        mood: userAudio.mood,
        tags: parseTags(userAudio.tags),
        r2_url: toAbsoluteUrl(userAudio.r2_url, siteUrl),
        duration_ms: userAudio.duration_ms,
        default_volume: userAudio.default_volume,
        default_loop: userAudio.default_loop === 1,
        default_fade_in_ms: userAudio.default_fade_in_ms,
        default_fade_out_ms: userAudio.default_fade_out_ms,
      };
    }
  } else if (assignment.audio_library_type === 'direct') {
    result.library = {
      type: 'direct',
      name: assignment.direct_name,
      r2_url: toAbsoluteUrl(assignment.direct_r2_url, siteUrl),
      duration_ms: assignment.direct_duration_ms,
      // directは各自設定なのでデフォルト値
      default_volume: 0.5,
      default_loop: false,
      default_fade_in_ms: 0,
      default_fade_out_ms: 0,
    };
  }

  // 最終的な再生パラメータを計算（override > library default）
  result.effective = {
    r2_url: result.library?.r2_url || null,
    name: result.library?.name || 'Unknown',
    duration_ms: result.library?.duration_ms || null,
    volume: result.volume_override ?? result.library?.default_volume ?? 0.5,
    loop: result.loop_override ?? result.library?.default_loop ?? false,
    fade_in_ms: result.fade_in_ms_override ?? result.library?.default_fade_in_ms ?? 0,
    fade_out_ms: result.fade_out_ms_override ?? result.library?.default_fade_out_ms ?? 0,
    start_ms: result.start_ms,
    end_ms: result.end_ms,
  };

  return result;
}

// ====================================================================
// GET /api/scenes/:sceneId/audio-assignments
// ====================================================================
// SSOT: 他のシーンAPIと同様、シーンが存在すればデータを返す
// 認証がある場合は所有者チェックを行い、ない場合はシーン存在チェックのみ
// これにより他のシーン取得API（scenes.ts GET /:id）と一貫した動作になる
sceneAudioAssignments.get('/:sceneId/audio-assignments', async (c) => {
  try {
    const sceneId = parseInt(c.req.param('sceneId'), 10);
    if (!Number.isFinite(sceneId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid scene id' } }, 400);
    }

    // シーン存在確認（認証状態に関係なく）
    const scene = await c.env.DB.prepare(`
      SELECT s.id, s.project_id FROM scenes s WHERE s.id = ?
    `).bind(sceneId).first<{ id: number; project_id: number }>();
    
    if (!scene) {
      console.log(`[SceneAudioAssignments] GET: Scene ${sceneId} not found`);
      return c.json({ error: { code: 'NOT_FOUND', message: 'Scene not found' } }, 404);
    }

    // オプション: 認証がある場合は所有者チェック（将来的な厳密化のため残す）
    const user = await getUserFromSession(c);
    if (user) {
      const access = await validateSceneAccess(c, sceneId, user);
      if (!access.valid && user.role !== 'superadmin') {
        console.log(`[SceneAudioAssignments] GET: User ${user.id} accessing scene ${sceneId} (owner check skipped for GET)`);
        // 読み取りは許可（他のシーンAPIと一貫性を保つ）
      }
    }

    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;
    
    // フィルタパラメータ
    const audioType = c.req.query('audio_type'); // 'bgm' | 'sfx' | undefined
    const includeInactive = c.req.query('include_inactive') === 'true';

    // クエリ構築
    let whereClause = 'scene_id = ?';
    const params: any[] = [sceneId];

    if (!includeInactive) {
      whereClause += ' AND is_active = 1';
    }

    if (audioType && (audioType === 'bgm' || audioType === 'sfx')) {
      whereClause += ' AND audio_type = ?';
      params.push(audioType);
    }

    const { results } = await c.env.DB.prepare(`
      SELECT * FROM scene_audio_assignments
      WHERE ${whereClause}
      ORDER BY audio_type, start_ms
    `).bind(...params).all();

    const items = await Promise.all(
      (results || []).map((item: any) => formatAssignmentWithLibrary(c, item, siteUrl))
    );

    // BGMとSFXを分けて返す
    const bgm = items.filter((item: any) => item.audio_type === 'bgm');
    const sfx = items.filter((item: any) => item.audio_type === 'sfx');

    return c.json({
      scene_id: sceneId,
      bgm: bgm.length > 0 ? bgm[0] : null, // BGMは最大1つ
      sfx,
      total: items.length,
    });
  } catch (error) {
    console.error('[SceneAudioAssignments] GET list error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get audio assignments' } }, 500);
  }
});

// ====================================================================
// POST /api/scenes/:sceneId/audio-assignments
// ====================================================================
sceneAudioAssignments.post('/:sceneId/audio-assignments', async (c) => {
  try {
    const user = await getUserFromSession(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const sceneId = parseInt(c.req.param('sceneId'), 10);
    if (!Number.isFinite(sceneId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid scene id' } }, 400);
    }

    const access = await validateSceneAccess(c, sceneId, user);
    if (!access.valid) {
      return c.json({ error: { code: 'NOT_FOUND', message: access.error } }, 404);
    }

    const body = await c.req.json();
    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;

    // 必須パラメータ
    const audioLibraryType = body.audio_library_type; // 'system' | 'user' | 'direct'
    const audioType = body.audio_type; // 'bgm' | 'sfx'

    if (!audioLibraryType || !['system', 'user', 'direct'].includes(audioLibraryType)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'audio_library_type must be system, user, or direct' } }, 400);
    }
    if (!audioType || !['bgm', 'sfx'].includes(audioType)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'audio_type must be bgm or sfx' } }, 400);
    }

    // ライブラリID確認
    let systemAudioId: number | null = null;
    let userAudioId: number | null = null;
    let directR2Key: string | null = null;
    let directR2Url: string | null = null;
    let directName: string | null = null;
    let directDurationMs: number | null = null;

    if (audioLibraryType === 'system') {
      if (!body.system_audio_id) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: 'system_audio_id required for system type' } }, 400);
      }
      const systemAudio = await c.env.DB.prepare(`
        SELECT id FROM system_audio_library WHERE id = ? AND is_active = 1
      `).bind(body.system_audio_id).first();
      if (!systemAudio) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'System audio not found' } }, 404);
      }
      systemAudioId = body.system_audio_id;
    } else if (audioLibraryType === 'user') {
      if (!body.user_audio_id) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: 'user_audio_id required for user type' } }, 400);
      }
      const userAudio = await c.env.DB.prepare(`
        SELECT id FROM user_audio_library WHERE id = ? AND user_id = ? AND is_active = 1
      `).bind(body.user_audio_id, user.id).first();
      if (!userAudio) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'User audio not found' } }, 404);
      }
      userAudioId = body.user_audio_id;

      // 使用回数をインクリメント
      await c.env.DB.prepare(`
        UPDATE user_audio_library 
        SET use_count = use_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(userAudioId).run();
    } else if (audioLibraryType === 'direct') {
      if (!body.direct_r2_url && !body.direct_r2_key) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: 'direct_r2_url or direct_r2_key required for direct type' } }, 400);
      }
      directR2Key = body.direct_r2_key || null;
      directR2Url = body.direct_r2_url || null;
      directName = body.direct_name || 'Direct Audio';
      directDurationMs = body.direct_duration_ms || null;
    }

    // BGMの場合、既存のactive BGMを無効化
    if (audioType === 'bgm') {
      await c.env.DB.prepare(`
        UPDATE scene_audio_assignments 
        SET is_active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE scene_id = ? AND audio_type = 'bgm' AND is_active = 1
      `).bind(sceneId).run();
      console.log(`[SceneAudioAssignments] Deactivated existing BGM for scene ${sceneId}`);
    }

    // オプショナルパラメータ
    const startMs = body.start_ms ?? 0;
    const endMs = body.end_ms ?? null;
    const volumeOverride = body.volume_override ?? null;
    const loopOverride = body.loop_override !== undefined ? (body.loop_override ? 1 : 0) : null;
    const fadeInMsOverride = body.fade_in_ms_override ?? null;
    const fadeOutMsOverride = body.fade_out_ms_override ?? null;

    // INSERT
    const result = await c.env.DB.prepare(`
      INSERT INTO scene_audio_assignments (
        scene_id, audio_library_type, system_audio_id, user_audio_id,
        direct_r2_key, direct_r2_url, direct_name, direct_duration_ms,
        audio_type, start_ms, end_ms,
        volume_override, loop_override, fade_in_ms_override, fade_out_ms_override,
        is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(
      sceneId, audioLibraryType, systemAudioId, userAudioId,
      directR2Key, directR2Url, directName, directDurationMs,
      audioType, startMs, endMs,
      volumeOverride, loopOverride, fadeInMsOverride, fadeOutMsOverride
    ).run();

    const assignmentId = result.meta.last_row_id;

    // 作成した割当を取得
    const assignment = await c.env.DB.prepare(`
      SELECT * FROM scene_audio_assignments WHERE id = ?
    `).bind(assignmentId).first();

    const formatted = await formatAssignmentWithLibrary(c, assignment, siteUrl);

    console.log(`[SceneAudioAssignments] Created: scene=${sceneId}, type=${audioType}, library=${audioLibraryType}, id=${assignmentId}`);

    return c.json(formatted, 201);
  } catch (error) {
    console.error('[SceneAudioAssignments] POST error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create audio assignment' } }, 500);
  }
});

// ====================================================================
// PUT /api/scenes/:sceneId/audio-assignments/:id
// ====================================================================
sceneAudioAssignments.put('/:sceneId/audio-assignments/:id', async (c) => {
  try {
    const user = await getUserFromSession(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const sceneId = parseInt(c.req.param('sceneId'), 10);
    const assignmentId = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(sceneId) || !Number.isFinite(assignmentId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid id' } }, 400);
    }

    const access = await validateSceneAccess(c, sceneId, user);
    if (!access.valid) {
      return c.json({ error: { code: 'NOT_FOUND', message: access.error } }, 404);
    }

    // 既存レコード確認
    const existing = await c.env.DB.prepare(`
      SELECT id FROM scene_audio_assignments WHERE id = ? AND scene_id = ?
    `).bind(assignmentId, sceneId).first();

    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Assignment not found' } }, 404);
    }

    const body = await c.req.json();
    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;

    // 更新可能フィールドを構築
    const updates: string[] = [];
    const values: any[] = [];

    if (body.start_ms !== undefined) {
      updates.push('start_ms = ?');
      values.push(body.start_ms);
    }
    if (body.end_ms !== undefined) {
      updates.push('end_ms = ?');
      values.push(body.end_ms);
    }
    if (body.volume_override !== undefined) {
      updates.push('volume_override = ?');
      values.push(body.volume_override);
    }
    if (body.loop_override !== undefined) {
      updates.push('loop_override = ?');
      values.push(body.loop_override !== null ? (body.loop_override ? 1 : 0) : null);
    }
    if (body.fade_in_ms_override !== undefined) {
      updates.push('fade_in_ms_override = ?');
      values.push(body.fade_in_ms_override);
    }
    if (body.fade_out_ms_override !== undefined) {
      updates.push('fade_out_ms_override = ?');
      values.push(body.fade_out_ms_override);
    }
    if (body.is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(body.is_active ? 1 : 0);
    }

    if (updates.length === 0) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'No fields to update' } }, 400);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(assignmentId, sceneId);

    await c.env.DB.prepare(`
      UPDATE scene_audio_assignments 
      SET ${updates.join(', ')}
      WHERE id = ? AND scene_id = ?
    `).bind(...values).run();

    // 更新後のレコード取得
    const assignment = await c.env.DB.prepare(`
      SELECT * FROM scene_audio_assignments WHERE id = ?
    `).bind(assignmentId).first();

    const formatted = await formatAssignmentWithLibrary(c, assignment, siteUrl);

    console.log(`[SceneAudioAssignments] Updated: id=${assignmentId}, scene=${sceneId}`);

    return c.json(formatted);
  } catch (error) {
    console.error('[SceneAudioAssignments] PUT error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update audio assignment' } }, 500);
  }
});

// ====================================================================
// DELETE /api/scenes/:sceneId/audio-assignments/:id
// ====================================================================
sceneAudioAssignments.delete('/:sceneId/audio-assignments/:id', async (c) => {
  try {
    const user = await getUserFromSession(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const sceneId = parseInt(c.req.param('sceneId'), 10);
    const assignmentId = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(sceneId) || !Number.isFinite(assignmentId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid id' } }, 400);
    }

    const access = await validateSceneAccess(c, sceneId, user);
    if (!access.valid) {
      return c.json({ error: { code: 'NOT_FOUND', message: access.error } }, 404);
    }

    // 既存レコード確認（R2削除用にdirect情報も取得）
    const existing = await c.env.DB.prepare(`
      SELECT id, audio_library_type, direct_r2_key 
      FROM scene_audio_assignments 
      WHERE id = ? AND scene_id = ?
    `).bind(assignmentId, sceneId).first<{ id: number; audio_library_type: string; direct_r2_key: string | null }>();

    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Assignment not found' } }, 404);
    }

    // directタイプの場合、R2ファイルも削除
    if (existing.audio_library_type === 'direct' && existing.direct_r2_key) {
      try {
        await c.env.R2.delete(existing.direct_r2_key);
        console.log(`[SceneAudioAssignments] R2 file deleted: ${existing.direct_r2_key}`);
      } catch (r2Error) {
        console.warn('[SceneAudioAssignments] Failed to delete R2 file:', r2Error);
      }
    }

    // DBから削除
    await c.env.DB.prepare(`
      DELETE FROM scene_audio_assignments WHERE id = ? AND scene_id = ?
    `).bind(assignmentId, sceneId).run();

    console.log(`[SceneAudioAssignments] Deleted: id=${assignmentId}, scene=${sceneId}`);

    return c.json({ success: true, deleted_id: assignmentId });
  } catch (error) {
    console.error('[SceneAudioAssignments] DELETE error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete audio assignment' } }, 500);
  }
});

// ====================================================================
// POST /api/scenes/:sceneId/audio-assignments/direct
// 直接アップロードして割当（ライブラリに登録せず使い捨て）
// ====================================================================
sceneAudioAssignments.post('/:sceneId/audio-assignments/direct', async (c) => {
  try {
    const user = await getUserFromSession(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const sceneId = parseInt(c.req.param('sceneId'), 10);
    if (!Number.isFinite(sceneId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid scene id' } }, 400);
    }

    const access = await validateSceneAccess(c, sceneId, user);
    if (!access.valid) {
      return c.json({ error: { code: 'NOT_FOUND', message: access.error } }, 404);
    }

    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'No file provided' } }, 400);
    }

    // ファイル形式チェック
    const allowedExtensions = ['.mp3', '.wav', '.m4a', '.ogg', '.aac'];
    const fileName = file.name.toLowerCase();
    const hasValidExtension = allowedExtensions.some(ext => fileName.endsWith(ext));
    
    if (!hasValidExtension) {
      return c.json({ 
        error: { 
          code: 'INVALID_FILE_TYPE', 
          message: `Invalid file type. Allowed: ${allowedExtensions.join(', ')}`
        } 
      }, 400);
    }

    // パラメータ取得
    const audioType = (formData.get('audio_type') as string) || 'sfx';
    if (audioType !== 'bgm' && audioType !== 'sfx') {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'audio_type must be bgm or sfx' } }, 400);
    }

    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;

    // R2にアップロード
    const timestamp = Date.now();
    const ext = fileName.split('.').pop() || 'mp3';
    const r2Key = `audio/scenes/${sceneId}/direct_${timestamp}.${ext}`;
    
    const arrayBuffer = await file.arrayBuffer();
    await c.env.R2.put(r2Key, arrayBuffer, {
      httpMetadata: {
        contentType: file.type || 'audio/mpeg',
      },
    });

    const r2Url = `/${r2Key}`;
    const directName = (formData.get('name') as string) || file.name.replace(/\.[^.]+$/, '');
    const durationMs = formData.get('duration_ms') ? parseInt(formData.get('duration_ms') as string, 10) : null;

    // BGMの場合、既存のactive BGMを無効化
    if (audioType === 'bgm') {
      await c.env.DB.prepare(`
        UPDATE scene_audio_assignments 
        SET is_active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE scene_id = ? AND audio_type = 'bgm' AND is_active = 1
      `).bind(sceneId).run();
    }

    // オプショナルパラメータ
    const startMs = parseInt(formData.get('start_ms') as string || '0', 10);
    const volumeOverride = formData.get('volume_override') ? parseFloat(formData.get('volume_override') as string) : null;
    const loopOverride = formData.get('loop_override') !== undefined 
      ? (formData.get('loop_override') === 'true' || formData.get('loop_override') === '1' ? 1 : 0) 
      : null;

    // INSERT
    const result = await c.env.DB.prepare(`
      INSERT INTO scene_audio_assignments (
        scene_id, audio_library_type,
        direct_r2_key, direct_r2_url, direct_name, direct_duration_ms,
        audio_type, start_ms, volume_override, loop_override,
        is_active
      ) VALUES (?, 'direct', ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(
      sceneId, r2Key, r2Url, directName, durationMs,
      audioType, startMs, volumeOverride, loopOverride
    ).run();

    const assignmentId = result.meta.last_row_id;

    // 作成した割当を取得
    const assignment = await c.env.DB.prepare(`
      SELECT * FROM scene_audio_assignments WHERE id = ?
    `).bind(assignmentId).first();

    const formatted = await formatAssignmentWithLibrary(c, assignment, siteUrl);

    console.log(`[SceneAudioAssignments] Direct upload: scene=${sceneId}, type=${audioType}, id=${assignmentId}, file=${r2Key}`);

    return c.json(formatted, 201);
  } catch (error) {
    console.error('[SceneAudioAssignments] Direct upload error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to upload audio' } }, 500);
  }
});

// ====================================================================
// POST /api/scenes/:sceneId/audio-assignments/upload
// /direct のエイリアス（互換性のため）
// ====================================================================
sceneAudioAssignments.post('/:sceneId/audio-assignments/upload', async (c) => {
  try {
    const user = await getUserFromSession(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const sceneId = parseInt(c.req.param('sceneId'), 10);
    if (!Number.isFinite(sceneId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid scene id' } }, 400);
    }

    const access = await validateSceneAccess(c, sceneId, user);
    if (!access.valid) {
      return c.json({ error: { code: 'NOT_FOUND', message: access.error } }, 404);
    }

    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'No file provided' } }, 400);
    }

    // ファイル形式チェック
    const allowedExtensions = ['.mp3', '.wav', '.m4a', '.ogg', '.aac'];
    const fileName = file.name.toLowerCase();
    const hasValidExtension = allowedExtensions.some(ext => fileName.endsWith(ext));
    
    if (!hasValidExtension) {
      return c.json({ 
        error: { 
          code: 'INVALID_FILE_TYPE', 
          message: `Invalid file type. Allowed: ${allowedExtensions.join(', ')}`
        } 
      }, 400);
    }

    // パラメータ取得
    const audioType = (formData.get('audio_type') as string) || 'bgm';
    if (audioType !== 'bgm' && audioType !== 'sfx') {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'audio_type must be bgm or sfx' } }, 400);
    }

    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;

    // R2にアップロード
    const timestamp = Date.now();
    const ext = fileName.split('.').pop() || 'mp3';
    const r2Key = `audio/scenes/${sceneId}/upload_${timestamp}.${ext}`;
    
    const arrayBuffer = await file.arrayBuffer();
    await c.env.R2.put(r2Key, arrayBuffer, {
      httpMetadata: {
        contentType: file.type || 'audio/mpeg',
      },
    });

    const r2Url = `/${r2Key}`;
    const directName = (formData.get('name') as string) || file.name.replace(/\.[^.]+$/, '');
    const durationMs = formData.get('duration_ms') ? parseInt(formData.get('duration_ms') as string, 10) : null;

    // BGMの場合、既存のactive BGMを無効化
    if (audioType === 'bgm') {
      await c.env.DB.prepare(`
        UPDATE scene_audio_assignments 
        SET is_active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE scene_id = ? AND audio_type = 'bgm' AND is_active = 1
      `).bind(sceneId).run();
    }

    // オプショナルパラメータ
    const startMs = parseInt(formData.get('start_ms') as string || '0', 10);
    const volumeOverride = formData.get('volume') ? parseFloat(formData.get('volume') as string) : 
                          formData.get('volume_override') ? parseFloat(formData.get('volume_override') as string) : null;
    const loopOverride = formData.get('loop') !== undefined 
      ? (formData.get('loop') === 'true' || formData.get('loop') === '1' ? 1 : 0) 
      : formData.get('loop_override') !== undefined
        ? (formData.get('loop_override') === 'true' || formData.get('loop_override') === '1' ? 1 : 0)
        : null;

    // INSERT
    const result = await c.env.DB.prepare(`
      INSERT INTO scene_audio_assignments (
        scene_id, audio_library_type,
        direct_r2_key, direct_r2_url, direct_name, direct_duration_ms,
        audio_type, start_ms, volume_override, loop_override,
        is_active
      ) VALUES (?, 'direct', ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(
      sceneId, r2Key, r2Url, directName, durationMs,
      audioType, startMs, volumeOverride, loopOverride
    ).run();

    const assignmentId = result.meta.last_row_id;

    // 作成した割当を取得
    const assignment = await c.env.DB.prepare(`
      SELECT * FROM scene_audio_assignments WHERE id = ?
    `).bind(assignmentId).first();

    const formatted = await formatAssignmentWithLibrary(c, assignment, siteUrl);

    console.log(`[SceneAudioAssignments] Upload: scene=${sceneId}, type=${audioType}, id=${assignmentId}, file=${r2Key}`);

    return c.json(formatted, 201);
  } catch (error) {
    console.error('[SceneAudioAssignments] Upload error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to upload audio' } }, 500);
  }
});

// ====================================================================
// POST /api/scenes/:sceneId/audio-assignments/deactivate-all
// 全ての音割当を無効化（BGMクリア等に使用）
// ====================================================================
sceneAudioAssignments.post('/:sceneId/audio-assignments/deactivate-all', async (c) => {
  try {
    const user = await getUserFromSession(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const sceneId = parseInt(c.req.param('sceneId'), 10);
    if (!Number.isFinite(sceneId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid scene id' } }, 400);
    }

    const access = await validateSceneAccess(c, sceneId, user);
    if (!access.valid) {
      return c.json({ error: { code: 'NOT_FOUND', message: access.error } }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const audioType = body.audio_type; // 'bgm' | 'sfx' | undefined (all)

    let whereClause = 'scene_id = ? AND is_active = 1';
    const params: any[] = [sceneId];

    if (audioType && (audioType === 'bgm' || audioType === 'sfx')) {
      whereClause += ' AND audio_type = ?';
      params.push(audioType);
    }

    const result = await c.env.DB.prepare(`
      UPDATE scene_audio_assignments 
      SET is_active = 0, updated_at = CURRENT_TIMESTAMP
      WHERE ${whereClause}
    `).bind(...params).run();

    console.log(`[SceneAudioAssignments] Deactivated: scene=${sceneId}, type=${audioType || 'all'}, count=${result.meta.changes}`);

    return c.json({ 
      success: true, 
      deactivated_count: result.meta.changes,
      audio_type: audioType || 'all',
    });
  } catch (error) {
    console.error('[SceneAudioAssignments] Deactivate error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to deactivate audio assignments' } }, 500);
  }
});

export { sceneAudioAssignments };
