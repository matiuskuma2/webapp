/**
 * DynamoDB-based Job Store (Final To-Be Version)
 * 
 * SSOT Design:
 * - Table: rilarc-video-jobs
 * - PK: job_id (S)
 * - TTL: ttl (N) - Unix timestamp in seconds
 * 
 * Features:
 * - Atomic updates with ConditionExpression
 * - S3 result reference (no base64 in DynamoDB for video)
 * - Idempotency key support (requires GSI)
 * - Public view without sensitive data (api_key, image_base64, vertex_sa_json)
 * 
 * PR-4: Veo3 Support
 * - Added vertex_sa_json, vertex_project_id, vertex_location fields
 * - Sensitive data (vertex_sa_json) cleared on completion/failure
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient, 
  PutCommand, 
  GetCommand, 
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';
import type { JobItem, JobStatus } from '../types';

// =============================================================================
// Configuration
// =============================================================================

type JobStoreConfig = { 
  tableName: string; 
  region: string; 
};

function nowMs(): number { 
  return Date.now(); 
}

function ttlSec(minutes: number): number { 
  return Math.floor((Date.now() + minutes * 60_000) / 1000); 
}

// =============================================================================
// Job Store Class
// =============================================================================

export class JobStore {
  private tableName: string;
  private ddb: DynamoDBDocumentClient;

  constructor(cfg: JobStoreConfig) {
    this.tableName = cfg.tableName;
    const raw = new DynamoDBClient({ region: cfg.region });
    this.ddb = DynamoDBDocumentClient.from(raw, { 
      marshallOptions: { removeUndefinedValues: true } 
    });
  }

  // ==========================================================================
  // Public-safe job (never include api_key/image_base64)
  // ==========================================================================

  toPublicJob(job: JobItem): Omit<JobItem, 'api_key' | 'image_base64' | 'vertex_sa_json'> {
    const { api_key, image_base64, vertex_sa_json, ...rest } = job;
    return rest;
  }

  // ==========================================================================
  // Idempotency Check (requires GSI: gsi_idempotency with PK=idempotency_key)
  // ==========================================================================

  async findByIdempotencyKey(idempotencyKey: string): Promise<JobItem | null> {
    try {
      const res = await this.ddb.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: 'gsi_idempotency',
        KeyConditionExpression: 'idempotency_key = :k',
        ExpressionAttributeValues: { ':k': idempotencyKey },
        Limit: 1,
      }));
      const item = res.Items?.[0] as JobItem | undefined;
      return item ?? null;
    } catch (error: any) {
      // If GSI not present, just disable reuse (safe fallback)
      logger.warn('findByIdempotencyKey failed (GSI may not exist)', { 
        error: error.message 
      });
      return null;
    }
  }

  // ==========================================================================
  // Job CRUD Operations
  // ==========================================================================

  async createQueuedJob(job: Omit<JobItem, 'status' | 'created_at' | 'updated_at' | 'ttl'> & {
    job_id: string;
  }): Promise<void> {
    const item: JobItem = {
      ...job,
      status: 'queued',
      created_at: nowMs(),
      updated_at: nowMs(),
      ttl: ttlSec(60 * 24), // keep 24h
    };

    // Atomic: create only if not exists
    await this.ddb.send(new PutCommand({
      TableName: this.tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(job_id)',
    }));

    logger.info('Job created (queued)', { job_id: job.job_id });
  }

  async getJob(jobId: string): Promise<JobItem | null> {
    const res = await this.ddb.send(new GetCommand({
      TableName: this.tableName,
      Key: { job_id: jobId },
    }));
    return (res.Item as JobItem) ?? null;
  }

  // ==========================================================================
  // State Transitions (Atomic)
  // ==========================================================================

  async markProcessing(jobId: string): Promise<void> {
    // Atomic: only queued -> processing
    await this.ddb.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { job_id: jobId },
      UpdateExpression: 'SET #s = :processing, updated_at = :u, progress_stage = :p',
      ConditionExpression: '#s = :queued',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':queued': 'queued',
        ':processing': 'processing',
        ':u': nowMs(),
        ':p': 'processing',
      },
    }));

    logger.info('Job marked as processing', { job_id: jobId });
  }

  async markCompleted(jobId: string, args: {
    s3_bucket: string;
    s3_key: string;
    content_type: string;
    size_bytes: number;
  }): Promise<void> {
    await this.ddb.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { job_id: jobId },
      UpdateExpression: [
        'SET #s = :completed',
        'updated_at = :u',
        'progress_stage = :p',
        's3_bucket = :b',
        's3_key = :k',
        'content_type = :ct',
        'size_bytes = :sz',
        // Clear sensitive data (Veo2 + Veo3)
        'image_base64 = :empty',
        'api_key = :empty',
        'vertex_sa_json = :empty',
      ].join(', '),
      ConditionExpression: '#s IN (:queued, :processing)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':queued': 'queued',
        ':processing': 'processing',
        ':completed': 'completed',
        ':u': nowMs(),
        ':p': 'completed',
        ':b': args.s3_bucket,
        ':k': args.s3_key,
        ':ct': args.content_type,
        ':sz': args.size_bytes,
        ':empty': '',
      },
    }));

    logger.info('Job marked as completed', { 
      job_id: jobId, 
      s3_key: args.s3_key, 
      size_bytes: args.size_bytes 
    });
  }

  async markFailed(jobId: string, args: { code: string; message: string }): Promise<void> {
    try {
      await this.ddb.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { job_id: jobId },
        UpdateExpression: [
          'SET #s = :failed',
          'updated_at = :u',
          'progress_stage = :p',
          'error_code = :ec',
          'error_message = :em',
          // Clear sensitive data (Veo2 + Veo3)
          'image_base64 = :empty',
          'api_key = :empty',
          'vertex_sa_json = :empty',
        ].join(', '),
        ConditionExpression: '#s IN (:queued, :processing)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':queued': 'queued',
          ':processing': 'processing',
          ':failed': 'failed',
          ':u': nowMs(),
          ':p': 'failed',
          ':ec': args.code,
          ':em': args.message.slice(0, 2000),
          ':empty': '',
        },
      }));

      logger.info('Job marked as failed', { job_id: jobId, error_code: args.code });
    } catch (error: any) {
      // Job might already be in terminal state
      logger.warn('markFailed condition check failed', { 
        job_id: jobId, 
        error: error.message 
      });
    }
  }

  async updateProgress(jobId: string, stage: string): Promise<void> {
    await this.ddb.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { job_id: jobId },
      UpdateExpression: 'SET progress_stage = :p, updated_at = :u',
      ExpressionAttributeValues: { 
        ':p': stage.slice(0, 200), 
        ':u': nowMs() 
      },
    }));
  }
}

// =============================================================================
// Legacy compatibility exports
// =============================================================================

export function generateJobId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `vp-${timestamp}-${random}`;
}

// =============================================================================
// Global Job Store Instance
// =============================================================================

const TABLE_NAME = process.env.VIDEO_JOBS_TABLE || process.env.DYNAMODB_TABLE || 'rilarc-video-jobs';
const REGION = process.env.AWS_REGION || 'ap-northeast-1';

export const jobStore = new JobStore({
  tableName: TABLE_NAME,
  region: REGION,
});
