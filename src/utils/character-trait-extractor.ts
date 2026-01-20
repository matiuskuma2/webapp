/**
 * Character Trait Extractor (Phase X-3)
 * 
 * Purpose: Automatically extract character traits from scene dialogues
 * to ensure visual consistency across all scenes.
 * 
 * Example:
 * - Scene 1 dialogue: "ベルは小さな妖精で、キラキラと光る羽を持っている"
 * - Extracted trait: "小さな妖精、キラキラと光る羽を持つ"
 * - This trait is then used for ALL scenes featuring ベル
 */

import type { D1Database } from '@cloudflare/workers-types';

interface CharacterTrait {
  characterKey: string;
  characterName: string;
  traits: string[];
  currentDescription: string | null;
}

interface SceneDialogue {
  sceneId: number;
  dialogue: string;
  bullets: string;
  imagePrompt: string;
}

/**
 * Trait patterns to look for in Japanese text
 * These patterns help identify character descriptions
 */
const TRAIT_PATTERNS = [
  // Species/Type patterns
  /(?:は|という|である)([^。、]+(?:妖精|精霊|天使|悪魔|ロボット|AI|人工知能|獣人|エルフ|ドワーフ|魔法使い|魔女|騎士|王子|王女|姫|勇者|戦士|忍者|侍))/g,
  
  // Physical appearance patterns
  /(?:(?:髪|目|瞳|肌|翼|羽|角|耳|尻尾|しっぽ)(?:は|が|の色は?))[^。、]+/g,
  
  // Clothing/Equipment patterns
  /(?:着ている|纏っている|身に(?:着|付)けている)[^。、]+/g,
  
  // Size/Age patterns
  /(?:小さな|大きな|巨大な|幼い|若い|老いた|古い)[^。、]*(?:妖精|精霊|少女|少年|男|女|人|者)/g,
  
  // Special features
  /(?:光る|輝く|キラキラ|ふわふわ|透明な|半透明の)[^。、]+/g,
];

/**
 * Extract character traits from text
 * 
 * @param text Text to analyze (dialogue, bullets, image_prompt)
 * @param characterName Character name to look for
 * @returns Array of extracted traits
 */
function extractTraitsFromText(text: string, characterName: string): string[] {
  if (!text || !characterName) return [];
  
  const traits: string[] = [];
  const normalizedText = text.toLowerCase();
  const normalizedName = characterName.toLowerCase();
  
  // Check if character is mentioned in this text
  if (!normalizedText.includes(normalizedName)) {
    return [];
  }
  
  // Find sentences containing the character name
  const sentences = text.split(/[。！？\n]/);
  
  for (const sentence of sentences) {
    if (!sentence.toLowerCase().includes(normalizedName)) continue;
    
    // Apply trait patterns
    for (const pattern of TRAIT_PATTERNS) {
      // Reset pattern state
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(sentence)) !== null) {
        const trait = match[0].trim();
        if (trait.length > 3 && trait.length < 50) {
          traits.push(trait);
        }
      }
    }
    
    // Also look for direct descriptions like "〇〇は△△"
    const directPattern = new RegExp(`${characterName}(?:は|って)[^。、]{5,30}`, 'gi');
    let directMatch;
    while ((directMatch = directPattern.exec(sentence)) !== null) {
      // Remove the character name from the beginning
      let trait = directMatch[0].replace(new RegExp(`^${characterName}(?:は|って)`, 'i'), '').trim();
      if (trait.length > 3 && !traits.includes(trait)) {
        traits.push(trait);
      }
    }
  }
  
  // Remove duplicates and return
  return [...new Set(traits)];
}

/**
 * Extract and update character traits for a project
 * 
 * This function:
 * 1. Fetches all characters for the project
 * 2. Fetches all scene dialogues
 * 3. Extracts traits from dialogues for each character
 * 4. Updates appearance_description with extracted traits (if not already set)
 * 
 * @param db D1 Database
 * @param projectId Project ID
 * @returns Summary of updates
 */
export async function extractAndUpdateCharacterTraits(
  db: D1Database,
  projectId: number
): Promise<{ updated: number; characters: string[] }> {
  console.log(`[CharacterTraitExtractor] Starting extraction for project ${projectId}`);
  
  // 1. Fetch all characters for the project
  const charactersResult = await db.prepare(`
    SELECT character_key, character_name, appearance_description
    FROM project_character_models
    WHERE project_id = ?
  `).bind(projectId).all();
  
  const characters: CharacterTrait[] = (charactersResult.results || []).map(c => ({
    characterKey: c.character_key as string,
    characterName: c.character_name as string,
    traits: [],
    currentDescription: c.appearance_description as string | null
  }));
  
  if (characters.length === 0) {
    console.log(`[CharacterTraitExtractor] No characters found for project ${projectId}`);
    return { updated: 0, characters: [] };
  }
  
  // 2. Fetch all scene dialogues
  const scenesResult = await db.prepare(`
    SELECT id, dialogue, bullets, image_prompt
    FROM scenes
    WHERE project_id = ?
    ORDER BY idx ASC
  `).bind(projectId).all();
  
  const scenes: SceneDialogue[] = (scenesResult.results || []).map(s => ({
    sceneId: s.id as number,
    dialogue: s.dialogue as string || '',
    bullets: s.bullets as string || '',
    imagePrompt: s.image_prompt as string || ''
  }));
  
  // 3. Extract traits for each character from all scenes
  for (const char of characters) {
    for (const scene of scenes) {
      // Combine all text sources
      const combinedText = [
        scene.dialogue,
        scene.bullets,
        scene.imagePrompt
      ].join(' ');
      
      const extractedTraits = extractTraitsFromText(combinedText, char.characterName);
      char.traits.push(...extractedTraits);
    }
    
    // Remove duplicates
    char.traits = [...new Set(char.traits)];
  }
  
  // 4. Update appearance_description for characters that don't have one
  let updatedCount = 0;
  const updatedCharacters: string[] = [];
  
  for (const char of characters) {
    if (char.traits.length === 0) continue;
    
    // Build new description from extracted traits
    const newTraits = char.traits.slice(0, 5).join('、'); // Max 5 traits
    
    // If no current description, set it
    // If current description exists, append new traits
    let newDescription: string;
    if (!char.currentDescription || char.currentDescription.trim() === '') {
      newDescription = newTraits;
    } else {
      // Check if traits are already in description
      const existingLower = char.currentDescription.toLowerCase();
      const newTraitsFiltered = char.traits.filter(t => 
        !existingLower.includes(t.toLowerCase())
      );
      
      if (newTraitsFiltered.length === 0) continue; // Nothing new to add
      
      newDescription = `${char.currentDescription}、${newTraitsFiltered.slice(0, 3).join('、')}`;
    }
    
    // Update database
    try {
      await db.prepare(`
        UPDATE project_character_models
        SET appearance_description = ?, updated_at = CURRENT_TIMESTAMP
        WHERE project_id = ? AND character_key = ?
      `).bind(newDescription, projectId, char.characterKey).run();
      
      updatedCount++;
      updatedCharacters.push(char.characterName);
      
      console.log(`[CharacterTraitExtractor] Updated ${char.characterName}: "${newDescription}"`);
    } catch (error) {
      console.error(`[CharacterTraitExtractor] Failed to update ${char.characterName}:`, error);
    }
  }
  
  console.log(`[CharacterTraitExtractor] Completed: ${updatedCount} characters updated`);
  return { updated: updatedCount, characters: updatedCharacters };
}
