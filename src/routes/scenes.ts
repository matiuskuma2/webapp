import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'

const scenes = new Hono<{ Bindings: Bindings }>()

// GET /api/scenes/:id - 単一シーン取得
scenes.get('/:id', async (c) => {
  try {
    const sceneId = c.req.param('id')
    const view = c.req.query('view') // 'board' 指定時のみ画像情報含む

    // 基本シーン情報取得（display_asset_type追加）
    const scene = await c.env.DB.prepare(`
      SELECT id, project_id, idx, role, title, dialogue, bullets, image_prompt, comic_data, display_asset_type, created_at, updated_at
      FROM scenes
      WHERE id = ?
    `).bind(sceneId).first()

    if (!scene) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Scene not found'
        }
      }, 404)
    }

    // Parse bullets JSON (safe parsing)
    const rawBullets = scene.bullets;
    let bulletsArr: any[] = [];
    try {
      if (rawBullets) {
        const parsed = JSON.parse(String(rawBullets));
        bulletsArr = Array.isArray(parsed) ? parsed : [];
      }
    } catch (err) {
      console.warn(`Failed to parse bullets for scene ${sceneId}:`, err);
      bulletsArr = [];
    }

    // Parse comic_data JSON (safe parsing)
    let comicData = null;
    try {
      if (scene.comic_data) {
        comicData = JSON.parse(String(scene.comic_data));
      }
    } catch (err) {
      console.warn(`Failed to parse comic_data for scene ${sceneId}:`, err);
    }

    const sceneData = {
      ...scene,
      bullets: bulletsArr,
      comic_data: comicData,
      display_asset_type: scene.display_asset_type || 'image'
    }

    // view=board の場合、画像情報とスタイル情報を含める
    if (view === 'board') {
      // 最新画像情報取得（SSOT）
      const latestImage = await c.env.DB.prepare(`
        SELECT 
          id,
          scene_id,
          r2_key,
          r2_url,
          status,
          error_message,
          provider,
          model,
          created_at
        FROM image_generations
        WHERE scene_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).bind(sceneId).first()

      // アクティブAI画像取得（asset_type='ai' または asset_type IS NULL）
      const activeImage = await c.env.DB.prepare(`
        SELECT 
          id,
          scene_id,
          r2_key,
          r2_url,
          status,
          created_at
        FROM image_generations
        WHERE scene_id = ? AND is_active = 1 AND (asset_type = 'ai' OR asset_type IS NULL)
        LIMIT 1
      `).bind(sceneId).first()

      // アクティブ漫画画像取得（asset_type='comic'）
      const activeComic = await c.env.DB.prepare(`
        SELECT 
          id,
          scene_id,
          r2_key,
          r2_url,
          status,
          created_at
        FROM image_generations
        WHERE scene_id = ? AND is_active = 1 AND asset_type = 'comic'
        LIMIT 1
      `).bind(sceneId).first()

      // スタイルプリセット取得
      const stylePreset = await c.env.DB.prepare(`
        SELECT sp.id, sp.name, sp.description, sp.prompt_prefix, sp.prompt_suffix
        FROM scene_style_settings sss
        JOIN style_presets sp ON sss.style_preset_id = sp.id
        WHERE sss.scene_id = ?
      `).bind(sceneId).first()

      // キャラクター情報取得（プロジェクトIDを取得してから）
      const projectId = scene.project_id
      const { results: characterMappings } = await c.env.DB.prepare(`
        SELECT 
          scm.character_key,
          scm.is_primary,
          pcm.character_name,
          pcm.voice_preset_id,
          pcm.reference_image_r2_url
        FROM scene_character_map scm
        LEFT JOIN project_character_models pcm 
          ON scm.character_key = pcm.character_key AND pcm.project_id = ?
        WHERE scm.scene_id = ?
      `).bind(projectId, sceneId).all()

      // 音声キャラクター（is_primary=1 のキャラ、またはvoice_preset_idがあるキャラ）
      // SSOT: voice_character = is_primary=1 のキャラクター
      // voice_preset_id がなくても、is_primary=1 なら voice_character として返す
      // (キャラに音声が設定されていない場合はUIで警告表示)
      const voiceCharacter = characterMappings.find((c: any) => c.is_primary === 1)
        || (characterMappings.length > 0 ? characterMappings[0] : null) // Fallback: 最初のキャラ
        || null

      return c.json({
        ...sceneData,
        latest_image: latestImage ? {
          id: latestImage.id,
          scene_id: latestImage.scene_id,
          r2_key: latestImage.r2_key,
          r2_url: latestImage.r2_url,
          image_url: latestImage.r2_url, // Alias for compatibility
          status: latestImage.status,
          error_message: latestImage.error_message,
          provider: latestImage.provider,
          model: latestImage.model,
          created_at: latestImage.created_at
        } : null,
        active_image: activeImage ? {
          id: activeImage.id,
          scene_id: activeImage.scene_id,
          r2_key: activeImage.r2_key,
          r2_url: activeImage.r2_url,
          image_url: activeImage.r2_url, // Alias for compatibility
          status: activeImage.status,
          created_at: activeImage.created_at
        } : null,
        // Phase1.5: 漫画画像情報
        active_comic: activeComic ? {
          id: activeComic.id,
          scene_id: activeComic.scene_id,
          r2_key: activeComic.r2_key,
          r2_url: activeComic.r2_url,
          image_url: activeComic.r2_url,
          status: activeComic.status,
          created_at: activeComic.created_at
        } : null,
        style_preset: stylePreset || null,
        style_preset_id: stylePreset?.id || null,
        // キャラクター情報追加
        characters: characterMappings.map((c: any) => ({
          character_key: c.character_key,
          character_name: c.character_name,
          is_primary: c.is_primary,
          voice_preset_id: c.voice_preset_id,
          reference_image_r2_url: c.reference_image_r2_url
        })),
        voice_character: voiceCharacter ? {
          character_key: voiceCharacter.character_key,
          character_name: voiceCharacter.character_name,
          voice_preset_id: voiceCharacter.voice_preset_id
        } : null
      })
    }

    // デフォルト: 基本情報のみ
    return c.json(sceneData)

  } catch (error) {
    console.error(`[GET /api/scenes/:id] Error fetching scene ${c.req.param('id')}, view=${c.req.query('view')}:`, error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch scene'
      }
    }, 500)
  }
})

// PUT /api/scenes/:id - シーン編集
scenes.put('/:id', async (c) => {
  try {
    const sceneId = c.req.param('id')
    const { title, dialogue, bullets, image_prompt, comic_data } = await c.req.json()

    // シーン存在確認
    const scene = await c.env.DB.prepare(`
      SELECT id FROM scenes WHERE id = ?
    `).bind(sceneId).first()

    if (!scene) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Scene not found'
        }
      }, 404)
    }

    // 部分更新（指定されたフィールドのみ）
    const updates: string[] = []
    const values: any[] = []

    if (title !== undefined) {
      updates.push('title = ?')
      values.push(title)
    }
    if (dialogue !== undefined) {
      updates.push('dialogue = ?')
      values.push(dialogue)
    }
    if (bullets !== undefined) {
      updates.push('bullets = ?')
      values.push(JSON.stringify(bullets))
    }
    if (image_prompt !== undefined) {
      updates.push('image_prompt = ?')
      values.push(image_prompt)
    }
    // Phase1: 漫画編集データ対応
    if (comic_data !== undefined) {
      updates.push('comic_data = ?')
      values.push(comic_data === null ? null : JSON.stringify(comic_data))
    }

    if (updates.length === 0) {
      return c.json({
        error: {
          code: 'NO_UPDATES',
          message: 'No fields to update'
        }
      }, 400)
    }

    updates.push('updated_at = CURRENT_TIMESTAMP')
    values.push(sceneId)

    // 更新実行
    await c.env.DB.prepare(`
      UPDATE scenes
      SET ${updates.join(', ')}
      WHERE id = ?
    `).bind(...values).run()

    // 更新後のシーン取得
    const updatedScene = await c.env.DB.prepare(`
      SELECT id, project_id, idx, role, title, dialogue, bullets, image_prompt, comic_data, updated_at
      FROM scenes
      WHERE id = ?
    `).bind(sceneId).first()

    // comic_data のパース
    let parsedComicData = null
    if (updatedScene.comic_data) {
      try {
        parsedComicData = JSON.parse(updatedScene.comic_data as string)
      } catch (e) {
        console.warn('Failed to parse comic_data:', e)
      }
    }

    return c.json({
      ...updatedScene,
      bullets: JSON.parse(updatedScene.bullets as string),
      comic_data: parsedComicData
    })
  } catch (error) {
    console.error('Error updating scene:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update scene'
      }
    }, 500)
  }
})

// DELETE /api/scenes/:id - シーン削除（idx自動再採番）
scenes.delete('/:id', async (c) => {
  try {
    const sceneId = c.req.param('id')

    // シーン存在確認＋project_id取得
    const scene = await c.env.DB.prepare(`
      SELECT id, project_id FROM scenes WHERE id = ?
    `).bind(sceneId).first()

    if (!scene) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Scene not found'
        }
      }, 404)
    }

    const projectId = scene.project_id

    // シーン削除
    await c.env.DB.prepare(`
      DELETE FROM scenes WHERE id = ?
    `).bind(sceneId).run()

    // idx自動再採番（残ったシーンを1から連番に）
    const { results: remainingScenes } = await c.env.DB.prepare(`
      SELECT id FROM scenes
      WHERE project_id = ?
      ORDER BY idx ASC
    `).bind(projectId).all()

    for (let i = 0; i < remainingScenes.length; i++) {
      await c.env.DB.prepare(`
        UPDATE scenes SET idx = ? WHERE id = ?
      `).bind(i + 1, remainingScenes[i].id).run()
    }

    return c.json({
      success: true,
      message: 'Scene deleted successfully',
      deleted_scene_id: parseInt(sceneId),
      remaining_scenes_count: remainingScenes.length
    })
  } catch (error) {
    console.error('Error deleting scene:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete scene'
      }
    }, 500)
  }
})

// POST /api/projects/:id/scenes/reorder - シーン並び替え
scenes.post('/:id/scenes/reorder', async (c) => {
  try {
    const projectId = c.req.param('id')
    const { scene_ids } = await c.req.json()

    // バリデーション
    if (!Array.isArray(scene_ids) || scene_ids.length === 0) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'scene_ids must be a non-empty array'
        }
      }, 400)
    }

    // プロジェクト存在確認
    const project = await c.env.DB.prepare(`
      SELECT id FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // 指定されたシーンが全てこのprojectに属しているか確認
    const { results: scenes } = await c.env.DB.prepare(`
      SELECT id FROM scenes WHERE project_id = ?
    `).bind(projectId).all()

    const sceneIdsSet = new Set(scenes.map((s: any) => s.id))
    const invalidIds = scene_ids.filter(id => !sceneIdsSet.has(id))

    if (invalidIds.length > 0) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Some scene_ids do not belong to this project',
          details: { invalid_ids: invalidIds }
        }
      }, 400)
    }

    // idx再採番（トランザクション的に実行）
    for (let i = 0; i < scene_ids.length; i++) {
      await c.env.DB.prepare(`
        UPDATE scenes SET idx = ? WHERE id = ?
      `).bind(i + 1, scene_ids[i]).run()
    }

    // 更新後のシーン一覧取得
    const { results: reorderedScenes } = await c.env.DB.prepare(`
      SELECT id, idx, role, title
      FROM scenes
      WHERE project_id = ?
      ORDER BY idx ASC
    `).bind(projectId).all()

    return c.json({
      success: true,
      message: 'Scenes reordered successfully',
      scenes: reorderedScenes
    })
  } catch (error) {
    console.error('Error reordering scenes:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to reorder scenes'
      }
    }, 500)
  }
})

// GET /api/scenes/:id/images - シーンの画像生成履歴取得
scenes.get('/:id/images', async (c) => {
  try {
    const sceneId = c.req.param('id')

    // シーン存在確認
    const scene = await c.env.DB.prepare(`
      SELECT id FROM scenes WHERE id = ?
    `).bind(sceneId).first()

    if (!scene) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Scene not found'
        }
      }, 404)
    }

    // 画像生成履歴取得（新しい順）- asset_typeを含む
    const { results: imageGenerations } = await c.env.DB.prepare(`
      SELECT id, prompt, r2_key, r2_url, status, is_active, error_message, asset_type, created_at
      FROM image_generations
      WHERE scene_id = ?
      ORDER BY created_at DESC
    `).bind(sceneId).all()

    return c.json({
      scene_id: parseInt(sceneId),
      total_images: imageGenerations.length,
      images: imageGenerations.map((img: any) => ({
        id: img.id,
        prompt: img.prompt,
        r2_key: img.r2_key,
        image_url: img.r2_url,
        status: img.status,
        is_active: img.is_active === 1,
        error_message: img.error_message,
        asset_type: img.asset_type || 'ai', // 'ai' | 'comic'
        created_at: img.created_at
      }))
    })
  } catch (error) {
    console.error(`[GET /api/scenes/:id/images] Error for scene ${c.req.param('id')}:`, error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch scene images'
      }
    }, 500)
  }
})

export default scenes
