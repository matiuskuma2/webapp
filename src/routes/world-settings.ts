/**
 * World Settings API (Phase X-2)
 * Manages project-wide world/setting information
 */

import { Hono } from 'hono';
import type { Bindings } from '../types/bindings';
import { ERROR_CODES } from '../constants';
import { createErrorResponse } from '../utils/error-response';

const app = new Hono<{ Bindings: Bindings }>();

/**
 * GET /api/projects/:projectId/world-settings
 * Get world settings for a project
 */
app.get('/projects/:projectId/world-settings', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    
    const settings = await c.env.DB.prepare(`
      SELECT 
        id, project_id, art_style, time_period, setting_description,
        prompt_prefix, created_at, updated_at
      FROM world_settings
      WHERE project_id = ?
    `).bind(projectId).first();

    if (!settings) {
      // Return empty settings if not found (not an error)
      return c.json({
        world_settings: null
      });
    }

    return c.json({
      world_settings: settings
    });
  } catch (error) {
    console.error('[World Settings] Get error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to get world settings'),
      500
    );
  }
});

/**
 * POST /api/projects/:projectId/world-settings
 * Create world settings for a project
 */
app.post('/projects/:projectId/world-settings', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    const body = await c.req.json();

    const { art_style, time_period, setting_description, prompt_prefix } = body;

    // Check if settings already exist
    const existing = await c.env.DB.prepare(`
      SELECT id FROM world_settings WHERE project_id = ?
    `).bind(projectId).first();

    if (existing) {
      return c.json(
        createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'World settings already exist. Use PUT to update.'),
        400
      );
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO world_settings
        (project_id, art_style, time_period, setting_description, prompt_prefix)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      projectId,
      art_style || null,
      time_period || null,
      setting_description || null,
      prompt_prefix || null
    ).run();

    const settings = await c.env.DB.prepare(`
      SELECT * FROM world_settings WHERE id = ?
    `).bind(result.meta.last_row_id).first();

    return c.json({
      world_settings: settings
    }, 201);
  } catch (error) {
    console.error('[World Settings] Create error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to create world settings'),
      500
    );
  }
});

/**
 * PUT /api/projects/:projectId/world-settings
 * Update world settings for a project
 */
app.put('/projects/:projectId/world-settings', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    const body = await c.req.json();

    const { art_style, time_period, setting_description, prompt_prefix } = body;

    // Upsert: Create if not exists, update if exists
    const existing = await c.env.DB.prepare(`
      SELECT id FROM world_settings WHERE project_id = ?
    `).bind(projectId).first<any>();

    if (existing) {
      // Update
      await c.env.DB.prepare(`
        UPDATE world_settings
        SET art_style = ?, time_period = ?, setting_description = ?,
            prompt_prefix = ?, updated_at = CURRENT_TIMESTAMP
        WHERE project_id = ?
      `).bind(
        art_style || null,
        time_period || null,
        setting_description || null,
        prompt_prefix || null,
        projectId
      ).run();
    } else {
      // Insert
      await c.env.DB.prepare(`
        INSERT INTO world_settings
          (project_id, art_style, time_period, setting_description, prompt_prefix)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        projectId,
        art_style || null,
        time_period || null,
        setting_description || null,
        prompt_prefix || null
      ).run();
    }

    const settings = await c.env.DB.prepare(`
      SELECT * FROM world_settings WHERE project_id = ?
    `).bind(projectId).first();

    return c.json({
      world_settings: settings
    });
  } catch (error) {
    console.error('[World Settings] Update error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to update world settings'),
      500
    );
  }
});

/**
 * DELETE /api/projects/:projectId/world-settings
 * Delete world settings for a project
 */
app.delete('/projects/:projectId/world-settings', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));

    await c.env.DB.prepare(`
      DELETE FROM world_settings WHERE project_id = ?
    `).bind(projectId).run();

    return c.json({ success: true });
  } catch (error) {
    console.error('[World Settings] Delete error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to delete world settings'),
      500
    );
  }
});

export default app;
