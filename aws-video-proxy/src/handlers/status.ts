/**
 * GET /video/status/{jobId} Handler (To-Be Version)
 * 
 * Flow:
 * 1. Get job from DynamoDB
 * 2. If completed, generate presigned URL for S3 video
 * 3. Return status (without sensitive data)
 * 
 * Note: This handler is DynamoDB-ONLY.
 * Video bytes are never returned - use presigned URL instead.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { jobStore } from '../utils/job-store';
import { presignGetUrl } from '../utils/s3';
import { logger } from '../utils/logger';
import type { StatusVideoResponse } from '../types';

// =============================================================================
// Handler
// =============================================================================

/**
 * Handle GET /video/status/{jobId}
 */
export async function handleStatus(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const jobId = event.pathParameters?.jobId;

  logger.info('Status request received', { jobId });

  if (!jobId) {
    return createResponse(400, {
      success: false,
      error: { code: 'INVALID_REQUEST', message: 'Job ID is required' },
    });
  }

  // Validate job ID format
  if (!jobId.startsWith('vp-')) {
    return createResponse(400, {
      success: false,
      error: { code: 'INVALID_JOB_ID', message: 'Invalid job ID format' },
    });
  }

  // Fetch job from DynamoDB
  try {
    const job = await jobStore.getJob(jobId);

    if (!job) {
      logger.warn('Job not found', { jobId });
      return createResponse(404, {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Job not found or expired' },
      });
    }

    // Get public-safe job (without api_key, image_base64)
    const publicJob = jobStore.toPublicJob(job);

    // Build response based on job status
    const response: StatusVideoResponse = {
      success: true,
      job: {
        job_id: publicJob.job_id,
        status: publicJob.status,
        created_at: publicJob.created_at,
        updated_at: publicJob.updated_at,
        progress_stage: publicJob.progress_stage,
        project_id: publicJob.project_id,
        scene_id: publicJob.scene_id,
        billing_user_id: publicJob.billing_user_id,
        billing_source: publicJob.billing_source,
      },
    };

    // If completed, add result with presigned URL
    if (job.status === 'completed' && job.s3_bucket && job.s3_key) {
      try {
        const presignedUrl = await presignGetUrl(job.s3_key, undefined, job.s3_bucket);
        
        response.job.s3_bucket = job.s3_bucket;
        response.job.s3_key = job.s3_key;
        response.job.presigned_url = presignedUrl;
        response.job.content_type = job.content_type || 'video/mp4';
        response.job.size_bytes = job.size_bytes || 0;
        
        logger.info('Returning completed job with presigned URL', {
          jobId,
          s3Key: job.s3_key,
          sizeBytes: job.size_bytes,
        });
      } catch (presignError: any) {
        logger.error('Failed to generate presigned URL', {
          jobId,
          s3Bucket: job.s3_bucket,
          s3Key: job.s3_key,
          error: presignError.message,
        });
        // Still return success but without presigned URL
        response.job.s3_bucket = job.s3_bucket;
        response.job.s3_key = job.s3_key;
        response.job.content_type = job.content_type || 'video/mp4';
        response.job.size_bytes = job.size_bytes || 0;
      }
    }

    // If failed, add error info
    if (job.status === 'failed' && (job.error_code || job.error_message)) {
      response.job.error_code = job.error_code;
      response.job.error_message = job.error_message;
    }

    logger.info('Returning job status', {
      jobId,
      status: job.status,
      hasS3Key: !!job.s3_key,
      hasError: !!job.error_code,
    });

    return createResponse(200, response);
  } catch (error: any) {
    logger.error('Failed to get job status', { jobId, error: error.message });
    return createResponse(500, {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve job status' },
    });
  }
}

// =============================================================================
// Helpers
// =============================================================================

function createResponse(statusCode: number, body: StatusVideoResponse): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
