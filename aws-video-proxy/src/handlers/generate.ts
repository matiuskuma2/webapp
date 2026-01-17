/**
 * POST /video/generate Handler (DEPRECATED - Legacy Synchronous Mode)
 * 
 * WARNING: This endpoint is DEPRECATED. Use POST /video/start instead.
 * 
 * This endpoint exists only for backward compatibility.
 * New code should use the start/status pattern.
 * 
 * Issues with this endpoint:
 * - Returns video as base64 (huge response, breaks API Gateway limits)
 * - Synchronous processing (can timeout)
 * - Not compatible with SQS worker pattern
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { validateStartRequest } from '../utils/validation';
import { generateVeoVideo } from '../services/veo-generator';
import { jobStore, generateJobId } from '../utils/job-store';
import { logger } from '../utils/logger';
import type { StartVideoRequest } from '../types';

// Response type for legacy endpoint
interface LegacyGenerateResponse {
  success: boolean;
  job_id?: string;
  status?: string;
  video?: {
    base64: string;
    mime_type: string;
    size_bytes: number;
  };
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Handle POST /video/generate (DEPRECATED)
 * 
 * @deprecated Use handleStart instead
 */
export async function handleGenerate(
  event: APIGatewayProxyEvent,
  context?: Context
): Promise<APIGatewayProxyResult> {
  logger.warn('DEPRECATED endpoint /video/generate called. Use /video/start instead.');
  
  logger.info('Generate request received', {
    path: event.path,
    httpMethod: event.httpMethod,
    bodyLength: event.body?.length,
  });

  // Parse body
  let body: unknown;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    logger.warn('Invalid JSON body');
    return createResponse(400, {
      success: false,
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
    });
  }

  // Validate request (using same validation as start)
  const validation = validateStartRequest(body);
  if (!validation.valid) {
    logger.warn('Validation failed', { error: validation.error });
    return createResponse(400, {
      success: false,
      error: validation.error,
    });
  }

  const req = body as StartVideoRequest;

  // Generate job ID
  const jobId = generateJobId();
  
  logger.info('Starting video generation (DEPRECATED synchronous mode)', { jobId });

  // Run video generation synchronously (NOT RECOMMENDED)
  const startTime = Date.now();

  try {
    // @deprecated: このハンドラーは使用禁止。image_url 方式の start/status を使用すること
    const result = await generateVeoVideo({
      imageBase64: req.image_base64 || '',  // deprecated field
      imageMimeType: req.image_mime_type || 'image/png',  // deprecated field
      prompt: req.prompt || '',
      durationSec: req.duration_sec ?? 8,
      apiKey: req.api_key || '',
      model: req.model || 'veo-2.0-generate-001',
    });

    const elapsedMs = Date.now() - startTime;
    logger.info('Veo generation completed', {
      jobId,
      success: result.success,
      elapsedMs,
      videoSize: result.videoBytes?.length,
      errorCode: result.error?.code,
    });

    if (!result.success) {
      return createResponse(getStatusCodeForError(result.error?.code), {
        success: false,
        job_id: jobId,
        status: 'failed',
        error: result.error,
      });
    }

    // Convert video to base64
    const videoBase64 = uint8ArrayToBase64(result.videoBytes!);
    const videoSizeBytes = result.videoBytes!.length;

    logger.info('Video returning as base64 (DEPRECATED)', { jobId, videoSize: videoSizeBytes, elapsedMs });

    return createResponse(200, {
      success: true,
      job_id: jobId,
      status: 'completed',
      video: {
        base64: videoBase64,
        mime_type: result.mimeType || 'video/mp4',
        size_bytes: videoSizeBytes,
      },
    });
  } catch (error: any) {
    const elapsedMs = Date.now() - startTime;
    logger.error('Video generation error', { 
      jobId, 
      elapsedMs,
      error: error.message, 
      stack: error.stack?.substring(0, 500) 
    });

    return createResponse(500, {
      success: false,
      job_id: jobId,
      status: 'failed',
      error: { code: 'INTERNAL_ERROR', message: error.message || 'An unexpected error occurred' },
    });
  }
}

// =============================================================================
// Helpers
// =============================================================================

function createResponse(statusCode: number, body: LegacyGenerateResponse): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

function getStatusCodeForError(errorCode?: string): number {
  switch (errorCode) {
    case 'INVALID_API_KEY':
      return 403;
    case 'RATE_LIMITED':
      return 429;
    case 'TIMEOUT':
      return 504;
    case 'INVALID_REQUEST':
    case 'INVALID_JSON':
      return 400;
    default:
      return 500;
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
