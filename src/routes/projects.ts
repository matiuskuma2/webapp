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

    const project = await c.env.DB.prepare(`
      SELECT id, title, status, created_at
      FROM projects
      WHERE id = ?
    `).bind(result.meta.last_row_id).first()

    return c.json(project, 201)
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

    // DB更新
    await c.env.DB.prepare(`
      UPDATE projects
      SET audio_r2_key = ?,
          audio_filename = ?,
          audio_size_bytes = ?,
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
projects.get('/:id/scenes', async (c) => {
  try {
    const projectId = c.req.param('id')

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

    // シーン一覧取得（idx順）
    const { results: scenes } = await c.env.DB.prepare(`
      SELECT id, idx, role, title, dialogue, bullets, image_prompt, created_at, updated_at
      FROM scenes
      WHERE project_id = ?
      ORDER BY idx ASC
    `).bind(projectId).all()

    // 各シーンの画像情報を取得（active_image + latest_image）
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

export default projects
