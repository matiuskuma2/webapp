// src/utils/scene-idx-manager.ts
// シーンidx管理SSOT - UNIQUE制約違反を防ぐ一元管理

/**
 * SSOT: シーンidx管理ルール
 * 
 * 1. 可視シーンのidx: 1から始まる連番（1, 2, 3, ...）
 * 2. 非表示シーンのidx: -scene_id（-1, -2, -3, ...）
 *    → 同一プロジェクト内で複数の非表示シーンがあっても衝突しない
 * 3. idx更新は必ず2段階で行う（UNIQUE制約回避）
 *    → Step1: 一時的な大きな値（10000+）に設定
 *    → Step2: 正しい連番に再設定
 */

/**
 * 可視シーンのidxを再採番（hide/restore/reorder後に呼ぶ）
 * - UNIQUE制約回避のため、2段階で更新
 * - 非表示シーンは対象外
 */
export async function renumberVisibleScenes(
  db: D1Database,
  projectId: number
): Promise<{ success: boolean; count: number; error?: string }> {
  try {
    // 可視シーンをidx順で取得
    const { results: visibleScenes } = await db.prepare(`
      SELECT id FROM scenes
      WHERE project_id = ? AND (is_hidden = 0 OR is_hidden IS NULL)
      ORDER BY idx ASC
    `).bind(projectId).all<{ id: number }>();

    if (visibleScenes.length === 0) {
      return { success: true, count: 0 };
    }

    // Step 1: 一時的な大きな値を割り当て（衝突回避）
    for (let i = 0; i < visibleScenes.length; i++) {
      await db.prepare(`
        UPDATE scenes SET idx = ? WHERE id = ?
      `).bind(10000 + i, visibleScenes[i].id).run();
    }

    // Step 2: 正しい連番に再設定（1, 2, 3, ...）
    for (let i = 0; i < visibleScenes.length; i++) {
      await db.prepare(`
        UPDATE scenes SET idx = ? WHERE id = ?
      `).bind(i + 1, visibleScenes[i].id).run();
    }

    console.log(`[SceneIdx] Renumbered ${visibleScenes.length} visible scenes for project ${projectId}`);
    return { success: true, count: visibleScenes.length };
  } catch (error: any) {
    console.error(`[SceneIdx] Failed to renumber scenes for project ${projectId}:`, error);
    return { success: false, count: 0, error: error?.message || String(error) };
  }
}

/**
 * シーンを非表示にする（idx = -scene_id に設定）
 * - UNIQUE制約回避: 各非表示シーンは -scene_id でユニーク
 * - 呼び出し後、renumberVisibleScenes() で可視シーンを再採番すること
 */
export async function hideSceneIdx(
  db: D1Database,
  sceneId: number
): Promise<{ success: boolean; error?: string }> {
  try {
    // is_hidden = 1, idx = -scene_id に設定
    await db.prepare(`
      UPDATE scenes 
      SET is_hidden = 1, idx = -id, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).bind(sceneId).run();

    console.log(`[SceneIdx] Hidden scene ${sceneId}, idx set to -${sceneId}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[SceneIdx] Failed to hide scene ${sceneId}:`, error);
    return { success: false, error: error?.message || String(error) };
  }
}

/**
 * シーンを復元する（末尾に追加）
 * - 可視シーンの最大idx + 1 の位置に復元
 */
export async function restoreSceneIdx(
  db: D1Database,
  sceneId: number,
  projectId: number
): Promise<{ success: boolean; newIdx: number; error?: string }> {
  try {
    // 現在の可視シーンの最大idxを取得
    const maxIdxResult = await db.prepare(`
      SELECT MAX(idx) as max_idx FROM scenes 
      WHERE project_id = ? AND (is_hidden = 0 OR is_hidden IS NULL)
    `).bind(projectId).first<{ max_idx: number | null }>();

    const newIdx = (maxIdxResult?.max_idx ?? 0) + 1;

    // is_hidden = 0, idx = newIdx に設定
    await db.prepare(`
      UPDATE scenes 
      SET is_hidden = 0, idx = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).bind(newIdx, sceneId).run();

    console.log(`[SceneIdx] Restored scene ${sceneId}, new idx=${newIdx}`);
    return { success: true, newIdx };
  } catch (error: any) {
    console.error(`[SceneIdx] Failed to restore scene ${sceneId}:`, error);
    return { success: false, newIdx: 0, error: error?.message || String(error) };
  }
}

/**
 * シーンの順序を指定の配列順に変更
 * - scene_ids の順番で idx を 1, 2, 3, ... に設定
 * - 2段階更新でUNIQUE制約を回避
 */
export async function reorderScenes(
  db: D1Database,
  sceneIds: number[]
): Promise<{ success: boolean; error?: string }> {
  try {
    if (sceneIds.length === 0) {
      return { success: true };
    }

    // Step 1: 一時的な大きな値を割り当て（衝突回避）
    for (let i = 0; i < sceneIds.length; i++) {
      await db.prepare(`
        UPDATE scenes SET idx = ? WHERE id = ?
      `).bind(10000 + i, sceneIds[i]).run();
    }

    // Step 2: 正しい連番に再設定
    for (let i = 0; i < sceneIds.length; i++) {
      await db.prepare(`
        UPDATE scenes SET idx = ? WHERE id = ?
      `).bind(i + 1, sceneIds[i]).run();
    }

    console.log(`[SceneIdx] Reordered ${sceneIds.length} scenes`);
    return { success: true };
  } catch (error: any) {
    console.error(`[SceneIdx] Failed to reorder scenes:`, error);
    return { success: false, error: error?.message || String(error) };
  }
}

/**
 * 新しいシーンを挿入する位置のidxを計算
 * - insert_after_idx が指定されていれば、その次の位置
 * - 指定がなければ末尾
 * - 挿入後は renumberVisibleScenes() を呼ぶ必要あり
 */
export async function getInsertPosition(
  db: D1Database,
  projectId: number,
  insertAfterIdx?: number
): Promise<{ newIdx: number; needsRenumber: boolean }> {
  const maxIdxResult = await db.prepare(`
    SELECT MAX(idx) as max_idx FROM scenes 
    WHERE project_id = ? AND (is_hidden = 0 OR is_hidden IS NULL)
  `).bind(projectId).first<{ max_idx: number | null }>();

  const maxIdx = maxIdxResult?.max_idx ?? 0;

  if (insertAfterIdx !== undefined && insertAfterIdx < maxIdx) {
    // 途中に挿入 → 挿入後に再採番が必要
    return { newIdx: insertAfterIdx + 1, needsRenumber: true };
  } else {
    // 末尾に追加 → 再採番不要
    return { newIdx: maxIdx + 1, needsRenumber: false };
  }
}
