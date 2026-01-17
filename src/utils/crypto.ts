/**
 * Encryption/Decryption Utilities
 * 
 * AES-256-GCM encryption for API keys
 * Format: iv_hex:ciphertext_hex
 * 
 * Key-Ring対応:
 * - 複数の鍵を順番に試して復号
 * - 旧鍵で復号成功した場合、新鍵で再暗号化してDB更新（CAS付き）
 * - 鍵は必ず hex 64文字（32 bytes = 256 bit）で統一
 */

/**
 * Decrypt an encrypted API key
 * @param encryptedKey - Format: iv_hex:ciphertext_hex
 * @param encryptionKey - Hex string (32 bytes = 64 hex chars for AES-256)
 * @returns Decrypted plaintext
 */
export async function decryptApiKey(
  encryptedKey: string,
  encryptionKey: string
): Promise<string> {
  // Parse iv:ciphertext format
  const parts = encryptedKey.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted key format');
  }
  
  const [ivHex, ciphertextHex] = parts;
  
  // Convert hex to Uint8Array
  const iv = hexToBytes(ivHex);
  const ciphertext = hexToBytes(ciphertextHex);
  const keyBytes = hexToBytes(encryptionKey);
  
  // Import the key
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  
  // Decrypt
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertext
  );
  
  // Convert to string
  return new TextDecoder().decode(decrypted);
}

/**
 * Encrypt a plaintext API key
 * @param plaintext - The API key to encrypt
 * @param encryptionKey - Hex string (32 bytes = 64 hex chars for AES-256)
 * @returns Encrypted string in format iv_hex:ciphertext_hex
 */
export async function encryptApiKey(
  plaintext: string,
  encryptionKey: string
): Promise<string> {
  // Generate random IV (12 bytes for AES-GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyBytes = hexToBytes(encryptionKey);
  
  // Import the key
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  
  // Encrypt
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    encoded
  );
  
  // Return iv:ciphertext format
  return `${bytesToHex(iv)}:${bytesToHex(new Uint8Array(ciphertext))}`;
}

// ====================================================================
// Key-Ring: 複数鍵での復号対応
// ====================================================================

/**
 * 鍵フォーマット検証
 * @param key - 検証する鍵
 * @param name - エラーメッセージ用の鍵名
 * @throws 不正な形式の場合
 */
export function validateKeyHex(key: string, name: string = 'key'): void {
  if (!/^[0-9a-fA-F]+$/.test(key)) {
    throw new Error(`${name} must be hex string`);
  }
  // 64 hex = 32 bytes (AES-256) を推奨
  // 32 hex = 16 bytes (AES-128), 48 hex = 24 bytes (AES-192) も技術的には可
  if (![32, 48, 64].includes(key.length)) {
    throw new Error(`${name} must be 32/48/64 hex chars (got ${key.length})`);
  }
}

/**
 * Key-Ring復号: 複数の鍵を順番に試して復号
 * 
 * @param encrypted - 暗号化された文字列 (iv_hex:ciphertext_hex)
 * @param keys - 鍵の配列 [現行鍵, 旧鍵1, 旧鍵2, ...] すべて hex
 * @returns { decrypted: 復号結果, keyIndex: 復号に成功した鍵のindex }
 *          keyIndex > 0 なら旧鍵で復号した → 再暗号化が必要
 * @throws すべての鍵で復号に失敗した場合
 */
export async function decryptWithKeyRing(
  encrypted: string,
  keys: string[]
): Promise<{ decrypted: string; keyIndex: number }> {
  const errors: string[] = [];

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!key) continue;

    try {
      // 鍵フォーマット検証
      validateKeyHex(key, `keys[${i}]`);
      
      const decrypted = await decryptApiKey(encrypted, key);
      return { decrypted, keyIndex: i };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`key[${i}]: ${msg}`);
    }
  }

  throw new Error(`Decryption failed with all ${keys.length} key(s): ${errors.join('; ')}`);
}

/**
 * 旧鍵で復号できた時に現行鍵で再暗号化
 * 
 * @param decrypted - 復号済みの平文
 * @param newKeyHex - 新しい鍵 (hex 64文字)
 * @returns 再暗号化された文字列
 */
export async function reEncryptApiKey(
  decrypted: string,
  newKeyHex: string
): Promise<string> {
  validateKeyHex(newKeyHex, 'newKey');
  return encryptApiKey(decrypted, newKeyHex);
}

/**
 * Key-Ring結果の型
 */
export interface KeyRingDecryptResult {
  decrypted: string;
  keyIndex: number;
  needsMigration: boolean;  // keyIndex > 0 なら true
}

/**
 * Key-Ring復号（拡張版）
 * needsMigration フラグ付きで返す
 */
export async function decryptWithKeyRingEx(
  encrypted: string,
  keys: string[]
): Promise<KeyRingDecryptResult> {
  const result = await decryptWithKeyRing(encrypted, keys);
  return {
    ...result,
    needsMigration: result.keyIndex > 0
  };
}

// ====================================================================
// Helper functions
// ====================================================================

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
