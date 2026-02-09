// src/routes/utterances.ts
// R1.5: Scene Utterances API (Multi-speaker audio SSOT)
import { Hono } from 'hono';
import type { Bindings } from '../types/bindings';
import { createErrorResponse } from '../utils/error-response';
import { getMp3Duration, estimateMp3Duration } from '../utils/mp3-duration';
import { generateFishTTS } from '../utils/fish-audio';
import { generateElevenLabsTTS, resolveElevenLabsVoiceId } from '../utils/elevenlabs';

const utterances = new Hono<{ Bindings: Bindings }>();

// =============================================================================
// Types
// =============================================================================

interface Utterance {
  id: number;
  scene_id: number;
  order_no: number;
  role: 'narration' | 'dialogue';
  character_key: string | null;
  text: string;
  audio_generation_id: number | null;
  duration_ms: number | null;
  audio_url?: string | null;
  character_name?: string | null;
  created_at: string;
  updated_at: string;
}

interface AssignedCharacter {
  character_key: string;
  name: string;
  voice_preset_id?: string | null;
}

// =============================================================================
// Helper: Lazy Migration
// Creates a default utterance from scene.dialogue if no utterances exist
// =============================================================================

async function lazyMigrateSceneUtterances(
  db: D1Database,
  sceneId: number,
  dialogue: string | null,
  activeAudioId: number | null
): Promise<void> {
  // Check if utterances exist
  const existing = await db.prepare(`
    SELECT COUNT(*) as count FROM scene_utterances WHERE scene_id = ?
  `).bind(sceneId).first<{ count: number }>();

  if (existing && existing.count > 0) {
    return; // Already has utterances
  }

  // No utterances exist - create default narration utterance
  const text = dialogue || '';
  
  // Get duration from active audio if exists
  let durationMs: number | null = null;
  if (activeAudioId) {
    const audio = await db.prepare(`
      SELECT duration_ms FROM audio_generations WHERE id = ?
    `).bind(activeAudioId).first<{ duration_ms: number | null }>();
    if (audio) {
      durationMs = audio.duration_ms;
    }
  }

  await db.prepare(`
    INSERT INTO scene_utterances (
      scene_id, order_no, role, character_key, text, audio_generation_id, duration_ms
    ) VALUES (?, 1, 'narration', NULL, ?, ?, ?)
  `).bind(sceneId, text, activeAudioId, durationMs).run();

  console.log(`[Utterances] Lazy migrated scene ${sceneId} - created default narration utterance`);
}

// =============================================================================
// GET /api/scenes/:sceneId/utterances
// Returns utterances with assigned characters for the scene
// =============================================================================

utterances.get('/scenes/:sceneId/utterances', async (c) => {
  try {
    const sceneId = Number(c.req.param('sceneId'));
    if (!Number.isFinite(sceneId)) {
      return c.json(createErrorResponse('INVALID_REQUEST', 'Invalid scene id'), 400);
    }

    // Get scene with project_id and dialogue
    const scene = await c.env.DB.prepare(`
      SELECT s.id, s.project_id, s.dialogue
      FROM scenes s
      WHERE s.id = ?
    `).bind(sceneId).first<{ id: number; project_id: number; dialogue: string }>();

    if (!scene) {
      return c.json(createErrorResponse('NOT_FOUND', 'Scene not found'), 404);
    }

    // Get active audio for lazy migration
    const activeAudio = await c.env.DB.prepare(`
      SELECT id FROM audio_generations
      WHERE scene_id = ? AND is_active = 1
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(sceneId).first<{ id: number }>();

    // Lazy migrate if needed
    await lazyMigrateSceneUtterances(
      c.env.DB,
      sceneId,
      scene.dialogue,
      activeAudio?.id || null
    );

    // Get utterances with audio info
    const { results: utteranceRows } = await c.env.DB.prepare(`
      SELECT 
        u.id,
        u.scene_id,
        u.order_no,
        u.role,
        u.character_key,
        u.text,
        u.audio_generation_id,
        u.duration_ms,
        u.created_at,
        u.updated_at,
        ag.r2_url as audio_url,
        pcm.character_name
      FROM scene_utterances u
      LEFT JOIN audio_generations ag ON u.audio_generation_id = ag.id
      LEFT JOIN project_character_models pcm 
        ON u.character_key = pcm.character_key AND pcm.project_id = ?
      WHERE u.scene_id = ?
      ORDER BY u.order_no ASC
    `).bind(scene.project_id, sceneId).all<any>();

    // Get assigned characters for this scene
    // FIX: Fallback to project_character_models if scene_character_map is empty
    let { results: characterRows } = await c.env.DB.prepare(`
      SELECT 
        scm.character_key,
        pcm.character_name as name,
        pcm.voice_preset_id
      FROM scene_character_map scm
      LEFT JOIN project_character_models pcm 
        ON scm.character_key = pcm.character_key AND pcm.project_id = ?
      WHERE scm.scene_id = ?
    `).bind(scene.project_id, sceneId).all<any>();

    // FIX: If no scene-level character assignments, fall back to all project characters
    // This ensures users can always select キャラセリフ if the project has any characters
    if (!characterRows || characterRows.length === 0) {
      const { results: projectCharRows } = await c.env.DB.prepare(`
        SELECT 
          character_key,
          character_name as name,
          voice_preset_id
        FROM project_character_models
        WHERE project_id = ?
        ORDER BY character_name ASC
      `).bind(scene.project_id).all<any>();
      characterRows = projectCharRows || [];
    }

    const utterancesList: Utterance[] = utteranceRows.map(row => ({
      id: row.id,
      scene_id: row.scene_id,
      order_no: row.order_no,
      role: row.role,
      character_key: row.character_key,
      text: row.text,
      audio_generation_id: row.audio_generation_id,
      duration_ms: row.duration_ms,
      audio_url: row.audio_url,
      character_name: row.character_name,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));

    const assignedCharacters: AssignedCharacter[] = characterRows.map(row => ({
      character_key: row.character_key,
      name: row.name || row.character_key,
      voice_preset_id: row.voice_preset_id
    }));

    return c.json({
      scene_id: sceneId,
      project_id: scene.project_id,
      assigned_characters: assignedCharacters,
      utterances: utterancesList
    });

  } catch (error) {
    console.error('[GET /api/scenes/:sceneId/utterances] Error:', error);
    return c.json(createErrorResponse('INTERNAL_ERROR', 'Failed to fetch utterances'), 500);
  }
});

// =============================================================================
// POST /api/scenes/:sceneId/utterances
// Create a new utterance
// =============================================================================

utterances.post('/scenes/:sceneId/utterances', async (c) => {
  try {
    const sceneId = Number(c.req.param('sceneId'));
    if (!Number.isFinite(sceneId)) {
      return c.json(createErrorResponse('INVALID_REQUEST', 'Invalid scene id'), 400);
    }

    const body = await c.req.json().catch(() => ({} as any));
    const { role, character_key, text } = body;

    // Validate role
    if (!role || !['narration', 'dialogue'].includes(role)) {
      return c.json(createErrorResponse('INVALID_REQUEST', 'role must be "narration" or "dialogue"'), 400);
    }

    // Validate text
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return c.json(createErrorResponse('INVALID_REQUEST', 'text is required and cannot be empty'), 400);
    }

    // Get scene with project_id
    const scene = await c.env.DB.prepare(`
      SELECT id, project_id FROM scenes WHERE id = ?
    `).bind(sceneId).first<{ id: number; project_id: number }>();

    if (!scene) {
      return c.json(createErrorResponse('NOT_FOUND', 'Scene not found'), 404);
    }

    // Validate character_key based on role
    if (role === 'narration') {
      // narration must have null character_key
      if (character_key !== null && character_key !== undefined) {
        return c.json(createErrorResponse('INVALID_REQUEST', 'character_key must be null for narration'), 400);
      }
    } else if (role === 'dialogue') {
      // dialogue must have character_key that exists in scene_character_map OR project_character_models
      if (!character_key) {
        return c.json(createErrorResponse('INVALID_REQUEST', 'character_key is required for dialogue'), 400);
      }

      // FIX: Check both scene_character_map AND project_character_models
      const charExists = await c.env.DB.prepare(`
        SELECT 1 FROM scene_character_map WHERE scene_id = ? AND character_key = ?
      `).bind(sceneId, character_key).first();

      if (!charExists) {
        // Fallback: check project_character_models
        const projectCharExists = await c.env.DB.prepare(`
          SELECT 1 FROM project_character_models WHERE project_id = ? AND character_key = ?
        `).bind(scene.project_id, character_key).first();

        if (!projectCharExists) {
          return c.json(createErrorResponse('INVALID_REQUEST', `character_key "${character_key}" not found in project characters`), 400);
        }

        // Auto-assign character to scene (so future queries work)
        await c.env.DB.prepare(`
          INSERT OR IGNORE INTO scene_character_map (scene_id, character_key) VALUES (?, ?)
        `).bind(sceneId, character_key).run();
        console.log(`[Utterance] Auto-assigned character "${character_key}" to scene ${sceneId}`);
      }
    }

    // Get next order_no
    const maxOrder = await c.env.DB.prepare(`
      SELECT MAX(order_no) as max_order FROM scene_utterances WHERE scene_id = ?
    `).bind(sceneId).first<{ max_order: number | null }>();

    const nextOrderNo = (maxOrder?.max_order || 0) + 1;

    // Insert utterance
    const result = await c.env.DB.prepare(`
      INSERT INTO scene_utterances (
        scene_id, order_no, role, character_key, text
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(
      sceneId,
      nextOrderNo,
      role,
      role === 'narration' ? null : character_key,
      text.trim()
    ).run();

    // Get the inserted utterance
    const inserted = await c.env.DB.prepare(`
      SELECT 
        u.id,
        u.scene_id,
        u.order_no,
        u.role,
        u.character_key,
        u.text,
        u.audio_generation_id,
        u.duration_ms,
        u.created_at,
        u.updated_at,
        pcm.character_name
      FROM scene_utterances u
      LEFT JOIN project_character_models pcm 
        ON u.character_key = pcm.character_key AND pcm.project_id = ?
      WHERE u.id = ?
    `).bind(scene.project_id, result.meta.last_row_id).first<any>();

    return c.json({
      success: true,
      utterance: {
        id: inserted.id,
        scene_id: inserted.scene_id,
        order_no: inserted.order_no,
        role: inserted.role,
        character_key: inserted.character_key,
        text: inserted.text,
        audio_generation_id: inserted.audio_generation_id,
        duration_ms: inserted.duration_ms,
        audio_url: null,
        character_name: inserted.character_name,
        created_at: inserted.created_at,
        updated_at: inserted.updated_at
      }
    }, 201);

  } catch (error) {
    console.error('[POST /api/scenes/:sceneId/utterances] Error:', error);
    return c.json(createErrorResponse('INTERNAL_ERROR', 'Failed to create utterance'), 500);
  }
});

// =============================================================================
// PUT /api/utterances/:utteranceId
// Update an existing utterance
// =============================================================================

utterances.put('/utterances/:utteranceId', async (c) => {
  try {
    const utteranceId = Number(c.req.param('utteranceId'));
    if (!Number.isFinite(utteranceId)) {
      return c.json(createErrorResponse('INVALID_REQUEST', 'Invalid utterance id'), 400);
    }

    const body = await c.req.json().catch(() => ({} as any));
    const { role, character_key, text } = body;

    // Get existing utterance with scene and project info
    const existing = await c.env.DB.prepare(`
      SELECT u.*, s.project_id
      FROM scene_utterances u
      JOIN scenes s ON u.scene_id = s.id
      WHERE u.id = ?
    `).bind(utteranceId).first<any>();

    if (!existing) {
      return c.json(createErrorResponse('NOT_FOUND', 'Utterance not found'), 404);
    }

    // Build update query
    const updates: string[] = [];
    const values: any[] = [];

    // Update role if provided
    if (role !== undefined) {
      if (!['narration', 'dialogue'].includes(role)) {
        return c.json(createErrorResponse('INVALID_REQUEST', 'role must be "narration" or "dialogue"'), 400);
      }
      updates.push('role = ?');
      values.push(role);
    }

    const finalRole = role !== undefined ? role : existing.role;

    // Handle character_key based on role
    if (finalRole === 'narration') {
      // Force character_key to null for narration
      if (character_key !== undefined || (role === 'narration' && existing.character_key !== null)) {
        updates.push('character_key = ?');
        values.push(null);
      }
    } else if (finalRole === 'dialogue') {
      if (character_key !== undefined) {
        // FIX: Validate character exists in scene_character_map OR project_character_models
        const charExists = await c.env.DB.prepare(`
          SELECT 1 FROM scene_character_map WHERE scene_id = ? AND character_key = ?
        `).bind(existing.scene_id, character_key).first();

        if (!charExists) {
          // Fallback: check project_character_models
          const projectCharExists = await c.env.DB.prepare(`
            SELECT 1 FROM project_character_models WHERE project_id = ? AND character_key = ?
          `).bind(existing.project_id, character_key).first();

          if (!projectCharExists) {
            return c.json(createErrorResponse('INVALID_REQUEST', `character_key "${character_key}" not found in project characters`), 400);
          }

          // Auto-assign character to scene
          await c.env.DB.prepare(`
            INSERT OR IGNORE INTO scene_character_map (scene_id, character_key) VALUES (?, ?)
          `).bind(existing.scene_id, character_key).run();
          console.log(`[Utterance] Auto-assigned character "${character_key}" to scene ${existing.scene_id} via PUT`);
        }
        updates.push('character_key = ?');
        values.push(character_key);
      } else if (role === 'dialogue' && !existing.character_key) {
        // Changing to dialogue but no character_key provided
        return c.json(createErrorResponse('INVALID_REQUEST', 'character_key is required when changing to dialogue'), 400);
      }
    }

    // Update text if provided
    if (text !== undefined) {
      if (typeof text !== 'string' || text.trim().length === 0) {
        return c.json(createErrorResponse('INVALID_REQUEST', 'text cannot be empty'), 400);
      }
      updates.push('text = ?');
      values.push(text.trim());
    }

    if (updates.length === 0) {
      return c.json(createErrorResponse('NO_UPDATES', 'No fields to update'), 400);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(utteranceId);

    // Execute update
    await c.env.DB.prepare(`
      UPDATE scene_utterances
      SET ${updates.join(', ')}
      WHERE id = ?
    `).bind(...values).run();

    // Get updated utterance
    const updated = await c.env.DB.prepare(`
      SELECT 
        u.id,
        u.scene_id,
        u.order_no,
        u.role,
        u.character_key,
        u.text,
        u.audio_generation_id,
        u.duration_ms,
        u.created_at,
        u.updated_at,
        ag.r2_url as audio_url,
        pcm.character_name
      FROM scene_utterances u
      LEFT JOIN audio_generations ag ON u.audio_generation_id = ag.id
      LEFT JOIN project_character_models pcm 
        ON u.character_key = pcm.character_key AND pcm.project_id = ?
      WHERE u.id = ?
    `).bind(existing.project_id, utteranceId).first<any>();

    return c.json({
      success: true,
      utterance: {
        id: updated.id,
        scene_id: updated.scene_id,
        order_no: updated.order_no,
        role: updated.role,
        character_key: updated.character_key,
        text: updated.text,
        audio_generation_id: updated.audio_generation_id,
        duration_ms: updated.duration_ms,
        audio_url: updated.audio_url,
        character_name: updated.character_name,
        created_at: updated.created_at,
        updated_at: updated.updated_at
      }
    });

  } catch (error) {
    console.error('[PUT /api/utterances/:utteranceId] Error:', error);
    return c.json(createErrorResponse('INTERNAL_ERROR', 'Failed to update utterance'), 500);
  }
});

// =============================================================================
// DELETE /api/utterances/:utteranceId
// Delete an utterance and re-number remaining utterances
// =============================================================================

utterances.delete('/utterances/:utteranceId', async (c) => {
  try {
    const utteranceId = Number(c.req.param('utteranceId'));
    if (!Number.isFinite(utteranceId)) {
      return c.json(createErrorResponse('INVALID_REQUEST', 'Invalid utterance id'), 400);
    }

    // Get existing utterance
    const existing = await c.env.DB.prepare(`
      SELECT id, scene_id FROM scene_utterances WHERE id = ?
    `).bind(utteranceId).first<{ id: number; scene_id: number }>();

    if (!existing) {
      return c.json(createErrorResponse('NOT_FOUND', 'Utterance not found'), 404);
    }

    const sceneId = existing.scene_id;

    // Delete utterance
    await c.env.DB.prepare(`
      DELETE FROM scene_utterances WHERE id = ?
    `).bind(utteranceId).run();

    // Re-number remaining utterances
    const { results: remaining } = await c.env.DB.prepare(`
      SELECT id FROM scene_utterances WHERE scene_id = ? ORDER BY order_no ASC
    `).bind(sceneId).all<{ id: number }>();

    for (let i = 0; i < remaining.length; i++) {
      await c.env.DB.prepare(`
        UPDATE scene_utterances SET order_no = ? WHERE id = ?
      `).bind(i + 1, remaining[i].id).run();
    }

    return c.json({
      success: true,
      message: 'Utterance deleted successfully',
      deleted_utterance_id: utteranceId,
      remaining_count: remaining.length
    });

  } catch (error) {
    console.error('[DELETE /api/utterances/:utteranceId] Error:', error);
    return c.json(createErrorResponse('INTERNAL_ERROR', 'Failed to delete utterance'), 500);
  }
});

// =============================================================================
// PUT /api/scenes/:sceneId/utterances/reorder
// Reorder utterances within a scene
// =============================================================================

utterances.put('/scenes/:sceneId/utterances/reorder', async (c) => {
  try {
    const sceneId = Number(c.req.param('sceneId'));
    if (!Number.isFinite(sceneId)) {
      return c.json(createErrorResponse('INVALID_REQUEST', 'Invalid scene id'), 400);
    }

    const body = await c.req.json().catch(() => ({} as any));
    const { order } = body;

    // Validate order array
    if (!Array.isArray(order) || order.length === 0) {
      return c.json(createErrorResponse('INVALID_REQUEST', 'order must be a non-empty array of utterance ids'), 400);
    }

    // Verify scene exists
    const scene = await c.env.DB.prepare(`
      SELECT id FROM scenes WHERE id = ?
    `).bind(sceneId).first();

    if (!scene) {
      return c.json(createErrorResponse('NOT_FOUND', 'Scene not found'), 404);
    }

    // Get all utterances for this scene
    const { results: existingUtterances } = await c.env.DB.prepare(`
      SELECT id FROM scene_utterances WHERE scene_id = ?
    `).bind(sceneId).all<{ id: number }>();

    const existingIds = new Set(existingUtterances.map(u => u.id));

    // Validate all provided ids belong to this scene
    const invalidIds = order.filter((id: number) => !existingIds.has(id));
    if (invalidIds.length > 0) {
      return c.json(createErrorResponse('INVALID_REQUEST', `These utterance ids do not belong to this scene: ${invalidIds.join(', ')}`), 400);
    }

    // Update order_no for each utterance
    for (let i = 0; i < order.length; i++) {
      await c.env.DB.prepare(`
        UPDATE scene_utterances SET order_no = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(i + 1, order[i]).run();
    }

    // Get updated utterances
    const { results: updatedUtterances } = await c.env.DB.prepare(`
      SELECT id, order_no FROM scene_utterances WHERE scene_id = ? ORDER BY order_no ASC
    `).bind(sceneId).all<{ id: number; order_no: number }>();

    return c.json({
      success: true,
      message: 'Utterances reordered successfully',
      scene_id: sceneId,
      order: updatedUtterances.map(u => ({ id: u.id, order_no: u.order_no }))
    });

  } catch (error) {
    console.error('[PUT /api/scenes/:sceneId/utterances/reorder] Error:', error);
    return c.json(createErrorResponse('INTERNAL_ERROR', 'Failed to reorder utterances'), 500);
  }
});

// =============================================================================
// POST /api/utterances/:utteranceId/generate-audio
// Generate audio for a specific utterance (utterance-level conflict check)
// =============================================================================

utterances.post('/utterances/:utteranceId/generate-audio', async (c) => {
  try {
    const utteranceId = Number(c.req.param('utteranceId'));
    if (!Number.isFinite(utteranceId)) {
      return c.json(createErrorResponse('INVALID_REQUEST', 'Invalid utterance id'), 400);
    }

    const body = await c.req.json().catch(() => ({} as any));
    const forceRegenerate = body.force === true || c.req.query('force') === 'true';
    
    // Get utterance with scene and project info
    const utterance = await c.env.DB.prepare(`
      SELECT u.*, s.project_id, s.idx as scene_idx
      FROM scene_utterances u
      JOIN scenes s ON u.scene_id = s.id
      WHERE u.id = ?
    `).bind(utteranceId).first<any>();

    if (!utterance) {
      return c.json(createErrorResponse('NOT_FOUND', 'Utterance not found'), 404);
    }

    // Check if utterance has text
    const text = (utterance.text ?? '').trim();
    if (!text) {
      return c.json(createErrorResponse('NO_DIALOGUE', 'Utterance has no text'), 400);
    }

    // Check if this utterance already has a completed audio
    if (utterance.audio_generation_id && !forceRegenerate) {
      const existingAudio = await c.env.DB.prepare(`
        SELECT id, status, r2_url FROM audio_generations WHERE id = ?
      `).bind(utterance.audio_generation_id).first<any>();
      
      // If audio is completed, skip generation (reuse existing)
      if (existingAudio && existingAudio.status === 'completed' && existingAudio.r2_url) {
        console.log(`[Utterance ${utteranceId}] Audio already completed (id=${existingAudio.id}), skipping generation`);
        return c.json({
          success: true,
          utterance_id: utteranceId,
          audio_generation_id: existingAudio.id,
          status: 'completed',
          message: 'Audio already generated for this utterance',
          skipped: true
        }, 200);
      }
      
      // If audio is still generating, return 409
      if (existingAudio && existingAudio.status === 'generating') {
        console.log(`[Utterance ${utteranceId}] Audio still generating (id=${existingAudio.id})`);
        return c.json(createErrorResponse('AUDIO_GENERATING', 'Audio generation already in progress for this utterance'), 409);
      }
    } else if (forceRegenerate && utterance.audio_generation_id) {
      console.log(`[Utterance ${utteranceId}] Force regenerate requested, clearing existing audio_generation_id`);
      // Clear the existing audio_generation_id to allow fresh generation
      await c.env.DB.prepare(`
        UPDATE scene_utterances SET audio_generation_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(utteranceId).run();
    }

    // ========================================
    // SSOT: Voice Selection Logic
    // ========================================
    // Priority (MUST NOT be changed without spec review):
    // 1. dialogue + character_key → project_character_models.voice_preset_id
    // 2. narration → projects.settings_json.default_narration_voice
    // 3. fallback (only when nothing configured) → ja-JP-Neural2-B
    // ========================================
    
    let provider = 'google';
    let voiceId = 'ja-JP-Neural2-B'; // Ultimate fallback only
    let voiceSource = 'fallback';

    if (utterance.role === 'dialogue' && utterance.character_key) {
      // Priority 1: Character voice for dialogue
      const character = await c.env.DB.prepare(`
        SELECT voice_preset_id FROM project_character_models
        WHERE project_id = ? AND character_key = ?
      `).bind(utterance.project_id, utterance.character_key).first<{ voice_preset_id: string | null }>();

      if (character?.voice_preset_id) {
        voiceId = character.voice_preset_id;
        voiceSource = 'character';
        
        // Detect provider from voice_preset_id
        if (voiceId.startsWith('elevenlabs:') || voiceId.startsWith('el-')) {
          provider = 'elevenlabs';
        } else if (voiceId.startsWith('fish:') || voiceId.startsWith('fish-')) {
          provider = 'fish';
        }
      }
    }
    
    // Priority 2: Project default narration voice (for narration or when character voice not found)
    if (voiceSource === 'fallback') {
      const project = await c.env.DB.prepare(`
        SELECT settings_json FROM projects WHERE id = ?
      `).bind(utterance.project_id).first<{ settings_json: string | null }>();
      
      if (project?.settings_json) {
        try {
          const settings = JSON.parse(project.settings_json);
          if (settings.default_narration_voice?.voice_id) {
            voiceId = settings.default_narration_voice.voice_id;
            provider = settings.default_narration_voice.provider || 'google';
            voiceSource = 'project_default';
            
            // Re-detect provider if not explicitly set
            if (!settings.default_narration_voice.provider) {
              if (voiceId.startsWith('elevenlabs:') || voiceId.startsWith('el-')) {
                provider = 'elevenlabs';
              } else if (voiceId.startsWith('fish:') || voiceId.startsWith('fish-')) {
                provider = 'fish';
              }
            }
          }
        } catch (e) {
          console.warn(`[Utterance ${utteranceId}] Failed to parse settings_json:`, e);
        }
      }
    }
    
    console.log(`[Utterance ${utteranceId}] Voice resolved: source=${voiceSource}, provider=${provider}, voiceId=${voiceId}`);

    // Allow override from request body (explicit user request only)
    if (body.voice_id) voiceId = body.voice_id;
    if (body.provider) provider = body.provider;
    let format = body.format || 'mp3';
    const sampleRate = provider === 'fish' ? 44100 : 24000;

    // Create audio_generation record with 'generating' status
    const insert = await c.env.DB.prepare(`
      INSERT INTO audio_generations
        (scene_id, provider, voice_id, model, format, sample_rate, text, status, is_active)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, 'generating', 0)
    `).bind(
      utterance.scene_id,
      provider,
      voiceId,
      null,
      format,
      sampleRate,
      text
    ).run();

    const audioId = insert.meta.last_row_id as number;

    // Link utterance to this audio_generation
    await c.env.DB.prepare(`
      UPDATE scene_utterances
      SET audio_generation_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(audioId, utteranceId).run();

    console.log(`[Utterance ${utteranceId}] Created audio_generation id=${audioId} for text: "${text.substring(0, 50)}..."`);

    // Generate audio asynchronously using waitUntil
    // Import the generate function from audio-generation route
    c.executionCtx.waitUntil(
      generateUtteranceAudio({
        env: c.env,
        audioId,
        utteranceId,
        projectId: utterance.project_id,
        sceneIdx: utterance.scene_idx,
        text,
        provider,
        voiceId,
        format,
        sampleRate,
      })
    );

    return c.json({
      success: true,
      utterance_id: utteranceId,
      audio_generation_id: audioId,
      status: 'generating',
      message: 'Audio generation started for utterance'
    }, 202);

  } catch (error) {
    console.error('[POST /api/utterances/:utteranceId/generate-audio] Error:', error);
    return c.json(createErrorResponse('INTERNAL_ERROR', 'Failed to generate audio for utterance'), 500);
  }
});

// =============================================================================
// Helper: Generate audio for utterance (runs in waitUntil)
// =============================================================================

async function generateUtteranceAudio(args: {
  env: Bindings;
  audioId: number;
  utteranceId: number;
  projectId: number;
  sceneIdx: number;
  text: string;
  provider: string;
  voiceId: string;
  format: string;
  sampleRate: number;
}) {
  const { env, audioId, utteranceId, projectId, sceneIdx, text, provider, voiceId, format, sampleRate } = args;

  try {
    let bytes: Uint8Array;

    if (provider === 'google') {
      // Google TTS
      const googleTtsKey = env.GOOGLE_TTS_API_KEY || env.GEMINI_API_KEY;
      if (!googleTtsKey) {
        throw new Error('GOOGLE_TTS_API_KEY is not set');
      }

      const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': googleTtsKey,
        },
        body: JSON.stringify({
          input: { text },
          voice: {
            languageCode: 'ja-JP',
            name: voiceId,
          },
          audioConfig: {
            audioEncoding: format === 'wav' ? 'LINEAR16' : 'MP3',
            sampleRateHertz: sampleRate,
          },
        }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`TTS API error: ${res.status} ${errorText}`);
      }

      const data: any = await res.json();
      const audioContent = data?.audioContent;
      if (!audioContent) {
        throw new Error('TTS API returned empty audioContent');
      }

      // Decode base64
      const binaryString = atob(audioContent);
      bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
    } else if (provider === 'fish') {
      // Fish Audio implementation
      const fishApiToken = (env as any).FISH_AUDIO_API_TOKEN;
      if (!fishApiToken) {
        throw new Error('FISH_AUDIO_API_TOKEN is not configured');
      }
      
      // Extract reference_id from voiceId (format: fish:xxx or fish-xxx)
      const referenceId = voiceId.replace(/^fish[-:]/, '');
      console.log(`[Utterance ${utteranceId}] Using Fish Audio: reference_id=${referenceId}`);
      
      const fishResult = await generateFishTTS(fishApiToken, {
        text: text,
        reference_id: referenceId,
        format: format === 'wav' ? 'wav' : 'mp3',
        sample_rate: sampleRate,
        mp3_bitrate: 128,
      });
      
      // Convert ArrayBuffer to Uint8Array
      bytes = new Uint8Array(fishResult.audio);
      
    } else if (provider === 'elevenlabs') {
      // ElevenLabs implementation
      const elevenLabsApiKey = (env as any).ELEVENLABS_API_KEY;
      if (!elevenLabsApiKey) {
        throw new Error('ELEVENLABS_API_KEY is not configured');
      }
      
      // Extract voice_id from voiceId (format: elevenlabs:xxx or el-xxx)
      const resolvedVoiceId = await resolveElevenLabsVoiceId(elevenLabsApiKey, voiceId);
      console.log(`[Utterance ${utteranceId}] Using ElevenLabs: voice_id=${resolvedVoiceId}`);
      
      // Get model from env or use default
      const model = (env as any).ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
      
      const elevenLabsResult = await generateElevenLabsTTS(elevenLabsApiKey, {
        text: text,
        voice_id: resolvedVoiceId,
        model_id: model,
        output_format: 'mp3_44100_128',
      });
      
      if (!elevenLabsResult.success || !elevenLabsResult.audio) {
        throw new Error(elevenLabsResult.error || 'ElevenLabs TTS failed');
      }
      
      // Convert ArrayBuffer to Uint8Array
      bytes = new Uint8Array(elevenLabsResult.audio);
      
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }

    // Upload to R2
    const timestamp = Date.now();
    const ext = format === 'wav' ? 'wav' : 'mp3';
    const r2Key = `audio/${projectId}/scene_${sceneIdx}/utt_${utteranceId}_${audioId}_${timestamp}.${ext}`;

    await env.R2.put(r2Key, bytes, {
      httpMetadata: {
        contentType: format === 'wav' ? 'audio/wav' : 'audio/mpeg',
      },
    });

    // Use relative path for R2 URL (same as audio-generation.ts)
    // The frontend/Remotion will resolve this through the app's R2 serving endpoint
    const r2Url = (env as any).R2_PUBLIC_URL 
      ? `${(env as any).R2_PUBLIC_URL}/${r2Key}`
      : `/${r2Key}`;

    // Calculate duration: MP3ヘッダーを解析して正確なdurationを取得
    // ★ FIX: 以前は bitrate=16000 で粗雑計算していたため、
    //    実際の音声長と大幅にズレてセリフ切れの根本原因になっていた
    const bytesLength = bytes.length;
    let estimatedDurationMs: number;
    
    if (format === 'wav') {
      // WAV: ファイルサイズから計算（24kHz 16bit mono = 48000 bytes/sec）
      const sampleBytes = sampleRate * 2; // 16-bit = 2 bytes per sample, mono
      const calculatedDurationMs = Math.round((bytesLength / sampleBytes) * 1000);
      estimatedDurationMs = Math.max(1000, calculatedDurationMs);
      console.log(`[Utterance ${utteranceId}] WAV duration: ${bytesLength} bytes / ${sampleBytes} = ${calculatedDurationMs}ms`);
    } else {
      // MP3: ヘッダーを解析して正確なdurationを取得
      const parsedDurationMs = getMp3Duration(bytes.buffer);
      if (parsedDurationMs && parsedDurationMs > 0) {
        estimatedDurationMs = parsedDurationMs;
        console.log(`[Utterance ${utteranceId}] MP3 parsed duration: ${parsedDurationMs}ms (${(parsedDurationMs/1000).toFixed(2)}s)`);
      } else {
        // フォールバック: 64kbpsを仮定（TTSは通常32-128kbps）
        const calculatedDurationMs = estimateMp3Duration(bytesLength, 64);
        estimatedDurationMs = Math.max(1000, calculatedDurationMs);
        console.log(`[Utterance ${utteranceId}] MP3 fallback duration: ${bytesLength} bytes @ 64kbps = ${calculatedDurationMs}ms`);
      }
    }

    // Update audio_generation to completed
    await env.DB.prepare(`
      UPDATE audio_generations
      SET status = 'completed', r2_key = ?, r2_url = ?, duration_ms = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(r2Key, r2Url, estimatedDurationMs, audioId).run();

    // Update utterance with duration
    await env.DB.prepare(`
      UPDATE scene_utterances
      SET duration_ms = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(estimatedDurationMs, utteranceId).run();

    console.log(`[Utterance ${utteranceId}] Audio generation completed: ${r2Url} (${estimatedDurationMs}ms)`);

  } catch (error) {
    console.error(`[Utterance ${utteranceId}] Audio generation failed:`, error);
    
    // Mark as failed
    await env.DB.prepare(`
      UPDATE audio_generations
      SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(error instanceof Error ? error.message : String(error), audioId).run();
  }
}

export default utterances;
