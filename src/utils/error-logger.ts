/**
 * API Error Logger Utility
 * 
 * Centralized error logging to D1 api_error_logs table.
 * Used for debugging and monitoring API failures.
 * 
 * Usage:
 *   await logApiError(db, {
 *     userId: 1,
 *     sceneId: 123,
 *     apiType: 'video_generation',
 *     errorCode: 'USER_KEY_ERROR',
 *     errorMessage: 'API key not found',
 *   });
 */

export interface ApiErrorLogParams {
  // Who/What
  userId?: number | null;
  projectId?: number | null;
  sceneId?: number | null;
  
  // What API
  apiType: string;              // 'video_generation', 'audio_generation', 'image_generation'
  apiEndpoint?: string;         // '/api/scenes/:id/generate-video'
  provider?: string;            // 'google', 'vertex', 'openai'
  videoEngine?: string;         // 'veo2', 'veo3'
  
  // Error details
  errorCode: string;            // 'USER_KEY_ERROR', 'AWS_START_FAILED', etc.
  errorMessage: string;         // Human-readable message
  errorDetails?: Record<string, unknown>;  // Additional context
  
  // HTTP info
  httpStatusCode?: number;      // 400, 401, 403, 500, etc.
  
  // Request context (will be sanitized)
  requestBody?: Record<string, unknown>;
}

/**
 * Sanitize request body by removing sensitive fields
 */
function sanitizeRequestBody(body: Record<string, unknown> | undefined): string | null {
  if (!body) return null;
  
  const sensitiveFields = [
    'api_key', 'apiKey', 'api-key',
    'password', 'secret', 'token',
    'authorization', 'auth',
    'vertex_sa_json', 'vertexSaJson',
    'encrypted_key', 'encryptedKey',
  ];
  
  const sanitized = { ...body };
  
  for (const field of sensitiveFields) {
    if (field in sanitized) {
      sanitized[field] = '[REDACTED]';
    }
  }
  
  // Also check nested objects
  for (const key of Object.keys(sanitized)) {
    if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
      const nested = sanitized[key] as Record<string, unknown>;
      for (const field of sensitiveFields) {
        if (field in nested) {
          nested[field] = '[REDACTED]';
        }
      }
    }
  }
  
  return JSON.stringify(sanitized);
}

/**
 * Log API error to D1 database
 * 
 * Note: This function catches its own errors to prevent
 * error logging from causing additional failures.
 */
export async function logApiError(
  db: D1Database,
  params: ApiErrorLogParams
): Promise<{ success: boolean; errorLogId?: number }> {
  try {
    const result = await db.prepare(`
      INSERT INTO api_error_logs (
        user_id, project_id, scene_id,
        api_type, api_endpoint, provider, video_engine,
        error_code, error_message, error_details_json,
        http_status_code, request_body_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      params.userId ?? null,
      params.projectId ?? null,
      params.sceneId ?? null,
      params.apiType,
      params.apiEndpoint ?? null,
      params.provider ?? null,
      params.videoEngine ?? null,
      params.errorCode,
      params.errorMessage,
      params.errorDetails ? JSON.stringify(params.errorDetails) : null,
      params.httpStatusCode ?? null,
      sanitizeRequestBody(params.requestBody)
    ).run();
    
    const errorLogId = result.meta.last_row_id;
    console.log(`[ErrorLogger] Logged error: ${params.errorCode} (log_id=${errorLogId})`);
    
    return { success: true, errorLogId: errorLogId };
  } catch (error) {
    // Don't let logging failures cascade
    console.error('[ErrorLogger] Failed to log error:', error);
    return { success: false };
  }
}

/**
 * Create a helper for a specific API type
 * Makes logging more convenient with pre-filled fields
 */
export function createApiErrorLogger(
  db: D1Database,
  apiType: string,
  apiEndpoint: string
) {
  return async (params: Omit<ApiErrorLogParams, 'apiType' | 'apiEndpoint'>) => {
    return logApiError(db, {
      ...params,
      apiType,
      apiEndpoint,
    });
  };
}
