/**
 * Vertex AI Veo3 Client
 * 
 * Calls Vertex AI Video Generation API (Veo3) using predictLongRunning pattern.
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
 * @returns Operation name for polling
 */
export async function startVeo3Generation(input: Veo3GenerateInput): Promise<{
  operationName: string;
  projectId: string;
}> {
  const { accessToken, projectId: saProjectId } = await getVertexAccessToken(input.serviceAccountJson);
  const projectId = input.projectId || saProjectId;
  const endpoint = getVertexEndpoint(input.location);

  // Vertex AI predictLongRunning endpoint for video generation
  const url = `${endpoint}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(input.location)}/publishers/google/models/${encodeURIComponent(input.model)}:predictLongRunning`;

  logger.info('Starting Veo3 generation', {
    projectId,
    location: input.location,
    model: input.model,
    promptPreview: input.prompt.substring(0, 50),
    durationSec: input.durationSec,
    imageMimeType: input.imageMimeType,
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
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
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
  };
}

/**
 * Poll Veo3 operation until completion
 * 
 * @param serviceAccountJson - SA JSON for auth (needed for each poll)
 * @param location - GCP region
 * @param operationName - Operation name from startVeo3Generation
 * @param timeoutMs - Maximum time to wait (default: 10 minutes)
 * @param intervalMs - Polling interval (default: 5 seconds)
 */
export async function pollVeo3Operation(
  serviceAccountJson: string,
  location: string,
  operationName: string,
  timeoutMs: number = POLL_TIMEOUT_MS,
  intervalMs: number = POLL_INTERVAL_MS
): Promise<Veo3GenerationResult> {
  const { accessToken } = await getVertexAccessToken(serviceAccountJson);
  const endpoint = getVertexEndpoint(location);

  // Operation name format: projects/.../locations/.../operations/...
  // We need to use the full name as returned
  const url = `${endpoint}/v1/${operationName}`;

  const startTime = Date.now();
  let pollCount = 0;

  logger.info('Starting Veo3 operation polling', {
    operationName,
    timeoutMs,
    intervalMs,
  });

  while (Date.now() - startTime < timeoutMs) {
    pollCount++;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error('Veo3 operations.get failed', {
        status: res.status,
        pollCount,
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
      const bytesBase64 = 
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
      gcsUri = 
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
        response?.generatedVideos?.[0]?.video?.mimeType ||
        response?.mimeType ||
        'video/mp4';

      if (!videoBytes && !gcsUri) {
        logger.error('Veo3: No video data in response', {
          responseKeys: Object.keys(response || {}),
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
    const { operationName } = await startVeo3Generation(input);

    // Poll until completion
    const result = await pollVeo3Operation(
      input.serviceAccountJson,
      input.location,
      operationName
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
