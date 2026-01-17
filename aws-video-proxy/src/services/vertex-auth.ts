/**
 * Vertex AI Authentication
 * 
 * Converts Service Account JSON to OAuth2 access token for Vertex AI API calls.
 * 
 * SECURITY:
 * - SA JSON is NEVER logged
 * - Access token has 1-hour expiry
 * - No caching (each request gets fresh token)
 */

import crypto from 'crypto';
import { logger } from '../utils/logger';

// =============================================================================
// Types
// =============================================================================

interface ServiceAccount {
  type: 'service_account';
  project_id: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
  client_id?: string;
  auth_uri?: string;
  token_uri?: string;
  auth_provider_x509_cert_url?: string;
  client_x509_cert_url?: string;
}

export interface VertexAuthResult {
  accessToken: string;
  projectId: string;
  clientEmail: string;
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Get Vertex AI access token from Service Account JSON
 * 
 * @param saJson - Service Account JSON string (plaintext)
 * @returns Access token and project info
 * @throws Error if SA JSON is invalid or token exchange fails
 */
export async function getVertexAccessToken(saJson: string): Promise<VertexAuthResult> {
  // Parse and validate SA JSON
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(saJson);
  } catch (e) {
    throw new Error('Invalid Service Account JSON: parse failed');
  }

  if (sa.type !== 'service_account') {
    throw new Error('Invalid Service Account JSON: type must be "service_account"');
  }
  if (!sa.private_key || !sa.client_email || !sa.project_id) {
    throw new Error('Invalid Service Account JSON: missing required fields');
  }

  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';

  // Create JWT
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600; // 1 hour expiry

  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: tokenUri,
    iat: now,
    exp,
  };

  // Base64url encode
  const encode = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');

  const unsignedJwt = `${encode(header)}.${encode(claimSet)}`;

  // Sign JWT with private key
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedJwt);
  signer.end();
  
  let signature: string;
  try {
    signature = signer.sign(sa.private_key).toString('base64url');
  } catch (e) {
    throw new Error('Invalid Service Account JSON: private key signing failed');
  }

  const jwt = `${unsignedJwt}.${signature}`;

  // Exchange JWT for access token
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });

  logger.info('Exchanging JWT for access token', {
    clientEmail: sa.client_email,
    projectId: sa.project_id,
    // NEVER log the private key or JWT
  });

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error('OAuth token exchange failed', {
      status: res.status,
      // Don't log the full error which might contain sensitive info
      errorPreview: text.substring(0, 200),
    });
    throw new Error(`OAuth token error: HTTP ${res.status}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in?: number };

  if (!json.access_token) {
    throw new Error('OAuth response missing access_token');
  }

  logger.info('Access token obtained successfully', {
    projectId: sa.project_id,
    expiresIn: json.expires_in,
  });

  return {
    accessToken: json.access_token,
    projectId: sa.project_id,
    clientEmail: sa.client_email,
  };
}

/**
 * Validate Service Account JSON without exchanging for token
 * Useful for quick validation before storing
 */
export function validateServiceAccountJson(saJson: string): {
  valid: boolean;
  projectId?: string;
  clientEmail?: string;
  error?: string;
} {
  try {
    const sa = JSON.parse(saJson) as ServiceAccount;
    
    if (sa.type !== 'service_account') {
      return { valid: false, error: 'type must be "service_account"' };
    }
    if (!sa.private_key) {
      return { valid: false, error: 'missing private_key' };
    }
    if (!sa.client_email) {
      return { valid: false, error: 'missing client_email' };
    }
    if (!sa.project_id) {
      return { valid: false, error: 'missing project_id' };
    }
    
    return {
      valid: true,
      projectId: sa.project_id,
      clientEmail: sa.client_email,
    };
  } catch (e) {
    return { valid: false, error: 'invalid JSON' };
  }
}
