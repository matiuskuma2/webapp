/**
 * Image Prompt Builder
 * docs/12_IMAGE_PROMPT_TEMPLATE.md に準拠
 */

/**
 * シーン固有のプロンプトを返す（API制限対応でトリム）
 * スタイルはスタイルプリセット（composeStyledPrompt）で適用される
 * 
 * Flux/FAL.ai API: T5エンコーダー使用、約512トークン（~2000文字）対応
 * 安全マージンとして2000文字でトリム
 * 
 * @param scenePrompt - シーン固有の内容記述（scene.image_prompt）
 * @returns 画像生成プロンプト（最大2000文字）
 */
const MAX_PROMPT_LENGTH = 2000;

export function buildImagePrompt(scenePrompt: string): string {
  if (!scenePrompt) return '';
  
  // 2000文字を超える場合はトリム
  if (scenePrompt.length > MAX_PROMPT_LENGTH) {
    console.warn(`[Prompt Builder] Prompt truncated from ${scenePrompt.length} to ${MAX_PROMPT_LENGTH} chars`);
    return scenePrompt.substring(0, MAX_PROMPT_LENGTH);
  }
  
  return scenePrompt;
}

/**
 * スタイルプリセットを適用して最終プロンプトを生成
 * 
 * Priority: scene_style_settings > project_style_settings > scene.image_prompt only
 * 
 * @param db - D1 Database instance
 * @param projectId - Project ID
 * @param sceneId - Scene ID
 * @param basePrompt - scene.image_prompt
 * @returns Final prompt with style applied
 */
export async function composeStyledPrompt(
  db: any,
  projectId: number,
  sceneId: number,
  basePrompt: string
): Promise<string> {
  // Phase X-2: Enhance with world/character info first (Optional - fallback to original on error)
  let enhancedPrompt = basePrompt;
  try {
    const { fetchWorldSettings, fetchSceneCharacters, enhancePromptWithWorldAndCharacters } = await import('./world-character-helper');
    
    const world = await fetchWorldSettings(db, projectId);
    const characters = await fetchSceneCharacters(db, sceneId);
    
    enhancedPrompt = enhancePromptWithWorldAndCharacters(basePrompt, world, characters);
  } catch (error) {
    console.warn('[Prompt Builder] Phase X-2 enhancement failed, using original prompt:', error);
  }

  // 1. scene_style_settings から scene固有のstyle_preset_idを取得
  const sceneStyle = await db.prepare(`
    SELECT style_preset_id 
    FROM scene_style_settings 
    WHERE scene_id = ?
  `).bind(sceneId).first()

  let stylePresetId = sceneStyle?.style_preset_id

  // 2. scene固有のスタイルがない場合、主キャラクターのstyle_preset_idを取得
  if (!stylePresetId) {
    try {
      const charStyle = await db.prepare(`
        SELECT pcm.style_preset_id
        FROM scene_character_map scm
        JOIN project_character_models pcm 
          ON pcm.project_id = ? AND scm.character_key = pcm.character_key
        WHERE scm.scene_id = ? AND pcm.style_preset_id IS NOT NULL
        ORDER BY scm.is_primary DESC, scm.created_at ASC
        LIMIT 1
      `).bind(projectId, sceneId).first()
      
      stylePresetId = charStyle?.style_preset_id
    } catch (charError) {
      console.warn('[Prompt Builder] Failed to fetch character style:', charError)
    }
  }

  // 3. キャラスタイルもない場合、project defaultを取得
  if (!stylePresetId) {
    const projectStyle = await db.prepare(`
      SELECT default_style_preset_id 
      FROM project_style_settings 
      WHERE project_id = ?
    `).bind(projectId).first()

    stylePresetId = projectStyle?.default_style_preset_id
  }

  // 3. style_preset_id がない場合、enhancedPromptのみ返す
  if (!stylePresetId) {
    return enhancedPrompt
  }

  // 4. style_presetsからprefix/suffixを取得
  const preset = await db.prepare(`
    SELECT prompt_prefix, prompt_suffix 
    FROM style_presets 
    WHERE id = ? AND is_active = 1
  `).bind(stylePresetId).first()

  if (!preset) {
    return enhancedPrompt
  }

  // 5. 最終プロンプト: prefix + enhancedPrompt + suffix
  const prefix = preset.prompt_prefix || ''
  const suffix = preset.prompt_suffix || ''
  
  return `${prefix} ${enhancedPrompt} ${suffix}`.trim()
}

/**
 * R2保存用のキーを生成
 * パス規約: images/{project_id}/scene_{idx}/{generation_id}_{timestamp}.png
 * 
 * @param projectId - プロジェクトID
 * @param sceneIdx - シーン番号
 * @param generationId - 画像生成ID
 * @returns R2キー
 */
export function buildR2Key(projectId: number, sceneIdx: number, generationId: number): string {
  const timestamp = Date.now();
  return `images/${projectId}/scene_${sceneIdx}/${generationId}_${timestamp}.png`;
}
