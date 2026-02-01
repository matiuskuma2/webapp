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
        pcm.id, pcm.project_id, pcm.character_key, pcm.character_name, pcm.description,
        pcm.appearance_description, pcm.reference_image_r2_key, pcm.reference_image_r2_url,
        pcm.voice_preset_id, pcm.aliases_json, pcm.style_preset_id,
        pcm.created_at, pcm.updated_at,
        sp.name as style_preset_name
      FROM project_character_models pcm
      LEFT JOIN style_presets sp ON pcm.style_preset_id = sp.id
      WHERE pcm.project_id = ?
      ORDER BY pcm.created_at ASC
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
      aliases,
      style_preset_id
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
         reference_image_r2_key, reference_image_r2_url, voice_preset_id, aliases_json, style_preset_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      projectId,
      character_key,
      character_name,
      description || null,
      appearance_description || null,
      reference_image_r2_key || null,
      reference_image_r2_url || null,
      voice_preset_id || null,
      aliasesJson,
      style_preset_id || null
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
      aliases,
      style_preset_id
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
          voice_preset_id = ?, aliases_json = ?, style_preset_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND character_key = ?
    `).bind(
      character_name,
      description || null,
      appearance_description || null,
      reference_image_r2_key || null,
      reference_image_r2_url || null,
      voice_preset_id || null,
      aliasesJson,
      style_preset_id || null,
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

/**
 * POST /api/projects/:projectId/characters/auto-assign
 * Manually trigger character auto-assignment
 * 
 * Phase X-2: Manual re-run of auto-assignment
 * - Overwrites existing assignments
 * - UI should show confirmation modal before calling
 */
app.post('/projects/:projectId/characters/auto-assign', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    
    // Verify project exists
    const project = await c.env.DB.prepare(`
      SELECT id, status FROM projects WHERE id = ?
    `).bind(projectId).first();
    
    if (!project) {
      return c.json(
        createErrorResponse(ERROR_CODES.NOT_FOUND, 'Project not found'),
        404
      );
    }
    
    // Execute auto-assign
    const { autoAssignCharactersToScenes } = await import('../utils/character-auto-assign');
    const { extractAndUpdateCharacterTraits } = await import('../utils/character-trait-extractor');
    
    const result = await autoAssignCharactersToScenes(c.env.DB, projectId);
    
    // Phase X-3: Also extract and update character traits
    const traitResult = await extractAndUpdateCharacterTraits(c.env.DB, projectId);
    console.log(`[Phase X-3] Extracted traits for ${traitResult.updated} characters during auto-assign`);
    
    return c.json({
      success: true,
      assigned: result.assigned,
      scenes: result.scenes,
      skipped: result.skipped,
      traits_updated: traitResult.updated,
      message: `Assigned ${result.assigned} characters to ${result.scenes} scenes, updated ${traitResult.updated} character traits`
    });
  } catch (error) {
    console.error('[Characters] Auto-assign error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to auto-assign characters'),
      500
    );
  }
});

/**
 * POST /api/projects/:projectId/characters/:characterKey/reference-image
 * Upload reference image for a character
 */
app.post('/projects/:projectId/characters/:characterKey/reference-image', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    const characterKey = c.req.param('characterKey');

    // Verify character exists
    const character = await c.env.DB.prepare(`
      SELECT id FROM project_character_models
      WHERE project_id = ? AND character_key = ?
    `).bind(projectId, characterKey).first();

    if (!character) {
      return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND, 'Character not found'), 404);
    }

    // Parse form data
    const formData = await c.req.formData();
    const imageFile = formData.get('image') as File;

    if (!imageFile) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Image file is required'), 400);
    }

    // Validate file type
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp'];
    if (!allowedTypes.includes(imageFile.type)) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Invalid image type. Allowed: PNG, JPEG, WEBP'), 400);
    }

    // Validate file size (5MB max)
    const maxSize = 5 * 1024 * 1024;
    if (imageFile.size > maxSize) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'File size exceeds 5MB limit'), 400);
    }

    // Generate R2 key (with images/ prefix for consistency with other images)
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    const ext = imageFile.type.split('/')[1];
    const r2Key = `images/characters/${projectId}/${characterKey}_${timestamp}_${random}.${ext}`;

    // Upload to R2
    await c.env.R2.put(r2Key, imageFile.stream(), {
      httpMetadata: {
        contentType: imageFile.type
      }
    });

    // Generate URL for the image (r2Key already starts with 'images/')
    const r2Url = `/${r2Key}`;

    // Update character
    await c.env.DB.prepare(`
      UPDATE project_character_models
      SET reference_image_r2_key = ?,
          reference_image_r2_url = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND character_key = ?
    `).bind(r2Key, r2Url, projectId, characterKey).run();

    return c.json({
      success: true,
      r2_key: r2Key,
      r2_url: r2Url
    });
  } catch (error) {
    console.error('[Characters] Reference image upload error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to upload reference image'), 500);
  }
});

/**
 * DELETE /api/projects/:projectId/characters/:characterKey/reference-image
 * Delete reference image for a character
 */
app.delete('/projects/:projectId/characters/:characterKey/reference-image', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    const characterKey = c.req.param('characterKey');

    // Get character with current reference image
    const character = await c.env.DB.prepare(`
      SELECT reference_image_r2_key FROM project_character_models
      WHERE project_id = ? AND character_key = ?
    `).bind(projectId, characterKey).first<{ reference_image_r2_key: string | null }>();

    if (!character) {
      return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND, 'Character not found'), 404);
    }

    // Delete from R2 if exists
    if (character.reference_image_r2_key) {
      await c.env.R2.delete(character.reference_image_r2_key);
    }

    // Update character
    await c.env.DB.prepare(`
      UPDATE project_character_models
      SET reference_image_r2_key = NULL,
          reference_image_r2_url = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND character_key = ?
    `).bind(projectId, characterKey).run();

    return c.json({ success: true });
  } catch (error) {
    console.error('[Characters] Reference image delete error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to delete reference image'), 500);
  }
});

/**
 * POST /api/projects/:projectId/characters/:characterKey/update
 * Update character with optional image (unified endpoint for FormData)
 */
app.post('/projects/:projectId/characters/:characterKey/update', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    const characterKey = c.req.param('characterKey');

    // Verify character exists
    const existing = await c.env.DB.prepare(`
      SELECT id, reference_image_r2_key FROM project_character_models
      WHERE project_id = ? AND character_key = ?
    `).bind(projectId, characterKey).first<{ id: number; reference_image_r2_key: string | null }>();

    if (!existing) {
      return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND, 'Character not found'), 404);
    }

    // Parse form data
    const formData = await c.req.formData();
    const characterName = formData.get('character_name') as string || '';
    const aliasesJsonStr = formData.get('aliases_json') as string || '[]';
    const appearanceDescription = formData.get('appearance_description') as string || '';
    const storyTraits = formData.get('story_traits') as string || '';
    const voicePresetId = formData.get('voice_preset_id') as string || '';
    const imageFile = formData.get('image') as File | null;

    // Parse aliases
    let aliasesJson = null;
    try {
      const aliases = JSON.parse(aliasesJsonStr);
      if (Array.isArray(aliases) && aliases.length > 0) {
        aliasesJson = JSON.stringify(aliases);
      }
    } catch (_) {
      // Keep null
    }

    // Handle image upload if provided
    let r2Key = existing.reference_image_r2_key;
    let r2Url = null;

    if (imageFile && imageFile.size > 0) {
      // Validate file type
      const allowedTypes = ['image/png', 'image/jpeg', 'image/webp'];
      if (!allowedTypes.includes(imageFile.type)) {
        return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Invalid image type'), 400);
      }

      // Validate file size (5MB max)
      const maxSize = 5 * 1024 * 1024;
      if (imageFile.size > maxSize) {
        return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'File size exceeds 5MB'), 400);
      }

      // Delete old image if exists
      if (existing.reference_image_r2_key) {
        await c.env.R2.delete(existing.reference_image_r2_key);
      }

      // Generate new R2 key (with images/ prefix for consistency)
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(7);
      const ext = imageFile.type.split('/')[1];
      r2Key = `images/characters/${projectId}/${characterKey}_${timestamp}_${random}.${ext}`;

      // Upload to R2
      await c.env.R2.put(r2Key, imageFile.stream(), {
        httpMetadata: { contentType: imageFile.type }
      });

      r2Url = `/${r2Key}`;
    } else {
      // Keep existing URL
      const current = await c.env.DB.prepare(`
        SELECT reference_image_r2_url FROM project_character_models
        WHERE project_id = ? AND character_key = ?
      `).bind(projectId, characterKey).first<{ reference_image_r2_url: string | null }>();
      r2Url = current?.reference_image_r2_url || null;
    }

    // Update character
    await c.env.DB.prepare(`
      UPDATE project_character_models
      SET character_name = ?,
          aliases_json = ?,
          appearance_description = ?,
          story_traits = ?,
          voice_preset_id = ?,
          reference_image_r2_key = ?,
          reference_image_r2_url = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND character_key = ?
    `).bind(
      characterName || null,
      aliasesJson,
      appearanceDescription || null,
      storyTraits || null,
      voicePresetId || null,
      r2Key,
      r2Url,
      projectId,
      characterKey
    ).run();

    const character = await c.env.DB.prepare(`
      SELECT * FROM project_character_models
      WHERE project_id = ? AND character_key = ?
    `).bind(projectId, characterKey).first();

    return c.json({ character });
  } catch (error) {
    console.error('[Characters] Update with image error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to update character'), 500);
  }
});

// ===== Image Generation Logging =====
interface ImageGenerationLogParams {
  env: Bindings;
  userId?: number;
  projectId?: number;
  sceneId?: number;
  characterKey?: string;
  generationType: 'scene_image' | 'character_preview' | 'character_reference';
  provider: string;
  model: string;
  apiKeySource: 'user' | 'system' | 'sponsor';
  sponsorUserId?: number;
  promptLength?: number;
  imageCount?: number;
  imageSize?: string;
  imageQuality?: string;
  status: 'success' | 'failed' | 'quota_exceeded';
  errorMessage?: string;
  errorCode?: string;
  referenceImageCount?: number;
}

// コスト推定関数（画像生成）
function estimateImageGenerationCost(provider: string, model: string, imageCount: number = 1): number {
  // Gemini Imagen: ~$0.04/image, Gemini experimental: free during preview
  // OpenAI DALL-E 3: ~$0.04/image
  if (provider === 'gemini') {
    if (model.includes('imagen')) return 0.04 * imageCount;
    // gemini-3-pro-image-preview is experimental/free
    return 0;
  }
  if (provider === 'openai') {
    if (model.includes('dall-e-3')) return 0.04 * imageCount;
  }
  return 0;
}

// 画像生成ログ記録
async function logImageGeneration(params: ImageGenerationLogParams): Promise<void> {
  try {
    const estimatedCost = estimateImageGenerationCost(params.provider, params.model, params.imageCount);
    
    await params.env.DB.prepare(`
      INSERT INTO image_generation_logs (
        user_id, project_id, scene_id, character_key,
        generation_type, provider, model,
        api_key_source, sponsor_user_id,
        prompt_length, image_count, image_size, image_quality,
        estimated_cost_usd, billing_unit, billing_amount,
        status, error_message, error_code,
        reference_image_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      params.userId ?? 1, // デフォルトユーザー
      params.projectId ?? null,
      params.sceneId ?? null,
      params.characterKey ?? null,
      params.generationType,
      params.provider,
      params.model,
      params.apiKeySource,
      params.sponsorUserId ?? null,
      params.promptLength ?? null,
      params.imageCount ?? 1,
      params.imageSize ?? null,
      params.imageQuality ?? null,
      estimatedCost,
      'image', // billing_unit
      params.imageCount ?? 1, // billing_amount
      params.status,
      params.errorMessage ?? null,
      params.errorCode ?? null,
      params.referenceImageCount ?? 0
    ).run();
    
    console.log(`[Image Generation] Logged: type=${params.generationType}, provider=${params.provider}, keySource=${params.apiKeySource}, cost=$${estimatedCost.toFixed(4)}, status=${params.status}`);
  } catch (error) {
    // ログ記録の失敗は無視（本体処理に影響させない）
    console.error('[Image Generation] Failed to log:', error);
  }
}

/**
 * POST /api/projects/:projectId/characters/generate-preview
 * Generate a preview image for character (AI generation)
 * 
 * API Key Priority:
 * 1. User's registered Google API key (from user_api_keys table)
 * 2. System GEMINI_API_KEY (fallback)
 */
app.post('/projects/:projectId/characters/generate-preview', async (c) => {
  const projectId = Number(c.req.param('projectId'));
  let userId: number | undefined;
  let apiKeySource: 'user' | 'system' = 'system';
  const model = 'gemini-3-pro-image-preview';
  const provider = 'gemini';
  
  try {
    const { prompt, characterKey } = await c.req.json() as { prompt?: string; characterKey?: string };

    if (!prompt || prompt.trim() === '') {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Prompt is required'), 400);
    }

    // Get session and user info
    const { getCookie } = await import('hono/cookie');
    const sessionId = getCookie(c, 'session');
    
    let apiKey: string | null = null;
    
    // Step 1: Try to get user's API key
    if (sessionId) {
      const session = await c.env.DB.prepare(`
        SELECT user_id FROM sessions WHERE id = ? AND expires_at > datetime('now')
      `).bind(sessionId).first<{ user_id: number }>();
      
      if (session) {
        userId = session.user_id;
        
        const keyRecord = await c.env.DB.prepare(`
          SELECT encrypted_key FROM user_api_keys
          WHERE user_id = ? AND provider = 'google'
        `).bind(session.user_id).first<{ encrypted_key: string }>();
        
        if (keyRecord?.encrypted_key) {
          try {
            const { decryptApiKey } = await import('../utils/crypto');
            apiKey = await decryptApiKey(keyRecord.encrypted_key, c.env.ENCRYPTION_KEY);
            apiKeySource = 'user';
            console.log(`[Characters] Using USER API key for user_id=${userId}`);
          } catch (decryptError) {
            console.warn('[Characters] Failed to decrypt user API key:', decryptError);
          }
        }
      }
    }
    
    // Step 2: Fallback to system key (GEMINI_API_KEY only - GOOGLE_API_KEY not defined in bindings)
    if (!apiKey) {
      if (c.env.GEMINI_API_KEY) {
        apiKey = c.env.GEMINI_API_KEY;
        apiKeySource = 'system';
        console.log(`[Characters] Using SYSTEM GEMINI_API_KEY (user key not found or not configured)`);
      }
    }
    
    // Step 3: No key available
    if (!apiKey) {
      console.error('[Characters] No API key available - user has no key and system key not configured');
      
      // Log the failure
      await logImageGeneration({
        env: c.env,
        userId,
        projectId,
        characterKey,
        generationType: 'character_preview',
        provider,
        model,
        apiKeySource,
        promptLength: prompt.length,
        status: 'failed',
        errorMessage: 'No API key configured',
        errorCode: 'NO_API_KEY'
      });
      
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'No API key configured for image generation. Please configure your Google API key in Settings.'), 400);
    }

    // Build full prompt for character portrait
    const fullPrompt = `Create a detailed portrait of a character: ${prompt}. High quality, professional illustration style, clear face visible, upper body portrait, neutral or simple background, anime/illustration style preferred for character consistency.`;

    // Helper function to call Gemini API
    const callGeminiApi = async (keyToUse: string): Promise<Response> => {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      return fetch(geminiUrl, {
        method: 'POST',
        headers: {
          'x-goog-api-key': keyToUse,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: fullPrompt }
              ]
            }
          ],
          generationConfig: {
            responseModalities: ['Image'],
            imageConfig: {
              aspectRatio: '1:1',
              imageSize: '1K'
            }
          }
        })
      });
    };

    // Call Gemini API with quota fallback
    console.log(`[Characters] Calling Gemini API: model=${model}, keySource=${apiKeySource}, promptLength=${prompt.length}`);
    
    let response = await callGeminiApi(apiKey);
    let currentKeySource = apiKeySource;

    // If user key quota exceeded and system key is available, try with system key
    if (!response.ok && apiKeySource === 'user' && c.env.GEMINI_API_KEY) {
      const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
      const errorMessage = errorData?.error?.message || '';
      const isQuotaExceeded = errorMessage.toLowerCase().includes('quota') || 
                             errorMessage.toLowerCase().includes('resource_exhausted') ||
                             response.status === 429;
      
      if (isQuotaExceeded) {
        console.log(`[Characters] User key quota exceeded, falling back to SYSTEM key`);
        
        // Log the user key failure
        await logImageGeneration({
          env: c.env,
          userId,
          projectId,
          characterKey,
          generationType: 'character_preview',
          provider,
          model,
          apiKeySource: 'user',
          promptLength: prompt.length,
          imageSize: '1:1',
          imageQuality: '1K',
          status: 'quota_exceeded',
          errorMessage: 'User key quota exceeded, retrying with system key',
          errorCode: 'QUOTA_EXCEEDED_FALLBACK'
        });
        
        // Retry with system key
        response = await callGeminiApi(c.env.GEMINI_API_KEY);
        currentKeySource = 'system';
      }
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string; status?: string } };
      console.error('[Characters] Gemini API error:', response.status, JSON.stringify(errorData));
      
      const errorMessage = errorData?.error?.message || `Image generation failed (HTTP ${response.status})`;
      const isQuotaExceeded = errorMessage.toLowerCase().includes('quota') || response.status === 429;
      
      // Log the failure with details
      await logImageGeneration({
        env: c.env,
        userId,
        projectId,
        characterKey,
        generationType: 'character_preview',
        provider,
        model,
        apiKeySource: currentKeySource,
        promptLength: prompt.length,
        imageSize: '1:1',
        imageQuality: '1K',
        status: isQuotaExceeded ? 'quota_exceeded' : 'failed',
        errorMessage,
        errorCode: isQuotaExceeded ? 'QUOTA_EXCEEDED' : `HTTP_${response.status}`
      });
      
      // Add helpful message for quota errors
      if (isQuotaExceeded) {
        const helpMessage = currentKeySource === 'system'
          ? 'System API key quota exceeded. Please try again later or configure your own Google API key in Settings.'
          : 'Your API key quota exceeded. Please try again later or enable billing on your Google Cloud project.';
        return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, helpMessage), 429);
      }
      
      return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, errorMessage), 500);
    }
    
    // Update apiKeySource for logging
    apiKeySource = currentKeySource;

    const result = await response.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { data?: string; mimeType?: string }
          }>
        }
      }>
    };
    
    // Extract image from Gemini response format
    let base64Image: string | undefined;
    if (result.candidates && result.candidates.length > 0) {
      const parts = result.candidates[0].content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          base64Image = part.inlineData.data;
          break;
        }
      }
    }
    
    if (!base64Image) {
      console.error('[Characters] No image in response:', JSON.stringify(result).substring(0, 500));
      
      await logImageGeneration({
        env: c.env,
        userId,
        projectId,
        characterKey,
        generationType: 'character_preview',
        provider,
        model,
        apiKeySource,
        promptLength: prompt.length,
        imageSize: '1:1',
        imageQuality: '1K',
        status: 'failed',
        errorMessage: 'No image in API response',
        errorCode: 'NO_IMAGE_IN_RESPONSE'
      });
      
      return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'No image generated'), 500);
    }

    // Log successful generation
    await logImageGeneration({
      env: c.env,
      userId,
      projectId,
      characterKey,
      generationType: 'character_preview',
      provider,
      model,
      apiKeySource,
      promptLength: prompt.length,
      imageSize: '1:1',
      imageQuality: '1K',
      status: 'success'
    });

    // Convert base64 to binary
    const binaryData = Uint8Array.from(atob(base64Image), c => c.charCodeAt(0));

    // Return as PNG image
    return new Response(binaryData, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache'
      }
    });
  } catch (error) {
    console.error('[Characters] Generate preview error:', error);
    
    // Log the error
    await logImageGeneration({
      env: c.env,
      userId,
      projectId,
      generationType: 'character_preview',
      provider,
      model,
      apiKeySource,
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      errorCode: 'INTERNAL_ERROR'
    });
    
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to generate preview'), 500);
  }
});

/**
 * POST /api/projects/:projectId/characters/create-with-image
 * Create a new character with image in one request (FormData)
 */
app.post('/projects/:projectId/characters/create-with-image', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));

    // Parse form data
    const formData = await c.req.formData();
    const characterKey = formData.get('character_key') as string || '';
    const characterName = formData.get('character_name') as string || '';
    const aliasesJsonStr = formData.get('aliases_json') as string || '[]';
    const appearanceDescription = formData.get('appearance_description') as string || '';
    const voicePresetId = formData.get('voice_preset_id') as string || '';
    const imageFile = formData.get('image') as File | null;

    // Validation
    if (!characterKey || !characterName) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'character_key and character_name are required'), 400);
    }

    if (!/^[a-zA-Z0-9_]+$/.test(characterKey)) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'character_key must be alphanumeric with underscores only'), 400);
    }

    // Check for duplicate
    const existing = await c.env.DB.prepare(`
      SELECT id FROM project_character_models
      WHERE project_id = ? AND character_key = ?
    `).bind(projectId, characterKey).first();

    if (existing) {
      return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Character key already exists'), 400);
    }

    // Parse aliases
    let aliasesJson = null;
    try {
      const aliases = JSON.parse(aliasesJsonStr);
      if (Array.isArray(aliases) && aliases.length > 0) {
        const validAliases = aliases.filter(a => typeof a === 'string' && a.trim().length > 0);
        aliasesJson = validAliases.length > 0 ? JSON.stringify(validAliases) : null;
      }
    } catch (_) {
      // Keep null
    }

    // Handle image upload
    let r2Key: string | null = null;
    let r2Url: string | null = null;

    if (imageFile && imageFile.size > 0) {
      // Validate file type
      const allowedTypes = ['image/png', 'image/jpeg', 'image/webp'];
      if (!allowedTypes.includes(imageFile.type)) {
        return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Invalid image type'), 400);
      }

      // Validate file size (5MB max)
      const maxSize = 5 * 1024 * 1024;
      if (imageFile.size > maxSize) {
        return c.json(createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'File size exceeds 5MB'), 400);
      }

      // Generate R2 key (with images/ prefix for consistency)
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(7);
      const ext = imageFile.type.split('/')[1];
      r2Key = `images/characters/${projectId}/${characterKey}_${timestamp}_${random}.${ext}`;

      // Upload to R2
      await c.env.R2.put(r2Key, imageFile.stream(), {
        httpMetadata: { contentType: imageFile.type }
      });

      r2Url = `/${r2Key}`;
    }

    // Create character
    const result = await c.env.DB.prepare(`
      INSERT INTO project_character_models
        (project_id, character_key, character_name, description, appearance_description,
         reference_image_r2_key, reference_image_r2_url, voice_preset_id, aliases_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      projectId,
      characterKey,
      characterName,
      null,
      appearanceDescription || null,
      r2Key,
      r2Url,
      voicePresetId || null,
      aliasesJson
    ).run();

    const character = await c.env.DB.prepare(`
      SELECT * FROM project_character_models WHERE id = ?
    `).bind(result.meta.last_row_id).first();

    return c.json({ character }, 201);
  } catch (error) {
    console.error('[Characters] Create with image error:', error);
    return c.json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to create character'), 500);
  }
});

/**
 * GET /api/projects/:projectId/character-traits-summary
 * Get summary of all character traits for visualization
 * 
 * Returns:
 * - For each character: base traits (story_traits), scene overrides
 * - Useful for scene split visualization
 */
app.get('/projects/:projectId/character-traits-summary', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    
    // Get all characters with their story traits
    const characters = await c.env.DB.prepare(`
      SELECT 
        character_key, character_name, appearance_description, story_traits, reference_image_r2_url
      FROM project_character_models
      WHERE project_id = ?
      ORDER BY created_at ASC
    `).bind(projectId).all();
    
    // Get all scene trait overrides for this project
    const sceneTraits = await c.env.DB.prepare(`
      SELECT 
        sct.scene_id, sct.character_key, sct.override_type, sct.trait_description, sct.source,
        s.idx as scene_idx, s.title as scene_title
      FROM scene_character_traits sct
      INNER JOIN scenes s ON sct.scene_id = s.id
      WHERE s.project_id = ?
      ORDER BY s.idx ASC
    `).bind(projectId).all();
    
    // Build summary for each character
    const characterSummaries = (characters.results || []).map(char => {
      const overrides = (sceneTraits.results || [])
        .filter(t => t.character_key === char.character_key)
        .map(t => ({
          scene_id: t.scene_id,
          scene_idx: t.scene_idx,
          scene_title: t.scene_title,
          override_type: t.override_type,
          trait_description: t.trait_description,
          source: t.source
        }));
      
      return {
        character_key: char.character_key,
        character_name: char.character_name,
        base_traits: char.story_traits || char.appearance_description || null,
        reference_image: char.reference_image_r2_url || null,
        scene_overrides: overrides
      };
    });
    
    return c.json({
      characters: characterSummaries
    });
  } catch (error) {
    console.error('[Characters] Traits summary error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to get character traits summary'),
      500
    );
  }
});

/**
 * PUT /api/projects/:projectId/characters/:characterKey/story-traits
 * Update story-wide traits for a character
 */
app.put('/projects/:projectId/characters/:characterKey/story-traits', async (c) => {
  try {
    const projectId = Number(c.req.param('projectId'));
    const characterKey = c.req.param('characterKey');
    const body = await c.req.json();
    
    const { story_traits } = body;
    
    // P2: Sanitize B-layer traits to prevent text on images
    const sanitizedTraits = sanitizeTraits(story_traits || '');
    
    await c.env.DB.prepare(`
      UPDATE project_character_models
      SET story_traits = ?, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND character_key = ?
    `).bind(sanitizedTraits || null, projectId, characterKey).run();
    
    const character = await c.env.DB.prepare(`
      SELECT * FROM project_character_models
      WHERE project_id = ? AND character_key = ?
    `).bind(projectId, characterKey).first();
    
    return c.json({ character });
  } catch (error) {
    console.error('[Characters] Update story traits error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to update story traits'),
      500
    );
  }
});

/**
 * Sanitize trait description to prevent text appearing in images
 * - Remove dialogue (「」)
 * - Remove emotional/action words
 * - Limit length
 * 
 * Same as scene-characters.ts (P2: apply to B-layer story_traits)
 */
function sanitizeTraits(s: string): string {
  if (!s) return '';
  let t = s;
  
  // Remove dialogue in brackets
  t = t.replace(/「[^」]*」/g, '');
  
  // Remove quotes
  t = t.replace(/["']/g, '');
  
  // Remove emotional/action patterns
  const excludePatterns = [
    /[泣笑怒叫言答驚悲喜思考願祈][いきくけこっ]*/g,
    /ありがとう|ごめん|すみません|一緒に|来い|行こう|待って|お願い/g,
    /という|と言って|と答え|と叫/g,
  ];
  
  for (const pattern of excludePatterns) {
    t = t.replace(pattern, '');
  }
  
  // Clean up whitespace and punctuation
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/^[、。\s]+|[、。\s]+$/g, '');
  t = t.replace(/、{2,}/g, '、');
  
  // Limit length
  if (t.length > 150) {
    t = t.substring(0, 150);
  }
  
  return t;
}

export default app;
