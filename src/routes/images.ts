import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'

const images = new Hono<{ Bindings: Bindings }>()

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
      SELECT id, r2_key, status, is_active, error_message, created_at
      FROM image_generations
      WHERE scene_id = ?
      ORDER BY created_at DESC
    `).bind(sceneId).all()

    return c.json({
      scene_id: parseInt(sceneId),
      total_images: imageGenerations.length,
      images: imageGenerations.map((img: any) => ({
        id: img.id,
        r2_key: img.r2_key,
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
