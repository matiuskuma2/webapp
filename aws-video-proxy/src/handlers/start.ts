/**
 * POST /video/start Handler (To-Be: Enqueue Only)
 * 
 * Flow:
 * 1. Validate request
 * 2. Check idempotency key (if provided)
 * 3. Create job in DynamoDB (status: queued)
 * 4. Send message to SQS for async processing
 * 5. Return job_id immediately (29秒以内に必ず返る)
 * 
 * CRITICAL: This handler does NOT call Veo API.
 * Veo generation is handled by the Worker Lambda triggered by SQS.
 * 
 * API Gateway 29秒制限に完全準拠。
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { validateStartRequest } from '../utils/validation';
import { jobStore, generateJobId } from '../utils/job-store';
import { presignGetUrl } from '../utils/s3';
import { logger } from '../utils/logger';
import type { StartVideoRequest, StartVideoResponse, StatusVideoResponse, VideoGenerationMessage } from '../types';

// =============================================================================
// Configuration
// =============================================================================

const SQS_QUEUE_URL = process.env.VIDEO_JOBS_QUEUE_URL || '';
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-1';

// SQS Client (reuse across invocations)
const sqs = new SQSClient({ region: AWS_REGION });

// =============================================================================
// Handler
// =============================================================================

/**
 * Handle POST /video/start
 * 
 * IMPORTANT: This handler ONLY creates the job and enqueues it.
 * It does NOT generate the video (that's the Worker's job).
 */
export async function handleStart(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const startTime = Date.now();
  
  logger.info('Start request received', {
    path: event.path,
    httpMethod: event.httpMethod,
    bodyLength: event.body?.length,
    queueConfigured: !!SQS_QUEUE_URL,
  });

  // Check SQS configuration
  if (!SQS_QUEUE_URL) {
    logger.error('SQS queue URL not configured');
    return createResponse(500, {
      success: false,
      error: { 
        code: 'CONFIG_ERROR', 
        message: 'Video processing queue not configured. Please contact administrator.' 
      },
    });
  }

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

  // Validate request
  const validation = validateStartRequest(body);
  if (!validation.valid) {
    logger.warn('Validation failed', { error: validation.error });
    return createResponse(400, {
      success: false,
      error: validation.error || { code: 'VALIDATION_ERROR', message: 'Validation failed' },
    });
  }

  const req = body as StartVideoRequest;

  // PR-4: Determine video engine from request
  const videoEngine = req.video_engine || (req.model?.includes('veo-3') ? 'veo3' : 'veo2');
  
  logger.info('Request video engine', {
    videoEngine,
    model: req.model,
    hasApiKey: !!req.api_key,
    hasVertexSaJson: !!req.vertex_sa_json,
    billingSource: req.billing_source,
  });

  // Generate idempotency key if not provided
  const idempotencyKey = req.idempotency_key || 
    `${req.project_id}-${req.scene_id}-${Date.now()}`;

  // Check idempotency key
  try {
    const existingJob = await jobStore.findByIdempotencyKey(idempotencyKey);
    if (existingJob) {
      // Return existing job if not failed
      if (existingJob.status !== 'failed') {
        logger.info('Returning existing job (idempotency)', {
          jobId: existingJob.job_id,
          status: existingJob.status,
          idempotencyKey,
        });
        
        // If completed, return with presigned URL
        if (existingJob.status === 'completed' && existingJob.s3_bucket && existingJob.s3_key) {
          const presignedUrl = await presignGetUrl(existingJob.s3_key, undefined, existingJob.s3_bucket);
          return createStatusResponse(200, {
            success: true,
            job: {
              job_id: existingJob.job_id,
              status: existingJob.status,
              created_at: existingJob.created_at,
              updated_at: existingJob.updated_at,
              progress_stage: 'completed',
              project_id: existingJob.project_id,
              scene_id: existingJob.scene_id,
              billing_user_id: existingJob.billing_user_id,
              billing_source: existingJob.billing_source,
              s3_bucket: existingJob.s3_bucket,
              s3_key: existingJob.s3_key,
              presigned_url: presignedUrl,
              content_type: existingJob.content_type || 'video/mp4',
              size_bytes: existingJob.size_bytes || 0,
            },
          });
        }
        
        // Return current status (queued/processing)
        return createResponse(200, {
          success: true,
          job_id: existingJob.job_id,
          status: existingJob.status,
          reused: true,
        });
      }
      // If failed, allow retry with new job
      logger.info('Existing job failed, allowing retry', {
        existingJobId: existingJob.job_id,
        idempotencyKey,
      });
    }
  } catch (error) {
    // GSI might not exist - continue with new job creation
    logger.warn('Idempotency check failed, continuing', { error });
  }

  // Generate job ID
  const jobId = generateJobId();
  
  // Create job in DynamoDB (queued state)
  try {
    await jobStore.createQueuedJob({
      job_id: jobId,
      idempotency_key: idempotencyKey,
      project_id: req.project_id,
      scene_id: req.scene_id,
      owner_user_id: req.owner_user_id,
      executor_user_id: req.executor_user_id,
      billing_user_id: req.billing_user_id,
      billing_source: req.billing_source,
      provider: req.provider || 'google',
      model: req.model || (videoEngine === 'veo3' ? 'veo-3.0-generate-preview' : 'veo-2.0-generate-001'),
      duration_sec: req.duration_sec ?? 8,
      prompt: req.prompt || '',
      // To-Be: image_url 方式（base64廃止）
      image_url: req.image_url,
      // @deprecated: base64は後方互換のため残す（使用しない）
      image_base64: req.image_base64,
      image_mime_type: req.image_mime_type,
      // PR-4: Video engine and authentication
      video_engine: videoEngine,
      // Veo2: Gemini API key
      api_key: videoEngine === 'veo2' ? req.api_key : undefined,
      // Veo3: Vertex AI credentials (SECURITY: cleared after processing)
      vertex_sa_json: videoEngine === 'veo3' ? req.vertex_sa_json : undefined,
      vertex_project_id: req.vertex_project_id,
      vertex_location: req.vertex_location,
    });
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException' || error.message === 'JOB_ALREADY_EXISTS') {
      return createResponse(409, {
        success: false,
        error: { code: 'JOB_ALREADY_EXISTS', message: 'Job ID already exists' },
      });
    }
    logger.error('Failed to create job', { jobId, error: error.message });
    return createResponse(500, {
      success: false,
      error: { code: 'JOB_CREATE_FAILED', message: 'Failed to create video generation job' },
    });
  }

  // Send message to SQS for async processing
  try {
    const message: VideoGenerationMessage = {
      job_id: jobId,
      attempt: 1,
    };

    // SQS MessageAttributes で Number 型は StringValue に数値文字列が必要
    // undefined や null の場合はエラーになるため、String 型に変更
    const messageAttributes: Record<string, { DataType: string; StringValue: string }> = {
      'jobId': {
        DataType: 'String',
        StringValue: jobId,
      },
    };
    
    // project_id が存在する場合のみ追加（String型として）
    if (req.project_id !== undefined && req.project_id !== null) {
      messageAttributes['projectId'] = {
        DataType: 'String',
        StringValue: String(req.project_id),
      };
    }
    
    await sqs.send(new SendMessageCommand({
      QueueUrl: SQS_QUEUE_URL,
      MessageBody: JSON.stringify(message),
      MessageAttributes: messageAttributes,
    }));

    logger.info('Job enqueued to SQS', { 
      jobId, 
      queueUrl: SQS_QUEUE_URL.split('/').pop(), // Log only queue name
      elapsedMs: Date.now() - startTime,
    });

  } catch (error: any) {
    logger.error('Failed to enqueue job to SQS', { jobId, error: error.message });
    
    // Mark job as failed since it won't be processed
    try {
      await jobStore.markFailed(jobId, {
        code: 'ENQUEUE_FAILED',
        message: 'Failed to enqueue video generation job',
      });
    } catch (markError) {
      logger.error('Failed to mark job as failed', { jobId });
    }
    
    return createResponse(500, {
      success: false,
      error: { code: 'ENQUEUE_FAILED', message: 'Failed to queue video generation job' },
    });
  }

  const totalElapsedMs = Date.now() - startTime;
  logger.info('Start request completed', {
    jobId,
    totalElapsedMs,
    projectId: req.project_id,
    sceneId: req.scene_id,
  });

  // Return job_id immediately (29秒以内に必ず返る)
  return createResponse(202, {
    success: true,
    job_id: jobId,
    status: 'queued',
  });
}

// =============================================================================
// Helpers
// =============================================================================

function createResponse(statusCode: number, body: StartVideoResponse): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

function createStatusResponse(statusCode: number, body: StatusVideoResponse): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
