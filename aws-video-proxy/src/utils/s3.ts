/**
 * S3 Utilities for Video Storage (Final To-Be Version)
 * 
 * Design:
 * - Store video results in S3 (not DynamoDB)
 * - Generate presigned URLs for client access
 * - Key format: videos/{project_id}/{scene_id}/{job_id}.mp4
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from './logger';

// =============================================================================
// Configuration
// =============================================================================

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const BUCKET = process.env.VIDEO_S3_BUCKET || 'rilarc-video-results';
const PREFIX = process.env.VIDEO_S3_PREFIX || 'videos';
const PRESIGN_EXPIRES = Number(process.env.PRESIGN_EXPIRES_SECONDS || '86400');

// S3 Client (reuse across invocations)
const s3 = new S3Client({ region: REGION });

// =============================================================================
// Key Building
// =============================================================================

export function buildS3Key(projectId: number, sceneId: number, jobId: string): string {
  return `${PREFIX}/${projectId}/${sceneId}/${jobId}.mp4`;
}

// =============================================================================
// Upload
// =============================================================================

export interface PutVideoResult {
  bucket: string;
  key: string;
  size: number;
}

export async function putVideoToS3(
  key: string,
  body: Uint8Array,
  contentType: string
): Promise<PutVideoResult> {
  logger.info('Uploading video to S3', {
    bucket: BUCKET,
    key,
    size: body.length,
    contentType,
  });

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));

  logger.info('Video uploaded to S3', {
    bucket: BUCKET,
    key,
    size: body.length,
  });

  return {
    bucket: BUCKET,
    key,
    size: body.length,
  };
}

// =============================================================================
// Presigned URL
// =============================================================================

export async function presignGetUrl(
  key: string,
  expiresIn?: number,
  bucket?: string
): Promise<string> {
  const targetBucket = bucket || BUCKET;
  const expires = expiresIn || PRESIGN_EXPIRES;

  logger.info('Generating presigned URL', {
    bucket: targetBucket,
    key,
    expiresIn: expires,
  });

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: targetBucket, Key: key }),
    { expiresIn: expires }
  );

  return url;
}
