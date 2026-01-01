/**
 * Scene-Character Mapping API (Phase X-2)
 * Manages which characters appear in which scenes
 */

import { Hono } from 'hono';
import type { Bindings } from '../types/bindings';
import { ERROR_CODES } from '../constants';
import { createErrorResponse } from '../utils/error-response';

const app = new Hono<{ Bindings: Bindings }>();

/**
 * GET /api/scenes/:sceneId/characters
 * List characters in a scene
 */
app.get('/scenes/:sceneId/characters', async (c) => {
  try {
    const sceneId = Number(c.req.param('sceneId'));
    
    const mappings = await c.env.DB.prepare(`
      SELECT 
        scm.id, scm.scene_id, scm.character_key, scm.is_primary, scm.created_at,
        pcm.character_name, pcm.appearance_description, pcm.reference_image_r2_url
      FROM scene_character_map scm
      LEFT JOIN scenes s ON scm.scene_id = s.id
      LEFT JOIN project_character_models pcm 
        ON s.project_id = pcm.project_id AND scm.character_key = pcm.character_key
      WHERE scm.scene_id = ?
      ORDER BY scm.is_primary DESC, scm.created_at ASC
    `).bind(sceneId).all();

    return c.json({
      scene_characters: mappings.results || []
    });
  } catch (error) {
    console.error('[Scene Characters] List error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to list scene characters'),
      500
    );
  }
});

/**
 * POST /api/scenes/:sceneId/characters
 * Add a character to a scene
 */
app.post('/scenes/:sceneId/characters', async (c) => {
  try {
    const sceneId = Number(c.req.param('sceneId'));
    const body = await c.req.json();

    const { character_key, is_primary } = body;

    if (!character_key) {
      return c.json(
        createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'character_key is required'),
        400
      );
    }

    // Phase X-2: Check maximum 3 characters per scene
    const currentCount = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM scene_character_map WHERE scene_id = ?
    `).bind(sceneId).first();

    if (currentCount && (currentCount.count as number) >= 3) {
      return c.json(
        createErrorResponse(
          ERROR_CODES.INVALID_REQUEST,
          'Maximum 3 characters per scene. Remove an existing character first.'
        ),
        400
      );
    }

    // Check if mapping already exists
    const existing = await c.env.DB.prepare(`
      SELECT id FROM scene_character_map
      WHERE scene_id = ? AND character_key = ?
    `).bind(sceneId, character_key).first();

    if (existing) {
      return c.json(
        createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Character already added to scene'),
        400
      );
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO scene_character_map (scene_id, character_key, is_primary)
      VALUES (?, ?, ?)
    `).bind(sceneId, character_key, is_primary ? 1 : 0).run();

    const mapping = await c.env.DB.prepare(`
      SELECT 
        scm.*, pcm.character_name, pcm.appearance_description
      FROM scene_character_map scm
      LEFT JOIN scenes s ON scm.scene_id = s.id
      LEFT JOIN project_character_models pcm 
        ON s.project_id = pcm.project_id AND scm.character_key = pcm.character_key
      WHERE scm.id = ?
    `).bind(result.meta.last_row_id).first();

    return c.json({
      scene_character: mapping
    }, 201);
  } catch (error) {
    console.error('[Scene Characters] Add error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to add character to scene'),
      500
    );
  }
});

/**
 * PUT /api/scenes/:sceneId/characters/:characterKey
 * Update character mapping in a scene (e.g., toggle is_primary)
 */
app.put('/scenes/:sceneId/characters/:characterKey', async (c) => {
  try {
    const sceneId = Number(c.req.param('sceneId'));
    const characterKey = c.req.param('characterKey');
    const body = await c.req.json();

    const { is_primary } = body;

    await c.env.DB.prepare(`
      UPDATE scene_character_map
      SET is_primary = ?
      WHERE scene_id = ? AND character_key = ?
    `).bind(is_primary ? 1 : 0, sceneId, characterKey).run();

    const mapping = await c.env.DB.prepare(`
      SELECT * FROM scene_character_map
      WHERE scene_id = ? AND character_key = ?
    `).bind(sceneId, characterKey).first();

    return c.json({
      scene_character: mapping
    });
  } catch (error) {
    console.error('[Scene Characters] Update error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to update scene character'),
      500
    );
  }
});

/**
 * DELETE /api/scenes/:sceneId/characters/:characterKey
 * Remove a character from a scene
 */
app.delete('/scenes/:sceneId/characters/:characterKey', async (c) => {
  try {
    const sceneId = Number(c.req.param('sceneId'));
    const characterKey = c.req.param('characterKey');

    await c.env.DB.prepare(`
      DELETE FROM scene_character_map
      WHERE scene_id = ? AND character_key = ?
    `).bind(sceneId, characterKey).run();

    return c.json({ success: true });
  } catch (error) {
    console.error('[Scene Characters] Delete error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to remove character from scene'),
      500
    );
  }
});

/**
 * POST /api/scenes/:sceneId/characters/batch
 * Batch update: Replace all characters in a scene
 */
app.post('/scenes/:sceneId/characters/batch', async (c) => {
  try {
    const sceneId = Number(c.req.param('sceneId'));
    const body = await c.req.json();

    const { character_keys } = body;

    if (!Array.isArray(character_keys)) {
      return c.json(
        createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'character_keys must be an array'),
        400
      );
    }

    // Delete existing mappings
    await c.env.DB.prepare(`
      DELETE FROM scene_character_map WHERE scene_id = ?
    `).bind(sceneId).run();

    // Insert new mappings
    for (const key of character_keys) {
      await c.env.DB.prepare(`
        INSERT INTO scene_character_map (scene_id, character_key, is_primary)
        VALUES (?, ?, 0)
      `).bind(sceneId, key).run();
    }

    // Return updated list
    const mappings = await c.env.DB.prepare(`
      SELECT * FROM scene_character_map WHERE scene_id = ?
    `).bind(sceneId).all();

    return c.json({
      scene_characters: mappings.results || []
    });
  } catch (error) {
    console.error('[Scene Characters] Batch error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to batch update scene characters'),
      500
    );
  }
});

/**
 * POST /api/projects/:projectId/characters/auto-assign
 * Manually trigger character auto-assignment
 * 
 * Phase X-2: Manual re-run of auto-assignment
 * - Overwrites existing assignments
 * - UI should show confirmation modal before calling
 * 
 * Safety:
 * - Project existence check
 * - Optional: Block if image/audio generation in progress (409)
 */
app.post('/projects/:projectId/characters/auto-assign', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    
    // Verify project exists
    const project = await c.env.DB.prepare(`
      SELECT id, status FROM projects WHERE id = ?
    `).bind(projectId).first();
    
    if (!project) {
      return c.json({
        error: 'NOT_FOUND',
        message: 'Project not found'
      }, 404);
    }
    
    // TODO: 要確認 - Block if generation in progress?
    // if (project.status === 'generating_images') {
    //   return c.json({
    //     error: 'GENERATION_IN_PROGRESS',
    //     message: 'Cannot re-assign while image generation is in progress'
    //   }, 409);
    // }
    
    // Execute auto-assign
    const { autoAssignCharactersToScenes } = await import('../utils/character-auto-assign');
    const result = await autoAssignCharactersToScenes(c.env.DB, projectId);
    
    return c.json({
      success: true,
      assigned: result.assigned,
      scenes: result.scenes,
      skipped: result.skipped,
      message: `Assigned ${result.assigned} characters to ${result.scenes} scenes`
    });
  } catch (error) {
    console.error('[SceneCharacters] Auto-assign error:', error);
    return c.json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to auto-assign characters'
    }, 500);
  }
});

export default app;
