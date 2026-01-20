/**
 * World & Character Helper (Phase X-2)
 * Utilities for fetching world settings and character info for prompt enhancement
 */

export interface WorldSettings {
  id: number;
  project_id: number;
  art_style: string | null;
  time_period: string | null;
  setting_description: string | null;
  prompt_prefix: string | null;
}

export interface CharacterInfo {
  character_key: string;
  character_name: string;
  appearance_description: string | null;
  story_traits: string | null;
  reference_image_r2_url: string | null;
  is_primary: boolean;
  scene_override?: string | null; // シーン別の特徴オーバーライド
}

export interface SceneCharacterTrait {
  scene_id: number;
  character_key: string;
  override_type: string;
  trait_description: string;
}

/**
 * Fetch world settings for a project
 * Returns null if not found (not an error)
 */
export async function fetchWorldSettings(
  db: D1Database,
  projectId: number
): Promise<WorldSettings | null> {
  try {
    const result = await db.prepare(`
      SELECT 
        id, project_id, art_style, time_period, setting_description, prompt_prefix
      FROM world_settings
      WHERE project_id = ?
    `).bind(projectId).first<WorldSettings>();
    
    return result || null;
  } catch (error) {
    console.error('[World Helper] Failed to fetch world settings:', error);
    return null;
  }
}

/**
 * Fetch characters assigned to a scene
 * Includes scene-specific trait overrides (e.g., fairy → human transformation)
 * Returns empty array if none found
 */
export async function fetchSceneCharacters(
  db: D1Database,
  sceneId: number
): Promise<CharacterInfo[]> {
  try {
    // Fetch base character info with story traits
    const result = await db.prepare(`
      SELECT 
        scm.character_key,
        scm.is_primary,
        pcm.character_name,
        pcm.appearance_description,
        pcm.story_traits,
        pcm.reference_image_r2_url
      FROM scene_character_map scm
      LEFT JOIN scenes s ON scm.scene_id = s.id
      LEFT JOIN project_character_models pcm 
        ON s.project_id = pcm.project_id AND scm.character_key = pcm.character_key
      WHERE scm.scene_id = ?
      ORDER BY scm.is_primary DESC, scm.created_at ASC
    `).bind(sceneId).all<CharacterInfo>();
    
    const characters = result.results || [];
    
    // Fetch scene-specific trait overrides
    const overrides = await db.prepare(`
      SELECT character_key, trait_description
      FROM scene_character_traits
      WHERE scene_id = ?
    `).bind(sceneId).all<{ character_key: string; trait_description: string }>();
    
    // Apply overrides to characters
    const overrideMap = new Map<string, string>();
    for (const override of (overrides.results || [])) {
      overrideMap.set(override.character_key, override.trait_description);
    }
    
    return characters.map(c => ({
      ...c,
      scene_override: overrideMap.get(c.character_key) || null
    }));
  } catch (error) {
    console.error('[World Helper] Failed to fetch scene characters:', error);
    return [];
  }
}

/**
 * Enhance prompt with world settings and character info
 * Phase X-2: Safely adds world/character context without breaking existing prompts
 * Phase X-4: Supports scene-specific trait overrides
 * 
 * Priority for character description:
 * 1. scene_override (if set) - シーン別の特徴（例：妖精→人間の変身）
 * 2. story_traits - 物語全体で抽出された特徴
 * 3. appearance_description - 手動設定された外見説明
 * 
 * @param basePrompt - Original scene prompt
 * @param world - World settings (optional)
 * @param characters - Scene characters (optional)
 * @returns Enhanced prompt
 */
export function enhancePromptWithWorldAndCharacters(
  basePrompt: string,
  world: WorldSettings | null,
  characters: CharacterInfo[]
): string {
  const enhancements: string[] = [];
  
  // Phase X-2: Add world context
  if (world?.prompt_prefix) {
    enhancements.push(world.prompt_prefix);
  }
  
  // Phase X-4: Add character descriptions with override support
  if (characters.length > 0) {
    const characterDescriptions = characters
      .filter(c => c.scene_override || c.story_traits || c.appearance_description)
      .map(c => {
        const prefix = c.is_primary ? '[Main Character]' : '[Character]';
        // Priority: scene_override > story_traits > appearance_description
        const description = c.scene_override || c.story_traits || c.appearance_description;
        return `${prefix} ${c.character_name}: ${description}`;
      })
      .join(', ');
    
    if (characterDescriptions) {
      enhancements.push(characterDescriptions);
    }
  }
  
  // Compose final prompt: base + enhancements
  if (enhancements.length === 0) {
    return basePrompt;
  }
  
  // Format: "basePrompt. World: xxx. Characters: xxx."
  return `${basePrompt}. ${enhancements.join('. ')}.`;
}

/**
 * Get reference image URLs for scene characters
 * Returns array of R2 URLs for image generation APIs that support reference images
 */
export function getCharacterReferenceImages(characters: CharacterInfo[]): string[] {
  return characters
    .filter(c => c.reference_image_r2_url)
    .map(c => c.reference_image_r2_url as string);
}
