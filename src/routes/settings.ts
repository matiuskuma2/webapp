/**
 * Settings Routes
 * 
 * User settings management API
 * - GET /api/settings/api-keys - List user's API keys
 * - PUT /api/settings/api-keys/:provider - Set/update API key
 * - DELETE /api/settings/api-keys/:provider - Delete API key
 */

import { Hono } from 'hono';
import type { Bindings } from '../types/bindings';
import { encryptApiKey, decryptApiKey } from '../utils/crypto';

const settings = new Hono<{ Bindings: Bindings }>();

// ====================================================================
// Types
// ====================================================================

interface ApiKeyRequest {
  api_key: string;
}

// ====================================================================
// Helper: Get user ID from request (placeholder - implement auth later)
// ====================================================================

function getUserId(c: any): number {
  // TODO: Implement proper authentication
  // For now, use user_id=1 for testing
  return 1;
}

// ====================================================================
// GET /api/settings/api-keys - List user's API keys
// ====================================================================

settings.get('/settings/api-keys', async (c) => {
  const userId = getUserId(c);
  const { DB, ENCRYPTION_KEY } = c.env;
  
  try {
    const keys = await DB.prepare(`
      SELECT provider, is_active, created_at, updated_at
      FROM user_api_keys
      WHERE user_id = ?
      ORDER BY provider
    `).bind(userId).all<{
      provider: string;
      is_active: number;
      created_at: string;
      updated_at: string;
    }>();
    
    // Test decryption for each key to check validity
    const keysWithStatus = await Promise.all(
      (keys.results || []).map(async (key) => {
        let decryptionStatus = 'unknown';
        
        if (ENCRYPTION_KEY) {
          try {
            const encrypted = await DB.prepare(`
              SELECT encrypted_key FROM user_api_keys
              WHERE user_id = ? AND provider = ?
            `).bind(userId, key.provider).first<{ encrypted_key: string }>();
            
            if (encrypted?.encrypted_key) {
              await decryptApiKey(encrypted.encrypted_key, ENCRYPTION_KEY);
              decryptionStatus = 'valid';
            }
          } catch {
            decryptionStatus = 'invalid';
          }
        }
        
        return {
          provider: key.provider,
          is_active: key.is_active === 1,
          decryption_status: decryptionStatus,
          created_at: key.created_at,
          updated_at: key.updated_at,
        };
      })
    );
    
    return c.json({
      api_keys: keysWithStatus,
    });
  } catch (error) {
    console.error('Failed to list API keys:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list API keys' } }, 500);
  }
});

// ====================================================================
// PUT /api/settings/api-keys/:provider - Set/update API key
// ====================================================================

settings.put('/settings/api-keys/:provider', async (c) => {
  const userId = getUserId(c);
  const provider = c.req.param('provider');
  const { DB, ENCRYPTION_KEY } = c.env;
  
  // Validate provider
  const validProviders = ['google', 'gemini', 'vertex', 'openai'];
  if (!validProviders.includes(provider)) {
    return c.json({
      error: {
        code: 'INVALID_PROVIDER',
        message: `Invalid provider. Valid providers: ${validProviders.join(', ')}`,
      },
    }, 400);
  }
  
  // Check encryption key
  if (!ENCRYPTION_KEY) {
    return c.json({
      error: {
        code: 'SERVER_CONFIG_ERROR',
        message: 'ENCRYPTION_KEY not configured on server',
      },
    }, 500);
  }
  
  // Parse request
  let body: ApiKeyRequest;
  try {
    body = await c.req.json<ApiKeyRequest>();
  } catch {
    return c.json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Invalid JSON body',
      },
    }, 400);
  }
  
  const { api_key } = body;
  if (!api_key || typeof api_key !== 'string' || api_key.trim().length < 10) {
    return c.json({
      error: {
        code: 'INVALID_API_KEY',
        message: 'API key must be at least 10 characters',
      },
    }, 400);
  }
  
  try {
    // Encrypt the API key
    const encryptedKey = await encryptApiKey(api_key.trim(), ENCRYPTION_KEY);
    
    // Upsert the key
    await DB.prepare(`
      INSERT INTO user_api_keys (user_id, provider, encrypted_key, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
      ON CONFLICT(user_id, provider)
      DO UPDATE SET encrypted_key = ?, is_active = 1, updated_at = datetime('now')
    `).bind(userId, provider, encryptedKey, encryptedKey).run();
    
    // Verify decryption works
    const stored = await DB.prepare(`
      SELECT encrypted_key FROM user_api_keys
      WHERE user_id = ? AND provider = ?
    `).bind(userId, provider).first<{ encrypted_key: string }>();
    
    if (stored?.encrypted_key) {
      const decrypted = await decryptApiKey(stored.encrypted_key, ENCRYPTION_KEY);
      if (decrypted !== api_key.trim()) {
        throw new Error('Decryption verification failed');
      }
    }
    
    return c.json({
      success: true,
      message: `API key for '${provider}' saved successfully`,
      provider,
    });
  } catch (error) {
    console.error('Failed to save API key:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      error: {
        code: 'SAVE_FAILED',
        message: `Failed to save API key: ${message}`,
      },
    }, 500);
  }
});

// ====================================================================
// DELETE /api/settings/api-keys/:provider - Delete API key
// ====================================================================

settings.delete('/settings/api-keys/:provider', async (c) => {
  const userId = getUserId(c);
  const provider = c.req.param('provider');
  const { DB } = c.env;
  
  try {
    const result = await DB.prepare(`
      DELETE FROM user_api_keys
      WHERE user_id = ? AND provider = ?
    `).bind(userId, provider).run();
    
    if (result.meta.changes === 0) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: `API key for '${provider}' not found`,
        },
      }, 404);
    }
    
    return c.json({
      success: true,
      message: `API key for '${provider}' deleted successfully`,
      provider,
    });
  } catch (error) {
    console.error('Failed to delete API key:', error);
    return c.json({
      error: {
        code: 'DELETE_FAILED',
        message: 'Failed to delete API key',
      },
    }, 500);
  }
});

// ====================================================================
// GET /api/settings/api-keys/:provider/test - Test API key
// ====================================================================

settings.get('/settings/api-keys/:provider/test', async (c) => {
  const userId = getUserId(c);
  const provider = c.req.param('provider');
  const { DB, ENCRYPTION_KEY } = c.env;
  
  if (!ENCRYPTION_KEY) {
    return c.json({
      error: {
        code: 'SERVER_CONFIG_ERROR',
        message: 'ENCRYPTION_KEY not configured',
      },
    }, 500);
  }
  
  try {
    const stored = await DB.prepare(`
      SELECT encrypted_key FROM user_api_keys
      WHERE user_id = ? AND provider = ? AND is_active = 1
    `).bind(userId, provider).first<{ encrypted_key: string }>();
    
    if (!stored?.encrypted_key) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: `No API key found for '${provider}'`,
        },
      }, 404);
    }
    
    // Try to decrypt
    const decrypted = await decryptApiKey(stored.encrypted_key, ENCRYPTION_KEY);
    
    // Return masked key for verification
    const masked = decrypted.substring(0, 4) + '...' + decrypted.substring(decrypted.length - 4);
    
    return c.json({
      success: true,
      provider,
      decryption: 'success',
      key_preview: masked,
      key_length: decrypted.length,
    });
  } catch (error) {
    console.error('Failed to test API key:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      error: {
        code: 'DECRYPTION_FAILED',
        message: `Decryption failed: ${message}`,
      },
    }, 500);
  }
});

export default settings;
