import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'

const images = new Hono<{ Bindings: Bindings }>()

// GET /images/* - R2バケットから画像直接配信
images.get('/*', async (c) => {
  try {
    // Request path: /images/12/scene_1/21_xxx.png
    // R2 key: images/12/scene_1/21_xxx.png
    const fullPath = c.req.path // e.g., "/images/12/scene_1/21_xxx.png"
    const r2Key = fullPath.substring(1) // Remove leading "/" → "images/12/scene_1/21_xxx.png"
    
    if (!r2Key || r2Key === 'images') {
      return c.json({ error: 'Invalid image path' }, 400)
    }

    const object = await c.env.R2.get(r2Key)
    
    if (!object) {
      return c.notFound()
    }

    const headers = new Headers()
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/png')
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    headers.set('Access-Control-Allow-Origin', '*')

    return new Response(object.body, { headers })
  } catch (error) {
    console.error('Error fetching image from R2:', error)
    return c.json({ error: 'Failed to fetch image' }, 500)
  }
})

// GET /api/scenes/:id/images - シーンの画像生成履歴取得
images.get('/:id/images', async (c) => {
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

    // 画像生成履歴取得（新しい順）
    const { results: imageGenerations } = await c.env.DB.prepare(`
      SELECT id, prompt, r2_key, r2_url, status, is_active, error_message, created_at
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
        created_at: img.created_at
      }))
    })
  } catch (error) {
    console.error('Error fetching scene images:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch scene images'
      }
    }, 500)
  }
})

// POST /api/images/:id/activate - 画像採用切替
images.post('/:id/activate', async (c) => {
  try {
    const imageId = c.req.param('id')

    // 画像存在確認＋scene_id取得
    const image = await c.env.DB.prepare(`
      SELECT id, scene_id FROM image_generations WHERE id = ?
    `).bind(imageId).first()

    if (!image) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Image not found'
        }
      }, 404)
    }

    const sceneId = image.scene_id

    // 同シーンの全画像を is_active=0 に
    await c.env.DB.prepare(`
      UPDATE image_generations
      SET is_active = 0
      WHERE scene_id = ?
    `).bind(sceneId).run()

    // 指定画像を is_active=1 に
    await c.env.DB.prepare(`
      UPDATE image_generations
      SET is_active = 1
      WHERE id = ?
    `).bind(imageId).run()

    return c.json({
      success: true,
      message: 'Image activated successfully',
      activated_image_id: parseInt(imageId),
      scene_id: sceneId
    })
  } catch (error) {
    console.error('Error activating image:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to activate image'
      }
    }, 500)
  }
})

export default images
