/**
 * Image Prompt Builder
 * docs/12_IMAGE_PROMPT_TEMPLATE.md に準拠
 */

/**
 * シーン固有のプロンプトに、ニュース風インフォグラフィックのスタイル指定を追加
 * 
 * @param scenePrompt - シーン固有の内容記述（scene.image_prompt）
 * @returns 最終的な画像生成プロンプト
 */
export function buildImagePrompt(scenePrompt: string): string {
  // スタイル指定（固定部分）
  const styleTemplate = ", clean infographic style, news broadcast quality, professional layout, modern design, data visualization elements, blue and white color scheme, high contrast, readable text hierarchy, minimalist composition, corporate aesthetic, 16:9 aspect ratio";
  
  return scenePrompt + styleTemplate;
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
  // 1. scene_style_settings から scene固有のstyle_preset_idを取得
  const sceneStyle = await db.prepare(`
    SELECT style_preset_id 
    FROM scene_style_settings 
    WHERE scene_id = ?
  `).bind(sceneId).first()

  let stylePresetId = sceneStyle?.style_preset_id

  // 2. scene固有のスタイルがない場合、project defaultを取得
  if (!stylePresetId) {
    const projectStyle = await db.prepare(`
      SELECT default_style_preset_id 
      FROM project_style_settings 
      WHERE project_id = ?
    `).bind(projectId).first()

    stylePresetId = projectStyle?.default_style_preset_id
  }

  // 3. style_preset_id がない場合、basePromptのみ返す
  if (!stylePresetId) {
    return basePrompt
  }

  // 4. style_presetsからprefix/suffixを取得
  const preset = await db.prepare(`
    SELECT prompt_prefix, prompt_suffix 
    FROM style_presets 
    WHERE id = ? AND is_active = 1
  `).bind(stylePresetId).first()

  if (!preset) {
    return basePrompt
  }

  // 5. 最終プロンプト: prefix + basePrompt + suffix
  const prefix = preset.prompt_prefix || ''
  const suffix = preset.prompt_suffix || ''
  
  return `${prefix} ${basePrompt} ${suffix}`.trim()
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
