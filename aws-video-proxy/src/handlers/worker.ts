/**
 * Worker Lambda Handler (SQS Trigger)
 * 
 * Flow:
 * 1. Receive SQS message with job_id
 * 2. Get job from DynamoDB
 * 3. Mark as processing (atomic)
 * 4. Generate video using Veo
 * 5. Upload to S3
 * 6. Mark as completed (or failed)
 * 
 * CRITICAL: This is the ONLY place where Veo API is called.
 * It runs in a separate Lambda with 15-minute timeout.
 * 
 * API Lambda (start.ts) does NOT generate videos - it only enqueues.
 */

import type { SQSEvent, SQSHandler } from 'aws-lambda';
import { generateVeoVideo } from '../services/veo-generator';
import { generateVeo3Video } from '../services/veo3-client';
import { downloadGcsObject } from '../services/gcs-download';
import { jobStore } from '../utils/job-store';
import { buildS3Key, putVideoToS3 } from '../utils/s3';
import { logger } from '../utils/logger';
import type { VideoGenerationMessage, VideoEngine } from '../types';
import { getVideoEngineFromModel } from '../types';

// =============================================================================
// Handler
// =============================================================================

/**
 * SQS trigger handler for video generation
 */
export const handler: SQSHandler = async (event: SQSEvent): Promise<void> => {
  logger.info('Worker received SQS event', {
    recordCount: event.Records.length,
  });

  for (const record of event.Records) {
    let message: VideoGenerationMessage;
    let jobId: string = '';

    try {
      message = JSON.parse(record.body);
      jobId = message.job_id;
      
      logger.info('Processing job', { jobId, messageId: record.messageId, attempt: message.attempt });
      
      await processJob(jobId);
      
      logger.info('Job processed successfully', { jobId });
    } catch (error: any) {
      logger.error('Failed to process job', {
        jobId,
        messageId: record.messageId,
        error: error.message,
        stack: error.stack?.substring(0, 500),
      });

      // Try to mark job as failed if we have a job ID
      if (jobId) {
        try {
          await jobStore.markFailed(jobId, {
            code: 'WORKER_ERROR',
            message: error.message || 'Worker processing failed',
          });
        } catch (markError: any) {
          logger.error('Failed to mark job as failed', {
            jobId,
            error: markError.message,
          });
        }
      }

      // Re-throw to let SQS handle retry/DLQ
      throw error;
    }
  }
};

// =============================================================================
// Job Processing
// =============================================================================

async function processJob(jobId: string): Promise<void> {
  // 1. Get job from DynamoDB
  const job = await jobStore.getJob(jobId);
  
  if (!job) {
    logger.error('Job not found', { jobId });
    throw new Error(`Job not found: ${jobId}`);
  }

  // Validate job state
  if (job.status !== 'queued') {
    logger.warn('Job is not in queued state', {
      jobId,
      currentStatus: job.status,
    });
    // Don't throw - job might already be processed
    if (job.status === 'completed' || job.status === 'failed') {
      return;
    }
    // If processing, another worker might be handling it
    if (job.status === 'processing') {
      logger.warn('Job is already being processed', { jobId });
      return;
    }
  }

  // 2. Mark as processing (atomic transition)
  try {
    await jobStore.markProcessing(jobId);
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      logger.warn('Job state transition failed, may already be processed', { jobId });
      return;
    }
    throw error;
  }

  // 3. Determine video engine
  // PR-4: Route to Veo2 or Veo3 based on video_engine or model
  const videoEngine: VideoEngine = job.video_engine || getVideoEngineFromModel(job.model || '');
  
  logger.info('Video engine determined', {
    jobId,
    videoEngine,
    model: job.model,
    hasApiKey: !!job.api_key,
    hasVertexSaJson: !!job.vertex_sa_json,
  });

  // 4. Validate required fields based on engine
  if (!job.image_url) {
    await jobStore.markFailed(jobId, {
      code: 'MISSING_DATA',
      message: 'Job is missing required data: image_url',
    });
    return;
  }
  
  if (videoEngine === 'veo2' && !job.api_key) {
    await jobStore.markFailed(jobId, {
      code: 'MISSING_DATA',
      message: 'Veo2 job is missing required API key',
    });
    return;
  }
  
  if (videoEngine === 'veo3' && !job.vertex_sa_json) {
    await jobStore.markFailed(jobId, {
      code: 'MISSING_DATA',
      message: 'Veo3 job is missing required Vertex SA JSON',
    });
    return;
  }
  
  if (videoEngine === 'veo3' && !job.vertex_location) {
    await jobStore.markFailed(jobId, {
      code: 'MISSING_DATA',
      message: 'Veo3 job is missing required vertex_location',
    });
    return;
  }

  // 4. Fetch image from URL (To-Be: base64廃止)
  const startTime = Date.now();
  
  logger.info('Fetching image from URL', {
    jobId,
    imageUrl: job.image_url.substring(0, 100) + '...',
  });

  // Update progress stage
  await jobStore.updateProgress(jobId, 'fetching_image');

  let imageBase64: string;
  let imageMimeType: string;
  
  try {
    const imageResponse = await fetch(job.image_url);
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch image: HTTP ${imageResponse.status}`);
    }
    
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    imageBase64 = imageBuffer.toString('base64');
    imageMimeType = imageResponse.headers.get('content-type') || 'image/png';
    
    logger.info('Image fetched successfully', {
      jobId,
      imageSizeBytes: imageBuffer.length,
      mimeType: imageMimeType,
    });
  } catch (fetchError: any) {
    logger.error('Failed to fetch image from URL', {
      jobId,
      imageUrl: job.image_url.substring(0, 100),
      error: fetchError.message,
    });
    await jobStore.markFailed(jobId, {
      code: 'IMAGE_FETCH_FAILED',
      message: `Failed to fetch image: ${fetchError.message}`,
    });
    return;
  }

  // 5. Generate video using Veo2 or Veo3
  let videoBytes: Uint8Array;
  let mimeType: string = 'video/mp4';
  
  if (videoEngine === 'veo2') {
    // ====== Veo2 Path (existing, unchanged) ======
    logger.info('Starting Veo2 generation', {
      jobId,
      imageMimeType,
      prompt: job.prompt?.substring(0, 50),
      durationSec: job.duration_sec,
      model: job.model,
    });

    await jobStore.updateProgress(jobId, 'generating_veo2');

    const result = await generateVeoVideo({
      imageBase64,
      imageMimeType,
      prompt: job.prompt || '',
      durationSec: job.duration_sec ?? 8,
      apiKey: job.api_key!,
      model: job.model || 'veo-2.0-generate-001',
    });

    const elapsedMs = Date.now() - startTime;
    
    logger.info('Veo2 generation result', {
      jobId,
      success: result.success,
      elapsedMs,
      videoSize: result.videoBytes?.length,
      errorCode: result.error?.code,
    });

    if (!result.success || !result.videoBytes) {
      await jobStore.markFailed(jobId, {
        code: result.error?.code || 'VEO2_GENERATION_FAILED',
        message: result.error?.message || 'Veo2 video generation failed',
      });
      return;
    }
    
    videoBytes = result.videoBytes;
    mimeType = result.mimeType || 'video/mp4';
    
  } else {
    // ====== Veo3 Path (new, Vertex AI) ======
    logger.info('Starting Veo3 generation', {
      jobId,
      imageMimeType,
      prompt: job.prompt?.substring(0, 50),
      durationSec: job.duration_sec,
      model: job.model,
      vertexProjectId: job.vertex_project_id,
      vertexLocation: job.vertex_location,
      // NEVER log vertex_sa_json
    });

    await jobStore.updateProgress(jobId, 'generating_veo3');

    const result = await generateVeo3Video({
      serviceAccountJson: job.vertex_sa_json!,
      projectId: job.vertex_project_id || '',
      location: job.vertex_location!,
      model: job.model || 'veo-3.0-generate-preview',
      prompt: job.prompt || '',
      durationSec: job.duration_sec ?? 8,
      imageBase64,
      imageMimeType,
    });

    const elapsedMs = Date.now() - startTime;
    
    logger.info('Veo3 generation result', {
      jobId,
      success: result.success,
      elapsedMs,
      hasVideoBytes: !!result.videoBytes,
      hasGcsUri: !!result.gcsUri,
      videoSize: result.videoBytes?.length,
      errorCode: result.error?.code,
    });

    if (!result.success) {
      await jobStore.markFailed(jobId, {
        code: result.error?.code || 'VEO3_GENERATION_FAILED',
        message: result.error?.message || 'Veo3 video generation failed',
      });
      return;
    }
    
    // Handle GCS output (download if needed)
    if (result.videoBytes) {
      videoBytes = result.videoBytes;
    } else if (result.gcsUri) {
      logger.info('Downloading video from GCS', { jobId, gcsUri: result.gcsUri.substring(0, 100) });
      await jobStore.updateProgress(jobId, 'downloading_gcs');
      
      const gcsResult = await downloadGcsObject(job.vertex_sa_json!, result.gcsUri);
      videoBytes = gcsResult.bytes;
      mimeType = gcsResult.contentType;
    } else {
      await jobStore.markFailed(jobId, {
        code: 'VEO3_NO_OUTPUT',
        message: 'Veo3 generation completed but no video data returned',
      });
      return;
    }
    
    mimeType = result.mimeType || mimeType;
  }
  
  const generationElapsedMs = Date.now() - startTime;

  // 6. Upload to S3 (same for both Veo2 and Veo3)
  const s3Key = buildS3Key(job.project_id, job.scene_id, jobId);
  
  logger.info('Uploading video to S3', {
    jobId,
    s3Key,
    videoSize: videoBytes.length,
    videoEngine,
  });

  await jobStore.updateProgress(jobId, 'uploading');

  const s3Result = await putVideoToS3(
    s3Key,
    videoBytes,
    mimeType
  );

  // 7. Mark as completed
  await jobStore.markCompleted(jobId, {
    s3_bucket: s3Result.bucket,
    s3_key: s3Result.key,
    content_type: mimeType,
    size_bytes: s3Result.size,
  });

  logger.info('Job completed successfully', {
    jobId,
    videoEngine,
    s3Key: s3Result.key,
    videoSize: s3Result.size,
    generationElapsedMs,
    totalElapsedMs: Date.now() - startTime,
  });
}

// =============================================================================
// Direct invocation support (for testing without SQS)
// =============================================================================

export async function processJobDirect(jobId: string): Promise<void> {
  logger.info('Direct job processing', { jobId });
  return processJob(jobId);
}
