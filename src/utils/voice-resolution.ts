// src/utils/voice-resolution.ts
// ================================================================
// Unified Voice Resolution - Audio SSOT Single Source of Truth
// ================================================================
// This module is the ONLY place voice resolution logic should exist.
// DO NOT duplicate this logic in audio-generation.ts, bulk-audio.ts,
// or utterances.ts. Always import from here.
//
// SSOT Priority Order (MUST NOT be changed without spec review):
//   1. utterance override (explicit voice_id from request body)
//   2. dialogue + character_key → project_character_models.voice_preset_id
//   3. projects.settings_json.default_narration_voice
//   4. fallback → google / ja-JP-Neural2-B
//
// Referenced by:
//   - docs/AUDIO_SSOT_SPEC.md §3 Voice Resolution Flow
//   - PROGRESS.md Audio SSOT section
// ================================================================

// ================================================================
// Types
// ================================================================

export interface VoiceResolution {
  provider: string;
  voiceId: string;
  source: 'override' | 'character' | 'project_default' | 'fallback';
}

/** The minimal utterance shape needed for voice resolution */
export interface VoiceResolutionUtterance {
  role: 'narration' | 'dialogue' | string;
  character_key: string | null;
  project_id: number;
}

/** Shape of projects.settings_json (parsed) */
export interface ProjectSettings {
  default_narration_voice?: {
    provider?: string;
    voice_id: string;
  };
  [key: string]: unknown;
}

// ================================================================
// Constants
// ================================================================

export const FALLBACK_VOICE_ID = 'ja-JP-Neural2-B';
export const FALLBACK_PROVIDER = 'google';

// ================================================================
// Provider Detection
// ================================================================

/**
 * Detect TTS provider from a voice_id string.
 * Centralised: all voice-id → provider mapping goes through here.
 *
 * Rules:
 *   - 'elevenlabs:*' or 'el-*' → 'elevenlabs'
 *   - 'fish:*' or 'fish-*'    → 'fish'
 *   - everything else          → 'google'
 */
export function detectProvider(voiceId: string): string {
  if (voiceId.startsWith('elevenlabs:') || voiceId.startsWith('el-')) {
    return 'elevenlabs';
  }
  if (voiceId.startsWith('fish:') || voiceId.startsWith('fish-')) {
    return 'fish';
  }
  return 'google';
}

// ================================================================
// Core: resolveVoiceForUtterance
// ================================================================

/**
 * Resolve which voice to use for a given utterance.
 *
 * @param db        - D1Database handle
 * @param utterance - must include role, character_key, project_id
 * @param projectSettings - parsed projects.settings_json (nullable)
 * @returns VoiceResolution with provider, voiceId, source
 *
 * Priority:
 *   1. dialogue + character_key → project_character_models.voice_preset_id
 *   2. default_narration_voice from project settings
 *   3. fallback (ja-JP-Neural2-B / google)
 *
 * Note: explicit user override (body.voice_id) is handled by the caller
 * BEFORE calling this function — see `resolveVoiceWithOverride`.
 */
export async function resolveVoiceForUtterance(
  db: D1Database,
  utterance: VoiceResolutionUtterance,
  projectSettings: ProjectSettings | null
): Promise<VoiceResolution> {
  // Priority 1: Character voice for dialogue
  // NOTE: dialogue + character_key=null → skipped (speaker unknown).
  // This utterance will fall through to Priority 2/3 (narration voice).
  // The UI should flag these as "話者未確定" so the user can fix them.
  if (utterance.role === 'dialogue' && !utterance.character_key) {
    // ================================================================
    // DEFENSIVE LOG: dialogue utterance with no character_key
    // This should be rare after Phase 1 parser failsafe, but can still
    // happen if utterances are created manually via POST /utterances
    // without setting character_key, or via legacy code paths.
    // We intentionally fall through to Priority 2/3 (narration voice).
    // ================================================================
    console.warn(
      `[VoiceResolution] dialogue utterance has character_key=null ` +
      `(project=${utterance.project_id}). Falling back to narration voice. ` +
      `Fix: set character_key via PUT /utterances/:id`
    );
  }
  if (utterance.role === 'dialogue' && utterance.character_key) {
    const character = await db.prepare(`
      SELECT voice_preset_id FROM project_character_models
      WHERE project_id = ? AND character_key = ?
    `).bind(utterance.project_id, utterance.character_key)
      .first<{ voice_preset_id: string | null }>();

    if (character?.voice_preset_id) {
      return {
        provider: detectProvider(character.voice_preset_id),
        voiceId: character.voice_preset_id,
        source: 'character',
      };
    }
  }

  // Priority 2: Project default narration voice
  if (projectSettings?.default_narration_voice?.voice_id) {
    const dnv = projectSettings.default_narration_voice;
    const voiceId = dnv.voice_id;
    const provider = dnv.provider || detectProvider(voiceId);
    return { provider, voiceId, source: 'project_default' };
  }

  // Priority 3: Ultimate fallback
  return {
    provider: FALLBACK_PROVIDER,
    voiceId: FALLBACK_VOICE_ID,
    source: 'fallback',
  };
}

// ================================================================
// Convenience: resolveVoiceWithOverride
// ================================================================

/**
 * Resolve voice with optional explicit override from request body.
 * Use this when a caller may pass explicit voice_id / provider.
 *
 * If override.voiceId is provided, it takes top priority.
 * Otherwise delegates to `resolveVoiceForUtterance`.
 */
export async function resolveVoiceWithOverride(
  db: D1Database,
  utterance: VoiceResolutionUtterance,
  projectSettings: ProjectSettings | null,
  override?: { voiceId?: string; provider?: string }
): Promise<VoiceResolution> {
  if (override?.voiceId) {
    const provider = override.provider || detectProvider(override.voiceId);
    return { provider, voiceId: override.voiceId, source: 'override' };
  }
  return resolveVoiceForUtterance(db, utterance, projectSettings);
}

// ================================================================
// Helper: Parse project settings_json from DB
// ================================================================

/**
 * Safely parse settings_json from a projects row.
 * Returns null on any parse failure (never throws).
 */
export function parseProjectSettings(settingsJson: string | null | undefined): ProjectSettings | null {
  if (!settingsJson) return null;
  try {
    return JSON.parse(settingsJson) as ProjectSettings;
  } catch {
    return null;
  }
}

// ================================================================
// Helper: Load project settings from DB
// ================================================================

/**
 * Load and parse project settings from the database.
 * Combines DB fetch + safe JSON parse in one call.
 */
export async function loadProjectSettings(
  db: D1Database,
  projectId: number
): Promise<ProjectSettings | null> {
  const project = await db.prepare(`
    SELECT settings_json FROM projects WHERE id = ?
  `).bind(projectId).first<{ settings_json: string | null }>();
  return parseProjectSettings(project?.settings_json);
}

// ================================================================
// Helper: Get sample rate for provider
// ================================================================

/**
 * Returns the default sample rate for a TTS provider.
 *   - fish: 44100
 *   - all others: 24000
 */
export function getSampleRate(provider: string): number {
  return provider === 'fish' ? 44100 : 24000;
}
