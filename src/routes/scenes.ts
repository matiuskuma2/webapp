import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'

const scenes = new Hono<{ Bindings: Bindings }>()

// PUT /api/scenes/:id - シーン編集
scenes.put('/:id', async (c) => {
  try {
    const sceneId = c.req.param('id')
    const { title, dialogue, bullets, image_prompt } = await c.req.json()

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
      SELECT id, project_id, idx, role, title, dialogue, bullets, image_prompt, updated_at
      FROM scenes
      WHERE id = ?
    `).bind(sceneId).first()

    return c.json({
      ...updatedScene,
      bullets: JSON.parse(updatedScene.bullets as string)
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

export default scenes
