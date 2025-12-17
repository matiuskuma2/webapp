import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'

const styles = new Hono<{ Bindings: Bindings }>()

// GET /api/style-presets - Get all active style presets
styles.get('/style-presets', async (c) => {
  try {
    const { results: presets } = await c.env.DB.prepare(`
      SELECT id, name, description, prompt_prefix, prompt_suffix, negative_prompt, is_active
      FROM style_presets
      WHERE is_active = 1
      ORDER BY created_at ASC
    `).all()

    return c.json({ style_presets: presets })
  } catch (error) {
    console.error('Error fetching style presets:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch style presets'
      }
    }, 500)
  }
})

// GET /api/style-presets/:id - Get single style preset
styles.get('/style-presets/:id', async (c) => {
  try {
    const presetId = c.req.param('id')

    const preset = await c.env.DB.prepare(`
      SELECT id, name, description, prompt_prefix, prompt_suffix, negative_prompt, is_active
      FROM style_presets
      WHERE id = ?
    `).bind(presetId).first()

    if (!preset) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Style preset not found'
        }
      }, 404)
    }

    return c.json(preset)
  } catch (error) {
    console.error('Error fetching style preset:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch style preset'
      }
    }, 500)
  }
})

// POST /api/style-presets - Create new style preset
styles.post('/style-presets', async (c) => {
  try {
    const { name, description, prompt_prefix, prompt_suffix, negative_prompt } = await c.req.json()

    if (!name) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Name is required'
        }
      }, 400)
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO style_presets (name, description, prompt_prefix, prompt_suffix, negative_prompt)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      name,
      description || null,
      prompt_prefix || null,
      prompt_suffix || null,
      negative_prompt || null
    ).run()

    const newPreset = await c.env.DB.prepare(`
      SELECT id, name, description, prompt_prefix, prompt_suffix, negative_prompt, is_active
      FROM style_presets
      WHERE id = ?
    `).bind(result.meta.last_row_id).first()

    return c.json(newPreset, 201)
  } catch (error) {
    console.error('Error creating style preset:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create style preset'
      }
    }, 500)
  }
})

// PUT /api/style-presets/:id - Update style preset
styles.put('/style-presets/:id', async (c) => {
  try {
    const presetId = c.req.param('id')
    const { name, description, prompt_prefix, prompt_suffix, negative_prompt, is_active } = await c.req.json()

    const preset = await c.env.DB.prepare(`
      SELECT id FROM style_presets WHERE id = ?
    `).bind(presetId).first()

    if (!preset) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Style preset not found'
        }
      }, 404)
    }

    await c.env.DB.prepare(`
      UPDATE style_presets
      SET name = ?,
          description = ?,
          prompt_prefix = ?,
          prompt_suffix = ?,
          negative_prompt = ?,
          is_active = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      name,
      description || null,
      prompt_prefix || null,
      prompt_suffix || null,
      negative_prompt || null,
      is_active !== undefined ? (is_active ? 1 : 0) : 1,
      presetId
    ).run()

    const updatedPreset = await c.env.DB.prepare(`
      SELECT id, name, description, prompt_prefix, prompt_suffix, negative_prompt, is_active
      FROM style_presets
      WHERE id = ?
    `).bind(presetId).first()

    return c.json(updatedPreset)
  } catch (error) {
    console.error('Error updating style preset:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update style preset'
      }
    }, 500)
  }
})

// DELETE /api/style-presets/:id - Soft delete (set is_active=0)
styles.delete('/style-presets/:id', async (c) => {
  try {
    const presetId = c.req.param('id')

    const preset = await c.env.DB.prepare(`
      SELECT id FROM style_presets WHERE id = ?
    `).bind(presetId).first()

    if (!preset) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Style preset not found'
        }
      }, 404)
    }

    await c.env.DB.prepare(`
      UPDATE style_presets
      SET is_active = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(presetId).run()

    return c.json({
      success: true,
      message: 'Style preset deleted successfully'
    })
  } catch (error) {
    console.error('Error deleting style preset:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete style preset'
      }
    }, 500)
  }
})

// GET /api/projects/:id/style-settings - Get project's default style setting
styles.get('/projects/:id/style-settings', async (c) => {
  try {
    const projectId = c.req.param('id')

    // Get project's default style preset
    const settings = await c.env.DB.prepare(`
      SELECT pss.default_style_preset_id, sp.name as preset_name
      FROM project_style_settings pss
      LEFT JOIN style_presets sp ON pss.default_style_preset_id = sp.id
      WHERE pss.project_id = ?
    `).bind(projectId).first()

    // Get all available presets
    const { results: presets } = await c.env.DB.prepare(`
      SELECT id, name, description
      FROM style_presets
      WHERE is_active = 1
      ORDER BY created_at ASC
    `).all()

    return c.json({
      default_style_preset_id: settings?.default_style_preset_id || null,
      default_preset_name: settings?.preset_name || null,
      available_presets: presets
    })
  } catch (error) {
    console.error('Error fetching project style settings:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch project style settings'
      }
    }, 500)
  }
})

// PUT /api/projects/:id/style-settings - Update project's default style
styles.put('/projects/:id/style-settings', async (c) => {
  try {
    const projectId = c.req.param('id')
    const { default_style_preset_id } = await c.req.json()

    // Upsert project_style_settings
    await c.env.DB.prepare(`
      INSERT INTO project_style_settings (project_id, default_style_preset_id)
      VALUES (?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        default_style_preset_id = excluded.default_style_preset_id,
        updated_at = CURRENT_TIMESTAMP
    `).bind(projectId, default_style_preset_id || null).run()

    return c.json({
      success: true,
      default_style_preset_id: default_style_preset_id || null
    })
  } catch (error) {
    console.error('Error updating project style settings:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update project style settings'
      }
    }, 500)
  }
})

// PUT /api/scenes/:id/style - Set scene-specific style preset
styles.put('/scenes/:id/style', async (c) => {
  try {
    const sceneId = c.req.param('id')
    const { style_preset_id } = await c.req.json()

    // Upsert scene_style_settings
    await c.env.DB.prepare(`
      INSERT INTO scene_style_settings (scene_id, style_preset_id)
      VALUES (?, ?)
      ON CONFLICT(scene_id) DO UPDATE SET
        style_preset_id = excluded.style_preset_id,
        updated_at = CURRENT_TIMESTAMP
    `).bind(sceneId, style_preset_id || null).run()

    return c.json({
      success: true,
      scene_id: parseInt(sceneId),
      style_preset_id: style_preset_id || null
    })
  } catch (error) {
    console.error('Error updating scene style:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update scene style'
      }
    }, 500)
  }
})

export default styles
