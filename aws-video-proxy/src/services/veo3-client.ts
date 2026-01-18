/**
 * Vertex AI Veo3 Client
 * 
 * Calls Vertex AI Video Generation API (Veo3) using predictLongRunning pattern.
 * 
 * Supports TWO authentication methods:
 * 1. API Key (recommended): Simple key from Vertex AI Studio > Settings > API Keys
 * 2. Service Account JSON (legacy): OAuth-based authentication
 * 
 * Flow:
 * 1. Start generation with predictLongRunning → returns operation name
 * 2. Poll operations.get until done
 * 3. Extract video from response (bytesBase64 or GCS URI)
 * 
 * References:
 * - https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/imagen-api
 * - https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/video-generation
 */

import { getVertexAccessToken } from './vertex-auth';
import { logger } from '../utils/logger';
import type { Veo3GenerateInput, Veo3GenerationResult } from '../types';

// =============================================================================
// Auth Type Detection
// =============================================================================

/**
 * Detect if the provided credential is an API key or Service Account JSON
 */
function isApiKey(credential: string): boolean {
  // API keys are typically alphanumeric strings starting with specific prefixes
  // Service Account JSON always starts with '{'
  return !credential.trim().startsWith('{');
}

// =============================================================================
// Constants
// =============================================================================

/** Default polling interval in milliseconds */
const POLL_INTERVAL_MS = 5000;

/** Default timeout for operation completion (10 minutes) */
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

// =============================================================================
// Helpers
// =============================================================================

function getVertexEndpoint(location: string): string {
  return `https://${location}-aiplatform.googleapis.com`;
}

// =============================================================================
// Main Functions
// =============================================================================

/**
 * Start Veo3 video generation (long-running operation)
 * 
 * Supports both API key and Service Account JSON authentication.
 * 
 * @returns Operation name for polling
 */
export async function startVeo3Generation(input: Veo3GenerateInput): Promise<{
  operationName: string;
  projectId: string;
  authMethod: 'api_key' | 'service_account';
}> {
  const useApiKey = isApiKey(input.serviceAccountJson);
  let authHeader: Record<string, string>;
  let projectId: string;
  let authMethod: 'api_key' | 'service_account';

  if (useApiKey) {
    // API Key authentication - simpler, recommended
    authMethod = 'api_key';
    projectId = input.projectId || '';
    
    if (!projectId) {
      throw new Error('Project ID is required when using API key authentication');
    }
    
    // API key is passed as query parameter, not header
    authHeader = {
      'Content-Type': 'application/json',
    };
    
    logger.info('Using API key authentication for Veo3', {
      projectId,
      location: input.location,
    });
  } else {
    // Service Account JSON authentication - legacy
    authMethod = 'service_account';
    const { accessToken, projectId: saProjectId } = await getVertexAccessToken(input.serviceAccountJson);
    projectId = input.projectId || saProjectId;
    
    authHeader = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    
    logger.info('Using Service Account authentication for Veo3', {
      projectId,
      location: input.location,
    });
  }

  const endpoint = getVertexEndpoint(input.location);

  // Vertex AI predictLongRunning endpoint for video generation
  let url = `${endpoint}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(input.location)}/publishers/google/models/${encodeURIComponent(input.model)}:predictLongRunning`;
  
  // Add API key as query parameter if using API key auth
  if (useApiKey) {
    url += `?key=${encodeURIComponent(input.serviceAccountJson)}`;
  }

  logger.info('Starting Veo3 generation', {
    projectId,
    location: input.location,
    model: input.model,
    promptPreview: input.prompt.substring(0, 50),
    durationSec: input.durationSec,
    imageMimeType: input.imageMimeType,
    authMethod,
  });

  // Build request body following Vertex AI video generation schema
  const requestBody = {
    instances: [
      {
        prompt: input.prompt,
        image: {
          bytesBase64Encoded: input.imageBase64,
          mimeType: input.imageMimeType,
        },
      },
    ],
    parameters: {
      aspectRatio: '16:9',
      // Note: Veo3 duration is typically fixed at 8 seconds
      // Include it for future flexibility
      ...(input.durationSec && { durationSeconds: input.durationSec }),
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeader,
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error('Veo3 predictLongRunning failed', {
      status: res.status,
      errorPreview: text.substring(0, 500),
    });
    throw new Error(`Vertex AI error: HTTP ${res.status} - ${text.substring(0, 200)}`);
  }

  const json = await res.json() as { name?: string };

  if (!json.name) {
    logger.error('Veo3 response missing operation name', { response: json });
    throw new Error('Vertex AI response missing operation name');
  }

  logger.info('Veo3 operation started', {
    operationName: json.name,
    projectId,
  });

  return {
    operationName: json.name,
    projectId,
    authMethod,
  };
}

/**
 * Poll Veo3 operation until completion using fetchPredictOperation
 * 
 * Supports both API key and Service Account JSON authentication.
 * 
 * IMPORTANT: Uses `fetchPredictOperation` endpoint (POST with operationName in body)
 * NOT the generic operations.get endpoint which returns 404 for Veo operations.
 * 
 * @param credential - API key or SA JSON for auth (needed for each poll)
 * @param location - GCP region
 * @param operationName - Full operation name from startVeo3Generation
 * @param projectId - GCP project ID (required for fetchPredictOperation endpoint)
 * @param model - Model ID used for generation
 * @param timeoutMs - Maximum time to wait (default: 10 minutes)
 * @param intervalMs - Polling interval (default: 5 seconds)
 */
export async function pollVeo3Operation(
  credential: string,
  location: string,
  operationName: string,
  projectId: string,
  model: string,
  timeoutMs: number = POLL_TIMEOUT_MS,
  intervalMs: number = POLL_INTERVAL_MS
): Promise<Veo3GenerationResult> {
  const useApiKey = isApiKey(credential);
  const endpoint = getVertexEndpoint(location);

  // Use fetchPredictOperation endpoint (NOT operations.get which returns 404)
  // Format: POST {endpoint}/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:fetchPredictOperation
  let baseUrl = `${endpoint}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:fetchPredictOperation`;
  
  // Add API key as query parameter if using API key auth
  if (useApiKey) {
    baseUrl += `?key=${encodeURIComponent(credential)}`;
  }

  const startTime = Date.now();
  let pollCount = 0;

  logger.info('Starting Veo3 operation polling with fetchPredictOperation', {
    operationName,
    projectId,
    model,
    timeoutMs,
    intervalMs,
    authMethod: useApiKey ? 'api_key' : 'service_account',
  });

  while (Date.now() - startTime < timeoutMs) {
    pollCount++;

    // Build request headers
    let headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (!useApiKey) {
      // Refresh token for long-running operations
      const { accessToken } = await getVertexAccessToken(credential);
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    // fetchPredictOperation uses POST with operationName in body
    const requestBody = {
      operationName: operationName,
    };

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error('Veo3 fetchPredictOperation failed', {
        status: res.status,
        pollCount,
        url: baseUrl.replace(/key=[^&]+/, 'key=***'),  // Hide API key in logs
        errorPreview: text.substring(0, 200),
      });
      
      // Don't throw immediately - might be transient error
      if (res.status >= 500) {
        await new Promise(r => setTimeout(r, intervalMs));
        continue;
      }
      
      throw new Error(`Vertex AI operation status error: HTTP ${res.status}`);
    }

    const op = await res.json() as any;

    if (op.done) {
      logger.info('Veo3 operation completed', {
        operationName,
        pollCount,
        elapsedMs: Date.now() - startTime,
        hasError: !!op.error,
      });

      // Check for error
      if (op.error) {
        return {
          success: false,
          error: {
            code: op.error.code?.toString() || 'VERTEX_ERROR',
            message: op.error.message || 'Vertex AI operation failed',
          },
        };
      }

      // Extract video from response
      // The response structure varies by model version
      const response = op.response;
      
      // Try different possible response structures
      let videoBytes: Uint8Array | undefined;
      let gcsUri: string | undefined;
      let mimeType: string = 'video/mp4';

      // Check for direct bytes (less common for video)
      // Veo3 API returns `videos` array (not `generatedVideos`)
      const bytesBase64 = 
        response?.videos?.[0]?.video?.bytesBase64Encoded ||
        response?.videos?.[0]?.bytesBase64Encoded ||
        response?.generatedVideos?.[0]?.video?.bytesBase64Encoded ||
        response?.predictions?.[0]?.bytesBase64Encoded ||
        response?.bytesBase64Encoded;

      if (bytesBase64) {
        videoBytes = Uint8Array.from(Buffer.from(bytesBase64, 'base64'));
        logger.info('Veo3: Video bytes extracted from response', {
          size: videoBytes.length,
        });
      }

      // Check for GCS URI (more common for video)
      // Veo3 API returns `videos` array with nested structure
      gcsUri = 
        response?.videos?.[0]?.video?.gcsUri ||
        response?.videos?.[0]?.gcsUri ||
        response?.generatedVideos?.[0]?.video?.gcsUri ||
        response?.generatedVideos?.[0]?.gcsUri ||
        response?.predictions?.[0]?.gcsUri ||
        response?.gcsUri ||
        response?.outputUri;

      if (gcsUri) {
        logger.info('Veo3: GCS URI found in response', {
          gcsUri: gcsUri.substring(0, 100),
        });
      }

      // Get mime type if available
      mimeType = 
        response?.videos?.[0]?.video?.mimeType ||
        response?.videos?.[0]?.mimeType ||
        response?.generatedVideos?.[0]?.video?.mimeType ||
        response?.mimeType ||
        'video/mp4';

      if (!videoBytes && !gcsUri) {
        // Log more detail to diagnose response structure
        logger.error('Veo3: No video data in response', {
          responseKeys: Object.keys(response || {}),
          videosLength: response?.videos?.length,
          firstVideo: response?.videos?.[0] ? Object.keys(response.videos[0]) : null,
          raiFilteredCount: response?.raiMediaFilteredCount,
        });
        return {
          success: false,
          error: {
            code: 'NO_VIDEO_DATA',
            message: 'Vertex AI response contains no video data',
          },
        };
      }

      return {
        success: true,
        videoBytes,
        gcsUri,
        mimeType,
      };
    }

    // Not done yet - log progress and wait
    if (pollCount % 6 === 0) { // Log every 30 seconds
      logger.info('Veo3 operation still processing', {
        operationName,
        pollCount,
        elapsedMs: Date.now() - startTime,
        metadata: op.metadata,
      });
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  // Timeout
  logger.error('Veo3 operation timeout', {
    operationName,
    pollCount,
    elapsedMs: Date.now() - startTime,
  });

  return {
    success: false,
    error: {
      code: 'TIMEOUT',
      message: `Vertex AI operation timed out after ${timeoutMs / 1000} seconds`,
    },
  };
}

/**
 * Generate video with Veo3 (full flow)
 * 
 * Combines startVeo3Generation and pollVeo3Operation into single call.
 */
export async function generateVeo3Video(input: Veo3GenerateInput): Promise<Veo3GenerationResult> {
  try {
    // Start generation
    const { operationName, projectId } = await startVeo3Generation(input);

    // Poll until completion using fetchPredictOperation
    const result = await pollVeo3Operation(
      input.serviceAccountJson,
      input.location,
      operationName,
      projectId,
      input.model
    );

    return result;
  } catch (error: any) {
    logger.error('Veo3 generation failed', {
      error: error.message,
      stack: error.stack?.substring(0, 300),
    });

    return {
      success: false,
      error: {
        code: 'VEO3_ERROR',
        message: error.message || 'Veo3 generation failed',
      },
    };
  }
}
