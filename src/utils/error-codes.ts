/**
 * Image Generation Error Codes — SSOT (Single Source of Truth)
 *
 * 全ての画像生成エラーコードを統一する共通モジュール。
 * image-generation.ts, gemini-image-client.ts, marunage.ts から使用。
 *
 * Phase 0-C: ad-hoc 文字列リテラルを排除し、一元管理する。
 */

// ============================================================
// Error Code Constants
// ============================================================

export const IMAGE_GEN_ERROR = {
  /** Gemini API がタイムアウト (50s) */
  TIMEOUT: 'TIMEOUT',
  /** ユーザーまたはシステムの API クォータ超過 */
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  /** 429 レート制限 (RPM超過) */
  RATE_LIMIT: 'RATE_LIMIT',
  /** 画像生成失敗 (プロンプト不正、safety filterなど) */
  GENERATION_FAILED: 'GENERATION_FAILED',
  /** R2 ストレージへの保存失敗 */
  STORAGE_FAILED: 'STORAGE_FAILED',
  /** 内部エラー (予期しない例外) */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** Cloudflare Workers 実行コンテキスト終了 */
  WORKER_CONTEXT_CLOSED: 'WORKER_CONTEXT_CLOSED',
  /** レスポンスに画像データなし */
  NO_IMAGE_DATA: 'NO_IMAGE_DATA',
  /** 全リトライ合計時間超過 */
  TOTAL_TIMEOUT: 'TOTAL_TIMEOUT',
  /** サーバーエラー (500/502/503/524) */
  SERVER_ERROR: 'SERVER_ERROR',
} as const;

export type ImageGenErrorCode = typeof IMAGE_GEN_ERROR[keyof typeof IMAGE_GEN_ERROR];

// ============================================================
// Quota Error Detection — Structured
// ============================================================

/**
 * クォータ/レート制限エラーとして判定するパターン。
 * ★ timeout, 500, 502, 503, 524 は明示的にクォータエラーではない。
 */
const QUOTA_ERROR_PATTERNS = [
  'RESOURCE_EXHAUSTED',
  'RATE_LIMIT_EXCEEDED',
  'QUOTA',
  '429',
  'RATE_LIMIT_429',
] as const;

/**
 * timeout / server error として判定するパターン。
 * これらはクォータエラーではないことを明示。
 */
const NON_QUOTA_ERROR_PATTERNS = [
  'TIMEOUT',
  'ABORTERROR',
  'DID NOT RESPOND',
  'MESSAGE PORT CLOSED',
  'WORKER_CONTEXT_CLOSED',
] as const;

/**
 * エラーがクォータ/レート制限エラーかどうかを判定する。
 * ★ Phase 0-B: 構造化された判定ロジック
 *
 * @param error - エラーオブジェクトまたはエラーメッセージ文字列
 * @returns true = クォータ/レート制限エラー → キーフォールバック対象
 */
export function isQuotaError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? '')).toUpperCase();

  // ★ timeout / server error は明示的にクォータエラーではない
  if (NON_QUOTA_ERROR_PATTERNS.some(p => msg.includes(p))) {
    return false;
  }

  return QUOTA_ERROR_PATTERNS.some(p => msg.includes(p));
}

/**
 * エラーがタイムアウトエラーかどうかを判定する。
 */
export function isTimeoutError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? '')).toUpperCase();
  return msg.includes('TIMEOUT') || msg.includes('ABORTERROR') || msg.includes('DID NOT RESPOND');
}

/**
 * エラーがレート制限 (429) エラーかどうかを判定する。
 */
export function isRateLimitError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? '')).toUpperCase();
  return msg.includes('429') || msg.includes('RATE_LIMIT');
}

/**
 * エラーコードを推定する。
 * エラーメッセージからもっとも適切な IMAGE_GEN_ERROR を返す。
 */
export function classifyError(error: unknown): ImageGenErrorCode {
  if (isTimeoutError(error)) return IMAGE_GEN_ERROR.TIMEOUT;
  if (isQuotaError(error)) return IMAGE_GEN_ERROR.QUOTA_EXCEEDED;
  if (isRateLimitError(error)) return IMAGE_GEN_ERROR.RATE_LIMIT;

  const msg = (error instanceof Error ? error.message : String(error ?? '')).toUpperCase();
  if (msg.includes('WORKER_CONTEXT_CLOSED') || msg.includes('MESSAGE PORT CLOSED')) {
    return IMAGE_GEN_ERROR.WORKER_CONTEXT_CLOSED;
  }
  if (msg.includes('R2') || msg.includes('STORAGE')) {
    return IMAGE_GEN_ERROR.STORAGE_FAILED;
  }

  return IMAGE_GEN_ERROR.GENERATION_FAILED;
}
