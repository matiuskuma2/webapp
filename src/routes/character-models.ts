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
 * GET /api/projects/:projectId/characters/library-available
 * List user's library characters that are not yet imported to this project
 * NOTE: This route MUST be defined BEFORE :characterKey to avoid matching 'library-available' as a characterKey
 */
app.get('/projects/:projectId/characters/library-available', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    
    // Get user ID from session
    const { getCookie } = await import('hono/cookie');
    const sessionId = getCookie(c, 'session');
    if (!sessionId) {
      return c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED, 'Authentication required'), 401);
    }
    
    const session = await c.env.DB.prepare(`
      SELECT user_id FROM sessions WHERE id = ? AND expires_at > datetime('now')
    `).bind(sessionId).first<{ user_id: number }>();
    
    if (!session) {
      return c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED, 'Session expired'), 401);
    }
    
    const userId = session.user_id;
    
    // Get characters from user's library that are NOT already in this project
    const characters = await c.env.DB.prepare(`
      SELECT uc.* FROM user_characters uc
      WHERE uc.user_id = ?
        AND uc.character_key NOT IN (
          SELECT character_key FROM project_character_models WHERE project_id = ?
        )
      ORDER BY uc.is_favorite DESC, uc.character_name ASC
    `).bind(userId, projectId).all();
    
    return c.json({ characters: characters.results || [] });
  } catch (error) {
    console.error('[Characters] Library available error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to get library characters'), 500);
  }
});

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
 * POST /api/projects/:projectId/characters/import
 * Import a character from user's library to this project (by user_character_id)
 * Used by: character-library.js, world-character-ui.js
 */
app.post('/projects/:projectId/characters/import', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    const body = await c.req.json();
    const { user_character_id, character_key } = body;
    
    // Get user ID from session
    const { getCookie } = await import('hono/cookie');
    const sessionId = getCookie(c, 'session');
    if (!sessionId) {
      return c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED, 'Authentication required'), 401);
    }
    
    const session = await c.env.DB.prepare(`
      SELECT user_id FROM sessions WHERE id = ? AND expires_at > datetime('now')
    `).bind(sessionId).first<{ user_id: number }>();
    
    if (!session) {
      return c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED, 'Session expired'), 401);
    }
    
    let libraryChar;
    
    // Support both user_character_id (from frontend) and character_key
    if (user_character_id) {
      // Get character by ID
      libraryChar = await c.env.DB.prepare(`
        SELECT * FROM user_characters WHERE id = ? AND user_id = ?
      `).bind(user_character_id, session.user_id).first();
    } else if (character_key) {
      // Get character by key
      libraryChar = await c.env.DB.prepare(`
        SELECT * FROM user_characters WHERE user_id = ? AND character_key = ?
      `).bind(session.user_id, character_key).first();
    } else {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'user_character_id or character_key is required'), 400);
    }
    
    if (!libraryChar) {
      return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND, 'Character not found in library'), 404);
    }
    
    // Check if already imported
    const existing = await c.env.DB.prepare(`
      SELECT id FROM project_character_models WHERE project_id = ? AND character_key = ?
    `).bind(projectId, libraryChar.character_key).first();
    
    if (existing) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Character already exists in project'), 400);
    }
    
    // Import to project
    const result = await c.env.DB.prepare(`
      INSERT INTO project_character_models
        (project_id, character_key, character_name, description, appearance_description,
         reference_image_r2_key, reference_image_r2_url, voice_preset_id, aliases_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      projectId,
      libraryChar.character_key,
      libraryChar.character_name,
      libraryChar.description,
      libraryChar.appearance_description,
      libraryChar.reference_image_r2_key,
      libraryChar.reference_image_r2_url,
      libraryChar.voice_preset_id,
      libraryChar.aliases_json
    ).run();
    
    const character = await c.env.DB.prepare(`
      SELECT * FROM project_character_models WHERE id = ?
    `).bind(result.meta.last_row_id).first();
    
    return c.json({ character }, 201);
  } catch (error) {
    console.error('[Characters] Import error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to import character'), 500);
  }
});

/**
 * POST /api/projects/:projectId/characters/:characterKey/save-to-library
 * Save a project character to user's library
 */
app.post('/projects/:projectId/characters/:characterKey/save-to-library', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    const characterKey = c.req.param('characterKey');
    
    // Get user ID from session
    const { getCookie } = await import('hono/cookie');
    const sessionId = getCookie(c, 'session');
    if (!sessionId) {
      return c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED, 'Authentication required'), 401);
    }
    
    const session = await c.env.DB.prepare(`
      SELECT user_id FROM sessions WHERE id = ? AND expires_at > datetime('now')
    `).bind(sessionId).first<{ user_id: number }>();
    
    if (!session) {
      return c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED, 'Session expired'), 401);
    }
    
    // Get character from project
    const projectChar = await c.env.DB.prepare(`
      SELECT * FROM project_character_models WHERE project_id = ? AND character_key = ?
    `).bind(projectId, characterKey).first();
    
    if (!projectChar) {
      return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND, 'Character not found in project'), 404);
    }
    
    // Upsert to library
    await c.env.DB.prepare(`
      INSERT INTO user_characters
        (user_id, character_key, character_name, description, appearance_description,
         reference_image_r2_key, reference_image_r2_url, voice_preset_id, aliases_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, character_key) DO UPDATE SET
        character_name = excluded.character_name,
        description = excluded.description,
        appearance_description = excluded.appearance_description,
        reference_image_r2_key = excluded.reference_image_r2_key,
        reference_image_r2_url = excluded.reference_image_r2_url,
        voice_preset_id = excluded.voice_preset_id,
        aliases_json = excluded.aliases_json,
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      session.user_id,
      projectChar.character_key,
      projectChar.character_name,
      projectChar.description,
      projectChar.appearance_description,
      projectChar.reference_image_r2_key,
      projectChar.reference_image_r2_url,
      projectChar.voice_preset_id,
      projectChar.aliases_json
    ).run();
    
    return c.json({ success: true, message: 'Character saved to library' });
  } catch (error) {
    console.error('[Characters] Save to library error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to save character to library'), 500);
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
