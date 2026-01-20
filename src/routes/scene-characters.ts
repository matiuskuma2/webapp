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
app.get('/:sceneId/characters', async (c) => {
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
app.post('/:sceneId/characters', async (c) => {
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
app.put('/:sceneId/characters/:characterKey', async (c) => {
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
app.delete('/:sceneId/characters/:characterKey', async (c) => {
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
 * 
 * SSOT Rule:
 * - voice_character must be one of image_characters
 * - If voice_character is not specified, first character becomes primary automatically
 * - Exactly one is_primary=1 must exist after save (prevents "voice not determined" issues)
 */
app.post('/:sceneId/characters/batch', async (c) => {
  try {
    const sceneId = Number(c.req.param('sceneId'));
    const body = await c.req.json();

    // Support both old format (character_keys) and new format (image_characters)
    const character_keys = body.character_keys || body.image_characters || [];
    let voice_character = body.voice_character || null;

    if (!Array.isArray(character_keys)) {
      return c.json(
        createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'character_keys or image_characters must be an array'),
        400
      );
    }

    // SSOT: voice_character must be in image_characters
    // If not specified or invalid, auto-select first character as primary
    if (character_keys.length > 0) {
      if (!voice_character || !character_keys.includes(voice_character)) {
        voice_character = character_keys[0]; // Auto-select first as primary
        console.log(`[Scene Characters] Auto-selected voice_character: ${voice_character}`);
      }
    }

    // Delete existing mappings
    await c.env.DB.prepare(`
      DELETE FROM scene_character_map WHERE scene_id = ?
    `).bind(sceneId).run();

    // Insert new mappings (voice_character gets is_primary=1)
    for (const key of character_keys) {
      const isPrimary = (key === voice_character) ? 1 : 0;
      await c.env.DB.prepare(`
        INSERT INTO scene_character_map (scene_id, character_key, is_primary)
        VALUES (?, ?, ?)
      `).bind(sceneId, key, isPrimary).run();
    }

    // Return updated list with character details
    const mappings = await c.env.DB.prepare(`
      SELECT 
        scm.*,
        pcm.character_name,
        pcm.voice_preset_id
      FROM scene_character_map scm
      LEFT JOIN scenes s ON scm.scene_id = s.id
      LEFT JOIN project_character_models pcm 
        ON s.project_id = pcm.project_id AND scm.character_key = pcm.character_key
      WHERE scm.scene_id = ?
      ORDER BY scm.is_primary DESC
    `).bind(sceneId).all();

    return c.json({
      scene_characters: mappings.results || [],
      voice_character: voice_character // Return the determined voice_character
    });
  } catch (error) {
    console.error('[Scene Characters] Batch error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to batch update scene characters'),
      500
    );
  }
});

// auto-assign moved to character-models.ts

/**
 * GET /api/scenes/:sceneId/character-traits
 * Get character trait overrides for a scene
 */
app.get('/:sceneId/character-traits', async (c) => {
  try {
    const sceneId = Number(c.req.param('sceneId'));
    
    const traits = await c.env.DB.prepare(`
      SELECT 
        sct.id, sct.scene_id, sct.character_key, sct.override_type,
        sct.trait_description, sct.source, sct.confidence,
        sct.created_at, sct.updated_at,
        pcm.character_name, pcm.story_traits
      FROM scene_character_traits sct
      LEFT JOIN scenes s ON sct.scene_id = s.id
      LEFT JOIN project_character_models pcm 
        ON s.project_id = pcm.project_id AND sct.character_key = pcm.character_key
      WHERE sct.scene_id = ?
      ORDER BY sct.created_at ASC
    `).bind(sceneId).all();

    return c.json({
      scene_traits: traits.results || []
    });
  } catch (error) {
    console.error('[Scene Character Traits] List error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to list scene character traits'),
      500
    );
  }
});

/**
 * POST /api/scenes/:sceneId/character-traits
 * Add a character trait override for a scene
 * 
 * Example: Scene 10: Bell transforms from fairy to human
 * {
 *   "character_key": "bell",
 *   "override_type": "transform",
 *   "trait_description": "人間の姿に変身した。妖精の羽は消え、普通の人間の少女の姿になっている。"
 * }
 */
app.post('/:sceneId/character-traits', async (c) => {
  try {
    const sceneId = Number(c.req.param('sceneId'));
    const body = await c.req.json();

    const { 
      character_key, 
      override_type = 'transform', 
      trait_description,
      source = 'manual'
    } = body;

    if (!character_key || !trait_description) {
      return c.json(
        createErrorResponse(
          ERROR_CODES.INVALID_REQUEST, 
          'character_key and trait_description are required'
        ),
        400
      );
    }

    // Check if override already exists for this scene and character
    const existing = await c.env.DB.prepare(`
      SELECT id FROM scene_character_traits
      WHERE scene_id = ? AND character_key = ?
    `).bind(sceneId, character_key).first();

    if (existing) {
      // Update existing
      await c.env.DB.prepare(`
        UPDATE scene_character_traits
        SET override_type = ?, trait_description = ?, source = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(override_type, trait_description, source, existing.id).run();

      const updated = await c.env.DB.prepare(`
        SELECT * FROM scene_character_traits WHERE id = ?
      `).bind(existing.id).first();

      return c.json({ scene_trait: updated });
    }

    // Insert new
    const result = await c.env.DB.prepare(`
      INSERT INTO scene_character_traits (scene_id, character_key, override_type, trait_description, source)
      VALUES (?, ?, ?, ?, ?)
    `).bind(sceneId, character_key, override_type, trait_description, source).run();

    const newTrait = await c.env.DB.prepare(`
      SELECT * FROM scene_character_traits WHERE id = ?
    `).bind(result.meta.last_row_id).first();

    return c.json({ scene_trait: newTrait }, 201);
  } catch (error) {
    console.error('[Scene Character Traits] Add error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to add scene character trait'),
      500
    );
  }
});

/**
 * DELETE /api/scenes/:sceneId/character-traits/:characterKey
 * Remove a character trait override from a scene
 */
app.delete('/:sceneId/character-traits/:characterKey', async (c) => {
  try {
    const sceneId = Number(c.req.param('sceneId'));
    const characterKey = c.req.param('characterKey');

    await c.env.DB.prepare(`
      DELETE FROM scene_character_traits
      WHERE scene_id = ? AND character_key = ?
    `).bind(sceneId, characterKey).run();

    return c.json({ success: true });
  } catch (error) {
    console.error('[Scene Character Traits] Delete error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to remove scene character trait'),
      500
    );
  }
});

/**
 * GET /api/scenes/:sceneId/edit-context
 * Get complete edit context for scene modal (SSOT for unified editing)
 * 
 * Returns:
 * - scene: Basic scene data
 * - project_characters: All characters in the project with their traits
 * - assigned_image_character_keys: Characters assigned to this scene
 * - scene_traits: Scene-specific trait overrides (C layer)
 */
app.get('/:sceneId/edit-context', async (c) => {
  try {
    const sceneId = Number(c.req.param('sceneId'));
    
    // 1. Get scene basic info
    const scene = await c.env.DB.prepare(`
      SELECT id, project_id, idx, dialogue, image_prompt, is_prompt_customized, 
             display_asset_type, comic_data, created_at, updated_at
      FROM scenes
      WHERE id = ?
    `).bind(sceneId).first();
    
    if (!scene) {
      return c.json(
        createErrorResponse(ERROR_CODES.NOT_FOUND, 'Scene not found'),
        404
      );
    }
    
    const projectId = scene.project_id;
    
    // 2. Get all project characters with traits (A + B layers)
    const charactersResult = await c.env.DB.prepare(`
      SELECT 
        character_key,
        character_name,
        reference_image_r2_url,
        voice_preset_id,
        appearance_description,
        story_traits,
        aliases_json
      FROM project_character_models
      WHERE project_id = ?
      ORDER BY created_at ASC
    `).bind(projectId).all();
    
    // 3. Get assigned characters for this scene
    const mappingsResult = await c.env.DB.prepare(`
      SELECT character_key, is_primary
      FROM scene_character_map
      WHERE scene_id = ?
      ORDER BY is_primary DESC, created_at ASC
    `).bind(sceneId).all();
    
    const assignedCharacterKeys = (mappingsResult.results || []).map((m: any) => m.character_key);
    const voiceCharacter = (mappingsResult.results || []).find((m: any) => m.is_primary === 1);
    
    // 4. Get scene-specific trait overrides (C layer)
    const traitsResult = await c.env.DB.prepare(`
      SELECT id, character_key, override_type, trait_description, source, confidence
      FROM scene_character_traits
      WHERE scene_id = ?
    `).bind(sceneId).all();
    
    return c.json({
      scene: {
        id: scene.id,
        project_id: scene.project_id,
        idx: scene.idx,
        dialogue: scene.dialogue || '',
        image_prompt: scene.image_prompt || '',
        is_prompt_customized: scene.is_prompt_customized || 0,
        display_asset_type: scene.display_asset_type || 'image',
        comic_data: scene.comic_data ? JSON.parse(String(scene.comic_data)) : null
      },
      project_characters: (charactersResult.results || []).map((char: any) => ({
        character_key: char.character_key,
        character_name: char.character_name,
        reference_image_r2_url: char.reference_image_r2_url,
        voice_preset_id: char.voice_preset_id,
        appearance_description: char.appearance_description || '',
        story_traits: char.story_traits || '',
        aliases: char.aliases_json ? JSON.parse(char.aliases_json) : []
      })),
      assigned_image_character_keys: assignedCharacterKeys,
      voice_character_key: voiceCharacter?.character_key || null,
      scene_traits: (traitsResult.results || []).map((t: any) => ({
        id: t.id,
        character_key: t.character_key,
        override_type: t.override_type,
        trait_description: t.trait_description,
        source: t.source,
        confidence: t.confidence
      }))
    });
  } catch (error) {
    console.error('[Scene Edit Context] Get error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to get scene edit context'),
      500
    );
  }
});

/**
 * POST /api/scenes/:sceneId/save-edit-context
 * Save complete edit context in a single transaction (SSOT)
 * 
 * Payload:
 * - image_character_keys: string[] - Characters assigned to scene
 * - voice_character_key: string | null - Character for voice (must be in image_character_keys)
 * - scene_traits: { character_key: string, override_traits: string }[] - Scene-specific overrides
 * 
 * Important: This replaces ALL scene characters and traits atomically
 * Empty override_traits will DELETE the trait entry (no garbage)
 */
app.post('/:sceneId/save-edit-context', async (c) => {
  try {
    const sceneId = Number(c.req.param('sceneId'));
    const body = await c.req.json();
    
    const { 
      image_character_keys = [], 
      voice_character_key,
      scene_traits = []
    } = body;
    
    // Validate scene exists
    const scene = await c.env.DB.prepare(`
      SELECT id, project_id FROM scenes WHERE id = ?
    `).bind(sceneId).first();
    
    if (!scene) {
      return c.json(
        createErrorResponse(ERROR_CODES.NOT_FOUND, 'Scene not found'),
        404
      );
    }
    
    // SSOT Validation: voice_character must be in image_characters
    let finalVoiceCharacter = voice_character_key;
    if (image_character_keys.length > 0) {
      if (!finalVoiceCharacter || !image_character_keys.includes(finalVoiceCharacter)) {
        finalVoiceCharacter = image_character_keys[0]; // Auto-select first
        console.log(`[Save Edit Context] Auto-selected voice_character: ${finalVoiceCharacter}`);
      }
    } else {
      finalVoiceCharacter = null;
    }
    
    // === STEP 1: Delete and re-insert scene_character_map (atomic replace) ===
    await c.env.DB.prepare(`
      DELETE FROM scene_character_map WHERE scene_id = ?
    `).bind(sceneId).run();
    
    for (const charKey of image_character_keys) {
      const isPrimary = charKey === finalVoiceCharacter ? 1 : 0;
      await c.env.DB.prepare(`
        INSERT INTO scene_character_map (scene_id, character_key, is_primary, created_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      `).bind(sceneId, charKey, isPrimary).run();
    }
    
    // === STEP 2: Delete and re-insert scene_character_traits (atomic replace) ===
    await c.env.DB.prepare(`
      DELETE FROM scene_character_traits WHERE scene_id = ?
    `).bind(sceneId).run();
    
    // Only insert non-empty traits
    for (const trait of scene_traits) {
      const sanitizedTraits = sanitizeTraits(trait.override_traits || '');
      if (sanitizedTraits) {
        await c.env.DB.prepare(`
          INSERT INTO scene_character_traits (scene_id, character_key, override_type, trait_description, source, created_at, updated_at)
          VALUES (?, ?, 'transform', ?, 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).bind(sceneId, trait.character_key, sanitizedTraits).run();
      }
    }
    
    // Return updated context (same format as GET)
    // Re-fetch to ensure consistency
    const updatedMappings = await c.env.DB.prepare(`
      SELECT character_key, is_primary
      FROM scene_character_map
      WHERE scene_id = ?
      ORDER BY is_primary DESC, created_at ASC
    `).bind(sceneId).all();
    
    const updatedTraits = await c.env.DB.prepare(`
      SELECT id, character_key, override_type, trait_description, source
      FROM scene_character_traits
      WHERE scene_id = ?
    `).bind(sceneId).all();
    
    return c.json({
      success: true,
      assigned_image_character_keys: (updatedMappings.results || []).map((m: any) => m.character_key),
      voice_character_key: finalVoiceCharacter,
      scene_traits: (updatedTraits.results || []).map((t: any) => ({
        id: t.id,
        character_key: t.character_key,
        override_type: t.override_type,
        trait_description: t.trait_description,
        source: t.source
      }))
    });
  } catch (error) {
    console.error('[Save Edit Context] Error:', error);
    return c.json(
      createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Failed to save edit context'),
      500
    );
  }
});

/**
 * Sanitize trait description to prevent text appearing in images
 * - Remove dialogue (「」)
 * - Remove emotional/action words
 * - Limit length
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
