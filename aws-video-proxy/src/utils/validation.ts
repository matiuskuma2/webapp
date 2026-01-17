/**
 * Input validation utilities
 * 
 * PR-4: Added Veo3 validation
 * - video_engine determines which credentials are required
 * - veo2: api_key (Gemini API Key)
 * - veo3: vertex_sa_json + vertex_location
 */

import type { StartVideoRequest, VideoEngine } from '../types';

export interface ValidationResult {
  valid: boolean;
  error?: {
    code: string;
    message: string;
  };
}

// =============================================================================
// Common validation helpers
// =============================================================================

const VALID_DURATIONS = [5, 8, 10];

// =============================================================================
// To-Be: image_url 方式（base64廃止）
// =============================================================================

function validateImageUrl(imageUrl: unknown): ValidationResult | null {
  if (!imageUrl || typeof imageUrl !== 'string') {
    return {
      valid: false,
      error: { code: 'INVALID_REQUEST', message: 'image_url is required' },
    };
  }
  // URLの基本検証
  if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
    return {
      valid: false,
      error: { code: 'INVALID_REQUEST', message: 'image_url must be a valid HTTP/HTTPS URL' },
    };
  }
  // URL長さ制限（2048文字）
  if (imageUrl.length > 2048) {
    return {
      valid: false,
      error: { code: 'INVALID_REQUEST', message: 'image_url is too long (max 2048 characters)' },
    };
  }
  return null;
}

// @deprecated - base64は廃止。後方互換のため残すが、サイズ制限は緩和
function validateImageBase64(imageBase64: unknown): ValidationResult | null {
  // image_urlが必須になったので、base64はオプショナル
  if (imageBase64 !== undefined && typeof imageBase64 !== 'string') {
    return {
      valid: false,
      error: { code: 'INVALID_REQUEST', message: 'image_base64 must be a string if provided' },
    };
  }
  // サイズ制限は削除（image_url方式では不要）
  return null;
}

/**
 * Validate Veo2 API key (Gemini)
 * Required for video_engine === 'veo2'
 */
function validateApiKey(apiKey: unknown): ValidationResult | null {
  if (!apiKey || typeof apiKey !== 'string') {
    return {
      valid: false,
      error: { code: 'INVALID_REQUEST', message: 'api_key is required for Veo2' },
    };
  }
  if (apiKey.length < 10) {
    return {
      valid: false,
      error: { code: 'INVALID_API_KEY', message: 'API key appears to be invalid' },
    };
  }
  return null;
}

/**
 * Validate Veo3 Vertex AI credentials
 * Required for video_engine === 'veo3'
 */
function validateVeo3Credentials(
  vertexSaJson: unknown,
  vertexLocation: unknown
): ValidationResult | null {
  // vertex_sa_json is required
  if (!vertexSaJson || typeof vertexSaJson !== 'string') {
    return {
      valid: false,
      error: { code: 'INVALID_REQUEST', message: 'vertex_sa_json is required for Veo3' },
    };
  }
  
  // Basic JSON validation (don't parse fully for security)
  if (!vertexSaJson.includes('"type"') || !vertexSaJson.includes('service_account')) {
    return {
      valid: false,
      error: { code: 'INVALID_REQUEST', message: 'vertex_sa_json must be a valid service account JSON' },
    };
  }
  
  // vertex_location is required
  if (!vertexLocation || typeof vertexLocation !== 'string') {
    return {
      valid: false,
      error: { code: 'INVALID_REQUEST', message: 'vertex_location is required for Veo3' },
    };
  }
  
  // Basic location validation (e.g., us-central1, us-east1)
  if (!/^[a-z]+-[a-z]+\d+$/.test(vertexLocation)) {
    return {
      valid: false,
      error: { code: 'INVALID_REQUEST', message: 'vertex_location format is invalid (e.g., us-central1)' },
    };
  }
  
  return null;
}

function validateDuration(duration: unknown): ValidationResult | null {
  if (duration !== undefined) {
    if (typeof duration !== 'number' || !VALID_DURATIONS.includes(duration)) {
      return {
        valid: false,
        error: { code: 'INVALID_REQUEST', message: 'duration_sec must be 5, 8, or 10' },
      };
    }
  }
  return null;
}

function validatePrompt(prompt: unknown): ValidationResult | null {
  if (prompt !== undefined && typeof prompt !== 'string') {
    return {
      valid: false,
      error: { code: 'INVALID_REQUEST', message: 'prompt must be a string' },
    };
  }
  return null;
}

// =============================================================================
// Start Request Validation (To-Be)
// =============================================================================

/**
 * Validate start video request
 * 
 * To-Be: image_url が必須、image_base64 は deprecated
 */
export function validateStartRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object') {
    return {
      valid: false,
      error: { code: 'INVALID_REQUEST', message: 'Request body is required' },
    };
  }

  const req = body as Partial<StartVideoRequest>;

  // Validate required fields
  // To-Be: image_url が必須
  let result = validateImageUrl(req.image_url);
  if (result) return result;

  // @deprecated: base64 はオプショナル（後方互換）
  result = validateImageBase64(req.image_base64);
  if (result) return result;

  // PR-4: Determine video engine and validate accordingly
  const videoEngine = req.video_engine || (req.model?.includes('veo-3') ? 'veo3' : 'veo2');
  
  if (videoEngine === 'veo2') {
    // Veo2: Require api_key
    result = validateApiKey(req.api_key);
    if (result) return result;
  } else if (videoEngine === 'veo3') {
    // Veo3: Require vertex_sa_json and vertex_location
    result = validateVeo3Credentials(req.vertex_sa_json, req.vertex_location);
    if (result) return result;
  } else {
    return {
      valid: false,
      error: { code: 'INVALID_REQUEST', message: "video_engine must be 'veo2' or 'veo3'" },
    };
  }

  // Validate optional fields
  result = validateDuration(req.duration_sec);
  if (result) return result;

  result = validatePrompt(req.prompt);
  if (result) return result;

  // Validate optional context fields (if present)
  if (req.project_id !== undefined && typeof req.project_id !== 'number') {
    return {
      valid: false,
      error: { code: 'INVALID_REQUEST', message: 'project_id must be a number' },
    };
  }

  if (req.scene_id !== undefined && typeof req.scene_id !== 'number') {
    return {
      valid: false,
      error: { code: 'INVALID_REQUEST', message: 'scene_id must be a number' },
    };
  }

  if (req.billing_source !== undefined && !['user', 'sponsor'].includes(req.billing_source)) {
    return {
      valid: false,
      error: { code: 'INVALID_REQUEST', message: "billing_source must be 'user' or 'sponsor'" },
    };
  }

  return { valid: true };
}
