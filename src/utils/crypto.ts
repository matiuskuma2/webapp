/**
 * Encryption/Decryption Utilities
 * 
 * AES-256-GCM encryption for API keys
 * Format: iv_hex:ciphertext_hex
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

// Helper functions
function hexToBytes(hex: string): Uint8Array {
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
