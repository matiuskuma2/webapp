/**
 * Style Prompt Composer
 * 
 * Composes final image generation prompt by combining:
 * 1. Style preset's prompt_prefix (if style is selected)
 * 2. Scene's original image_prompt
 * 3. Style preset's prompt_suffix (if style is selected)
 * 
 * Priority:
 * 1. scene_style_settings.style_preset_id (scene-specific override)
 * 2. Primary character's style_preset_id (from scene_character_map + project_character_models)
 * 3. project_style_settings.default_style_preset_id (project default)
 * 4. No style (use original prompt only - backward compatibility)
 */

export interface StylePreset {
  id: number
  name: string
  prompt_prefix: string | null
  prompt_suffix: string | null
  negative_prompt: string | null
}

export interface StyleSettings {
  scene_style_preset_id: number | null
  character_style_preset_id: number | null
  project_default_preset_id: number | null
}

/**
 * Get effective style preset ID for a scene
 * Returns null if no style is configured (backward compatibility)
 */
export function getEffectiveStylePresetId(settings: StyleSettings): number | null {
  // Priority 1: Scene-specific style
  if (settings.scene_style_preset_id !== null) {
    return settings.scene_style_preset_id
  }
  
  // Priority 2: Primary character's style
  if (settings.character_style_preset_id !== null) {
    return settings.character_style_preset_id
  }
  
  // Priority 3: Project default style
  if (settings.project_default_preset_id !== null) {
    return settings.project_default_preset_id
  }
  
  // Priority 4: No style (backward compatibility)
  return null
}

/**
 * Compose final image generation prompt
 */
export function composeFinalPrompt(
  originalPrompt: string,
  stylePreset: StylePreset | null
): string {
  if (!stylePreset) {
    // No style preset: use original prompt (backward compatibility)
    return originalPrompt
  }

  const parts: string[] = []

  // 1. Add prefix
  if (stylePreset.prompt_prefix) {
    parts.push(stylePreset.prompt_prefix.trim())
  }

  // 2. Add original prompt
  parts.push(originalPrompt.trim())

  // 3. Add suffix
  if (stylePreset.prompt_suffix) {
    parts.push(stylePreset.prompt_suffix.trim())
  }

  return parts.join(' ')
}

/**
 * Get negative prompt from style preset (if any)
 */
export function getNegativePrompt(stylePreset: StylePreset | null): string | null {
  return stylePreset?.negative_prompt || null
}

/**
 * Fetch style preset from database
 */
export async function fetchStylePreset(
  db: any,
  presetId: number | null
): Promise<StylePreset | null> {
  if (presetId === null) {
    return null
  }

  try {
    const preset = await db.prepare(`
      SELECT id, name, prompt_prefix, prompt_suffix, negative_prompt
      FROM style_presets
      WHERE id = ? AND is_active = 1
    `).bind(presetId).first()

    return preset as StylePreset | null
  } catch (error) {
    console.error('Error fetching style preset:', error)
    return null
  }
}

/**
 * Fetch style settings for a scene
 */
export async function fetchSceneStyleSettings(
  db: any,
  sceneId: number,
  projectId: number
): Promise<StyleSettings> {
  try {
    const result = await db.prepare(`
      SELECT 
        sss.style_preset_id as scene_style_preset_id,
        pss.default_style_preset_id as project_default_preset_id
      FROM scenes s
      LEFT JOIN scene_style_settings sss ON s.id = sss.scene_id
      LEFT JOIN project_style_settings pss ON s.project_id = pss.project_id
      WHERE s.id = ? AND s.project_id = ?
    `).bind(sceneId, projectId).first()

    // Fetch primary character's style_preset_id for this scene
    let characterStylePresetId: number | null = null
    try {
      const charStyle = await db.prepare(`
        SELECT pcm.style_preset_id
        FROM scene_character_map scm
        JOIN project_character_models pcm 
          ON pcm.project_id = ? AND scm.character_key = pcm.character_key
        WHERE scm.scene_id = ? AND pcm.style_preset_id IS NOT NULL
        ORDER BY scm.is_primary DESC, scm.created_at ASC
        LIMIT 1
      `).bind(projectId, sceneId).first<{ style_preset_id: number }>()
      
      characterStylePresetId = charStyle?.style_preset_id || null
    } catch (charError) {
      console.warn('[Style Composer] Failed to fetch character style:', charError)
    }

    return {
      scene_style_preset_id: result?.scene_style_preset_id || null,
      character_style_preset_id: characterStylePresetId,
      project_default_preset_id: result?.project_default_preset_id || null
    }
  } catch (error) {
    console.error('Error fetching scene style settings:', error)
    return {
      scene_style_preset_id: null,
      character_style_preset_id: null,
      project_default_preset_id: null
    }
  }
}
