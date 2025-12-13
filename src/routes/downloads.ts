import { Hono } from 'hono'
import JSZip from 'jszip'
import type { Bindings } from '../types/bindings'

const downloads = new Hono<{ Bindings: Bindings }>()

// GET /api/projects/:id/download/images - 画像ZIP
downloads.get('/:id/download/images', async (c) => {
  try {
    const projectId = c.req.param('id')

    // 1. プロジェクト確認
    const project = await c.env.DB.prepare(`
      SELECT id, title, status FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // 2. ステータスチェック（completedのみ許可）
    if (project.status !== 'completed') {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot download images for project with status: ${project.status}`,
          details: {
            current_status: project.status,
            required_status: 'completed'
          }
        }
      }, 400)
    }

    // 3. アクティブな画像を取得（idx順）
    const { results: images } = await c.env.DB.prepare(`
      SELECT ig.r2_key, s.idx
      FROM image_generations ig
      JOIN scenes s ON ig.scene_id = s.id
      WHERE s.project_id = ? AND ig.is_active = 1
      ORDER BY s.idx ASC
    `).bind(projectId).all()

    if (images.length === 0) {
      return c.json({
        error: {
          code: 'NO_IMAGES',
          message: 'No active images found for this project'
        }
      }, 404)
    }

    // 4. ZIP生成
    const zip = new JSZip()

    for (const img of images) {
      const r2Object = await c.env.R2.get(img.r2_key as string)
      if (r2Object) {
        const imageData = await r2Object.arrayBuffer()
        const fileName = `scene_${String(img.idx).padStart(3, '0')}.png`
        zip.file(fileName, imageData)
      }
    }

    // 5. ZIP出力
    const zipBlob = await zip.generateAsync({ type: 'uint8array' })

    // 6. レスポンス返却
    return new Response(zipBlob, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="project_${projectId}_images.zip"`
      }
    })

  } catch (error) {
    console.error('Error in download/images endpoint:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate image ZIP'
      }
    }, 500)
  }
})

// GET /api/projects/:id/download/csv - セリフCSV
downloads.get('/:id/download/csv', async (c) => {
  try {
    const projectId = c.req.param('id')

    // 1. プロジェクト確認
    const project = await c.env.DB.prepare(`
      SELECT id, title, status FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // 2. ステータスチェック（completedのみ許可）
    if (project.status !== 'completed') {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot download CSV for project with status: ${project.status}`,
          details: {
            current_status: project.status,
            required_status: 'completed'
          }
        }
      }, 400)
    }

    // 3. シーン取得（idx順）
    const { results: scenes } = await c.env.DB.prepare(`
      SELECT idx, role, title, dialogue, bullets
      FROM scenes
      WHERE project_id = ?
      ORDER BY idx ASC
    `).bind(projectId).all()

    if (scenes.length === 0) {
      return c.json({
        error: {
          code: 'NO_SCENES',
          message: 'No scenes found for this project'
        }
      }, 404)
    }

    // 4. CSV生成（UTF-8 BOM付き）
    const BOM = '\uFEFF'
    const header = 'idx,role,title,dialogue,bullets\n'
    
    const rows = scenes.map(scene => {
      // bullets はJSON配列として保存されているのでパース
      const bullets = JSON.parse(scene.bullets as string)
      const bulletsStr = bullets.join('|')
      
      // CSVエスケープ処理（ダブルクォート、カンマ、改行を含む場合）
      const escapeCSV = (str: string) => {
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`
        }
        return str
      }
      
      return [
        scene.idx,
        escapeCSV(scene.role as string),
        escapeCSV(scene.title as string),
        escapeCSV(scene.dialogue as string),
        escapeCSV(bulletsStr)
      ].join(',')
    }).join('\n')

    const csv = BOM + header + rows

    // 5. レスポンス返却
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="project_${projectId}_dialogue.csv"`
      }
    })

  } catch (error) {
    console.error('Error in download/csv endpoint:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate CSV'
      }
    }, 500)
  }
})

// GET /api/projects/:id/download/all - 全ファイルZIP
downloads.get('/:id/download/all', async (c) => {
  try {
    const projectId = c.req.param('id')

    // 1. プロジェクト確認
    const project = await c.env.DB.prepare(`
      SELECT id, title, status, created_at FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // 2. ステータスチェック（completedのみ許可）
    if (project.status !== 'completed') {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot download files for project with status: ${project.status}`,
          details: {
            current_status: project.status,
            required_status: 'completed'
          }
        }
      }, 400)
    }

    // 3. シーン取得
    const { results: scenes } = await c.env.DB.prepare(`
      SELECT idx, role, title, dialogue, bullets
      FROM scenes
      WHERE project_id = ?
      ORDER BY idx ASC
    `).bind(projectId).all()

    if (scenes.length === 0) {
      return c.json({
        error: {
          code: 'NO_SCENES',
          message: 'No scenes found for this project'
        }
      }, 404)
    }

    // 4. アクティブな画像を取得
    const { results: images } = await c.env.DB.prepare(`
      SELECT ig.r2_key, s.idx
      FROM image_generations ig
      JOIN scenes s ON ig.scene_id = s.id
      WHERE s.project_id = ? AND ig.is_active = 1
      ORDER BY s.idx ASC
    `).bind(projectId).all()

    // 5. ZIP生成
    const zip = new JSZip()

    // 5-1. images/ ディレクトリに画像追加
    const imagesFolder = zip.folder('images')
    for (const img of images) {
      const r2Object = await c.env.R2.get(img.r2_key as string)
      if (r2Object && imagesFolder) {
        const imageData = await r2Object.arrayBuffer()
        const fileName = `scene_${String(img.idx).padStart(3, '0')}.png`
        imagesFolder.file(fileName, imageData)
      }
    }

    // 5-2. dialogue.csv 追加
    const BOM = '\uFEFF'
    const header = 'idx,role,title,dialogue,bullets\n'
    
    const rows = scenes.map(scene => {
      const bullets = JSON.parse(scene.bullets as string)
      const bulletsStr = bullets.join('|')
      
      const escapeCSV = (str: string) => {
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`
        }
        return str
      }
      
      return [
        scene.idx,
        escapeCSV(scene.role as string),
        escapeCSV(scene.title as string),
        escapeCSV(scene.dialogue as string),
        escapeCSV(bulletsStr)
      ].join(',')
    }).join('\n')

    const csv = BOM + header + rows
    zip.file('dialogue.csv', csv)

    // 5-3. project.json 追加（メタデータ）
    const projectInfo = {
      id: project.id,
      title: project.title,
      status: project.status,
      created_at: project.created_at,
      total_scenes: scenes.length,
      total_images: images.length
    }
    zip.file('project.json', JSON.stringify(projectInfo, null, 2))

    // 6. ZIP出力
    const zipBlob = await zip.generateAsync({ type: 'uint8array' })

    // 7. レスポンス返却
    return new Response(zipBlob, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="project_${projectId}_all.zip"`
      }
    })

  } catch (error) {
    console.error('Error in download/all endpoint:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate full ZIP'
      }
    }, 500)
  }
})

export default downloads
