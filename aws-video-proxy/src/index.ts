/**
 * rilarc-video-proxy Lambda Entry Point (To-Be Version)
 * 
 * Routes:
 * - POST /video/start     → Create job, return job_id immediately
 * - GET  /video/status/{jobId} → Get job status with presigned URL
 * - GET  /health          → Health check
 * 
 * Legacy (for backward compatibility):
 * - POST /video/generate  → Synchronous generation (deprecated)
 * 
 * Authentication: IAM (SigV4) - handled by API Gateway
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { handleStart } from './handlers/start';
import { handleStatus } from './handlers/status';
import { handleGenerate } from './handlers/generate';
import { logger } from './utils/logger';

/**
 * Lambda handler entry point
 */
export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  // Log request (without sensitive data)
  logger.info('Request received', {
    path: event.path,
    httpMethod: event.httpMethod,
    requestId: context.awsRequestId,
    remainingTimeMs: context.getRemainingTimeInMillis(),
  });

  try {
    // Route based on path and method
    const path = event.path;
    const method = event.httpMethod;

    // CORS preflight
    if (method === 'OPTIONS') {
      return createCorsResponse();
    }

    // POST /video/start (To-Be: Primary endpoint)
    if (method === 'POST' && (path === '/video/start' || path === '/prod/video/start')) {
      return await handleStart(event);
    }

    // GET /video/status/{jobId}
    if (method === 'GET' && (path.startsWith('/video/status/') || path.startsWith('/prod/video/status/'))) {
      // Extract jobId from path
      const pathParts = path.split('/');
      const jobId = pathParts[pathParts.length - 1];
      event.pathParameters = { ...event.pathParameters, jobId };
      return await handleStatus(event);
    }

    // POST /video/generate (Legacy: Keep for backward compatibility)
    if (method === 'POST' && (path === '/video/generate' || path === '/prod/video/generate')) {
      logger.warn('Using deprecated /video/generate endpoint');
      return await handleGenerate(event, context);
    }

    // Health check
    if (method === 'GET' && (path === '/health' || path === '/prod/health')) {
      return createHealthResponse(context);
    }

    // Not found
    logger.warn('Route not found', { path, method });
    return createNotFoundResponse(path, method);

  } catch (err: any) {
    logger.error('Unhandled error', {
      error: err.message,
      stack: err.stack?.substring(0, 500),
    });

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        },
      }),
    };
  }
}

// =============================================================================
// Helper Responses
// =============================================================================

function createCorsResponse(): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token',
      'Access-Control-Max-Age': '86400',
    },
    body: '',
  };
}

function createHealthResponse(context: Context): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({
      status: 'healthy',
      service: 'rilarc-video-proxy',
      version: '2.0.0',  // To-Be version
      features: {
        startEndpoint: true,
        statusEndpoint: true,
        s3Storage: true,
        presignedUrl: true,
      },
      remainingTimeMs: context.getRemainingTimeInMillis(),
      timestamp: new Date().toISOString(),
    }),
  };
}

function createNotFoundResponse(path: string, method: string): APIGatewayProxyResult {
  return {
    statusCode: 404,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Route not found: ${method} ${path}`,
      },
    }),
  };
}
