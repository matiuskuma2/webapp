/**
 * Character Models API (Phase X-2)
 * Manages character definitions for a project
 */

import { Hono } from 'hono';
import type { Bindings } from '../types/bindings';
import { ERROR_CODES } from '../constants';
import { createErrorResponse } from '../utils/error-response';

const app = new Hono<{ Bindings: Bindings }>();

/**
 * GET /api/projects/:projectId/characters
 * List all characters for a project
 */
app.get('/projects/:projectId/characters', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    
    const characters = await c.env.DB.prepare(`
      SELECT 
        id, project_id, character_key, character_name, description,
        appearance_description, reference_image_r2_key, reference_image_r2_url,
        voice_preset_id, aliases_json, created_at, updated_at
      FROM project_character_models
      WHERE project_id = ?
      ORDER BY created_at ASC
    `).bind(projectId).all();

    return c.json({
      characters: characters.results || []
    });
  } catch (error) {
    console.error('[Characters] List error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to list characters'),
      500
    );
  }
});

/**
 * GET /api/projects/:projectId/characters/:characterKey
 * Get a specific character
 */
app.get('/projects/:projectId/characters/:characterKey', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    const characterKey = c.req.param('characterKey');
    
    const character = await c.env.DB.prepare(`
      SELECT * FROM project_character_models
      WHERE project_id = ? AND character_key = ?
    `).bind(projectId, characterKey).first();

    if (!character) {
      return c.json(
        createErrorResponse(ERROR_CODES.NOT_FOUND, 'Character not found'),
        404
      );
    }

    return c.json({
      character
    });
  } catch (error) {
    console.error('[Characters] Get error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to get character'),
      500
    );
  }
});

/**
 * POST /api/projects/:projectId/characters
 * Create a new character
 */
app.post('/projects/:projectId/characters', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    const body = await c.req.json();

    const {
      character_key,
      character_name,
      description,
      appearance_description,
      reference_image_r2_key,
      reference_image_r2_url,
      voice_preset_id,
      aliases
    } = body;

    if (!character_key || !character_name) {
      return c.json(
        createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'character_key and character_name are required'),
        400
      );
    }

    // Check for duplicate character_key
    const existing = await c.env.DB.prepare(`
      SELECT id FROM project_character_models
      WHERE project_id = ? AND character_key = ?
    `).bind(projectId, character_key).first();

    if (existing) {
      return c.json(
        createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Character key already exists'),
        400
      );
    }

    // Validate and serialize aliases (Phase X-2 Part 2)
    let aliasesJson = null;
    if (aliases && Array.isArray(aliases)) {
      // Filter: only strings, trim, remove empty
      const validAliases = aliases
        .filter(a => typeof a === 'string')
        .map(a => a.trim())
        .filter(a => a.length > 0);
      aliasesJson = validAliases.length > 0 ? JSON.stringify(validAliases) : null;
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO project_character_models
        (project_id, character_key, character_name, description, appearance_description,
         reference_image_r2_key, reference_image_r2_url, voice_preset_id, aliases_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      projectId,
      character_key,
      character_name,
      description || null,
      appearance_description || null,
      reference_image_r2_key || null,
      reference_image_r2_url || null,
      voice_preset_id || null,
      aliasesJson
    ).run();

    const character = await c.env.DB.prepare(`
      SELECT * FROM project_character_models WHERE id = ?
    `).bind(result.meta.last_row_id).first();

    return c.json({
      character
    }, 201);
  } catch (error) {
    console.error('[Characters] Create error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to create character'),
      500
    );
  }
});

/**
 * PUT /api/projects/:projectId/characters/:characterKey
 * Update a character
 */
app.put('/projects/:projectId/characters/:characterKey', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    const characterKey = c.req.param('characterKey');
    const body = await c.req.json();

    const {
      character_name,
      description,
      appearance_description,
      reference_image_r2_key,
      reference_image_r2_url,
      voice_preset_id,
      aliases
    } = body;

    const existing = await c.env.DB.prepare(`
      SELECT id FROM project_character_models
      WHERE project_id = ? AND character_key = ?
    `).bind(projectId, characterKey).first();

    if (!existing) {
      return c.json(
        createErrorResponse(ERROR_CODES.NOT_FOUND, 'Character not found'),
        404
      );
    }

    // Validate and serialize aliases (Phase X-2 Part 2)
    let aliasesJson = null;
    if (aliases && Array.isArray(aliases)) {
      const validAliases = aliases
        .filter(a => typeof a === 'string')
        .map(a => a.trim())
        .filter(a => a.length > 0);
      aliasesJson = validAliases.length > 0 ? JSON.stringify(validAliases) : null;
    }

    await c.env.DB.prepare(`
      UPDATE project_character_models
      SET character_name = ?, description = ?, appearance_description = ?,
          reference_image_r2_key = ?, reference_image_r2_url = ?,
          voice_preset_id = ?, aliases_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND character_key = ?
    `).bind(
      character_name,
      description || null,
      appearance_description || null,
      reference_image_r2_key || null,
      reference_image_r2_url || null,
      voice_preset_id || null,
      aliasesJson,
      projectId,
      characterKey
    ).run();

    const character = await c.env.DB.prepare(`
      SELECT * FROM project_character_models
      WHERE project_id = ? AND character_key = ?
    `).bind(projectId, characterKey).first();

    return c.json({
      character
    });
  } catch (error) {
    console.error('[Characters] Update error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to update character'),
      500
    );
  }
});

/**
 * DELETE /api/projects/:projectId/characters/:characterKey
 * Delete a character
 */
app.delete('/projects/:projectId/characters/:characterKey', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    const characterKey = c.req.param('characterKey');

    // Delete character (cascade will handle scene_character_map)
    await c.env.DB.prepare(`
      DELETE FROM project_character_models
      WHERE project_id = ? AND character_key = ?
    `).bind(projectId, characterKey).run();

    // Also clean up scene mappings
    await c.env.DB.prepare(`
      DELETE FROM scene_character_map
      WHERE character_key = ? AND scene_id IN (
        SELECT id FROM scenes WHERE project_id = ?
      )
    `).bind(characterKey, projectId).run();

    return c.json({ success: true });
  } catch (error) {
    console.error('[Characters] Delete error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to delete character'),
      500
    );
  }
});

export default app;
