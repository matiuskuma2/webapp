/**
 * Scene Balloons API - A案 baked 対応
 * 
 * 目的: 文字入りバブル画像のアップロード・管理
 * 
 * A案 baked の定義（固定）:
 *   - 漫画制作で「文字入りバブルPNG」を作成
 *   - Remotion は bubble_r2_url の画像を utterance 時間窓で ON/OFF
 *   - Remotion で文字を「描かない」（テキストレンダリングなし）
 *   - 見た目は漫画制作側で 100% 確定（SSOT）
 */

import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  R2: R2Bucket;
};

const sceneBalloons = new Hono<{ Bindings: Bindings }>();

// ====================================================================
// GET /api/scene-balloons/:balloonId - バルーン情報取得
// ====================================================================
sceneBalloons.get('/:balloonId', async (c) => {
  const balloonId = parseInt(c.req.param('balloonId'));
  
  if (!Number.isFinite(balloonId)) {
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid balloon id' } }, 400);
  }
  
  try {
    const balloon = await c.env.DB.prepare(`
      SELECT 
        sb.*,
        su.text as utterance_text,
        su.speaker_type,
        su.character_key,
        ag.start_ms as audio_start_ms,
        ag.end_ms as audio_end_ms
      FROM scene_balloons sb
      LEFT JOIN scene_utterances su ON sb.utterance_id = su.id
      LEFT JOIN audio_generations ag ON su.audio_generation_id = ag.id AND ag.status = 'completed'
      WHERE sb.id = ?
    `).bind(balloonId).first();
    
    if (!balloon) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Balloon not found' } }, 404);
    }
    
    return c.json({ balloon });
  } catch (error) {
    console.error('[SceneBalloons] Get error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get balloon' } }, 500);
  }
});

// ====================================================================
// GET /api/scene-balloons/scene/:sceneId - シーンのバルーン一覧取得
// ====================================================================
sceneBalloons.get('/scene/:sceneId', async (c) => {
  const sceneId = parseInt(c.req.param('sceneId'));
  
  if (!Number.isFinite(sceneId)) {
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid scene id' } }, 400);
  }
  
  try {
    const result = await c.env.DB.prepare(`
      SELECT 
        sb.*,
        su.text as utterance_text,
        su.speaker_type,
        su.character_key,
        ag.start_ms as audio_start_ms,
        ag.end_ms as audio_end_ms,
        ag.status as audio_status
      FROM scene_balloons sb
      LEFT JOIN scene_utterances su ON sb.utterance_id = su.id
      LEFT JOIN audio_generations ag ON su.audio_generation_id = ag.id
      WHERE sb.scene_id = ?
      ORDER BY sb.z_index ASC, sb.id ASC
    `).bind(sceneId).all();
    
    return c.json({ balloons: result.results || [] });
  } catch (error) {
    console.error('[SceneBalloons] List error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list balloons' } }, 500);
  }
});

// ====================================================================
// POST /api/scene-balloons/:balloonId/upload-image - バブル画像アップロード
// ====================================================================
// 
// A案 baked の核心部分:
//   - 文字入りバブルPNGをR2に保存
//   - scene_balloons.bubble_r2_url を更新
//   - Remotion はこの画像を utterance 時間窓で表示
//
// リクエスト: multipart/form-data
//   - image: PNG/WebP ファイル（文字入りバブル画像）
//
// R2キー命名規則:
//   projects/{projectId}/balloons/{balloonId}/v{version}.png
//
sceneBalloons.post('/:balloonId/upload-image', async (c) => {
  const balloonId = parseInt(c.req.param('balloonId'));
  
  if (!Number.isFinite(balloonId)) {
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid balloon id' } }, 400);
  }
  
  try {
    // 1. バルーン存在確認 + プロジェクトID取得
    const balloon = await c.env.DB.prepare(`
      SELECT sb.*, s.project_id
      FROM scene_balloons sb
      JOIN scenes s ON sb.scene_id = s.id
      WHERE sb.id = ?
    `).bind(balloonId).first<{
      id: number;
      scene_id: number;
      project_id: number;
      bubble_source_version: number;
    }>();
    
    if (!balloon) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Balloon not found' } }, 404);
    }
    
    // 2. multipart/form-data から画像取得
    const formData = await c.req.formData();
    const imageFile = formData.get('image') as File | null;
    
    if (!imageFile) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'No image file provided' } }, 400);
    }
    
    // 3. ファイル形式チェック（PNG/WebP のみ許可）
    const allowedTypes = ['image/png', 'image/webp'];
    if (!allowedTypes.includes(imageFile.type)) {
      return c.json({ 
        error: { 
          code: 'INVALID_FILE_TYPE', 
          message: 'Only PNG and WebP images are allowed for bubble images' 
        } 
      }, 400);
    }
    
    // 4. 画像サイズ取得（基本的なバリデーション）
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (imageFile.size > maxSize) {
      return c.json({ 
        error: { 
          code: 'FILE_TOO_LARGE', 
          message: 'Image file must be less than 5MB' 
        } 
      }, 400);
    }
    
    // 5. バージョン番号インクリメント
    const newVersion = (balloon.bubble_source_version || 0) + 1;
    
    // 6. R2キー生成
    const extension = imageFile.type === 'image/webp' ? 'webp' : 'png';
    const r2Key = `projects/${balloon.project_id}/balloons/${balloonId}/v${newVersion}.${extension}`;
    
    // 7. R2に保存
    const imageBuffer = await imageFile.arrayBuffer();
    await c.env.R2.put(r2Key, imageBuffer, {
      httpMetadata: {
        contentType: imageFile.type,
      },
    });
    
    // 8. R2 URL生成（相対パス）
    const r2Url = `/${r2Key}`;
    
    // 9. DB更新
    // 注意: 画像サイズ（width/height）は別途取得が必要（ここでは省略）
    await c.env.DB.prepare(`
      UPDATE scene_balloons
      SET 
        bubble_r2_key = ?,
        bubble_r2_url = ?,
        bubble_source_version = ?,
        bubble_updated_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(r2Key, r2Url, newVersion, balloonId).run();
    
    console.log(`[SceneBalloons] Uploaded bubble image: balloon=${balloonId}, key=${r2Key}`);
    
    return c.json({
      success: true,
      balloon_id: balloonId,
      bubble_r2_key: r2Key,
      bubble_r2_url: r2Url,
      bubble_source_version: newVersion,
    });
    
  } catch (error) {
    console.error('[SceneBalloons] Upload error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to upload image' } }, 500);
  }
});

// ====================================================================
// DELETE /api/scene-balloons/:balloonId/image - バブル画像削除
// ====================================================================
sceneBalloons.delete('/:balloonId/image', async (c) => {
  const balloonId = parseInt(c.req.param('balloonId'));
  
  if (!Number.isFinite(balloonId)) {
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid balloon id' } }, 400);
  }
  
  try {
    // 1. バルーン取得
    const balloon = await c.env.DB.prepare(`
      SELECT bubble_r2_key FROM scene_balloons WHERE id = ?
    `).bind(balloonId).first<{ bubble_r2_key: string | null }>();
    
    if (!balloon) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Balloon not found' } }, 404);
    }
    
    // 2. R2から削除（存在する場合）
    if (balloon.bubble_r2_key) {
      try {
        await c.env.R2.delete(balloon.bubble_r2_key);
        console.log(`[SceneBalloons] Deleted R2 object: ${balloon.bubble_r2_key}`);
      } catch (r2Error) {
        console.warn('[SceneBalloons] R2 delete failed (may not exist):', r2Error);
      }
    }
    
    // 3. DB更新（画像参照をクリア）
    await c.env.DB.prepare(`
      UPDATE scene_balloons
      SET 
        bubble_r2_key = NULL,
        bubble_r2_url = NULL,
        bubble_width_px = NULL,
        bubble_height_px = NULL,
        bubble_updated_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(balloonId).run();
    
    return c.json({ success: true, balloon_id: balloonId });
    
  } catch (error) {
    console.error('[SceneBalloons] Delete image error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete image' } }, 500);
  }
});

// ====================================================================
// PUT /api/scene-balloons/:balloonId - バルーン情報更新（位置・サイズ等）
// ====================================================================
sceneBalloons.put('/:balloonId', async (c) => {
  const balloonId = parseInt(c.req.param('balloonId'));
  
  if (!Number.isFinite(balloonId)) {
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid balloon id' } }, 400);
  }
  
  try {
    const body = await c.req.json();
    
    // 更新可能フィールド
    const allowedFields = [
      'x', 'y', 'w', 'h',
      'shape', 'tail_enabled', 'tail_tip_x', 'tail_tip_y',
      'writing_mode', 'text_align',
      'font_family', 'font_weight', 'font_size', 'line_height',
      'padding', 'bg_color', 'text_color', 'border_color', 'border_width',
      'display_mode', 'start_ms', 'end_ms', 'z_index',
      'bubble_width_px', 'bubble_height_px'
    ];
    
    const updates: string[] = [];
    const values: any[] = [];
    
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(body[field]);
      }
    }
    
    if (updates.length === 0) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'No valid fields to update' } }, 400);
    }
    
    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(balloonId);
    
    await c.env.DB.prepare(`
      UPDATE scene_balloons
      SET ${updates.join(', ')}
      WHERE id = ?
    `).bind(...values).run();
    
    // 更新後のデータを返す
    const updated = await c.env.DB.prepare(`
      SELECT * FROM scene_balloons WHERE id = ?
    `).bind(balloonId).first();
    
    return c.json({ success: true, balloon: updated });
    
  } catch (error) {
    console.error('[SceneBalloons] Update error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update balloon' } }, 500);
  }
});

// ====================================================================
// POST /api/scene-balloons - バルーン新規作成
// ====================================================================
sceneBalloons.post('/', async (c) => {
  try {
    const body = await c.req.json();
    
    const sceneId = body.scene_id;
    const utteranceId = body.utterance_id || null;
    
    if (!sceneId) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'scene_id is required' } }, 400);
    }
    
    // シーン存在確認
    const scene = await c.env.DB.prepare(`
      SELECT id FROM scenes WHERE id = ?
    `).bind(sceneId).first();
    
    if (!scene) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Scene not found' } }, 404);
    }
    
    // デフォルト値でINSERT
    const result = await c.env.DB.prepare(`
      INSERT INTO scene_balloons (
        scene_id, utterance_id,
        x, y, w, h,
        shape, display_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      sceneId,
      utteranceId,
      body.x ?? 0.5,
      body.y ?? 0.5,
      body.w ?? 0.3,
      body.h ?? 0.2,
      body.shape ?? 'round',
      body.display_mode ?? 'voice_window'
    ).run();
    
    const balloonId = result.meta.last_row_id;
    
    const balloon = await c.env.DB.prepare(`
      SELECT * FROM scene_balloons WHERE id = ?
    `).bind(balloonId).first();
    
    return c.json({ success: true, balloon }, 201);
    
  } catch (error) {
    console.error('[SceneBalloons] Create error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create balloon' } }, 500);
  }
});

// ====================================================================
// DELETE /api/scene-balloons/:balloonId - バルーン削除
// ====================================================================
sceneBalloons.delete('/:balloonId', async (c) => {
  const balloonId = parseInt(c.req.param('balloonId'));
  
  if (!Number.isFinite(balloonId)) {
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid balloon id' } }, 400);
  }
  
  try {
    // R2の画像も削除
    const balloon = await c.env.DB.prepare(`
      SELECT bubble_r2_key FROM scene_balloons WHERE id = ?
    `).bind(balloonId).first<{ bubble_r2_key: string | null }>();
    
    if (!balloon) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Balloon not found' } }, 404);
    }
    
    if (balloon.bubble_r2_key) {
      try {
        await c.env.R2.delete(balloon.bubble_r2_key);
      } catch (r2Error) {
        console.warn('[SceneBalloons] R2 delete failed:', r2Error);
      }
    }
    
    await c.env.DB.prepare(`
      DELETE FROM scene_balloons WHERE id = ?
    `).bind(balloonId).run();
    
    return c.json({ success: true, deleted_id: balloonId });
    
  } catch (error) {
    console.error('[SceneBalloons] Delete error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete balloon' } }, 500);
  }
});

export default sceneBalloons;
