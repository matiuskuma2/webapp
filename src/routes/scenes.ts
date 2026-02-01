import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Bindings } from '../types/bindings'
import { logAudit } from '../utils/audit-logger'
import { 
  hideSceneIdx, 
  renumberVisibleScenes, 
  restoreSceneIdx, 
  reorderScenes,
  getInsertPosition
} from '../utils/scene-idx-manager'

const scenes = new Hono<{ Bindings: Bindings }>()

// GET /api/scenes/:id - 単一シーン取得
scenes.get('/:id', async (c) => {
  try {
    const sceneId = c.req.param('id')
    const view = c.req.query('view') // 'board' 指定時のみ画像情報含む

    // 基本シーン情報取得（display_asset_type追加、R3: duration_override_ms追加、R2-A: text_render_mode追加）
    const scene = await c.env.DB.prepare(`
      SELECT id, project_id, idx, role, title, dialogue, bullets, image_prompt, comic_data, display_asset_type, text_render_mode, duration_override_ms, created_at, updated_at
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
      display_asset_type: scene.display_asset_type || 'image',
      // R2-A: A案 baked 対応 - comic の場合は baked をデフォルト（二重描画防止）
      text_render_mode: scene.text_render_mode || 
        ((scene.display_asset_type === 'comic') ? 'baked' : 'remotion')
    }

    // view=board の場合、画像情報とスタイル情報を含める
    if (view === 'board') {
      // ✅ IMPROVEMENT: Auto-cleanup stuck 'generating' records (5+ minutes old)
      // This runs on every board view request to prevent UI getting stuck at 95%
      // Note: We use fixed datetime modifiers as D1 doesn't support dynamic string concat in prepared statements
      const forceCleanup = c.req.query('force_cleanup') === '1'
      const thresholdModifier = forceCleanup ? '-3 minutes' : '-5 minutes'
      
      try {
        // D1 workaround: Use raw SQL with threshold embedded (safe since it's a fixed string, not user input)
        const cleanupQuery = `
          UPDATE image_generations
          SET status = 'failed', 
              error_message = 'Generation timeout (auto-cleanup)'
          WHERE scene_id = ?
            AND status = 'generating' 
            AND created_at < datetime('now', '${thresholdModifier}')
        `
        await c.env.DB.prepare(cleanupQuery).bind(sceneId).run()
      } catch (cleanupErr) {
        // Cleanup failure should not block the request
        console.warn('[Scene] Auto-cleanup failed:', cleanupErr)
      }
      
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

      // アクティブAI画像取得（asset_type='ai' または asset_type IS NULL、r2_urlが有効なもののみ）
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
          AND r2_url IS NOT NULL AND r2_url != ''
        LIMIT 1
      `).bind(sceneId).first()

      // アクティブ漫画画像取得（asset_type='comic'、r2_urlが有効なもののみ）
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
          AND r2_url IS NOT NULL AND r2_url != ''
        LIMIT 1
      `).bind(sceneId).first()

      // Phase1.7: アクティブ動画取得
      const activeVideo = await c.env.DB.prepare(`
        SELECT 
          id,
          scene_id,
          r2_key,
          r2_url,
          status,
          model,
          duration_sec,
          created_at
        FROM video_generations
        WHERE scene_id = ? AND is_active = 1 AND status = 'completed' AND r2_url IS NOT NULL
        LIMIT 1
      `).bind(sceneId).first()

      // Phase1.7: 漫画編集用の元画像を取得（base_image_generation_id から）
      // 漫画編集時は吹き出し付き画像ではなく、元のAI画像をベースにする必要がある
      let baseImage = null
      const baseImageId = comicData?.base_image_generation_id
      if (baseImageId) {
        baseImage = await c.env.DB.prepare(`
          SELECT id, scene_id, r2_key, r2_url, status, created_at
          FROM image_generations
          WHERE id = ?
        `).bind(baseImageId).first()
      }
      // base_image_generation_id がない場合は activeImage をフォールバック
      if (!baseImage && activeImage) {
        baseImage = activeImage
      }

      // スタイルプリセット取得
      const stylePreset = await c.env.DB.prepare(`
        SELECT sp.id, sp.name, sp.description, sp.prompt_prefix, sp.prompt_suffix
        FROM scene_style_settings sss
        JOIN style_presets sp ON sss.style_preset_id = sp.id
        WHERE sss.scene_id = ?
      `).bind(sceneId).first()

      // R3-B: SFX数取得
      const sfxCountResult = await c.env.DB.prepare(`
        SELECT COUNT(*) as count
        FROM scene_audio_cues
        WHERE scene_id = ? AND is_active = 1
      `).bind(sceneId).first<{ count: number }>()
      const sfxCount = sfxCountResult?.count || 0

      // P3: SFX詳細情報取得（先頭2件のnameを含む）
      const { results: sfxDetails } = await c.env.DB.prepare(`
        SELECT name, start_ms
        FROM scene_audio_cues
        WHERE scene_id = ? AND is_active = 1
        ORDER BY start_ms ASC
        LIMIT 2
      `).bind(sceneId).all()

      // P3: シーン別BGM取得（scene_audio_assignments から）
      // 本番DBスキーマ: 
      //   scene_audio_assignments: audio_library_type, system_audio_id, user_audio_id, direct_r2_url, volume_override, loop_override
      //   system_audio_library: file_url (NOT r2_url)
      //   user_audio_library: r2_url
      const sceneBgm = await c.env.DB.prepare(`
        SELECT 
          saa.id,
          saa.audio_library_type as library_type,
          saa.volume_override as volume,
          saa.loop_override as loop,
          CASE 
            WHEN saa.audio_library_type = 'system' THEN sal.name
            WHEN saa.audio_library_type = 'user' THEN ual.name
            ELSE saa.direct_name
          END as name,
          CASE 
            WHEN saa.audio_library_type = 'system' THEN sal.file_url
            WHEN saa.audio_library_type = 'user' THEN ual.r2_url
            ELSE saa.direct_r2_url
          END as url
        FROM scene_audio_assignments saa
        LEFT JOIN system_audio_library sal ON saa.audio_library_type = 'system' AND saa.system_audio_id = sal.id
        LEFT JOIN user_audio_library ual ON saa.audio_library_type = 'user' AND saa.user_audio_id = ual.id
        WHERE saa.scene_id = ? AND saa.audio_type = 'bgm' AND saa.is_active = 1
        LIMIT 1
      `).bind(sceneId).first()

      // キャラクター情報取得（プロジェクトIDを取得してから）
      // A/B/C層の特徴も取得: A=appearance_description, B=story_traits, C=scene_trait
      const projectId = scene.project_id
      const { results: characterMappings } = await c.env.DB.prepare(`
        SELECT 
          scm.character_key,
          scm.is_primary,
          pcm.character_name,
          pcm.voice_preset_id,
          pcm.reference_image_r2_url,
          pcm.appearance_description,
          pcm.story_traits,
          sct.trait_description AS scene_trait
        FROM scene_character_map scm
        LEFT JOIN project_character_models pcm 
          ON scm.character_key = pcm.character_key AND pcm.project_id = ?
        LEFT JOIN scene_character_traits sct
          ON sct.scene_id = scm.scene_id AND sct.character_key = scm.character_key
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
        // Phase1.7: 動画情報
        active_video: activeVideo ? {
          id: activeVideo.id,
          scene_id: activeVideo.scene_id,
          r2_key: activeVideo.r2_key,
          r2_url: activeVideo.r2_url,
          status: activeVideo.status,
          model: activeVideo.model,
          duration_sec: activeVideo.duration_sec,
          created_at: activeVideo.created_at
        } : null,
        // Phase1.7: 漫画編集用の元画像（吹き出しなしのAI画像）
        base_image: baseImage ? {
          id: baseImage.id,
          scene_id: baseImage.scene_id,
          r2_key: baseImage.r2_key,
          r2_url: baseImage.r2_url,
          image_url: baseImage.r2_url,
          status: baseImage.status,
          created_at: baseImage.created_at
        } : null,
        // Phase1.7: display_image SSOT（display_asset_typeに基づく採用素材）
        display_image: (() => {
          const displayType = sceneData.display_asset_type || 'image';
          if (displayType === 'comic' && activeComic) {
            return {
              type: 'comic',
              r2_url: activeComic.r2_url,
              image_url: activeComic.r2_url
            };
          }
          if (activeImage) {
            return {
              type: 'image',
              r2_url: activeImage.r2_url,
              image_url: activeImage.r2_url
            };
          }
          return null;
        })(),
        style_preset: stylePreset || null,
        style_preset_id: stylePreset?.id || null,
        // キャラクター情報追加（A/B/C層の特徴を含む）
        characters: characterMappings.map((c: any) => ({
          character_key: c.character_key,
          character_name: c.character_name,
          is_primary: c.is_primary,
          voice_preset_id: c.voice_preset_id,
          reference_image_r2_url: c.reference_image_r2_url,
          appearance_description: c.appearance_description || null,  // A層
          story_traits: c.story_traits || null,                      // B層
          scene_trait: c.scene_trait || null                         // C層
        })),
        voice_character: voiceCharacter ? {
          character_key: voiceCharacter.character_key,
          character_name: voiceCharacter.character_name,
          voice_preset_id: voiceCharacter.voice_preset_id
        } : null,
        // R3-B: SFX数
        sfx_count: sfxCount,
        // P3: SFX詳細（先頭2件のname）
        sfx_preview: (sfxDetails || []).map((s: any) => s.name || 'SFX'),
        // P3: シーン別BGM
        scene_bgm: sceneBgm ? {
          id: sceneBgm.id,
          source: sceneBgm.library_type || 'direct',
          name: sceneBgm.name || 'BGM',
          url: sceneBgm.url,
          volume: sceneBgm.volume,
          loop: sceneBgm.loop
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
    const { title, dialogue, bullets, image_prompt, comic_data, display_asset_type, duration_override_ms } = await c.req.json()

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
      // Phase X-4: Mark prompt as customized when user edits it
      updates.push('is_prompt_customized = ?')
      values.push(1)
    }
    // Phase1: 漫画編集データ対応
    if (comic_data !== undefined) {
      updates.push('comic_data = ?')
      values.push(comic_data === null ? null : JSON.stringify(comic_data))
    }
    // display_asset_type の切替（image/comic/video）
    if (display_asset_type !== undefined) {
      updates.push('display_asset_type = ?')
      values.push(display_asset_type)
    }
    // R3: 無音シーンの手動尺設定
    if (duration_override_ms !== undefined) {
      // null/0 の場合はリセット（自動計算に戻す）
      if (duration_override_ms === null || duration_override_ms === 0) {
        updates.push('duration_override_ms = ?')
        values.push(null)
      } else {
        // 最小1秒、最大60秒の制限
        const clampedMs = Math.max(1000, Math.min(60000, parseInt(duration_override_ms)))
        updates.push('duration_override_ms = ?')
        values.push(clampedMs)
      }
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
      SELECT id, project_id, idx, role, title, dialogue, bullets, image_prompt, comic_data, updated_at, duration_override_ms
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

// PATCH /api/scenes/:id - シーン部分更新（PUTと同じ処理）
scenes.patch('/:id', async (c) => {
  try {
    const sceneId = c.req.param('id')
    const body = await c.req.json()

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

    if (body.title !== undefined) {
      updates.push('title = ?')
      values.push(body.title)
    }
    if (body.dialogue !== undefined) {
      updates.push('dialogue = ?')
      values.push(body.dialogue)
    }
    if (body.bullets !== undefined) {
      updates.push('bullets = ?')
      values.push(JSON.stringify(body.bullets))
    }
    if (body.image_prompt !== undefined) {
      updates.push('image_prompt = ?')
      values.push(body.image_prompt)
      // Phase X-4: Mark prompt as customized when user edits it
      updates.push('is_prompt_customized = ?')
      values.push(1)
    }
    if (body.comic_data !== undefined) {
      updates.push('comic_data = ?')
      values.push(body.comic_data === null ? null : JSON.stringify(body.comic_data))
    }
    if (body.display_asset_type !== undefined) {
      updates.push('display_asset_type = ?')
      values.push(body.display_asset_type)
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

    await c.env.DB.prepare(`
      UPDATE scenes
      SET ${updates.join(', ')}
      WHERE id = ?
    `).bind(...values).run()

    return c.json({ success: true, scene_id: sceneId })
  } catch (error) {
    console.error('Error patching scene:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to patch scene'
      }
    }, 500)
  }
})

// DELETE /api/scenes/:id - シーン非表示（ソフトデリート）
// ⚠️ 実際にはデータを削除せず、is_hidden=1 に設定
// 関連データ（画像、音声、動画、吹き出し等）はすべて保持される
scenes.delete('/:id', async (c) => {
  try {
    const sceneId = c.req.param('id')

    // シーン存在確認＋project_id取得
    const scene = await c.env.DB.prepare(`
      SELECT id, project_id, is_hidden FROM scenes WHERE id = ?
    `).bind(sceneId).first<{ id: number; project_id: number; is_hidden: number }>()

    if (!scene) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Scene not found'
        }
      }, 404)
    }

    // 既に非表示の場合は警告
    if (scene.is_hidden === 1) {
      return c.json({
        error: {
          code: 'ALREADY_HIDDEN',
          message: 'Scene is already hidden'
        }
      }, 400)
    }

    const projectId = scene.project_id

    // SSOT: シーン非表示処理（idx = -scene_id に設定）
    const hideResult = await hideSceneIdx(c.env.DB, parseInt(sceneId))
    if (!hideResult.success) {
      throw new Error(hideResult.error)
    }

    // SSOT: 可視シーンのidx再採番
    const renumberResult = await renumberVisibleScenes(c.env.DB, projectId)
    if (!renumberResult.success) {
      throw new Error(renumberResult.error)
    }

    // 監査ログ記録
    const sessionId = getCookie(c, 'session');
    let userId: number | null = null;
    let userRole: string | null = null;
    if (sessionId) {
      const session = await c.env.DB.prepare(`
        SELECT u.id, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?
      `).bind(sessionId).first<{ id: number; role: string }>();
      if (session) {
        userId = session.id;
        userRole = session.role;
      }
    }
    await logAudit({
      db: c.env.DB,
      userId,
      userRole,
      entityType: 'scene',
      entityId: parseInt(sceneId),
      projectId,
      action: 'hide',
      details: { visible_scenes_count: renumberResult.count }
    });

    return c.json({
      success: true,
      message: 'Scene hidden successfully (soft delete)',
      hidden_scene_id: parseInt(sceneId),
      visible_scenes_count: renumberResult.count
    })
  } catch (error) {
    console.error('Error hiding scene:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to hide scene'
      }
    }, 500)
  }
})

// POST /api/scenes/:id/restore - シーンを再表示（ソフトデリートの復元）
scenes.post('/:id/restore', async (c) => {
  try {
    const sceneId = c.req.param('id')

    // シーン存在確認
    const scene = await c.env.DB.prepare(`
      SELECT id, project_id, is_hidden FROM scenes WHERE id = ?
    `).bind(sceneId).first<{ id: number; project_id: number; is_hidden: number }>()

    if (!scene) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Scene not found'
        }
      }, 404)
    }

    if (scene.is_hidden === 0) {
      return c.json({
        error: {
          code: 'NOT_HIDDEN',
          message: 'Scene is not hidden'
        }
      }, 400)
    }

    const projectId = scene.project_id

    // SSOT: シーン復元処理（末尾に追加）
    const restoreResult = await restoreSceneIdx(c.env.DB, parseInt(sceneId), projectId)
    if (!restoreResult.success) {
      throw new Error(restoreResult.error)
    }
    const newIdx = restoreResult.newIdx

    // 監査ログ記録
    const sessionId = getCookie(c, 'session');
    let userId: number | null = null;
    let userRole: string | null = null;
    if (sessionId) {
      const session = await c.env.DB.prepare(`
        SELECT u.id, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?
      `).bind(sessionId).first<{ id: number; role: string }>();
      if (session) {
        userId = session.id;
        userRole = session.role;
      }
    }
    await logAudit({
      db: c.env.DB,
      userId,
      userRole,
      entityType: 'scene',
      entityId: parseInt(sceneId),
      projectId,
      action: 'restore',
      details: { new_idx: newIdx }
    });

    return c.json({
      success: true,
      message: 'Scene restored successfully',
      restored_scene_id: parseInt(sceneId),
      new_idx: newIdx
    })
  } catch (error) {
    console.error('Error restoring scene:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to restore scene'
      }
    }, 500)
  }
})

// POST /api/scenes - シーン追加（指定位置に挿入可能）
// ⚠️ Scene Split タブからの使用を想定
// Builder からの直接追加は整合性の観点から非推奨
scenes.post('/', async (c) => {
  try {
    const body = await c.req.json<{
      project_id: number;
      title?: string;
      dialogue?: string;
      role?: string; // 省略時は 'main_point'
      insert_after_idx?: number; // 指定したidxの後に挿入（省略時は最後に追加）
    }>();
    
    const { project_id, title, dialogue, role, insert_after_idx } = body;
    
    if (!project_id) {
      return c.json({
        error: { code: 'INVALID_REQUEST', message: 'project_id is required' }
      }, 400);
    }
    
    // role のバリデーション
    const validRoles = ['hook', 'context', 'main_point', 'evidence', 'timeline', 'analysis', 'summary', 'cta'];
    const sceneRole = role && validRoles.includes(role) ? role : 'main_point';
    
    // プロジェクト存在確認
    const project = await c.env.DB.prepare(`
      SELECT id FROM projects WHERE id = ?
    `).bind(project_id).first();
    
    if (!project) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Project not found' }
      }, 404);
    }
    
    // SSOT: 挿入位置を計算
    const insertPos = await getInsertPosition(c.env.DB, project_id, insert_after_idx);
    const newIdx = insertPos.newIdx;
    
    // 新規シーン作成（bullets, image_prompt は NOT NULL なので空文字列を設定）
    const result = await c.env.DB.prepare(`
      INSERT INTO scenes (project_id, idx, role, title, dialogue, bullets, image_prompt, is_hidden)
      VALUES (?, ?, ?, ?, ?, '[]', '', 0)
    `).bind(
      project_id,
      newIdx,
      sceneRole,
      title || `シーン ${newIdx}`,
      dialogue || ''
    ).run();
    
    const newSceneId = result.meta?.last_row_id;
    
    console.log(`[Scenes] Created scene id=${newSceneId}, idx=${newIdx}, project=${project_id}, role=${sceneRole}`);
    
    // 挿入位置に挿入した場合は再採番が必要
    if (insertPos.needsRenumber) {
      await renumberVisibleScenes(c.env.DB, project_id);
    }
    
    // 作成したシーンを取得して返却
    const newScene = await c.env.DB.prepare(`
      SELECT id, project_id, idx, role, title, dialogue, created_at
      FROM scenes WHERE id = ?
    `).bind(newSceneId).first();
    
    console.log(`[Scenes] Created scene id=${newSceneId}, idx=${newIdx}, project=${project_id}, insert_after=${insert_after_idx ?? 'end'}`);
    
    return c.json({
      success: true,
      scene: newScene
    }, 201);
    
  } catch (error) {
    console.error('Error creating scene:', error);
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create scene' }
    }, 500);
  }
});

// POST /api/projects/:id/scenes/reorder - シーン並び替え
scenes.post('/:id/scenes/reorder', async (c) => {
  try {
    const projectId = c.req.param('id')
    
    // リクエストボディを取得
    let requestBody: any
    try {
      requestBody = await c.req.json()
    } catch (parseError) {
      console.error('[Reorder] JSON parse error:', parseError)
      return c.json({
        error: {
          code: 'PARSE_ERROR',
          message: 'Invalid JSON in request body'
        }
      }, 400)
    }
    
    const { scene_ids } = requestBody
    console.log(`[Reorder] projectId=${projectId}, scene_ids=`, scene_ids)

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

    // SSOT: シーン順序変更
    const reorderResult = await reorderScenes(c.env.DB, scene_ids)
    if (!reorderResult.success) {
      throw new Error(reorderResult.error)
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
  } catch (error: any) {
    console.error('[Reorder] Error:', error?.message || error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to reorder scenes',
        details: error?.message || String(error)
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

// ====================================================================
// R2-C: Scene Motion API
// ====================================================================

// GET /api/scenes/:id/motion - シーンのモーション設定取得
scenes.get('/:id/motion', async (c) => {
  try {
    const sceneId = c.req.param('id')
    
    // シーン存在確認
    const scene = await c.env.DB.prepare(`
      SELECT id, display_asset_type FROM scenes WHERE id = ?
    `).bind(sceneId).first()
    
    if (!scene) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Scene not found' }
      }, 404)
    }
    
    // モーション設定を取得
    const motionSetting = await c.env.DB.prepare(`
      SELECT sm.motion_preset_id, mp.name, mp.description, mp.motion_type, mp.params
      FROM scene_motion sm
      JOIN motion_presets mp ON sm.motion_preset_id = mp.id
      WHERE sm.scene_id = ?
    `).bind(sceneId).first<{
      motion_preset_id: string;
      name: string;
      description: string;
      motion_type: string;
      params: string;
    }>()
    
    // 設定がない場合はデフォルト値を返す
    const displayType = (scene as any).display_asset_type || 'image'
    const defaultPreset = displayType === 'comic' ? 'none' : 'kenburns_soft'
    
    if (!motionSetting) {
      // プリセット情報を取得
      const preset = await c.env.DB.prepare(`
        SELECT id, name, description, motion_type, params
        FROM motion_presets WHERE id = ?
      `).bind(defaultPreset).first()
      
      return c.json({
        scene_id: parseInt(sceneId),
        is_default: true,
        motion_preset_id: defaultPreset,
        name: preset?.name || defaultPreset,
        description: preset?.description || '',
        motion_type: preset?.motion_type || 'zoom',
        params: preset?.params ? JSON.parse(preset.params as string) : {},
      })
    }
    
    return c.json({
      scene_id: parseInt(sceneId),
      is_default: false,
      motion_preset_id: motionSetting.motion_preset_id,
      name: motionSetting.name,
      description: motionSetting.description,
      motion_type: motionSetting.motion_type,
      params: JSON.parse(motionSetting.params || '{}'),
    })
  } catch (error) {
    console.error(`[GET /api/scenes/:id/motion] Error:`, error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch motion settings' }
    }, 500)
  }
})

// PUT /api/scenes/:id/motion - シーンのモーション設定更新
scenes.put('/:id/motion', async (c) => {
  try {
    const sceneId = c.req.param('id')
    const body = await c.req.json<{ motion_preset_id: string }>()
    
    if (!body.motion_preset_id) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'motion_preset_id is required' }
      }, 400)
    }
    
    // シーン存在確認
    const scene = await c.env.DB.prepare(`
      SELECT id FROM scenes WHERE id = ?
    `).bind(sceneId).first()
    
    if (!scene) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Scene not found' }
      }, 404)
    }
    
    // プリセット存在確認
    const preset = await c.env.DB.prepare(`
      SELECT id, name, motion_type, params FROM motion_presets WHERE id = ? AND is_active = 1
    `).bind(body.motion_preset_id).first()
    
    if (!preset) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Motion preset not found' }
      }, 404)
    }
    
    // UPSERT（存在すれば更新、なければ挿入）
    await c.env.DB.prepare(`
      INSERT INTO scene_motion (scene_id, motion_preset_id, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(scene_id) DO UPDATE SET 
        motion_preset_id = excluded.motion_preset_id,
        updated_at = CURRENT_TIMESTAMP
    `).bind(sceneId, body.motion_preset_id).run()
    
    return c.json({
      success: true,
      scene_id: parseInt(sceneId),
      motion_preset_id: body.motion_preset_id,
      motion_type: preset.motion_type,
      params: JSON.parse((preset.params as string) || '{}'),
    })
  } catch (error) {
    console.error(`[PUT /api/scenes/:id/motion] Error:`, error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update motion settings' }
    }, 500)
  }
})

// DELETE /api/scenes/:id/motion - シーンのモーション設定削除（デフォルトに戻す）
scenes.delete('/:id/motion', async (c) => {
  try {
    const sceneId = c.req.param('id')
    
    await c.env.DB.prepare(`
      DELETE FROM scene_motion WHERE scene_id = ?
    `).bind(sceneId).run()
    
    return c.json({
      success: true,
      scene_id: parseInt(sceneId),
      message: 'Motion setting reset to default'
    })
  } catch (error) {
    console.error(`[DELETE /api/scenes/:id/motion] Error:`, error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to delete motion settings' }
    }, 500)
  }
})

export default scenes
