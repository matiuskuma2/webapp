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
 *   const refImages = await getSceneReferenceImages(db, r2, sceneId, 5, debug);
 *   // Pass to generateImageWithRetry()
 * 
 * Debug Mode:
 *   - Set DEBUG_REFERENCE_IMAGES='1' in Cloudflare env for verbose logging
 *   - Pass debug=true to getSceneReferenceImages()
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
 * Convert ArrayBuffer to base64 (optimized for large files)
 * Uses chunked approach to avoid stack overflow
 * 
 * @param ab ArrayBuffer to convert
 * @returns base64 encoded string
 */
function arrayBufferToBase64(ab: ArrayBuffer): string {
  const bytes = new Uint8Array(ab);
  const CHUNK_SIZE = 0x8000; // 32KB chunks
  let binary = '';

  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    // Avoid Array.from for better performance
    let chunkStr = '';
    for (let j = 0; j < chunk.length; j++) {
      chunkStr += String.fromCharCode(chunk[j]);
    }
    binary += chunkStr;
  }

  return btoa(binary);
}

/**
 * Fetch reference images for characters in a scene
 * 
 * @param db D1 Database
 * @param r2 R2 Bucket
 * @param sceneId Scene ID
 * @param maxImages Maximum images to return (default: 5)
 * @param debug Enable verbose logging (default: false)
 * @returns Array of ReferenceImage objects for Gemini API
 */
export async function getSceneReferenceImages(
  db: D1Database,
  r2: R2Bucket,
  sceneId: number,
  maxImages: number = MAX_REFERENCE_IMAGES,
  debug: boolean = false
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
    
    if (debug) {
      console.log(`[CharacterRefHelper] Scene ${sceneId}: Query returned ${characters.length} characters`);
    }
    
    if (characters.length === 0) {
      if (debug) console.log(`[CharacterRefHelper] Scene ${sceneId}: No characters assigned`);
      return [];
    }
    
    // 2. Filter characters with reference images and limit to max
    const charactersWithImages = characters
      .filter(c => c.reference_image_r2_url)
      .slice(0, maxImages);
    
    if (debug) {
      console.log(`[CharacterRefHelper] Scene ${sceneId}: ${charactersWithImages.length} characters have reference images`, 
        charactersWithImages.map(c => ({ key: c.character_key, url: c.reference_image_r2_url })));
    }
    
    // 3. Fetch each reference image from R2
    for (const char of charactersWithImages) {
      try {
        const refImage = await fetchReferenceImageFromR2(
          r2,
          char.reference_image_r2_url!,
          char.character_key,
          char.character_name,
          debug
        );
        
        if (refImage) {
          referenceImages.push(refImage);
        }
      } catch (error) {
        // Always log errors (not gated by debug)
        console.warn(`[CharacterRefHelper] Failed to load ref for ${char.character_key}:`, error);
        // Continue with other characters
      }
    }
    
    if (debug) {
      console.log(`[CharacterRefHelper] Scene ${sceneId}: Loaded ${referenceImages.length}/${charactersWithImages.length} reference images`);
    }
    
  } catch (error) {
    // Always log errors (not gated by debug)
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
 * @param debug Enable verbose logging (default: false)
 * @returns ReferenceImage or null if failed
 */
export async function fetchReferenceImageFromR2(
  r2: R2Bucket,
  r2Url: string,
  characterKey: string,
  characterName?: string,
  debug: boolean = false
): Promise<ReferenceImage | null> {
  try {
    // Convert URL to R2 key (remove leading /)
    const r2Key = r2Url.startsWith('/') ? r2Url.substring(1) : r2Url;
    
    if (debug) {
      console.log(`[CharacterRefHelper] Attempting to fetch from R2: ${r2Key}`);
    }
    
    // Fetch from R2
    const r2Object = await r2.get(r2Key);
    
    if (!r2Object) {
      // Always warn on missing files (not gated by debug)
      console.warn(`[CharacterRefHelper] R2 object not found: ${r2Key}`);
      return null;
    }
    
    if (debug) {
      console.log(`[CharacterRefHelper] R2 object found: ${r2Key}, size=${r2Object.size}, contentType=${r2Object.httpMetadata?.contentType}`);
    }
    
    // Convert to base64 (optimized, chunked method)
    const arrayBuffer = await r2Object.arrayBuffer();
    const base64Data = arrayBufferToBase64(arrayBuffer);
    const mimeType = r2Object.httpMetadata?.contentType || 'image/png';
    
    if (debug) {
      console.log(`[CharacterRefHelper] Loaded reference: ${characterKey} (${arrayBuffer.byteLength} bytes)`);
    }
    
    return {
      base64Data,
      mimeType,
      characterKey,
      characterName: characterName || characterKey
    };
  } catch (error) {
    // Always log errors (not gated by debug)
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
