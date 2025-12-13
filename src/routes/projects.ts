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
    const allowedExtensions = ['.mp3', '.wav', '.m4a', '.ogg']
    const fileName = audioFile.name.toLowerCase()
    const isValidFormat = allowedExtensions.some(ext => fileName.endsWith(ext))

    if (!isValidFormat) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid file format. Supported formats: MP3, WAV, M4A, OGG',
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
        p.audio_filename,
        p.audio_size_bytes,
        p.audio_duration_seconds,
        p.audio_r2_key,
        p.created_at,
        p.updated_at
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
        created_at: scene.created_at,
        updated_at: scene.updated_at
      }))
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

export default projects
