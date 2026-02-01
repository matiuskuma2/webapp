// src/utils/split-mode-ssot.ts
// Scene Split モードのSSOT定義

/**
 * SSOT: Split モード定義
 * 
 * 【raw モード（原文保持）】
 * - 目的: 入力テキストを1文字も変えずに分割する
 * - 絶対的なルール:
 *   1. 原文の文字列を変更しない（trimのみ許可）
 *   2. 句読点を削除/変更しない
 *   3. 改行は設定に従う（維持 or 正規化）
 *   4. 連続空白は半角空白1つに正規化（内容には影響なし）
 * - 分割方法: 空行（\n\n）または段落（\n）で分割
 * - ユーザー価値: 「原稿をそのまま動画にしたい」ケース
 * 
 * 【optimized モード（整形）】
 * - 目的: 動画向けに編集しやすい形に整形する
 * - 許可される操作:
 *   1. 要約（長い文を短くする）
 *   2. 言い換え（より分かりやすい表現に）
 *   3. 段落の再構成
 *   4. 不要部分の削除
 * - ユーザー価値: 「AIに整理してほしい」ケース
 */

export type SplitMode = 'raw' | 'optimized';

// 後方互換: preserve → raw, ai → optimized へのマッピング
export function normalizeSplitMode(mode: string | undefined): SplitMode {
  if (!mode) return 'raw'; // デフォルトは原文保持
  
  // 後方互換マッピング
  if (mode === 'preserve') return 'raw';
  if (mode === 'ai') return 'optimized';
  
  // 新しい命名
  if (mode === 'raw' || mode === 'optimized') return mode;
  
  // 不明な値はデフォルト
  console.warn(`[SplitMode] Unknown mode: ${mode}, falling back to 'raw'`);
  return 'raw';
}

/**
 * Raw モード用: 原文不変チェック
 * - 空白を除いた文字数が一致することを確認
 */
export function checkRawIntegrity(original: string, result: string): {
  valid: boolean;
  originalChars: number;
  resultChars: number;
  diff: number;
} {
  // 空白を除いた文字数でチェック
  const normalizeForCheck = (s: string) => s.replace(/[\s\u00A0\u3000]+/g, '');
  const originalChars = normalizeForCheck(original).length;
  const resultChars = normalizeForCheck(result).length;
  
  return {
    valid: originalChars === resultChars,
    originalChars,
    resultChars,
    diff: resultChars - originalChars
  };
}

/**
 * Raw モード用: 空白正規化（内容は変えない）
 * - CRLF → LF
 * - NBSP/全角空白 → 半角空白
 * - 連続空白 → 単一空白（オプション）
 */
export function normalizeWhitespaceForRaw(
  text: string,
  options: { collapseSpaces?: boolean } = {}
): string {
  let result = text;
  
  // CRLF → LF
  result = result.replace(/\r\n/g, '\n');
  result = result.replace(/\r/g, '\n');
  
  // NBSP/全角空白 → 半角空白
  result = result.replace(/[\u00A0\u3000]/g, ' ');
  
  // 連続空白を1つに（改行は維持）
  if (options.collapseSpaces) {
    result = result.replace(/[^\S\n]+/g, ' ');
  }
  
  return result;
}

/**
 * Raw モード用: 段落分割（原文維持）
 * - 空行（\n\n）で分割
 * - 各段落の前後空白のみtrim
 */
export function splitIntoParagraphsRaw(text: string): string[] {
  return text
    .split(/\n\s*\n/)  // 空行で分割
    .map(p => p.trim()) // 前後空白のみ除去
    .filter(p => p.length > 0);
}

/**
 * SSOT: Split設定の保存データ型
 */
export interface SplitSettings {
  mode: SplitMode;
  targetSceneCount: number;
  preserveNewlines: boolean;  // raw モード: 改行維持
  preservePunctuation: boolean; // raw モード: 句読点維持（常にtrue推奨）
}

export const DEFAULT_SPLIT_SETTINGS: SplitSettings = {
  mode: 'raw',
  targetSceneCount: 5,
  preserveNewlines: true,
  preservePunctuation: true
};
