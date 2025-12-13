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
