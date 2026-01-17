/**
 * Signed URL Utilities
 * 
 * HMAC-SHA256署名付きURLの生成・検証
 * AWS Workerなど外部サービスからの画像取得に使用
 * 
 * URL形式: /images/signed/{r2_key}?exp={timestamp}&sig={signature}
 * - exp: 有効期限（Unix timestamp）
 * - sig: HMAC-SHA256署名（hex）
 */

// デフォルトTTL: 10分
const DEFAULT_TTL_SECONDS = 600;

/**
 * HMAC-SHA256署名を生成
 */
async function hmacSign(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(message);
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  
  // ArrayBufferをhex文字列に変換
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 署名付きURLを生成
 * 
 * @param r2Key - R2オブジェクトキー（例: images/22/scene_1/56_xxx.png）
 * @param secret - HMAC署名用シークレット
 * @param origin - オリジン（例: https://webapp-c7n.pages.dev）
 * @param ttlSeconds - 有効期限（秒）デフォルト10分
 * @returns 署名付きURL
 */
export async function generateSignedImageUrl(
  r2Key: string,
  secret: string,
  origin: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  
  // 署名対象: r2Key + exp
  const message = `${r2Key}:${exp}`;
  const sig = await hmacSign(message, secret);
  
  // URLエンコードされたr2Keyを使用
  const encodedKey = encodeURIComponent(r2Key);
  
  return `${origin}/images/signed/${encodedKey}?exp=${exp}&sig=${sig}`;
}

/**
 * 署名付きURLを検証
 * 
 * @param r2Key - R2オブジェクトキー
 * @param exp - 有効期限（Unix timestamp）
 * @param sig - 署名
 * @param secret - HMAC署名用シークレット
 * @returns 検証結果: { valid: true } または { valid: false, reason: string }
 */
export async function verifySignedUrl(
  r2Key: string,
  exp: string,
  sig: string,
  secret: string
): Promise<{ valid: true } | { valid: false; reason: string }> {
  // 1. パラメータ存在チェック
  if (!r2Key || !exp || !sig) {
    return { valid: false, reason: 'Missing required parameters' };
  }
  
  // 2. 有効期限チェック
  const expTimestamp = parseInt(exp, 10);
  if (isNaN(expTimestamp)) {
    return { valid: false, reason: 'Invalid expiration format' };
  }
  
  const now = Math.floor(Date.now() / 1000);
  if (now > expTimestamp) {
    return { valid: false, reason: 'URL has expired' };
  }
  
  // 3. 署名検証
  const message = `${r2Key}:${exp}`;
  const expectedSig = await hmacSign(message, secret);
  
  if (sig !== expectedSig) {
    return { valid: false, reason: 'Invalid signature' };
  }
  
  return { valid: true };
}

/**
 * 署名パラメータを解析
 */
export function parseSignedUrlParams(url: URL): {
  r2Key: string | null;
  exp: string | null;
  sig: string | null;
} {
  // パス: /images/signed/{encodedR2Key}
  const pathMatch = url.pathname.match(/^\/images\/signed\/(.+)$/);
  const r2Key = pathMatch ? decodeURIComponent(pathMatch[1]) : null;
  
  return {
    r2Key,
    exp: url.searchParams.get('exp'),
    sig: url.searchParams.get('sig'),
  };
}
