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
  reference_image_r2_url: string | null;
  is_primary: boolean;
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
 * Returns empty array if none found
 */
export async function fetchSceneCharacters(
  db: D1Database,
  sceneId: number
): Promise<CharacterInfo[]> {
  try {
    const result = await db.prepare(`
      SELECT 
        scm.character_key,
        scm.is_primary,
        pcm.character_name,
        pcm.appearance_description,
        pcm.reference_image_r2_url
      FROM scene_character_map scm
      LEFT JOIN scenes s ON scm.scene_id = s.id
      LEFT JOIN project_character_models pcm 
        ON s.project_id = pcm.project_id AND scm.character_key = pcm.character_key
      WHERE scm.scene_id = ?
      ORDER BY scm.is_primary DESC, scm.created_at ASC
    `).bind(sceneId).all<CharacterInfo>();
    
    return result.results || [];
  } catch (error) {
    console.error('[World Helper] Failed to fetch scene characters:', error);
    return [];
  }
}

/**
 * Enhance prompt with world settings and character info
 * Phase X-2: Safely adds world/character context without breaking existing prompts
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
  
  // Phase X-2: Add character descriptions
  if (characters.length > 0) {
    const characterDescriptions = characters
      .filter(c => c.appearance_description)
      .map(c => {
        const prefix = c.is_primary ? '[Main Character]' : '[Character]';
        return `${prefix} ${c.appearance_description}`;
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
