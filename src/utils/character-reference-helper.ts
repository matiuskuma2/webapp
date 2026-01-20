/**
 * Character Reference Image Helper (SSOT)
 * 
 * Purpose: Centralized logic for fetching character reference images
 * for Gemini API image generation.
 * 
 * SSOT Rules:
 * - Maximum 5 reference images (Gemini limit for character consistency)
 * - Priority: is_primary=1 first, then by created_at
 * - Reference images are fetched from R2 and converted to base64
 * 
 * Usage:
 *   const refImages = await getSceneReferenceImages(db, r2, sceneId);
 *   // Pass to generateImageWithRetry()
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { R2Bucket } from '@cloudflare/workers-types';

export interface ReferenceImage {
  base64Data: string;
  mimeType: string;
  characterName?: string;
  characterKey: string;
}

export interface CharacterForReference {
  character_key: string;
  character_name: string;
  reference_image_r2_url: string | null;
  is_primary: boolean;
}

/**
 * Maximum number of reference images to send to Gemini API
 * Based on gemini-3-pro-image-preview specification (max 5 for character consistency)
 */
export const MAX_REFERENCE_IMAGES = 5;

/**
 * Fetch reference images for characters in a scene
 * 
 * @param db D1 Database
 * @param r2 R2 Bucket
 * @param sceneId Scene ID
 * @param maxImages Maximum images to return (default: 5)
 * @returns Array of ReferenceImage objects for Gemini API
 */
export async function getSceneReferenceImages(
  db: D1Database,
  r2: R2Bucket,
  sceneId: number,
  maxImages: number = MAX_REFERENCE_IMAGES
): Promise<ReferenceImage[]> {
  const referenceImages: ReferenceImage[] = [];
  
  try {
    // 1. Fetch characters assigned to scene (ordered by priority)
    const result = await db.prepare(`
      SELECT 
        scm.character_key,
        scm.is_primary,
        pcm.character_name,
        pcm.reference_image_r2_url
      FROM scene_character_map scm
      LEFT JOIN scenes s ON scm.scene_id = s.id
      LEFT JOIN project_character_models pcm 
        ON s.project_id = pcm.project_id AND scm.character_key = pcm.character_key
      WHERE scm.scene_id = ?
      ORDER BY scm.is_primary DESC, scm.created_at ASC
    `).bind(sceneId).all<CharacterForReference>();
    
    const characters = result.results || [];
    
    if (characters.length === 0) {
      console.log(`[CharacterRefHelper] Scene ${sceneId}: No characters assigned`);
      return [];
    }
    
    // 2. Filter characters with reference images and limit to max
    const charactersWithImages = characters
      .filter(c => c.reference_image_r2_url)
      .slice(0, maxImages);
    
    // 3. Fetch each reference image from R2
    for (const char of charactersWithImages) {
      try {
        const refImage = await fetchReferenceImageFromR2(
          r2,
          char.reference_image_r2_url!,
          char.character_key,
          char.character_name
        );
        
        if (refImage) {
          referenceImages.push(refImage);
        }
      } catch (error) {
        console.warn(`[CharacterRefHelper] Failed to load ref for ${char.character_key}:`, error);
        // Continue with other characters
      }
    }
    
    console.log(`[CharacterRefHelper] Scene ${sceneId}: Loaded ${referenceImages.length}/${charactersWithImages.length} reference images`);
    
  } catch (error) {
    console.error(`[CharacterRefHelper] Error fetching scene characters:`, error);
  }
  
  return referenceImages;
}

/**
 * Fetch a single reference image from R2 and convert to base64
 * 
 * @param r2 R2 Bucket
 * @param r2Url R2 URL (e.g., "/images/characters/1/hero_123.png")
 * @param characterKey Character key for logging
 * @param characterName Character name for metadata
 * @returns ReferenceImage or null if failed
 */
export async function fetchReferenceImageFromR2(
  r2: R2Bucket,
  r2Url: string,
  characterKey: string,
  characterName?: string
): Promise<ReferenceImage | null> {
  try {
    // Convert URL to R2 key (remove leading /)
    const r2Key = r2Url.startsWith('/') ? r2Url.substring(1) : r2Url;
    
    // Fetch from R2
    const r2Object = await r2.get(r2Key);
    
    if (!r2Object) {
      console.warn(`[CharacterRefHelper] R2 object not found: ${r2Key}`);
      return null;
    }
    
    // Convert to base64
    const arrayBuffer = await r2Object.arrayBuffer();
    const base64Data = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
    const mimeType = r2Object.httpMetadata?.contentType || 'image/png';
    
    console.log(`[CharacterRefHelper] Loaded reference: ${characterKey} (${arrayBuffer.byteLength} bytes)`);
    
    return {
      base64Data,
      mimeType,
      characterKey,
      characterName: characterName || characterKey
    };
  } catch (error) {
    console.error(`[CharacterRefHelper] Failed to fetch R2 image ${r2Url}:`, error);
    return null;
  }
}

/**
 * Check if a character has a valid reference image
 */
export function hasValidReferenceImage(character: CharacterForReference): boolean {
  return !!character.reference_image_r2_url && character.reference_image_r2_url.length > 0;
}

/**
 * Get character keys that have reference images
 */
export function getCharactersWithReferences(characters: CharacterForReference[]): string[] {
  return characters
    .filter(hasValidReferenceImage)
    .map(c => c.character_key);
}
