import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'

const projects = new Hono<{ Bindings: Bindings }>()

// POST /api/projects - プロジェクト作成
projects.post('/', async (c) => {
  try {
    const { title } = await c.req.json()

    if (!title || title.trim() === '') {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Title is required',
          details: {
            field: 'title',
            constraint: 'required'
          }
        }
      }, 400)
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO projects (title, status) 
      VALUES (?, 'created')
    `).bind(title.trim()).run()

    const projectId = result.meta.last_row_id as number

    // Set default style preset to "インフォグラフィック" (ID=9)
    // Query to find "インフォグラフィック" style preset
    const defaultStyle = await c.env.DB.prepare(`
      SELECT id FROM style_presets 
      WHERE name = 'インフォグラフィック' AND is_active = 1
      LIMIT 1
    `).first()

    if (defaultStyle) {
      await c.env.DB.prepare(`
        INSERT INTO project_style_settings (project_id, default_style_preset_id)
        VALUES (?, ?)
      `).bind(projectId, defaultStyle.id).run()
    }

    // Phase B-2: Auto-create Run #1 for new project
    const runResult = await c.env.DB.prepare(`
      INSERT INTO runs (project_id, run_no, state, title, source_type)
      VALUES (?, 1, 'draft', 'Run #1', 'text')
    `).bind(projectId).run()

    const runId = runResult.meta.last_row_id as number

    const project = await c.env.DB.prepare(`
      SELECT id, title, status, created_at
      FROM projects
      WHERE id = ?
    `).bind(projectId).first()

    return c.json({
      ...project,
      run_id: runId
    }, 201)
  } catch (error) {
    console.error('Error creating project:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create project'
      }
    }, 500)
  }
})

// POST /api/projects/:id/upload - 音声アップロード
projects.post('/:id/upload', async (c) => {
  try {
    const projectId = c.req.param('id')

    // プロジェクト存在確認
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

    // ファイル取得
    const formData = await c.req.formData()
    const audioFile = formData.get('audio') as File

    if (!audioFile) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Audio file is required',
          details: {
            field: 'audio',
            constraint: 'required'
          }
        }
      }, 400)
    }

    // ファイル形式チェック
    const allowedExtensions = ['.mp3', '.wav', '.m4a', '.ogg', '.webm']
    const fileName = audioFile.name.toLowerCase()
    const isValidFormat = allowedExtensions.some(ext => fileName.endsWith(ext))

    if (!isValidFormat) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid file format. Supported formats: MP3, WAV, M4A, OGG, WebM',
          details: {
            field: 'audio',
            constraint: 'format',
            allowed: allowedExtensions
          }
        }
      }, 400)
    }

    // ファイルサイズチェック (25MB)
    const maxSize = 25 * 1024 * 1024
    if (audioFile.size > maxSize) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'File size exceeds 25MB limit',
          details: {
            field: 'audio',
            constraint: 'size',
            maxSize: maxSize,
            actualSize: audioFile.size
          }
        }
      }, 400)
    }

    // R2キー生成: audio/{project_id}/{filename}_{timestamp}_{random}.{ext}
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(7)
    const extension = fileName.substring(fileName.lastIndexOf('.'))
    const cleanFileName = fileName.substring(0, fileName.lastIndexOf('.')).replace(/[^a-zA-Z0-9_-]/g, '_')
    const r2Key = `audio/${projectId}/${cleanFileName}_${timestamp}_${random}${extension}`

    // R2にアップロード
    await c.env.R2.put(r2Key, audioFile.stream(), {
      httpMetadata: {
        contentType: audioFile.type
      }
    })

    // DB更新 (CRITICAL: source_type='audio' must be set for proper flow detection)
    await c.env.DB.prepare(`
      UPDATE projects
      SET audio_r2_key = ?,
          audio_filename = ?,
          audio_size_bytes = ?,
          source_type = 'audio',
          status = 'uploaded',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(r2Key, audioFile.name, audioFile.size, projectId).run()

    // 更新後のプロジェクト取得
    const updatedProject = await c.env.DB.prepare(`
      SELECT id, title, status, audio_filename, audio_size_bytes, audio_r2_key, updated_at
      FROM projects
      WHERE id = ?
    `).bind(projectId).first()

    return c.json(updatedProject, 200)
  } catch (error) {
    console.error('Error uploading audio:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to upload audio file'
      }
    }, 500)
  }
})

// GET /api/projects - プロジェクト一覧
projects.get('/', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(`
      SELECT id, title, status, audio_filename, audio_r2_key, audio_size_bytes, created_at, updated_at
      FROM projects
      ORDER BY created_at DESC
    `).all()

    return c.json({ projects: results })
  } catch (error) {
    console.error('Error fetching projects:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch projects'
      }
    }, 500)
  }
})

// GET /api/projects/:id - プロジェクト詳細
projects.get('/:id', async (c) => {
  try {
    const projectId = c.req.param('id')

    const project = await c.env.DB.prepare(`
      SELECT 
        p.id,
        p.title,
        p.status,
        p.source_type,
        p.source_text,
        p.audio_filename,
        p.audio_size_bytes,
        p.audio_duration_seconds,
        p.audio_r2_key,
        p.created_at,
        p.updated_at,
        p.source_updated_at
      FROM projects p
      WHERE p.id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    return c.json(project)
  } catch (error) {
    console.error('Error fetching project:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch project'
      }
    }, 500)
  }
})

// POST /api/projects/:id/source/text - テキスト入力保存
projects.post('/:id/source/text', async (c) => {
  try {
    const projectId = c.req.param('id')
    const { text } = await c.req.json()

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

    // バリデーション
    if (!text || text.trim() === '') {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Text is required',
          details: {
            field: 'text',
            constraint: 'required'
          }
        }
      }, 400)
    }

    // テキスト保存（uploadedステータスに変更）
    await c.env.DB.prepare(`
      UPDATE projects
      SET source_type = 'text',
          source_text = ?,
          status = 'uploaded',
          source_updated_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(text.trim(), projectId).run()

    // 更新後のプロジェクト取得
    const updatedProject = await c.env.DB.prepare(`
      SELECT id, title, status, source_type, source_updated_at, updated_at
      FROM projects
      WHERE id = ?
    `).bind(projectId).first()

    return c.json(updatedProject, 200)
  } catch (error) {
    console.error('Error saving source text:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to save source text'
      }
    }, 500)
  }
})

// GET /api/projects/:id/scenes - シーン一覧取得（idx順）
// Query params: ?view=edit (軽量版、画像情報なし), ?view=board (Builder用、最小画像情報)
projects.get('/:id/scenes', async (c) => {
  try {
    const projectId = c.req.param('id')
    const view = c.req.query('view') || 'full' // デフォルトは完全版（後方互換）

    // プロジェクト存在確認
    const project = await c.env.DB.prepare(`
      SELECT id, title, status
      FROM projects
      WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // シーン一覧取得（idx順、スタイル設定含む）
    // Phase1.7: display_asset_type, comic_data を追加
    const { results: scenes } = await c.env.DB.prepare(`
      SELECT 
        s.id, s.idx, s.role, s.title, s.dialogue, s.bullets, s.image_prompt, 
        s.chunk_id, s.created_at, s.updated_at, s.display_asset_type, s.comic_data,
        sss.style_preset_id
      FROM scenes s
      LEFT JOIN scene_style_settings sss ON s.id = sss.scene_id
      WHERE s.project_id = ?
      ORDER BY s.idx ASC
    `).bind(projectId).all()

    // view=edit: 画像情報なし（Scene Split用、超軽量）
    if (view === 'edit') {
      return c.json({
        project_id: parseInt(projectId),
        total_scenes: scenes.length,
        scenes: scenes.map((scene: any) => ({
          id: scene.id,
          idx: scene.idx,
          role: scene.role,
          title: scene.title,
          dialogue: scene.dialogue,
          bullets: JSON.parse(scene.bullets),
          image_prompt: scene.image_prompt,
          chunk_id: scene.chunk_id
        }))
      })
    }

    // view=board: 最小画像情報のみ（Builder用、軽量）+ キャラクター情報
    // Phase1.7: display_asset_type と active_comic を追加
    if (view === 'board') {
      const scenesWithMinimalImages = await Promise.all(
        scenes.map(async (scene: any) => {
          // アクティブAI画像（asset_type='ai' または NULL）
          const activeRecord = await c.env.DB.prepare(`
            SELECT r2_key, r2_url FROM image_generations
            WHERE scene_id = ? AND is_active = 1 AND (asset_type = 'ai' OR asset_type IS NULL)
            LIMIT 1
          `).bind(scene.id).first()

          // アクティブ漫画画像（asset_type='comic'）
          const activeComicRecord = await c.env.DB.prepare(`
            SELECT id, r2_key, r2_url FROM image_generations
            WHERE scene_id = ? AND is_active = 1 AND asset_type = 'comic'
            LIMIT 1
          `).bind(scene.id).first()

          // 最新ステータス＋エラーメッセージ＋r2情報（AI画像のみ）
          const latestRecord = await c.env.DB.prepare(`
            SELECT status, r2_key, r2_url, substr(error_message, 1, 80) as error_message
            FROM image_generations
            WHERE scene_id = ? AND (asset_type = 'ai' OR asset_type IS NULL)
            ORDER BY created_at DESC
            LIMIT 1
          `).bind(scene.id).first()

          // アクティブ動画（is_active=1 または 最新の completed）
          const activeVideo = await c.env.DB.prepare(`
            SELECT id, status, r2_url, model, duration_sec
            FROM video_generations
            WHERE scene_id = ? AND (is_active = 1 OR (status = 'completed' AND r2_url IS NOT NULL))
            ORDER BY is_active DESC, created_at DESC
            LIMIT 1
          `).bind(scene.id).first()

          // comic_dataのパース
          let comicData = null
          try {
            if (scene.comic_data) {
              comicData = JSON.parse(scene.comic_data)
            }
          } catch (e) {
            console.warn(`Failed to parse comic_data for scene ${scene.id}:`, e)
          }

          // キャラクター情報取得（scene_character_map + project_character_models）
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
          `).bind(projectId, scene.id).all()

          // SSOT: voice_character = is_primary=1 のキャラクター
          // voice_preset_id がなくても、is_primary=1 なら voice_character として返す
          const voiceCharacter = characterMappings.find((c: any) => c.is_primary === 1)
            || (characterMappings.length > 0 ? characterMappings[0] : null)
            || null

          return {
            id: scene.id,
            idx: scene.idx,
            role: scene.role,
            title: scene.title,
            dialogue: scene.dialogue.substring(0, 100), // 最初の100文字のみ
            bullets: JSON.parse(scene.bullets),
            image_prompt: scene.image_prompt.substring(0, 100), // 最初の100文字のみ
            style_preset_id: scene.style_preset_id || null,
            // Phase1.7: display_asset_type と active_comic を追加
            display_asset_type: scene.display_asset_type || 'image',
            comic_data: comicData,
            active_image: activeRecord ? { 
              r2_key: activeRecord.r2_key,
              r2_url: activeRecord.r2_url,
              image_url: activeRecord.r2_url || `/${activeRecord.r2_key}` 
            } : null,
            // Phase1.7: 漫画画像情報
            active_comic: activeComicRecord ? {
              id: activeComicRecord.id,
              r2_key: activeComicRecord.r2_key,
              r2_url: activeComicRecord.r2_url,
              image_url: activeComicRecord.r2_url || `/${activeComicRecord.r2_key}`
            } : null,
            // Phase1.7: display_image SSOT（display_asset_typeに基づく採用素材）
            display_image: (() => {
              const displayType = scene.display_asset_type || 'image';
              if (displayType === 'comic' && activeComicRecord) {
                return {
                  type: 'comic',
                  r2_url: activeComicRecord.r2_url,
                  image_url: activeComicRecord.r2_url || `/${activeComicRecord.r2_key}`
                };
              }
              if (activeRecord) {
                return {
                  type: 'image',
                  r2_url: activeRecord.r2_url,
                  image_url: activeRecord.r2_url || `/${activeRecord.r2_key}`
                };
              }
              return null;
            })(),
            latest_image: latestRecord ? {
              status: latestRecord.status,
              r2_key: latestRecord.r2_key,
              r2_url: latestRecord.r2_url,
              image_url: latestRecord.r2_url || (latestRecord.r2_key ? `/${latestRecord.r2_key}` : null),
              error_message: latestRecord.error_message
            } : null,
            active_video: activeVideo ? {
              id: activeVideo.id,
              status: activeVideo.status,
              r2_url: activeVideo.r2_url,
              model: activeVideo.model,
              duration_sec: activeVideo.duration_sec
            } : null,
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
          }
        })
      )

      return c.json({
        project_id: parseInt(projectId),
        total_scenes: scenes.length,
        scenes: scenesWithMinimalImages
      })
    }

    // デフォルト（full）: 完全版（既存の動作、後方互換）
    const scenesWithImages = await Promise.all(
      scenes.map(async (scene: any) => {
        // 1) アクティブな画像（表示用）
        const activeRecord = await c.env.DB.prepare(`
          SELECT id, prompt, r2_key, status, created_at
          FROM image_generations
          WHERE scene_id = ? AND is_active = 1
          ORDER BY created_at DESC
          LIMIT 1
        `).bind(scene.id).first()

        const activeImage = activeRecord ? {
          id: activeRecord.id,
          prompt: activeRecord.prompt,
          image_url: `/${activeRecord.r2_key}`, // SSOT: "/" + r2_key
          status: activeRecord.status,
          created_at: activeRecord.created_at
        } : null

        // 2) 最新の画像生成レコード（ステータス表示用、is_active無関係）
        const latestRecord = await c.env.DB.prepare(`
          SELECT id, status, error_message, created_at
          FROM image_generations
          WHERE scene_id = ?
          ORDER BY created_at DESC
          LIMIT 1
        `).bind(scene.id).first()

        const latestImage = latestRecord ? {
          id: latestRecord.id,
          status: latestRecord.status,
          error_message: latestRecord.error_message,
          created_at: latestRecord.created_at
        } : null

        return {
          id: scene.id,
          idx: scene.idx,
          role: scene.role,
          title: scene.title,
          dialogue: scene.dialogue,
          bullets: JSON.parse(scene.bullets),
          image_prompt: scene.image_prompt,
          created_at: scene.created_at,
          updated_at: scene.updated_at,
          active_image: activeImage,
          latest_image: latestImage // ステータスバッジ用
        }
      })
    )

    return c.json({
      project_id: parseInt(projectId),
      total_scenes: scenes.length,
      scenes: scenesWithImages
    })
  } catch (error) {
    console.error('Error fetching scenes:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch scenes'
      }
    }, 500)
  }
})

// DELETE /api/projects/:id - プロジェクト削除（堅牢版：明示的な子テーブル削除）
projects.delete('/:id', async (c) => {
  try {
    const projectId = c.req.param('id')

    // PRAGMA foreign_keys を有効化（D1では自動有効だが念のため）
    try {
      await c.env.DB.prepare('PRAGMA foreign_keys = ON').run()
    } catch (error) {
      console.warn('PRAGMA foreign_keys = ON failed (might be auto-enabled):', error)
    }

    // プロジェクト存在確認
    const project = await c.env.DB.prepare(`
      SELECT id, audio_r2_key FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // ===== R2削除（ベストエフォート） =====
    
    // R2から音声ファイル削除
    if (project.audio_r2_key) {
      try {
        await c.env.R2.delete(project.audio_r2_key)
        console.log(`Deleted audio from R2: ${project.audio_r2_key}`)
      } catch (error) {
        console.error('Error deleting audio from R2:', error)
      }
    }

    // R2から画像ファイル削除
    try {
      const { results: imageGenerations } = await c.env.DB.prepare(`
        SELECT DISTINCT r2_key FROM image_generations 
        WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
        AND r2_key IS NOT NULL
      `).bind(projectId).all()

      let deletedCount = 0
      for (const img of imageGenerations) {
        try {
          await c.env.R2.delete(img.r2_key)
          deletedCount++
        } catch (error) {
          console.error(`Error deleting image from R2 (${img.r2_key}):`, error)
        }
      }
      console.log(`Deleted ${deletedCount}/${imageGenerations.length} images from R2`)
    } catch (error) {
      console.error('Error fetching/deleting images:', error)
    }

    // ===== DB削除（明示的 + CASCADE保険） =====
    
    try {
      // 1. image_generations を明示削除（scene_id経由）
      await c.env.DB.prepare(`
        DELETE FROM image_generations 
        WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
      `).bind(projectId).run()
      
      // 2. scenes を明示削除
      await c.env.DB.prepare(`
        DELETE FROM scenes WHERE project_id = ?
      `).bind(projectId).run()
      
      // 3. transcriptions を明示削除
      await c.env.DB.prepare(`
        DELETE FROM transcriptions WHERE project_id = ?
      `).bind(projectId).run()
      
      // 4. 最後に projects を削除
      await c.env.DB.prepare(`
        DELETE FROM projects WHERE id = ?
      `).bind(projectId).run()
      
      console.log(`Project ${projectId} and all related data deleted successfully`)
    } catch (dbError) {
      console.error('Error during DB deletion:', dbError)
      throw new Error(`Database deletion failed: ${dbError}`)
    }

    return c.json({
      success: true,
      message: 'Project deleted successfully',
      deleted_project_id: parseInt(projectId)
    })
  } catch (error) {
    console.error('Error deleting project:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete project',
        details: error instanceof Error ? error.message : String(error)
      }
    }, 500)
  }
})

// POST /api/projects/:id/reset - プロジェクトを失敗状態からリセット
projects.post('/:id/reset', async (c) => {
  try {
    const projectId = c.req.param('id')

    // プロジェクト存在確認
    const project = await c.env.DB.prepare(`
      SELECT id, status, source_type, source_text, audio_r2_key
      FROM projects
      WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // リセット可能な状態チェック（failedのみ）
    if (project.status !== 'failed') {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: 'Can only reset failed projects',
          details: {
            current_status: project.status
          }
        }
      }, 400)
    }

    // リセット先のステータスを決定
    let resetStatus = 'created'
    
    if (project.source_type === 'text' && project.source_text) {
      // テキスト入力済み → uploaded
      resetStatus = 'uploaded'
    } else if (project.source_type === 'audio' && project.audio_r2_key) {
      // 音声アップロード済み → uploaded
      resetStatus = 'uploaded'
    } else {
      // 入力なし → created
      resetStatus = 'created'
    }

    // ステータスをリセット
    await c.env.DB.prepare(`
      UPDATE projects
      SET status = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(resetStatus, projectId).run()

    // 更新後のプロジェクト取得
    const updatedProject = await c.env.DB.prepare(`
      SELECT id, title, status, source_type, created_at, updated_at
      FROM projects
      WHERE id = ?
    `).bind(projectId).first()

    return c.json({
      success: true,
      message: 'Project reset successfully',
      project: updatedProject,
      reset_from: 'failed',
      reset_to: resetStatus
    }, 200)
  } catch (error) {
    console.error('Error resetting project:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to reset project'
      }
    }, 500)
  }
})

// GET /api/projects/:id/reset-to-input/preview - 入力からやり直しのプレビュー
projects.get('/:id/reset-to-input/preview', async (c) => {
  try {
    const projectId = c.req.param('id')

    // プロジェクト存在確認
    const project = await c.env.DB.prepare(`
      SELECT id, title, status, source_type, source_text, audio_r2_key
      FROM projects
      WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Project not found' }
      }, 404)
    }

    // 削除される項目をカウント + 動画・漫画の存在チェック
    const [chunksCount, scenesCount, imagesCount, audiosCount, videosCount, videoBuildCount, comicCount] = await Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM text_chunks WHERE project_id = ?`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM scenes WHERE project_id = ?`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM image_generations WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM audio_generations WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM video_generations WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM video_builds WHERE project_id = ?`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM scenes WHERE project_id = ? AND comic_data IS NOT NULL`).bind(projectId).first()
    ])

    const videoBuildExists = ((videoBuildCount as any)?.count || 0) > 0
    const comicExists = ((comicCount as any)?.count || 0) > 0
    const sceneVideosExist = ((videosCount as any)?.count || 0) > 0

    // リセット可能条件:
    // 1. ステータスがリセット可能なもの
    // 2. Video Build（最終動画）が存在しない
    // 3. 漫画化データが存在しない
    // 4. シーン動画が存在しない
    const resetableStatuses = ['uploaded', 'transcribed', 'parsing', 'parsed', 'formatting', 'formatted', 'completed', 'failed']
    const statusOk = resetableStatuses.includes(project.status as string)
    const canReset = statusOk && !videoBuildExists && !comicExists && !sceneVideosExist

    // リセット不可の理由
    let blockReason = null
    if (!statusOk) {
      blockReason = `現在のステータス（${project.status}）ではリセットできません`
    } else if (videoBuildExists) {
      blockReason = '最終動画（Video Build）が作成済みのため、リセットできません。動画を削除してから再度お試しください。'
    } else if (comicExists) {
      blockReason = '漫画化データが存在するため、リセットできません。漫画データを削除してから再度お試しください。'
    } else if (sceneVideosExist) {
      blockReason = 'シーン動画が生成済みのため、リセットできません。動画を削除してから再度お試しください。'
    }

    return c.json({
      project: {
        id: project.id,
        title: project.title,
        status: project.status,
        source_type: project.source_type
      },
      can_reset: canReset,
      block_reason: blockReason,
      has_video_build: videoBuildExists,
      has_comic: comicExists,
      has_scene_videos: sceneVideosExist,
      will_delete: {
        chunks: (chunksCount as any)?.count || 0,
        scenes: (scenesCount as any)?.count || 0,
        images: (imagesCount as any)?.count || 0,
        audios: (audiosCount as any)?.count || 0,
        videos: (videosCount as any)?.count || 0
      },
      will_preserve: {
        source_text: project.source_type === 'text' && !!project.source_text,
        audio_r2_key: project.source_type === 'audio' && !!project.audio_r2_key,
        characters: 0, // 後で実際のカウントを取得
        world_settings: 0,
        style_settings: 0,
        video_builds: (videoBuildCount as any)?.count || 0 // Video Buildは保持される
      }
    })
  } catch (error) {
    console.error('Error in reset-to-input preview:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get reset preview' }
    }, 500)
  }
})

// POST /api/projects/:id/reset-to-input - 入力からやり直し（シーン・チャンクを削除）
projects.post('/:id/reset-to-input', async (c) => {
  try {
    const projectId = c.req.param('id')

    // プロジェクト存在確認
    const project = await c.env.DB.prepare(`
      SELECT id, title, status, source_type, source_text, audio_r2_key
      FROM projects
      WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Project not found' }
      }, 404)
    }

    // リセット可能なステータス確認
    const resetableStatuses = ['uploaded', 'transcribed', 'parsing', 'parsed', 'formatting', 'formatted', 'completed', 'failed']
    if (!resetableStatuses.includes(project.status as string)) {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot reset from status: ${project.status}`
        }
      }, 400)
    }

    // 動画・漫画の存在チェック（これらがあればリセット不可）
    const [videoBuildCount, comicCount, sceneVideosCount] = await Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM video_builds WHERE project_id = ?`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM scenes WHERE project_id = ? AND comic_data IS NOT NULL`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM video_generations WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)`).bind(projectId).first()
    ])

    if (((videoBuildCount as any)?.count || 0) > 0) {
      return c.json({
        error: {
          code: 'VIDEO_BUILD_EXISTS',
          message: '最終動画（Video Build）が作成済みのため、リセットできません'
        }
      }, 400)
    }

    if (((comicCount as any)?.count || 0) > 0) {
      return c.json({
        error: {
          code: 'COMIC_EXISTS',
          message: '漫画化データが存在するため、リセットできません'
        }
      }, 400)
    }

    if (((sceneVideosCount as any)?.count || 0) > 0) {
      return c.json({
        error: {
          code: 'SCENE_VIDEOS_EXIST',
          message: 'シーン動画が生成済みのため、リセットできません'
        }
      }, 400)
    }

    // 削除件数カウント用
    const deletedCounts = { scenes: 0, images: 0, audios: 0, videos: 0, chunks: 0 }

    // ===== R2ファイル削除（ベストエフォート、DB削除前に実行） =====
    
    // 1. 画像R2ファイル削除
    const { results: imageR2Keys } = await c.env.DB.prepare(`
      SELECT DISTINCT r2_key FROM image_generations 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
      AND r2_key IS NOT NULL
    `).bind(projectId).all()
    
    for (const row of imageR2Keys || []) {
      try {
        if (row.r2_key) {
          await c.env.R2.delete(row.r2_key as string)
        }
      } catch (e) {
        console.error(`[ResetToInput] Failed to delete image R2: ${row.r2_key}`, e)
      }
    }
    deletedCounts.images = imageR2Keys?.length || 0

    // 2. 音声R2ファイル削除
    const { results: audioR2Keys } = await c.env.DB.prepare(`
      SELECT DISTINCT r2_key FROM audio_generations 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
      AND r2_key IS NOT NULL
    `).bind(projectId).all()
    
    for (const row of audioR2Keys || []) {
      try {
        if (row.r2_key) {
          await c.env.R2.delete(row.r2_key as string)
        }
      } catch (e) {
        console.error(`[ResetToInput] Failed to delete audio R2: ${row.r2_key}`, e)
      }
    }
    deletedCounts.audios = audioR2Keys?.length || 0

    // 3. 動画R2ファイル削除
    const { results: videoR2Keys } = await c.env.DB.prepare(`
      SELECT DISTINCT r2_key FROM video_generations 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
      AND r2_key IS NOT NULL
    `).bind(projectId).all()
    
    for (const row of videoR2Keys || []) {
      try {
        if (row.r2_key) {
          await c.env.R2.delete(row.r2_key as string)
        }
      } catch (e) {
        console.error(`[ResetToInput] Failed to delete video R2: ${row.r2_key}`, e)
      }
    }
    deletedCounts.videos = videoR2Keys?.length || 0

    // ===== DBデータ削除 =====
    
    // 1. image_generations削除
    await c.env.DB.prepare(`
      DELETE FROM image_generations 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
    `).bind(projectId).run()

    // 2. audio_generations削除
    await c.env.DB.prepare(`
      DELETE FROM audio_generations 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
    `).bind(projectId).run()

    // 3. video_generations削除
    await c.env.DB.prepare(`
      DELETE FROM video_generations 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
    `).bind(projectId).run()

    // 4. scene_character_map削除
    await c.env.DB.prepare(`
      DELETE FROM scene_character_map 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
    `).bind(projectId).run()

    // 5. scene_style_settings削除
    await c.env.DB.prepare(`
      DELETE FROM scene_style_settings 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
    `).bind(projectId).run()

    // 6. scenes削除（件数取得）
    const scenesCountResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM scenes WHERE project_id = ?
    `).bind(projectId).first()
    deletedCounts.scenes = (scenesCountResult?.count as number) || 0
    
    await c.env.DB.prepare(`
      DELETE FROM scenes WHERE project_id = ?
    `).bind(projectId).run()

    // 7. text_chunks削除（件数取得）
    const chunksCountResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM text_chunks WHERE project_id = ?
    `).bind(projectId).first()
    deletedCounts.chunks = (chunksCountResult?.count as number) || 0
    
    await c.env.DB.prepare(`
      DELETE FROM text_chunks WHERE project_id = ?
    `).bind(projectId).run()

    // 8. runs削除
    await c.env.DB.prepare(`
      DELETE FROM runs WHERE project_id = ?
    `).bind(projectId).run()

    // 9. transcriptions削除（入力音声ファイルはR2に残す）
    await c.env.DB.prepare(`
      DELETE FROM transcriptions WHERE project_id = ?
    `).bind(projectId).run()

    // リセット先のステータスを決定
    let resetStatus = 'created'
    if (project.source_type === 'text' && project.source_text) {
      resetStatus = 'uploaded'
    } else if (project.source_type === 'audio' && project.audio_r2_key) {
      resetStatus = 'uploaded'
    }

    // ステータス更新
    await c.env.DB.prepare(`
      UPDATE projects
      SET status = ?,
          error_message = NULL,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(resetStatus, projectId).run()

    console.log(`[ResetToInput] Project ${projectId} reset to ${resetStatus}`, deletedCounts)

    return c.json({
      success: true,
      message: 'Project reset to input successfully',
      project_id: parseInt(projectId),
      reset_to: resetStatus,
      deleted: deletedCounts  // フロントエンド互換のため追加
    })
  } catch (error) {
    console.error('Error in reset-to-input:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to reset project' }
    }, 500)
  }
})

// GET /api/projects/:id/chunks - チャンク一覧取得（失敗チャンク確認用）
projects.get('/:id/chunks', async (c) => {
  try {
    const projectId = c.req.param('id')

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

    // チャンク一覧取得
    const { results: chunks } = await c.env.DB.prepare(`
      SELECT 
        id,
        project_id,
        idx,
        text,
        status,
        error_message,
        scene_count,
        processed_at,
        created_at,
        updated_at
      FROM text_chunks
      WHERE project_id = ?
      ORDER BY idx ASC
    `).bind(projectId).all()

    // 統計情報
    const stats = {
      total: chunks.length,
      pending: chunks.filter((c: any) => c.status === 'pending').length,
      processing: chunks.filter((c: any) => c.status === 'processing').length,
      done: chunks.filter((c: any) => c.status === 'done').length,
      failed: chunks.filter((c: any) => c.status === 'failed').length
    }

    return c.json({
      chunks,
      stats
    })

  } catch (error) {
    console.error('Error fetching chunks:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch chunks'
      }
    }, 500)
  }
})

/**
 * GET /api/projects/:id/scene-split-settings
 * Get scene split settings for a project
 */
projects.get('/:id/scene-split-settings', async (c) => {
  try {
    const projectId = parseInt(c.req.param('id'), 10)
    if (isNaN(projectId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project id' } }, 400)
    }

    // Get settings or return defaults
    const settings = await c.env.DB.prepare(`
      SELECT target_scene_count, min_chars, max_chars, pacing, use_world_bible
      FROM scene_split_settings
      WHERE project_id = ?
    `).bind(projectId).first()

    if (settings) {
      return c.json(settings)
    }

    // Return defaults if no settings exist
    return c.json({
      target_scene_count: 20,
      min_chars: 800,
      max_chars: 1500,
      pacing: 'normal',
      use_world_bible: 1
    })
  } catch (error) {
    console.error('[Projects] Failed to get scene split settings:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get settings' } }, 500)
  }
})

/**
 * PUT /api/projects/:id/scene-split-settings
 * Update scene split settings for a project
 */
projects.put('/:id/scene-split-settings', async (c) => {
  try {
    const projectId = parseInt(c.req.param('id'), 10)
    if (isNaN(projectId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project id' } }, 400)
    }

    const body = await c.req.json()
    const { target_scene_count, min_chars, max_chars, pacing, use_world_bible } = body

    // Validate
    if (target_scene_count && (target_scene_count < 5 || target_scene_count > 200)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'target_scene_count must be 5-200' } }, 400)
    }
    if (min_chars && (min_chars < 200 || min_chars > 3000)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'min_chars must be 200-3000' } }, 400)
    }
    if (max_chars && (max_chars < 500 || max_chars > 5000)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'max_chars must be 500-5000' } }, 400)
    }
    if (min_chars && max_chars && min_chars >= max_chars) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'min_chars must be less than max_chars' } }, 400)
    }

    // Upsert settings (SQLite INSERT OR REPLACE)
    await c.env.DB.prepare(`
      INSERT INTO scene_split_settings (project_id, target_scene_count, min_chars, max_chars, pacing, use_world_bible)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        target_scene_count = excluded.target_scene_count,
        min_chars = excluded.min_chars,
        max_chars = excluded.max_chars,
        pacing = excluded.pacing,
        use_world_bible = excluded.use_world_bible
    `).bind(
      projectId,
      target_scene_count ?? 20,
      min_chars ?? 800,
      max_chars ?? 1500,
      pacing ?? 'normal',
      use_world_bible ?? 1
    ).run()

    return c.json({ success: true })
  } catch (error) {
    console.error('[Projects] Failed to save scene split settings:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to save settings' } }, 500)
  }
})

export default projects
