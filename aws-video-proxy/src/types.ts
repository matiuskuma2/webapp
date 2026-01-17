/**
 * Type definitions for rilarc-video-proxy Lambda (Final To-Be Version)
 * 
 * SSOT: DynamoDB table rilarc-video-jobs
 * Architecture: start → status polling → presigned URL playback
 * Base64返却禁止、成果物はS3+Presigned URL
 * 
 * PR-4: Veo3 (Vertex AI) support added
 * - video_engine: 'veo2' | 'veo3'
 * - Veo2: api_key (Gemini API Key)
 * - Veo3: vertex_sa_json + vertex_project_id + vertex_location
 */

// =============================================================================
// Core Types
// =============================================================================

export type BillingSource = 'user' | 'sponsor';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

/**
 * Video engine type for cost tracking and routing
 * - veo2: Google Gemini API (existing)
 * - veo3: Google Vertex AI (new)
 */
export type VideoEngine = 'veo2' | 'veo3';

// =============================================================================
// API Request Types
// =============================================================================

export type StartVideoRequest = {
  project_id: number;
  scene_id: number;

  owner_user_id: number;
  executor_user_id: number;
  billing_user_id: number;
  billing_source: BillingSource;

  provider?: 'google';
  model?: string; // veo-2.0-generate-001 or veo-3.0-generate-preview
  duration_sec?: 5 | 8 | 10;
  prompt?: string;

  // ==========================================
  // To-Be: 画像URL方式（base64廃止）
  // ==========================================
  // WorkerがこのURLから画像を取得してVeoに渡す
  // これにより2MB制限問題が解消される
  image_url: string;

  // @deprecated - base64は廃止。後方互換のためoptionalで残す
  image_base64?: string;
  image_mime_type?: 'image/png' | 'image/jpeg' | 'image/webp';

  // ==========================================
  // PR-4: Video Engine & Authentication
  // ==========================================
  /**
   * Video engine for routing and cost tracking
   * - veo2 (default): Uses Gemini API with api_key
   * - veo3: Uses Vertex AI with vertex_* fields
   */
  video_engine?: VideoEngine;
  
  /**
   * Veo2: Gemini API Key (existing)
   * Required when video_engine is 'veo2' or not specified
   */
  api_key?: string;
  
  /**
   * Veo3: Vertex AI Service Account JSON (plaintext)
   * Required when video_engine is 'veo3'
   * SECURITY: Stored temporarily in DynamoDB with short TTL, never logged
   */
  vertex_sa_json?: string;
  
  /**
   * Veo3: GCP Project ID
   * If not provided, extracted from vertex_sa_json
   */
  vertex_project_id?: string;
  
  /**
   * Veo3: GCP Region (e.g., 'us-central1')
   * Required for Vertex AI API endpoint
   */
  vertex_location?: string;

  // Optional: for idempotency (prevent duplicate jobs)
  idempotency_key?: string;
};

// =============================================================================
// API Response Types
// =============================================================================

export type StartVideoResponse = {
  success: true;
  job_id: string;
  status: JobStatus; // queued
  reused?: boolean;
} | {
  success: false;
  error: { code: string; message: string };
};

export type StatusVideoResponse = {
  success: true;
  job: {
    job_id: string;
    status: JobStatus;
    created_at: number;
    updated_at: number;
    progress_stage?: string;

    project_id: number;
    scene_id: number;

    billing_user_id: number;
    billing_source: BillingSource;

    // completed only
    s3_bucket?: string;
    s3_key?: string;
    content_type?: string;
    size_bytes?: number;
    presigned_url?: string; // generated in status handler

    // failed only
    error_code?: string;
    error_message?: string;
  };
} | {
  success: false;
  error: { code: string; message: string };
};

// =============================================================================
// DynamoDB Job Item (SSOT)
// =============================================================================

export type JobItem = {
  job_id: string;
  status: JobStatus;

  created_at: number;
  updated_at: number;
  ttl: number;

  idempotency_key: string;

  project_id: number;
  scene_id: number;

  owner_user_id: number;
  executor_user_id: number;
  billing_user_id: number;
  billing_source: BillingSource;

  provider: 'google';
  model: string;
  duration_sec: 5 | 8 | 10;
  prompt: string;

  // To-Be: 画像URL方式
  image_url?: string;

  // @deprecated - base64は廃止
  image_base64?: string;
  image_mime_type?: string;
  
  // ==========================================
  // PR-4: Video Engine & Authentication
  // ==========================================
  /**
   * Video engine for routing and cost tracking
   */
  video_engine?: VideoEngine;
  
  /**
   * Veo2: Gemini API Key
   * MVP (do not return to clients)
   */
  api_key?: string;
  
  /**
   * Veo3: Vertex AI Service Account JSON (plaintext)
   * SECURITY: Short TTL, never logged, never returned to clients
   */
  vertex_sa_json?: string;
  
  /**
   * Veo3: GCP Project ID
   */
  vertex_project_id?: string;
  
  /**
   * Veo3: GCP Region
   */
  vertex_location?: string;

  // result
  s3_bucket?: string;
  s3_key?: string;
  content_type?: string;
  size_bytes?: number;

  // error
  error_code?: string;
  error_message?: string;

  progress_stage?: string;
};

// =============================================================================
// SQS Message Types
// =============================================================================

export interface VideoGenerationMessage {
  job_id: string;
  attempt?: number;
}

// =============================================================================
// Veo Generation Types
// =============================================================================

export interface VeoGenerateInput {
  apiKey: string;
  model: string;
  prompt: string;
  durationSec: number;
  imageBase64: string;
  imageMimeType: string;
}

export interface VeoGenerationResult {
  success: boolean;
  videoBytes?: Uint8Array;
  mimeType?: string;
  error?: {
    code: string;
    message: string;
  };
}

// =============================================================================
// Veo3 (Vertex AI) Types
// =============================================================================

export interface Veo3GenerateInput {
  /** Service Account JSON (plaintext) */
  serviceAccountJson: string;
  /** GCP Project ID (extracted from SA JSON if not provided) */
  projectId: string;
  /** GCP Region (e.g., 'us-central1') */
  location: string;
  /** Veo3 model name */
  model: string;
  /** Video prompt */
  prompt: string;
  /** Duration in seconds (Veo3 is typically fixed at 8s) */
  durationSec: number;
  /** Base64 encoded image */
  imageBase64: string;
  /** Image MIME type */
  imageMimeType: string;
}

export interface Veo3GenerationResult {
  success: boolean;
  videoBytes?: Uint8Array;
  mimeType?: string;
  /** GCS URI if output is stored in GCS */
  gcsUri?: string;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Helper to determine video engine from model string
 */
export function getVideoEngineFromModel(model: string): VideoEngine {
  return model.includes('veo-3') ? 'veo3' : 'veo2';
}
