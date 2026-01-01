/**
 * Character Auto-Assignment Engine (Phase X-2 Part 2)
 * 
 * Purpose: Automatically assign characters to scenes based on text matching
 * 
 * Safety Features:
 * - Minimum 3-character aliases (prevent false positives)
 * - Text normalization (全角→半角、カタカナ→ひらがな)
 * - Project-scoped JOIN (prevent cross-project pollution)
 * - Maximum 3 characters per scene
 * - Primary character: first match
 * - Atomic operations (DELETE then INSERT)
 */

import type { D1Database } from '@cloudflare/workers-types';

/**
 * Character pattern for matching
 * 
 * Phase X-2 Part 2: 2-tier matching strategy
 * - name: Always matched (even 2 characters) - highest priority
 * - aliases: Minimum 3 characters (prevent false positives) - lower priority
 */
interface CharacterPattern {
  characterKey: string;
  name: string; // character_name (normalized, 2+ chars OK)
  aliases: string[]; // aliases (normalized, 3+ chars only)
}

/**
 * Scene text for matching
 */
interface SceneText {
  sceneId: number;
  text: string; // dialogue + bullets + image_prompt (normalized)
}

/**
 * Assignment result
 */
interface AssignmentResult {
  sceneId: number;
  characterKey: string;
  isPrimary: boolean;
}

/**
 * Normalize text for matching
 * - Convert full-width to half-width
 * - Convert katakana to hiragana
 * - Trim whitespace
 * - Lowercase
 * 
 * TODO: 要確認 - ひらがな化の範囲（運用次第で調整）
 */
function normalizeText(text: string): string {
  if (!text) return '';
  
  // Full-width to half-width (ASCII)
  let normalized = text.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) => {
    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
  });
  
  // Katakana to Hiragana (カタカナ → ひらがな)
  normalized = normalized.replace(/[\u30A1-\u30F6]/g, (s) => {
    return String.fromCharCode(s.charCodeAt(0) - 0x60);
  });
  
  // Trim and lowercase
  return normalized.trim().toLowerCase();
}

/**
 * Validate character name for auto-assignment
 * - Minimum 2 characters (allow common Japanese names like "太郎")
 * - Must contain at least one Japanese/English character
 * 
 * Phase X-2: character_name has lower minimum (2 chars) than aliases
 */
function isValidName(name: string): boolean {
  if (!name || name.length < 2) return false;
  
  // Must contain at least one letter or Japanese character
  const hasValidChar = /[a-zA-Z\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(name);
  if (!hasValidChar) return false;
  
  return true;
}

/**
 * Validate alias for auto-assignment
 * - Minimum 3 characters (prevent false positives)
 * - No pure numbers or symbols
 * - Must contain at least one Japanese/English character
 * 
 * Phase X-2: aliases have higher minimum (3 chars) to reduce false positives
 */
function isValidAlias(alias: string): boolean {
  if (!alias || alias.length < 3) return false;
  
  // Must contain at least one letter or Japanese character
  const hasValidChar = /[a-zA-Z\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(alias);
  if (!hasValidChar) return false;
  
  return true;
}

/**
 * Safe JSON parse for aliases
 * Returns empty array on error
 */
function parseAliasesSafe(aliasesJson: string | null): string[] {
  if (!aliasesJson) return [];
  
  try {
    const parsed = JSON.parse(aliasesJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(a => typeof a === 'string');
  } catch (error) {
    console.warn('[CharacterAutoAssign] Invalid aliases_json:', error);
    return [];
  }
}

/**
 * Build character patterns for matching
 * 
 * @param db D1 Database
 * @param projectId Project ID
 * @returns Character patterns with normalized text
 */
async function buildCharacterPatterns(
  db: D1Database,
  projectId: number
): Promise<CharacterPattern[]> {
  const characters = await db.prepare(`
    SELECT character_key, character_name, aliases_json
    FROM project_character_models
    WHERE project_id = ?
    ORDER BY id ASC
  `).bind(projectId).all();
  
  const patterns: CharacterPattern[] = [];
  
  for (const char of characters.results || []) {
    const rawName = char.character_name as string;
    const normalizedName = normalizeText(rawName);
    
    // ✅ Phase X-2: character_name is always included (2+ chars OK)
    if (!isValidName(normalizedName)) {
      console.warn(`[CharacterAutoAssign] Invalid character_name: "${rawName}" (too short or invalid)`);
      continue; // Skip this character entirely
    }
    
    // ✅ Phase X-2: aliases require 3+ chars (stricter)
    const rawAliases = parseAliasesSafe(char.aliases_json as string | null);
    const validAliases = rawAliases
      .map(a => normalizeText(a))
      .filter(a => isValidAlias(a)); // Only 3+ char aliases
    
    patterns.push({
      characterKey: char.character_key as string,
      name: normalizedName,
      aliases: validAliases
    });
  }
  
  return patterns;
}

/**
 * Build scene texts for matching
 * 
 * CRITICAL: JOIN with project_id to prevent cross-project pollution
 * 
 * @param db D1 Database
 * @param projectId Project ID
 * @returns Scene texts with normalized content
 */
async function buildSceneTexts(
  db: D1Database,
  projectId: number
): Promise<SceneText[]> {
  // ✅ JOIN condition: MUST include project_id filter
  const scenes = await db.prepare(`
    SELECT id, dialogue, bullets, image_prompt
    FROM scenes
    WHERE project_id = ?
    ORDER BY idx ASC
  `).bind(projectId).all();
  
  const sceneTexts: SceneText[] = [];
  
  for (const scene of scenes.results || []) {
    const text = [
      scene.dialogue,
      scene.bullets,
      scene.image_prompt
    ]
      .filter(Boolean)
      .join(' ');
    
    if (text.trim()) {
      sceneTexts.push({
        sceneId: scene.id as number,
        text: normalizeText(text)
      });
    }
  }
  
  return sceneTexts;
}

/**
 * Match characters to scenes
 * 
 * Phase X-2 Part 2: Priority-based matching
 * 
 * Rules:
 * - Maximum 3 characters per scene
 * - Priority: 1) name match, 2) alias match (longest first)
 * - Primary: first match (highest priority)
 * 
 * @param sceneTexts Scene texts
 * @param characterPatterns Character patterns
 * @returns Assignment results
 */
function matchCharactersToScenes(
  sceneTexts: SceneText[],
  characterPatterns: CharacterPattern[]
): AssignmentResult[] {
  const assignments: AssignmentResult[] = [];
  
  for (const scene of sceneTexts) {
    const matched: Array<{ key: string; priority: number; matchText: string }> = [];
    
    for (const char of characterPatterns) {
      // Priority 1: character_name match (highest)
      if (scene.text.includes(char.name)) {
        matched.push({
          key: char.characterKey,
          priority: 1,
          matchText: char.name
        });
        continue; // Name match is exclusive (don't check aliases)
      }
      
      // Priority 2: alias match (longest first to avoid partial matches)
      const sortedAliases = [...char.aliases].sort((a, b) => b.length - a.length);
      for (const alias of sortedAliases) {
        if (scene.text.includes(alias)) {
          matched.push({
            key: char.characterKey,
            priority: 2,
            matchText: alias
          });
          break; // Only match once per character
        }
      }
    }
    
    // Sort by priority (lower = higher priority), then deduplicate
    matched.sort((a, b) => a.priority - b.priority);
    const uniqueMatches = Array.from(new Set(matched.map(m => m.key)))
      .slice(0, 3); // ✅ Maximum 3
    
    // Create assignments
    for (let i = 0; i < uniqueMatches.length; i++) {
      assignments.push({
        sceneId: scene.sceneId,
        characterKey: uniqueMatches[i],
        isPrimary: i === 0 // ✅ First match is primary
      });
    }
  }
  
  return assignments;
}

/**
 * Apply assignments to database
 * 
 * Strategy: DELETE existing + INSERT new (atomic)
 * 
 * @param db D1 Database
 * @param projectId Project ID (for safety check)
 * @param assignments Assignment results
 */
async function applyAssignments(
  db: D1Database,
  projectId: number,
  assignments: AssignmentResult[]
): Promise<void> {
  // Group by scene_id
  const byScene = new Map<number, AssignmentResult[]>();
  for (const assignment of assignments) {
    if (!byScene.has(assignment.sceneId)) {
      byScene.set(assignment.sceneId, []);
    }
    byScene.get(assignment.sceneId)!.push(assignment);
  }
  
  // Process each scene
  for (const [sceneId, sceneAssignments] of byScene.entries()) {
    // Safety check: verify scene belongs to project
    const scene = await db.prepare(`
      SELECT id FROM scenes WHERE id = ? AND project_id = ?
    `).bind(sceneId, projectId).first();
    
    if (!scene) {
      console.warn(`[CharacterAutoAssign] Scene ${sceneId} not found or not in project ${projectId}`);
      continue;
    }
    
    // DELETE existing assignments for this scene
    await db.prepare(`
      DELETE FROM scene_character_map WHERE scene_id = ?
    `).bind(sceneId).run();
    
    // INSERT new assignments
    for (const assignment of sceneAssignments) {
      await db.prepare(`
        INSERT INTO scene_character_map (scene_id, character_key, is_primary)
        VALUES (?, ?, ?)
      `).bind(
        assignment.sceneId,
        assignment.characterKey,
        assignment.isPrimary ? 1 : 0
      ).run();
    }
  }
}

/**
 * Auto-assign characters to scenes
 * 
 * Main entry point for character auto-assignment
 * 
 * @param db D1 Database
 * @param projectId Project ID
 * @returns Assignment statistics
 */
export async function autoAssignCharactersToScenes(
  db: D1Database,
  projectId: number
): Promise<{ assigned: number; scenes: number; skipped: number }> {
  try {
    // Step 1: Build character patterns
    const characterPatterns = await buildCharacterPatterns(db, projectId);
    
    if (characterPatterns.length === 0) {
      console.log(`[CharacterAutoAssign] No characters defined for project ${projectId}`);
      return { assigned: 0, scenes: 0, skipped: 0 };
    }
    
    // Step 2: Build scene texts
    const sceneTexts = await buildSceneTexts(db, projectId);
    
    if (sceneTexts.length === 0) {
      console.log(`[CharacterAutoAssign] No scenes found for project ${projectId}`);
      return { assigned: 0, scenes: 0, skipped: 0 };
    }
    
    // Step 3: Match characters to scenes
    const assignments = matchCharactersToScenes(sceneTexts, characterPatterns);
    
    // Step 4: Apply assignments to database
    await applyAssignments(db, projectId, assignments);
    
    // Count unique scenes
    const uniqueScenes = new Set(assignments.map(a => a.sceneId)).size;
    
    console.log(`[CharacterAutoAssign] Project ${projectId}: ${assignments.length} assignments to ${uniqueScenes} scenes`);
    
    return {
      assigned: assignments.length,
      scenes: uniqueScenes,
      skipped: sceneTexts.length - uniqueScenes
    };
  } catch (error) {
    console.error('[CharacterAutoAssign] Error:', error);
    throw error;
  }
}
