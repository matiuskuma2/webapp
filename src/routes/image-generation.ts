import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'
import { buildImagePrompt, buildR2Key, composeStyledPrompt } from '../utils/image-prompt-builder'

/**
 * 参照画像の型定義（キャラクター一貫性用）
 */
interface ReferenceImage {
  base64Data: string
  mimeType: string
  characterName?: string
}

const imageGeneration = new Hono<{ Bindings: Bindings }>()

// POST /api/projects/:id/generate-images - バッチ画像生成
imageGeneration.post('/projects/:id/generate-images', async (c) => {
  try {
    const projectId = c.req.param('id')

    // 1. プロジェクト情報取得
    const project = await c.env.DB.prepare(`
      SELECT id, status FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // 2. ステータスチェック（formatted, generating_images, completed を許可）
    const allowedStatuses = ['formatted', 'generating_images', 'completed']
    if (!allowedStatuses.includes(project.status as string)) {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot generate images for project with status: ${project.status}`,
          details: {
            current_status: project.status,
            allowed_statuses: allowedStatuses
          }
        }
      }, 400)
    }

    // 3. プロジェクトステータスを 'generating_images' に（初回のみ）
    if (project.status === 'formatted') {
      await c.env.DB.prepare(`
        UPDATE projects 
        SET status = 'generating_images', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(projectId).run()
    }

    // 3.5. スタックした 'generating' レコードをタイムアウト処理（5分以上）
    await c.env.DB.prepare(`
      UPDATE image_generations
      SET status = 'failed', 
          error_message = 'Generation timeout (stuck for >5 minutes)'
      WHERE status = 'generating' 
        AND scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
        AND datetime(created_at, '+5 minutes') < datetime('now')
    `).bind(projectId).run()

    // 4. pending の scenes を取得（最大1件: Gemini APIが遅いため）
    const BATCH_SIZE = 1
    const { results: pendingScenes } = await c.env.DB.prepare(`
      SELECT s.id, s.idx, s.image_prompt
      FROM scenes s
      LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
      WHERE s.project_id = ? AND ig.id IS NULL
      ORDER BY s.idx ASC
      LIMIT ?
    `).bind(projectId, BATCH_SIZE).all()

    if (pendingScenes.length === 0) {
      // 全scenes処理済み → status を 'completed' に
      await c.env.DB.prepare(`
        UPDATE projects 
        SET status = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(projectId).run()

      const stats = await getImageGenerationStats(c.env.DB, projectId)

      return c.json({
        project_id: parseInt(projectId),
        status: 'completed',
        ...stats,
        message: 'All images generated'
      }, 200)
    }

    // 5. 各sceneの画像生成
    let successCount = 0
    let failedCount = 0

    for (const scene of pendingScenes) {
      try {
        // 最終プロンプト生成（スタイルプリセット適用）
        const finalPrompt = await composeStyledPrompt(
          c.env.DB,
          parseInt(projectId),
          scene.id as number,
          scene.image_prompt as string
        )

        // image_generationsレコード作成（generating状態）
        const insertResult = await c.env.DB.prepare(`
          INSERT INTO image_generations (
            scene_id, prompt, status, provider, model, is_active
          ) VALUES (?, ?, 'generating', 'gemini', 'gemini-3-pro-image-preview', 1)
        `).bind(scene.id, finalPrompt).run()

        const generationId = insertResult.meta.last_row_id as number

        // Gemini APIで画像生成（429リトライ付き）
        const imageResult = await generateImageWithRetry(
          finalPrompt,
          c.env.GEMINI_API_KEY,
          3
        )

        if (!imageResult.success) {
          // 生成失敗 → status = 'failed', error_message保存
          await c.env.DB.prepare(`
            UPDATE image_generations 
            SET status = 'failed', error_message = ?
            WHERE id = ?
          `).bind(imageResult.error || 'Unknown error', generationId).run()

          failedCount++
          continue
        }

        // R2に画像保存
        const r2Key = buildR2Key(
          parseInt(projectId),
          scene.idx as number,
          generationId
        )

        await c.env.R2.put(r2Key, imageResult.imageData)

        // R2 URL: r2_key がすでに "images/" で始まっているので、"/" だけ追加
        const r2Url = `/${r2Key}`

        // 成功 → status = 'completed', r2_key, r2_url保存
        const updateResult = await c.env.DB.prepare(`
          UPDATE image_generations 
          SET status = 'completed', r2_key = ?, r2_url = ?
          WHERE id = ?
        `).bind(r2Key, r2Url, generationId).run()

        // ✅ DB更新失敗時の検証
        if (!updateResult.success) {
          console.error(`DB update failed for generation ${generationId}:`, updateResult)
          throw new Error('Failed to update image generation record')
        }

        // ✅ r2_url が null でないことを確認（念のため）
        const verifyResult = await c.env.DB.prepare(`
          SELECT r2_url FROM image_generations WHERE id = ?
        `).bind(generationId).first()

        if (!verifyResult || !verifyResult.r2_url) {
          console.error(`r2_url is null after update for generation ${generationId}`)
          // r2_url が null の場合、failed に戻す
          await c.env.DB.prepare(`
            UPDATE image_generations 
            SET status = 'failed', error_message = 'R2 URL update failed'
            WHERE id = ?
          `).bind(generationId).run()
          throw new Error('r2_url is null after DB update')
        }

        successCount++

      } catch (sceneError) {
        console.error(`Failed to generate image for scene ${scene.id}:`, sceneError)
        failedCount++
      }
    }

    // 6. 統計を取得
    const stats = await getImageGenerationStats(c.env.DB, projectId)

    return c.json({
      project_id: parseInt(projectId),
      status: 'generating_images',
      batch_processed: successCount,
      batch_failed: failedCount,
      ...stats
    }, 200)

  } catch (error) {
    console.error('Batch image generation error:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate images'
      }
    }, 500)
  }
})

// GET /api/projects/:id/generate-images/status - 画像生成進捗取得
imageGeneration.get('/projects/:id/generate-images/status', async (c) => {
  try {
    const projectId = c.req.param('id')

    const project = await c.env.DB.prepare(`
      SELECT id, status FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Project not found' }
      }, 404)
    }

    const stats = await getImageGenerationStats(c.env.DB, projectId)

    return c.json({
      project_id: parseInt(projectId),
      status: project.status,
      ...stats
    })

  } catch (error) {
    console.error('Error getting image generation status:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get status' }
    }, 500)
  }
})

// 画像生成統計を取得
async function getImageGenerationStats(db: any, projectId: string) {
  // Total scenes count
  const { results: scenesCount } = await db.prepare(`
    SELECT COUNT(*) as total FROM scenes WHERE project_id = ?
  `).bind(projectId).all()

  const totalScenes = scenesCount[0]?.total || 0

  // Image generation stats
  const { results: imageStats } = await db.prepare(`
    SELECT ig.status, COUNT(*) as count
    FROM image_generations ig
    JOIN scenes s ON ig.scene_id = s.id
    WHERE s.project_id = ? AND ig.is_active = 1
    GROUP BY ig.status
  `).bind(projectId).all()

  const statusMap = new Map(imageStats.map((s: any) => [s.status, s.count]))
  const completed = statusMap.get('completed') || 0
  const failed = statusMap.get('failed') || 0
  const generating = statusMap.get('generating') || 0

  return {
    total_scenes: totalScenes,
    processed: completed,
    failed: failed,
    generating: generating,
    pending: totalScenes - completed - failed - generating
  }
}

// POST /api/scenes/:id/generate-image - 単体画像生成
imageGeneration.post('/scenes/:id/generate-image', async (c) => {
  try {
    const sceneId = c.req.param('id')

    // 1. シーン情報取得
    const scene = await c.env.DB.prepare(`
      SELECT s.id, s.idx, s.image_prompt, s.project_id
      FROM scenes s
      WHERE s.id = ?
    `).bind(sceneId).first()

    if (!scene) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Scene not found'
        }
      }, 404)
    }

    // 2. プロジェクト情報取得
    const project = await c.env.DB.prepare(`
      SELECT id, status FROM projects WHERE id = ?
    `).bind(scene.project_id).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // 3. プロジェクトステータスチェック（formatted以降のみ許可）
    const allowedStatuses = ['formatted', 'generating_images', 'completed']
    if (!allowedStatuses.includes(project.status as string)) {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot generate image for project with status: ${project.status}`,
          details: {
            current_status: project.status,
            allowed_statuses: allowedStatuses
          }
        }
      }, 400)
    }

    // 4. 競合チェック: 既に生成中のレコードがないか確認
    const existingGenerating = await c.env.DB.prepare(`
      SELECT id FROM image_generations
      WHERE scene_id = ? AND status = 'generating'
    `).bind(sceneId).first()

    if (existingGenerating) {
      return c.json({
        error: {
          code: 'ALREADY_GENERATING',
          message: 'Image is already being generated for this scene. Please wait for completion.',
          details: {
            generation_id: existingGenerating.id
          }
        }
      }, 409)
    }

    // 5. スタイル設定取得（優先順位: シーン個別 > プロジェクトデフォルト > 未設定）
    const { fetchSceneStyleSettings, fetchStylePreset, composeFinalPrompt, getEffectiveStylePresetId } = await import('../utils/style-prompt-composer')
    
    const styleSettings = await fetchSceneStyleSettings(
      c.env.DB,
      parseInt(sceneId),
      scene.project_id as number
    )
    
    const effectiveStyleId = getEffectiveStylePresetId(styleSettings)
    const stylePreset = await fetchStylePreset(c.env.DB, effectiveStyleId)
    
    // 6. Phase X-2: Fetch world settings and character info (Optional - no error if missing)
    let enhancedPrompt = buildImagePrompt(scene.image_prompt as string);
    let referenceImages: ReferenceImage[] = [];
    
    try {
      const { fetchWorldSettings, fetchSceneCharacters, enhancePromptWithWorldAndCharacters } = await import('../utils/world-character-helper');
      
      const world = await fetchWorldSettings(c.env.DB, scene.project_id as number);
      const characters = await fetchSceneCharacters(c.env.DB, parseInt(sceneId));
      
      // Enhance prompt with world + character context
      enhancedPrompt = enhancePromptWithWorldAndCharacters(enhancedPrompt, world, characters);
      
      // Phase X-3: キャラクター参照画像を取得
      for (const char of characters) {
        if (char.reference_image_r2_url) {
          try {
            // R2キーを抽出（/images/characters/... → images/characters/...）
            const r2Key = char.reference_image_r2_url.startsWith('/') 
              ? char.reference_image_r2_url.substring(1) 
              : char.reference_image_r2_url;
            
            // R2から画像を取得
            const r2Object = await c.env.R2.get(r2Key);
            if (r2Object) {
              const arrayBuffer = await r2Object.arrayBuffer();
              const base64Data = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
              const mimeType = r2Object.httpMetadata?.contentType || 'image/png';
              
              referenceImages.push({
                base64Data,
                mimeType,
                characterName: char.character_name || char.character_key
              });
              
              console.log('[Image Gen] Loaded character reference:', {
                character: char.character_name || char.character_key,
                r2Key,
                sizeBytes: arrayBuffer.byteLength
              });
            }
          } catch (refError) {
            console.warn('[Image Gen] Failed to load character reference image:', {
              character: char.character_name || char.character_key,
              error: refError
            });
          }
        }
      }
      
      console.log('[Image Gen] Phase X-2/X-3 enhancement:', {
        has_world: !!world,
        character_count: characters.length,
        reference_images_loaded: referenceImages.length,
        enhanced: enhancedPrompt !== buildImagePrompt(scene.image_prompt as string)
      });
    } catch (error) {
      // Phase X-2: Fallback to original prompt if enhancement fails (no breaking change)
      console.warn('[Image Gen] Phase X-2 enhancement failed, using original prompt:', error);
    }
    
    // 7. 最終プロンプト生成（スタイル適用）
    const finalPrompt = composeFinalPrompt(enhancedPrompt, stylePreset)

    // 7. image_generationsレコード作成（pending状態）
    const insertResult = await c.env.DB.prepare(`
      INSERT INTO image_generations (
        scene_id, prompt, status, provider, model, is_active
      ) VALUES (?, ?, 'pending', 'gemini', 'gemini-3-pro-image-preview', 0)
    `).bind(sceneId, finalPrompt).run()

    const generationId = insertResult.meta.last_row_id as number

    // 8. ステータスを 'generating' に更新
    await c.env.DB.prepare(`
      UPDATE image_generations SET status = 'generating' WHERE id = ?
    `).bind(generationId).run()

    // 9. Gemini APIで画像生成（キャラクター参照画像付き、429リトライ付き）
    const imageResult = await generateImageWithRetry(
      finalPrompt,
      c.env.GEMINI_API_KEY,
      3,
      referenceImages
    )

    if (!imageResult.success) {
      // 生成失敗 → status = 'failed', error_message保存
      await c.env.DB.prepare(`
        UPDATE image_generations 
        SET status = 'failed', error_message = ?
        WHERE id = ?
      `).bind(imageResult.error || 'Unknown error', generationId).run()

      return c.json({
        error: {
          code: 'GENERATION_FAILED',
          message: imageResult.error || 'Failed to generate image'
        }
      }, 500)
    }

    // 10. R2に画像保存
    const r2Key = buildR2Key(
      scene.project_id as number,
      scene.idx as number,
      generationId
    )

    try {
      await c.env.R2.put(r2Key, imageResult.imageData!)
    } catch (r2Error) {
      console.error('R2 upload failed:', r2Error)

      await c.env.DB.prepare(`
        UPDATE image_generations 
        SET status = 'failed', error_message = 'R2 upload failed'
        WHERE id = ?
      `).bind(generationId).run()

      return c.json({
        error: {
          code: 'STORAGE_FAILED',
          message: 'Failed to save image to storage'
        }
      }, 500)
    }

    // 11. 既存のアクティブ画像を無効化
    await c.env.DB.prepare(`
      UPDATE image_generations 
      SET is_active = 0 
      WHERE scene_id = ? AND id != ? AND is_active = 1
    `).bind(sceneId, generationId).run()

    // 12. 新しい画像をアクティブ化、status = 'completed'
    // r2_key がすでに "images/" で始まっているので、"/" だけ追加
    const r2Url = `/${r2Key}`
    
    const updateResult = await c.env.DB.prepare(`
      UPDATE image_generations 
      SET status = 'completed', r2_key = ?, r2_url = ?, is_active = 1
      WHERE id = ?
    `).bind(r2Key, r2Url, generationId).run()

    // ✅ DB更新失敗時の検証
    if (!updateResult.success) {
      console.error(`DB update failed for generation ${generationId}:`, updateResult)
      throw new Error('Failed to update image generation record')
    }

    // ✅ r2_url が null でないことを確認
    const verifyResult = await c.env.DB.prepare(`
      SELECT r2_url FROM image_generations WHERE id = ?
    `).bind(generationId).first()

    if (!verifyResult || !verifyResult.r2_url) {
      console.error(`r2_url is null after update for generation ${generationId}`)
      await c.env.DB.prepare(`
        UPDATE image_generations 
        SET status = 'failed', error_message = 'R2 URL update failed'
        WHERE id = ?
      `).bind(generationId).run()
      throw new Error('r2_url is null after DB update')
    }

    // 13. レスポンス返却
    return c.json({
      scene_id: parseInt(sceneId),
      image_generation_id: generationId,
      status: 'completed',
      r2_key: r2Key,
      r2_url: r2Url,
      is_active: true
    }, 200)

  } catch (error) {
    console.error('Error in generate-image endpoint:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate image'
      }
    }, 500)
  }
})

// POST /api/projects/:id/generate-all-images - 一括画像生成
imageGeneration.post('/:id/generate-all-images', async (c) => {
  try {
    const projectId = c.req.param('id')
    const body = await c.req.json().catch(() => ({ mode: 'all' }))
    const mode = body.mode || 'all' // 'all' | 'pending' | 'failed'

    // 1. プロジェクト情報取得
    const project = await c.env.DB.prepare(`
      SELECT id, status FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // 2. ステータスチェック（formatted以降のみ許可）
    const allowedStatuses = ['formatted', 'generating_images', 'completed']
    if (!allowedStatuses.includes(project.status as string)) {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot generate images for project with status: ${project.status}`
        }
      }, 400)
    }

    // 3. ステータスを 'generating_images' に更新
    if (project.status === 'formatted') {
      await c.env.DB.prepare(`
        UPDATE projects SET status = 'generating_images', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(projectId).run()
    }

    // 4. 対象シーン取得
    let targetScenes: any[] = []
    
    if (mode === 'all') {
      // 全シーン
      const { results } = await c.env.DB.prepare(`
        SELECT id, idx, image_prompt FROM scenes
        WHERE project_id = ?
        ORDER BY idx ASC
      `).bind(projectId).all()
      targetScenes = results
    } else if (mode === 'pending') {
      // アクティブな画像がないシーン
      const { results } = await c.env.DB.prepare(`
        SELECT s.id, s.idx, s.image_prompt
        FROM scenes s
        LEFT JOIN image_generations ig ON s.id = ig.scene_id AND ig.is_active = 1
        WHERE s.project_id = ? AND ig.id IS NULL
        ORDER BY s.idx ASC
      `).bind(projectId).all()
      targetScenes = results
    } else if (mode === 'failed') {
      // 最後の生成が失敗したシーン
      const { results } = await c.env.DB.prepare(`
        SELECT s.id, s.idx, s.image_prompt
        FROM scenes s
        INNER JOIN (
          SELECT scene_id, MAX(id) as max_id
          FROM image_generations
          GROUP BY scene_id
        ) latest ON s.id = latest.scene_id
        INNER JOIN image_generations ig ON ig.id = latest.max_id
        WHERE s.project_id = ? AND ig.status = 'failed'
        ORDER BY s.idx ASC
      `).bind(projectId).all()
      targetScenes = results
    }

    const totalScenes = targetScenes.length

    if (totalScenes === 0) {
      return c.json({
        project_id: parseInt(projectId),
        total_scenes: 0,
        target_scenes: 0,
        mode,
        status: project.status,
        message: 'No scenes to generate'
      }, 200)
    }

    // 5. 各シーンで画像生成（順次実行）
    let successCount = 0
    let failedCount = 0
    
    // ヘルパー関数をインポート
    const { fetchSceneCharacters } = await import('../utils/world-character-helper');

    for (const scene of targetScenes) {
      try {
        const finalPrompt = buildImagePrompt(scene.image_prompt as string)
        
        // Phase X-3: キャラクター参照画像を取得
        let referenceImages: ReferenceImage[] = [];
        try {
          const characters = await fetchSceneCharacters(c.env.DB, scene.id as number);
          
          for (const char of characters) {
            if (char.reference_image_r2_url) {
              try {
                const r2Key = char.reference_image_r2_url.startsWith('/') 
                  ? char.reference_image_r2_url.substring(1) 
                  : char.reference_image_r2_url;
                
                const r2Object = await c.env.R2.get(r2Key);
                if (r2Object) {
                  const arrayBuffer = await r2Object.arrayBuffer();
                  const base64Data = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
                  const mimeType = r2Object.httpMetadata?.contentType || 'image/png';
                  
                  referenceImages.push({
                    base64Data,
                    mimeType,
                    characterName: char.character_name || char.character_key
                  });
                }
              } catch (refError) {
                console.warn(`[Batch Image Gen] Failed to load ref for ${char.character_key}:`, refError);
              }
            }
          }
          
          console.log(`[Batch Image Gen] Scene ${scene.id}: ${referenceImages.length} character refs loaded`);
        } catch (charError) {
          console.warn(`[Batch Image Gen] Failed to fetch characters for scene ${scene.id}:`, charError);
        }

        // image_generationsレコード作成
        const insertResult = await c.env.DB.prepare(`
          INSERT INTO image_generations (
            scene_id, prompt, status, provider, model, is_active
          ) VALUES (?, ?, 'generating', 'gemini', 'gemini-3-pro-image-preview', 0)
        `).bind(scene.id, finalPrompt).run()

        const generationId = insertResult.meta.last_row_id as number

        // Gemini APIで画像生成（キャラクター参照画像付き）
        const imageResult = await generateImageWithRetry(
          finalPrompt,
          c.env.GEMINI_API_KEY,
          3,
          referenceImages
        )

        if (!imageResult.success) {
          // 失敗
          await c.env.DB.prepare(`
            UPDATE image_generations 
            SET status = 'failed', error_message = ?
            WHERE id = ?
          `).bind(imageResult.error || 'Unknown error', generationId).run()
          
          failedCount++
          continue
        }

        // R2に保存
        const r2Key = buildR2Key(parseInt(projectId), scene.idx as number, generationId)
        await c.env.R2.put(r2Key, imageResult.imageData!)

        // 既存のアクティブ画像を無効化
        await c.env.DB.prepare(`
          UPDATE image_generations 
          SET is_active = 0 
          WHERE scene_id = ? AND id != ? AND is_active = 1
        `).bind(scene.id, generationId).run()

        // 新しい画像をアクティブ化
        await c.env.DB.prepare(`
          UPDATE image_generations 
          SET status = 'completed', r2_key = ?, is_active = 1
          WHERE id = ?
        `).bind(r2Key, generationId).run()

        successCount++

      } catch (sceneError) {
        console.error(`Failed to generate image for scene ${scene.id}:`, sceneError)
        failedCount++
      }
    }

    // 6. 全て成功した場合、プロジェクトステータスを 'completed' に更新
    if (successCount === totalScenes && failedCount === 0) {
      await c.env.DB.prepare(`
        UPDATE projects SET status = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(projectId).run()
    }

    // 7. レスポンス返却
    return c.json({
      project_id: parseInt(projectId),
      total_scenes: totalScenes,
      success_count: successCount,
      failed_count: failedCount,
      mode,
      status: successCount === totalScenes ? 'completed' : 'generating_images'
    }, 200)

  } catch (error) {
    console.error('Error in generate-all-images endpoint:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate images'
      }
    }, 500)
  }
})

/**
 * Gemini APIで画像生成（429リトライ付き）
 * 公式仕様: generateContent エンドポイント
 * キャラクター参照画像をサポート（最大5枚）
 */
async function generateImageWithRetry(
  prompt: string,
  apiKey: string,
  maxRetries: number = 3,
  referenceImages: ReferenceImage[] = []
): Promise<{
  success: boolean
  imageData?: ArrayBuffer
  error?: string
}> {
  let lastError: string = ''

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // パーツを構築：参照画像 + テキストプロンプト
      const parts: any[] = []
      
      // キャラクター参照画像を追加（最大5枚）
      const limitedImages = referenceImages.slice(0, 5)
      for (const refImg of limitedImages) {
        parts.push({
          inline_data: {
            data: refImg.base64Data,
            mime_type: refImg.mimeType
          }
        })
      }
      
      // キャラクター参照の説明をプロンプトに追加
      // 日本語テキスト生成を明示的に指定
      const japaneseTextInstruction = 'IMPORTANT: Any text, signs, or labels in the image MUST be written in Japanese (日本語). Do NOT use English text.'
      
      let enhancedPrompt = prompt
      if (limitedImages.length > 0) {
        const charNames = limitedImages
          .filter(img => img.characterName)
          .map(img => img.characterName)
          .join(', ')
        if (charNames) {
          enhancedPrompt = `${japaneseTextInstruction}\n\nUsing the provided reference images for character consistency (${charNames}), generate: ${prompt}`
        } else {
          enhancedPrompt = `${japaneseTextInstruction}\n\nUsing the provided reference images for character consistency, generate: ${prompt}`
        }
      } else {
        enhancedPrompt = `${japaneseTextInstruction}\n\n${prompt}`
      }
      
      // テキストプロンプトを追加
      parts.push({ text: enhancedPrompt })
      
      console.log('[Gemini Image Gen] Request:', {
        referenceImageCount: limitedImages.length,
        promptLength: enhancedPrompt.length,
        hasCharacterRefs: limitedImages.some(img => img.characterName)
      })

      // Gemini API公式仕様: generateContent
      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent',
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [
              {
                parts: parts
              }
            ],
            generationConfig: {
              responseModalities: ['Image'],
              imageConfig: {
                aspectRatio: '16:9',
                imageSize: '2K'
              }
            }
          })
        }
      )

      // 429エラー時はリトライ
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After')
        const waitTime = retryAfter 
          ? parseInt(retryAfter) * 1000 
          : Math.pow(2, attempt) * 1000 // 指数バックオフ: 1s, 2s, 4s

        console.warn(`Rate limited (429). Retrying after ${waitTime}ms... (attempt ${attempt + 1}/${maxRetries})`)
        
        if (attempt < maxRetries - 1) {
          await sleep(waitTime)
          continue
        } else {
          lastError = 'Rate limit exceeded after max retries'
          break
        }
      }

      // その他のエラー
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        
        // 詳細なエラー情報を構築
        const errorDetails = {
          status: response.status,
          message: errorData.error?.message || `API error: ${response.status}`,
          code: errorData.error?.code || 'UNKNOWN',
          details: errorData.error?.details || null
        }
        
        // JSON形式でエラーを保存（省略なし）
        lastError = JSON.stringify(errorDetails)
        console.error('Gemini API error (full details):', {
          httpStatus: response.status,
          errorCode: errorDetails.code,
          errorMessage: errorDetails.message,
          errorDetails: errorDetails.details,
          prompt: prompt.substring(0, 100) + '...'
        })
        break
      }

      // 成功: レスポンスから画像データを取得
      const result = await response.json()
      
      // candidates[0].content.parts から inlineData.data を取得
      if (result.candidates && result.candidates.length > 0) {
        const parts = result.candidates[0].content?.parts || []
        
        for (const part of parts) {
          if (part.inlineData && part.inlineData.data) {
            // base64デコード: atob (Web標準、Cloudflare Workers対応)
            const base64Data = part.inlineData.data
            const binaryString = atob(base64Data)
            const bytes = new Uint8Array(binaryString.length)
            
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i)
            }
            
            console.log('Image generation success:', {
              model: 'gemini-3-pro-image-preview',
              endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent',
              promptLength: prompt.length,
              imageSize: '2K',
              aspectRatio: '16:9',
              dataSizeBytes: bytes.buffer.byteLength
            })
            
            return {
              success: true,
              imageData: bytes.buffer
            }
          }
        }
        
        lastError = 'No inline data in response parts'
        break
      } else {
        lastError = 'No candidates in response'
        break
      }

    } catch (error) {
      const errorDetails = {
        type: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : null,
        attempt: attempt + 1,
        maxRetries
      }
      
      lastError = JSON.stringify(errorDetails)
      console.error(`Image generation attempt ${attempt + 1} failed (full details):`, {
        errorType: errorDetails.type,
        errorMessage: errorDetails.message,
        attempt: errorDetails.attempt,
        maxRetries: errorDetails.maxRetries,
        promptLength: prompt.length
      })
      
      // 最後の試行でない場合はリトライ
      if (attempt < maxRetries - 1) {
        await sleep(Math.pow(2, attempt) * 1000)
        continue
      }
    }
  }

  return {
    success: false,
    error: lastError
  }
}

// Sleep utility
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export default imageGeneration
