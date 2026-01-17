/**
 * Settings Routes
 * 
 * User settings management API
 * Routes are available at BOTH paths for backward compatibility:
 * - /api/user/api-keys (legacy, used by frontend)
 * - /api/settings/api-keys (new)
 * 
 * Endpoints:
 * - GET /api/user/api-keys - List user's API keys
 * - PUT /api/user/api-keys/:provider - Set/update API key
 * - DELETE /api/user/api-keys/:provider - Delete API key
 */

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
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

async function getUserId(c: any): Promise<number | null> {
  const { DB } = c.env;
  const sessionId = getCookie(c, 'session');
  
  if (!sessionId) {
    return null;
  }
  
  try {
    const session = await DB.prepare(`
      SELECT user_id FROM sessions
      WHERE id = ? AND expires_at > datetime('now')
    `).bind(sessionId).first<{ user_id: number }>();
    
    return session?.user_id || null;
  } catch {
    return null;
  }
}

// ====================================================================
// GET /api/settings/api-keys - List user's API keys
// ====================================================================

// ====================================================================
// Legacy route: /api/user/api-keys (for backward compatibility)
// ====================================================================

settings.get('/user/api-keys', async (c) => {
  const userId = await getUserId(c);
  if (!userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
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
    
    return c.json({ api_keys: keysWithStatus });
  } catch (error) {
    console.error('Failed to list API keys:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list API keys' } }, 500);
  }
});

settings.put('/user/api-keys/:provider', async (c) => {
  const userId = await getUserId(c);
  if (!userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
  const provider = c.req.param('provider');
  const { DB, ENCRYPTION_KEY } = c.env;
  
  const validProviders = ['google', 'gemini', 'vertex', 'openai'];
  if (!validProviders.includes(provider)) {
    return c.json({ error: { code: 'INVALID_PROVIDER', message: `Invalid provider. Valid: ${validProviders.join(', ')}` } }, 400);
  }
  
  if (!ENCRYPTION_KEY) {
    return c.json({ error: { code: 'SERVER_CONFIG_ERROR', message: 'ENCRYPTION_KEY not configured' } }, 500);
  }
  
  let body: ApiKeyRequest;
  try {
    body = await c.req.json<ApiKeyRequest>();
  } catch {
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body' } }, 400);
  }
  
  const { api_key } = body;
  if (!api_key || typeof api_key !== 'string' || api_key.trim().length < 10) {
    return c.json({ error: { code: 'INVALID_API_KEY', message: 'API key must be at least 10 characters' } }, 400);
  }
  
  try {
    const encryptedKey = await encryptApiKey(api_key.trim(), ENCRYPTION_KEY);
    
    await DB.prepare(`
      INSERT INTO user_api_keys (user_id, provider, encrypted_key, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
      ON CONFLICT(user_id, provider)
      DO UPDATE SET encrypted_key = ?, is_active = 1, updated_at = datetime('now')
    `).bind(userId, provider, encryptedKey, encryptedKey).run();
    
    return c.json({ success: true, message: `API key for '${provider}' saved successfully`, provider });
  } catch (error) {
    console.error('Failed to save API key:', error);
    return c.json({ error: { code: 'SAVE_FAILED', message: 'Failed to save API key' } }, 500);
  }
});

settings.delete('/user/api-keys/:provider', async (c) => {
  const userId = await getUserId(c);
  if (!userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
  const provider = c.req.param('provider');
  const { DB } = c.env;
  
  try {
    const result = await DB.prepare(`
      DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?
    `).bind(userId, provider).run();
    
    if (result.meta.changes === 0) {
      return c.json({ error: { code: 'NOT_FOUND', message: `API key for '${provider}' not found` } }, 404);
    }
    
    return c.json({ success: true, message: `API key for '${provider}' deleted successfully`, provider });
  } catch (error) {
    console.error('Failed to delete API key:', error);
    return c.json({ error: { code: 'DELETE_FAILED', message: 'Failed to delete API key' } }, 500);
  }
});

// ====================================================================
// Original routes: /api/settings/api-keys
// ====================================================================

settings.get('/settings/api-keys', async (c) => {
  const userId = await getUserId(c);
  if (!userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
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
  const userId = await getUserId(c);
  if (!userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
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
  const userId = await getUserId(c);
  if (!userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
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
  const userId = await getUserId(c);
  if (!userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
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

// ====================================================================
// User Characters Library (マイキャラ)
// ====================================================================

/**
 * GET /user/characters
 * List all characters in user's library
 */
settings.get('/user/characters', async (c) => {
  const userId = await getUserId(c);
  if (!userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
  
  const { DB } = c.env;
  
  try {
    const characters = await DB.prepare(`
      SELECT * FROM user_characters
      WHERE user_id = ?
      ORDER BY is_favorite DESC, character_name ASC
    `).bind(userId).all();
    
    return c.json({ characters: characters.results || [] });
  } catch (error) {
    console.error('[Settings] Get user characters error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get characters' } }, 500);
  }
});

/**
 * POST /user/characters
 * Create a new character in user's library
 */
settings.post('/user/characters', async (c) => {
  const userId = await getUserId(c);
  if (!userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
  
  const { DB } = c.env;
  const body = await c.req.json();
  const {
    character_key,
    character_name,
    description,
    appearance_description,
    reference_image_r2_key,
    reference_image_r2_url,
    voice_preset_id,
    aliases
  } = body;
  
  if (!character_key || !character_name) {
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'character_key and character_name are required' } }, 400);
  }
  
  try {
    // Check duplicate
    const existing = await DB.prepare(`
      SELECT id FROM user_characters WHERE user_id = ? AND character_key = ?
    `).bind(userId, character_key).first();
    
    if (existing) {
      return c.json({ error: { code: 'DUPLICATE', message: 'Character key already exists' } }, 400);
    }
    
    // Serialize aliases
    let aliasesJson = null;
    if (aliases && Array.isArray(aliases)) {
      const validAliases = aliases
        .filter(a => typeof a === 'string')
        .map(a => a.trim())
        .filter(a => a.length > 0);
      aliasesJson = validAliases.length > 0 ? JSON.stringify(validAliases) : null;
    }
    
    const result = await DB.prepare(`
      INSERT INTO user_characters
        (user_id, character_key, character_name, description, appearance_description,
         reference_image_r2_key, reference_image_r2_url, voice_preset_id, aliases_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId,
      character_key,
      character_name,
      description || null,
      appearance_description || null,
      reference_image_r2_key || null,
      reference_image_r2_url || null,
      voice_preset_id || null,
      aliasesJson
    ).run();
    
    const character = await DB.prepare(`
      SELECT * FROM user_characters WHERE id = ?
    `).bind(result.meta.last_row_id).first();
    
    return c.json({ character }, 201);
  } catch (error) {
    console.error('[Settings] Create user character error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create character' } }, 500);
  }
});

/**
 * POST /user/characters/from-project
 * Copy a character from a project to user's library (マイキャラに追加)
 * Used by: character-library.js, world-character-ui.js
 */
settings.post('/user/characters/from-project', async (c) => {
  const userId = await getUserId(c);
  if (!userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
  
  const { DB } = c.env;
  const body = await c.req.json();
  const { project_id, character_key } = body;
  
  if (!project_id || !character_key) {
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'project_id and character_key are required' } }, 400);
  }
  
  try {
    // Get character from project
    const projectChar = await DB.prepare(`
      SELECT * FROM project_character_models WHERE project_id = ? AND character_key = ?
    `).bind(project_id, character_key).first();
    
    if (!projectChar) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Character not found in project' } }, 404);
    }
    
    // Upsert to user's library
    await DB.prepare(`
      INSERT INTO user_characters
        (user_id, character_key, character_name, description, appearance_description,
         reference_image_r2_key, reference_image_r2_url, voice_preset_id, aliases_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, character_key) DO UPDATE SET
        character_name = excluded.character_name,
        description = excluded.description,
        appearance_description = excluded.appearance_description,
        reference_image_r2_key = excluded.reference_image_r2_key,
        reference_image_r2_url = excluded.reference_image_r2_url,
        voice_preset_id = excluded.voice_preset_id,
        aliases_json = excluded.aliases_json,
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      userId,
      projectChar.character_key,
      projectChar.character_name,
      projectChar.description,
      projectChar.appearance_description,
      projectChar.reference_image_r2_key,
      projectChar.reference_image_r2_url,
      projectChar.voice_preset_id,
      projectChar.aliases_json
    ).run();
    
    // Get the saved character
    const savedChar = await DB.prepare(`
      SELECT * FROM user_characters WHERE user_id = ? AND character_key = ?
    `).bind(userId, projectChar.character_key).first();
    
    return c.json({ 
      success: true, 
      message: 'Character saved to library',
      character: savedChar
    });
  } catch (error) {
    console.error('[Settings] Save character to library error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to save character' } }, 500);
  }
});

/**
 * PUT /user/characters/:characterKey
 * Update a character in user's library
 */
settings.put('/user/characters/:characterKey', async (c) => {
  const userId = await getUserId(c);
  if (!userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
  
  const { DB } = c.env;
  const characterKey = c.req.param('characterKey');
  const body = await c.req.json();
  const {
    character_name,
    description,
    appearance_description,
    reference_image_r2_key,
    reference_image_r2_url,
    voice_preset_id,
    aliases,
    is_favorite
  } = body;
  
  try {
    // Check exists
    const existing = await DB.prepare(`
      SELECT id FROM user_characters WHERE user_id = ? AND character_key = ?
    `).bind(userId, characterKey).first();
    
    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Character not found' } }, 404);
    }
    
    // Serialize aliases
    let aliasesJson = null;
    if (aliases && Array.isArray(aliases)) {
      const validAliases = aliases
        .filter(a => typeof a === 'string')
        .map(a => a.trim())
        .filter(a => a.length > 0);
      aliasesJson = validAliases.length > 0 ? JSON.stringify(validAliases) : null;
    }
    
    await DB.prepare(`
      UPDATE user_characters
      SET character_name = ?, description = ?, appearance_description = ?,
          reference_image_r2_key = ?, reference_image_r2_url = ?,
          voice_preset_id = ?, aliases_json = ?, is_favorite = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND character_key = ?
    `).bind(
      character_name,
      description || null,
      appearance_description || null,
      reference_image_r2_key || null,
      reference_image_r2_url || null,
      voice_preset_id || null,
      aliasesJson,
      is_favorite ? 1 : 0,
      userId,
      characterKey
    ).run();
    
    const character = await DB.prepare(`
      SELECT * FROM user_characters WHERE user_id = ? AND character_key = ?
    `).bind(userId, characterKey).first();
    
    return c.json({ character });
  } catch (error) {
    console.error('[Settings] Update user character error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update character' } }, 500);
  }
});

/**
 * DELETE /user/characters/:characterKey
 * Delete a character from user's library
 */
settings.delete('/user/characters/:characterKey', async (c) => {
  const userId = await getUserId(c);
  if (!userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
  
  const { DB } = c.env;
  const characterKey = c.req.param('characterKey');
  
  try {
    await DB.prepare(`
      DELETE FROM user_characters WHERE user_id = ? AND character_key = ?
    `).bind(userId, characterKey).run();
    
    return c.json({ success: true });
  } catch (error) {
    console.error('[Settings] Delete user character error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete character' } }, 500);
  }
});

export default settings;
