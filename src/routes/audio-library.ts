/**
 * P1: User Audio Library API
 * 
 * ユーザーがアップロードしたBGM/SFXをプロジェクト横断で再利用するためのAPI
 * 
 * 設計思想（Audio SSOT）:
 * - system_audio_library: 管理者が登録したシステム音素材
 * - user_audio_library: ユーザーが登録した個人音素材 ← このAPI
 * - scene_audio_assignments: シーンへの割当（P2で実装）
 * 
 * エンドポイント:
 * - GET    /api/audio-library              - ユーザーの音素材一覧取得
 * - GET    /api/audio-library/:id          - 単一音素材取得
 * - POST   /api/audio-library/upload       - 音素材アップロード
 * - PUT    /api/audio-library/:id          - 音素材メタデータ更新
 * - DELETE /api/audio-library/:id          - 音素材削除
 * 
 * クエリパラメータ:
 * - type: 'bgm' | 'sfx' | undefined (all)
 * - category: string (フィルタ)
 * - mood: string (フィルタ)
 * - search: string (名前・タグ検索)
 * - limit: number (default 50)
 * - offset: number (default 0)
 * - sort: 'recent' | 'popular' | 'name' (default 'recent')
 */

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';

interface Bindings {
  DB: D1Database;
  R2: R2Bucket;
  SITE_URL?: string;
}

const audioLibrary = new Hono<{ Bindings: Bindings }>();

const DEFAULT_SITE_URL = 'https://app.marumuviai.com';

// ====================================================================
// Helper Functions
// ====================================================================

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
 * セッションからユーザーIDを取得
 */
async function getUserIdFromSession(c: any): Promise<number | null> {
  try {
    const sessionId = getCookie(c, 'session');
    if (!sessionId) {
      console.log('[AudioLibrary] No session cookie');
      return null;
    }
    
    const session = await c.env.DB.prepare(`
      SELECT user_id FROM sessions 
      WHERE id = ? AND expires_at > datetime('now')
    `).bind(sessionId).first<{ user_id: number }>();
    
    if (!session) {
      console.log('[AudioLibrary] Session not found or expired');
      return null;
    }
    
    return session.user_id;
  } catch (error) {
    console.error('[AudioLibrary] Session lookup error:', error);
    return null;
  }
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
 * 音素材レスポンスを整形
 */
function formatAudioItem(item: any, siteUrl: string) {
  return {
    id: item.id,
    user_id: item.user_id,
    audio_type: item.audio_type,
    name: item.name,
    description: item.description,
    category: item.category,
    mood: item.mood,
    tags: parseTags(item.tags),
    r2_url: toAbsoluteUrl(item.r2_url, siteUrl),
    r2_key: item.r2_key,
    duration_ms: item.duration_ms,
    file_size: item.file_size,
    default_volume: item.default_volume,
    default_loop: item.default_loop === 1,
    default_fade_in_ms: item.default_fade_in_ms,
    default_fade_out_ms: item.default_fade_out_ms,
    is_active: item.is_active === 1,
    use_count: item.use_count,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

// ====================================================================
// GET /api/audio-library
// ====================================================================
audioLibrary.get('/audio-library', async (c) => {
  try {
    const userId = await getUserIdFromSession(c);
    if (!userId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;
    
    // クエリパラメータ取得
    const type = c.req.query('type'); // 'bgm' | 'sfx' | undefined
    const category = c.req.query('category');
    const mood = c.req.query('mood');
    const search = c.req.query('search');
    const limit = Math.min(100, parseInt(c.req.query('limit') || '50', 10));
    const offset = parseInt(c.req.query('offset') || '0', 10);
    const sort = c.req.query('sort') || 'recent'; // 'recent' | 'popular' | 'name'

    // クエリ構築
    let whereClause = 'user_id = ? AND is_active = 1';
    const params: any[] = [userId];

    if (type && (type === 'bgm' || type === 'sfx')) {
      whereClause += ' AND audio_type = ?';
      params.push(type);
    }

    if (category) {
      whereClause += ' AND category = ?';
      params.push(category);
    }

    if (mood) {
      whereClause += ' AND mood = ?';
      params.push(mood);
    }

    if (search) {
      // 名前またはタグで検索
      whereClause += ' AND (name LIKE ? OR tags LIKE ?)';
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern);
    }

    // ソート順
    let orderBy: string;
    switch (sort) {
      case 'popular':
        orderBy = 'use_count DESC, updated_at DESC';
        break;
      case 'name':
        orderBy = 'name ASC, created_at DESC';
        break;
      case 'recent':
      default:
        orderBy = 'updated_at DESC, created_at DESC';
        break;
    }

    // 総件数取得
    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total FROM user_audio_library WHERE ${whereClause}
    `).bind(...params).first<{ total: number }>();
    const total = countResult?.total || 0;

    // データ取得
    params.push(limit, offset);
    const { results } = await c.env.DB.prepare(`
      SELECT 
        id, user_id, audio_type, name, description,
        category, mood, tags,
        r2_key, r2_url, duration_ms, file_size,
        default_volume, default_loop, default_fade_in_ms, default_fade_out_ms,
        is_active, use_count, created_at, updated_at
      FROM user_audio_library
      WHERE ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).bind(...params).all();

    const items = (results || []).map((item: any) => formatAudioItem(item, siteUrl));

    // カテゴリ・ムードの選択肢を取得（AI提案用）
    const categoriesResult = await c.env.DB.prepare(`
      SELECT DISTINCT category FROM user_audio_library 
      WHERE user_id = ? AND is_active = 1 AND category IS NOT NULL
      ORDER BY category
    `).bind(userId).all();

    const moodsResult = await c.env.DB.prepare(`
      SELECT DISTINCT mood FROM user_audio_library 
      WHERE user_id = ? AND is_active = 1 AND mood IS NOT NULL
      ORDER BY mood
    `).bind(userId).all();

    return c.json({
      items,
      pagination: {
        total,
        limit,
        offset,
        has_more: offset + items.length < total,
      },
      filters: {
        categories: (categoriesResult.results || []).map((r: any) => r.category),
        moods: (moodsResult.results || []).map((r: any) => r.mood),
      },
      meta: {
        type_filter: type || null,
        sort,
      }
    });
  } catch (error) {
    console.error('[AudioLibrary] GET list error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get audio library' } }, 500);
  }
});

// ====================================================================
// GET /api/audio-library/system - システムライブラリ（管理者登録）一覧
// SceneEditModalのBGMタブで呼び出される
// ====================================================================
audioLibrary.get('/audio-library/system', async (c) => {
  try {
    const userId = await getUserIdFromSession(c);
    if (!userId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;
    
    // クエリパラメータ取得
    const category = c.req.query('category'); // 'bgm' | 'sfx' (audio_type)
    const mood = c.req.query('mood');
    const search = c.req.query('search');
    const limit = Math.min(100, parseInt(c.req.query('limit') || '50', 10));
    const offset = parseInt(c.req.query('offset') || '0', 10);

    // クエリ構築
    let whereClause = 'is_active = 1';
    const params: any[] = [];

    // categoryはaudio_typeとして扱う（bgm/sfx）
    if (category && (category === 'bgm' || category === 'sfx')) {
      whereClause += ' AND audio_type = ?';
      params.push(category);
    }

    if (mood) {
      whereClause += ' AND mood = ?';
      params.push(mood);
    }

    if (search) {
      whereClause += ' AND (name LIKE ? OR tags LIKE ?)';
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern);
    }

    // 総件数取得
    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total FROM system_audio_library WHERE ${whereClause}
    `).bind(...params).first<{ total: number }>();
    const total = countResult?.total || 0;

    // データ取得
    params.push(limit, offset);
    const { results } = await c.env.DB.prepare(`
      SELECT 
        id, audio_type, name, description,
        category, mood, tags,
        file_url, duration_ms, file_size,
        source, is_active, sort_order,
        created_at, updated_at
      FROM system_audio_library
      WHERE ${whereClause}
      ORDER BY sort_order ASC, created_at DESC
      LIMIT ? OFFSET ?
    `).bind(...params).all();

    // レスポンス整形（file_urlをr2_urlとして返す）
    const items = (results || []).map((item: any) => ({
      id: item.id,
      audio_type: item.audio_type,
      name: item.name,
      description: item.description,
      category: item.category,
      mood: item.mood,
      tags: parseTags(item.tags),
      r2_url: toAbsoluteUrl(item.file_url, siteUrl), // file_url → r2_url
      duration_ms: item.duration_ms,
      duration_sec: item.duration_ms ? item.duration_ms / 1000 : null,
      file_size: item.file_size,
      source: 'system',
      is_active: item.is_active === 1,
      created_at: item.created_at,
      updated_at: item.updated_at,
    }));

    return c.json({
      items,
      pagination: {
        total,
        limit,
        offset,
        has_more: offset + items.length < total,
      },
      source: 'system',
    });
  } catch (error) {
    console.error('[AudioLibrary] GET system list error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get system audio library' } }, 500);
  }
});

// ====================================================================
// GET /api/audio-library/user - ユーザーライブラリ（個人音素材）一覧
// SceneEditModalのBGMタブで呼び出される
// ====================================================================
audioLibrary.get('/audio-library/user', async (c) => {
  try {
    const userId = await getUserIdFromSession(c);
    if (!userId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;
    
    // クエリパラメータ取得
    const category = c.req.query('category'); // 'bgm' | 'sfx' (audio_type)
    const mood = c.req.query('mood');
    const search = c.req.query('search');
    const limit = Math.min(100, parseInt(c.req.query('limit') || '50', 10));
    const offset = parseInt(c.req.query('offset') || '0', 10);

    // クエリ構築
    let whereClause = 'user_id = ? AND is_active = 1';
    const params: any[] = [userId];

    // categoryはaudio_typeとして扱う（bgm/sfx）
    if (category && (category === 'bgm' || category === 'sfx')) {
      whereClause += ' AND audio_type = ?';
      params.push(category);
    }

    if (mood) {
      whereClause += ' AND mood = ?';
      params.push(mood);
    }

    if (search) {
      whereClause += ' AND (name LIKE ? OR tags LIKE ?)';
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern);
    }

    // 総件数取得
    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total FROM user_audio_library WHERE ${whereClause}
    `).bind(...params).first<{ total: number }>();
    const total = countResult?.total || 0;

    // データ取得
    params.push(limit, offset);
    const { results } = await c.env.DB.prepare(`
      SELECT 
        id, user_id, audio_type, name, description,
        category, mood, tags,
        r2_key, r2_url, duration_ms, file_size,
        default_volume, default_loop, default_fade_in_ms, default_fade_out_ms,
        is_active, use_count, created_at, updated_at
      FROM user_audio_library
      WHERE ${whereClause}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ? OFFSET ?
    `).bind(...params).all();

    // レスポンス整形
    const items = (results || []).map((item: any) => ({
      id: item.id,
      audio_type: item.audio_type,
      name: item.name,
      description: item.description,
      category: item.category,
      mood: item.mood,
      tags: parseTags(item.tags),
      r2_url: toAbsoluteUrl(item.r2_url, siteUrl),
      duration_ms: item.duration_ms,
      duration_sec: item.duration_ms ? item.duration_ms / 1000 : null,
      file_size: item.file_size,
      default_volume: item.default_volume,
      default_loop: item.default_loop === 1,
      source: 'user',
      is_active: item.is_active === 1,
      use_count: item.use_count,
      created_at: item.created_at,
      updated_at: item.updated_at,
    }));

    return c.json({
      items,
      pagination: {
        total,
        limit,
        offset,
        has_more: offset + items.length < total,
      },
      source: 'user',
    });
  } catch (error) {
    console.error('[AudioLibrary] GET user list error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get user audio library' } }, 500);
  }
});

// ====================================================================
// GET /api/audio-library/:id
// ====================================================================
audioLibrary.get('/audio-library/:id', async (c) => {
  try {
    const userId = await getUserIdFromSession(c);
    if (!userId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid audio id' } }, 400);
    }

    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;

    const item = await c.env.DB.prepare(`
      SELECT 
        id, user_id, audio_type, name, description,
        category, mood, tags,
        r2_key, r2_url, duration_ms, file_size,
        default_volume, default_loop, default_fade_in_ms, default_fade_out_ms,
        is_active, use_count, created_at, updated_at
      FROM user_audio_library
      WHERE id = ? AND user_id = ?
    `).bind(id, userId).first();

    if (!item) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Audio not found' } }, 404);
    }

    return c.json(formatAudioItem(item, siteUrl));
  } catch (error) {
    console.error('[AudioLibrary] GET single error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get audio' } }, 500);
  }
});

// ====================================================================
// POST /api/audio-library/upload
// ====================================================================
audioLibrary.post('/audio-library/upload', async (c) => {
  try {
    const userId = await getUserIdFromSession(c);
    if (!userId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'No file provided' } }, 400);
    }

    // ファイル形式チェック
    const allowedTypes = ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'audio/ogg', 'audio/aac'];
    const allowedExtensions = ['.mp3', '.wav', '.m4a', '.ogg', '.aac'];
    const fileName = file.name.toLowerCase();
    const hasValidExtension = allowedExtensions.some(ext => fileName.endsWith(ext));
    
    if (!allowedTypes.includes(file.type) && !hasValidExtension) {
      return c.json({ 
        error: { 
          code: 'INVALID_FILE_TYPE', 
          message: `Invalid file type. Allowed: ${allowedExtensions.join(', ')}`
        } 
      }, 400);
    }

    // ファイルサイズチェック（50MB制限）
    const maxSize = 50 * 1024 * 1024;
    if (file.size > maxSize) {
      return c.json({ 
        error: { 
          code: 'FILE_TOO_LARGE', 
          message: 'File size exceeds 50MB limit'
        } 
      }, 400);
    }

    // パラメータ取得
    const audioType = (formData.get('audio_type') as string) || 'bgm';
    if (audioType !== 'bgm' && audioType !== 'sfx') {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'audio_type must be bgm or sfx' } }, 400);
    }

    const name = (formData.get('name') as string) || file.name.replace(/\.[^.]+$/, '');
    const description = formData.get('description') as string | null;
    const category = formData.get('category') as string | null;
    const mood = formData.get('mood') as string | null;
    
    // タグ処理
    let tags: string | null = null;
    const tagsParam = formData.get('tags');
    if (tagsParam) {
      try {
        // JSON配列として検証
        const parsed = JSON.parse(tagsParam as string);
        if (Array.isArray(parsed)) {
          tags = JSON.stringify(parsed);
        }
      } catch {
        // カンマ区切りとして処理
        const tagArray = (tagsParam as string).split(',').map(t => t.trim()).filter(t => t);
        tags = tagArray.length > 0 ? JSON.stringify(tagArray) : null;
      }
    }

    const defaultVolume = Math.max(0, Math.min(1, parseFloat(formData.get('default_volume') as string || '0.25')));
    const defaultLoop = formData.get('default_loop') === '1' || formData.get('default_loop') === 'true' ? 1 : 0;
    const defaultFadeInMs = parseInt(formData.get('default_fade_in_ms') as string || '0', 10);
    const defaultFadeOutMs = parseInt(formData.get('default_fade_out_ms') as string || '0', 10);
    const durationMs = formData.get('duration_ms') ? parseInt(formData.get('duration_ms') as string, 10) : null;

    // R2にアップロード
    const timestamp = Date.now();
    const ext = fileName.split('.').pop() || 'mp3';
    const r2Key = `audio/library/user_${userId}/${audioType}/${timestamp}.${ext}`;
    
    const arrayBuffer = await file.arrayBuffer();
    await c.env.R2.put(r2Key, arrayBuffer, {
      httpMetadata: {
        contentType: file.type || 'audio/mpeg',
      },
    });

    const r2Url = `/${r2Key}`;
    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;

    // DBに保存
    const result = await c.env.DB.prepare(`
      INSERT INTO user_audio_library (
        user_id, audio_type, name, description,
        category, mood, tags,
        r2_key, r2_url, duration_ms, file_size,
        default_volume, default_loop, default_fade_in_ms, default_fade_out_ms,
        is_active, use_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
    `).bind(
      userId, audioType, name, description,
      category, mood, tags,
      r2Key, r2Url, durationMs, arrayBuffer.byteLength,
      defaultVolume, defaultLoop, defaultFadeInMs, defaultFadeOutMs
    ).run();

    const audioId = result.meta.last_row_id;

    // 作成したレコードを取得
    const item = await c.env.DB.prepare(`
      SELECT * FROM user_audio_library WHERE id = ?
    `).bind(audioId).first();

    console.log(`[AudioLibrary] Upload success: user=${userId}, type=${audioType}, id=${audioId}, file=${r2Key}`);

    return c.json(formatAudioItem(item, siteUrl), 201);
  } catch (error) {
    console.error('[AudioLibrary] Upload error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to upload audio' } }, 500);
  }
});

// ====================================================================
// PUT /api/audio-library/:id
// ====================================================================
audioLibrary.put('/audio-library/:id', async (c) => {
  try {
    const userId = await getUserIdFromSession(c);
    if (!userId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid audio id' } }, 400);
    }

    // 既存レコード確認
    const existing = await c.env.DB.prepare(`
      SELECT id FROM user_audio_library WHERE id = ? AND user_id = ?
    `).bind(id, userId).first();

    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Audio not found' } }, 404);
    }

    const body = await c.req.json();
    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;

    // 更新可能フィールドを構築
    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      values.push(body.description);
    }
    if (body.category !== undefined) {
      updates.push('category = ?');
      values.push(body.category);
    }
    if (body.mood !== undefined) {
      updates.push('mood = ?');
      values.push(body.mood);
    }
    if (body.tags !== undefined) {
      updates.push('tags = ?');
      if (Array.isArray(body.tags)) {
        values.push(JSON.stringify(body.tags));
      } else {
        values.push(body.tags ? JSON.stringify(body.tags.split(',').map((t: string) => t.trim())) : null);
      }
    }
    if (body.default_volume !== undefined) {
      updates.push('default_volume = ?');
      values.push(Math.max(0, Math.min(1, parseFloat(body.default_volume))));
    }
    if (body.default_loop !== undefined) {
      updates.push('default_loop = ?');
      values.push(body.default_loop ? 1 : 0);
    }
    if (body.default_fade_in_ms !== undefined) {
      updates.push('default_fade_in_ms = ?');
      values.push(Math.max(0, parseInt(body.default_fade_in_ms, 10)));
    }
    if (body.default_fade_out_ms !== undefined) {
      updates.push('default_fade_out_ms = ?');
      values.push(Math.max(0, parseInt(body.default_fade_out_ms, 10)));
    }
    if (body.duration_ms !== undefined) {
      updates.push('duration_ms = ?');
      values.push(body.duration_ms ? parseInt(body.duration_ms, 10) : null);
    }
    if (body.is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(body.is_active ? 1 : 0);
    }

    if (updates.length === 0) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'No fields to update' } }, 400);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id, userId);

    await c.env.DB.prepare(`
      UPDATE user_audio_library 
      SET ${updates.join(', ')}
      WHERE id = ? AND user_id = ?
    `).bind(...values).run();

    // 更新後のレコード取得
    const item = await c.env.DB.prepare(`
      SELECT * FROM user_audio_library WHERE id = ?
    `).bind(id).first();

    console.log(`[AudioLibrary] Update success: user=${userId}, id=${id}`);

    return c.json(formatAudioItem(item, siteUrl));
  } catch (error) {
    console.error('[AudioLibrary] Update error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update audio' } }, 500);
  }
});

// ====================================================================
// DELETE /api/audio-library/:id
// ====================================================================
audioLibrary.delete('/audio-library/:id', async (c) => {
  try {
    const userId = await getUserIdFromSession(c);
    if (!userId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid audio id' } }, 400);
    }

    // 既存レコード確認（R2削除用にr2_keyも取得）
    const existing = await c.env.DB.prepare(`
      SELECT id, r2_key FROM user_audio_library WHERE id = ? AND user_id = ?
    `).bind(id, userId).first<{ id: number; r2_key: string | null }>();

    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Audio not found' } }, 404);
    }

    // R2からファイル削除
    if (existing.r2_key) {
      try {
        await c.env.R2.delete(existing.r2_key);
        console.log(`[AudioLibrary] R2 file deleted: ${existing.r2_key}`);
      } catch (r2Error) {
        console.warn('[AudioLibrary] Failed to delete R2 file:', r2Error);
      }
    }

    // DBから削除
    await c.env.DB.prepare(`
      DELETE FROM user_audio_library WHERE id = ? AND user_id = ?
    `).bind(id, userId).run();

    console.log(`[AudioLibrary] Delete success: user=${userId}, id=${id}`);

    return c.json({ success: true, deleted_id: id });
  } catch (error) {
    console.error('[AudioLibrary] Delete error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete audio' } }, 500);
  }
});

// ====================================================================
// POST /api/audio-library/:id/increment-use
// 使用回数をインクリメント（scene_audio_assignmentsで参照時に呼ぶ）
// ====================================================================
audioLibrary.post('/audio-library/:id/increment-use', async (c) => {
  try {
    const userId = await getUserIdFromSession(c);
    if (!userId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid audio id' } }, 400);
    }

    // 所有確認 & 使用回数インクリメント
    const result = await c.env.DB.prepare(`
      UPDATE user_audio_library 
      SET use_count = use_count + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).bind(id, userId).run();

    if (result.meta.changes === 0) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Audio not found' } }, 404);
    }

    // 更新後の use_count を取得
    const item = await c.env.DB.prepare(`
      SELECT use_count FROM user_audio_library WHERE id = ?
    `).bind(id).first<{ use_count: number }>();

    return c.json({ success: true, use_count: item?.use_count || 0 });
  } catch (error) {
    console.error('[AudioLibrary] Increment use error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to increment use count' } }, 500);
  }
});

export { audioLibrary };
