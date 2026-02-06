/**
 * AWS Video Proxy Client
 * 
 * Cloudflare Workers から AWS API Gateway (rilarc-video-proxy) への通信
 * 通信方式: SigV4 署名付きリクエスト
 * 
 * エンドポイント:
 * - POST /video/start  → ジョブ登録（SQS enqueue）
 * - GET /video/status/{jobId} → ステータス確認（presigned URL含む）
 */

// AWS SigV4署名に必要な定数
const AWS_SERVICE = 'execute-api';
const DEFAULT_AWS_REGION = 'ap-northeast-1';
const DEFAULT_API_GATEWAY_ENDPOINT = 'https://sddd2nwesf.execute-api.ap-northeast-1.amazonaws.com/prod';

// ====================================================================
// Types
// ====================================================================

export type VideoEngine = 'veo2' | 'veo3';
export type BillingSource = 'user' | 'sponsor';

export interface StartVideoRequest {
  project_id: number;
  scene_id: number;
  owner_user_id: number;
  executor_user_id: number;
  billing_user_id: number;
  billing_source: BillingSource;
  provider?: 'google';
  model?: string;
  duration_sec?: 5 | 8 | 10;
  prompt?: string;
  image_url: string;
  
  // Veo2
  video_engine?: VideoEngine;
  api_key?: string;
  
  // Veo3
  vertex_sa_json?: string;
  vertex_project_id?: string;
  vertex_location?: string;
  
  idempotency_key?: string;
}

export interface StartVideoResponse {
  success: boolean;
  job_id?: string;
  status?: string;
  reused?: boolean;
  error?: { code: string; message: string };
}

export interface StatusVideoResponse {
  success: boolean;
  job?: {
    job_id: string;
    status: 'queued' | 'processing' | 'completed' | 'failed';
    created_at: number;
    updated_at: number;
    progress_stage?: string;
    project_id: number;
    scene_id: number;
    billing_user_id: number;
    billing_source: BillingSource;
    // completed
    s3_bucket?: string;
    s3_key?: string;
    content_type?: string;
    size_bytes?: number;
    presigned_url?: string;
    // failed
    error_code?: string;
    error_message?: string;
  };
  error?: { code: string; message: string };
}

// ====================================================================
// SigV4 Signing (Web Crypto API for Cloudflare Workers)
// ====================================================================

async function hmacSha256(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  regionName: string,
  serviceName: string
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(new TextEncoder().encode('AWS4' + secretKey).buffer, dateStamp);
  const kRegion = await hmacSha256(kDate, regionName);
  const kService = await hmacSha256(kRegion, serviceName);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  return kSigning;
}

interface SignedHeaders {
  'x-amz-date': string;
  'x-amz-content-sha256': string;
  'Authorization': string;
  'Content-Type'?: string;
}

async function signRequest(
  method: string,
  url: string,
  body: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string = DEFAULT_AWS_REGION
): Promise<SignedHeaders> {
  const parsedUrl = new URL(url);
  const host = parsedUrl.host;
  const path = parsedUrl.pathname;
  const queryString = parsedUrl.search.slice(1);
  
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  
  const payloadHash = await sha256(body);
  
  // Canonical request
  const signedHeadersList = ['host', 'x-amz-content-sha256', 'x-amz-date'];
  const signedHeaders = signedHeadersList.join(';');
  
  const canonicalHeaders = 
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  
  const canonicalRequest = [
    method,
    path,
    queryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  
  const canonicalRequestHash = await sha256(canonicalRequest);
  
  // String to sign
  const credentialScope = `${dateStamp}/${region}/${AWS_SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    canonicalRequestHash
  ].join('\n');
  
  // Signature
  const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, AWS_SERVICE);
  const signatureBuffer = await hmacSha256(signingKey, stringToSign);
  const signature = toHex(signatureBuffer);
  
  // Authorization header
  const authorizationHeader = 
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  
  const headers: SignedHeaders = {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'Authorization': authorizationHeader,
  };
  
  if (body) {
    headers['Content-Type'] = 'application/json';
  }
  
  return headers;
}

// ====================================================================
// API Client
// ====================================================================

export class AwsVideoClient {
  private accessKeyId: string;
  private secretAccessKey: string;
  private baseUrl: string;
  private region: string;
  
  constructor(
    accessKeyId: string,
    secretAccessKey: string,
    baseUrl?: string,
    region?: string
  ) {
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.baseUrl = baseUrl || DEFAULT_API_GATEWAY_ENDPOINT;
    this.region = region || DEFAULT_AWS_REGION;
  }
  
  /**
   * POST /video/start - 動画生成ジョブを登録
   */
  async startVideo(request: StartVideoRequest): Promise<StartVideoResponse> {
    const url = `${this.baseUrl}/video/start`;
    const body = JSON.stringify(request);
    
    try {
      const signedHeaders = await signRequest('POST', url, body, this.accessKeyId, this.secretAccessKey, this.region);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...signedHeaders,
          'Content-Type': 'application/json',
        },
        body,
      });
      
      const data = await response.json() as StartVideoResponse;
      
      if (!response.ok) {
        console.error('[AwsVideoClient] startVideo failed:', response.status, data);
        return {
          success: false,
          error: data.error || { code: 'AWS_ERROR', message: `HTTP ${response.status}` },
        };
      }
      
      return data;
    } catch (error) {
      console.error('[AwsVideoClient] startVideo error:', error);
      return {
        success: false,
        error: { code: 'NETWORK_ERROR', message: String(error) },
      };
    }
  }
  
  /**
   * GET /video/status/{jobId} - ジョブステータスを取得
   */
  async getStatus(jobId: string): Promise<StatusVideoResponse> {
    const url = `${this.baseUrl}/video/status/${encodeURIComponent(jobId)}`;
    
    try {
      const signedHeaders = await signRequest('GET', url, '', this.accessKeyId, this.secretAccessKey, this.region);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: signedHeaders,
      });
      
      const data = await response.json() as StatusVideoResponse;
      
      if (!response.ok) {
        console.error('[AwsVideoClient] getStatus failed:', response.status, data);
        return {
          success: false,
          error: data.error || { code: 'AWS_ERROR', message: `HTTP ${response.status}` },
        };
      }
      
      return data;
    } catch (error) {
      console.error('[AwsVideoClient] getStatus error:', error);
      return {
        success: false,
        error: { code: 'NETWORK_ERROR', message: String(error) },
      };
    }
  }
}

/**
 * Create AWS Video Client from environment
 */
export function createAwsVideoClient(env: {
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_ORCH_BASE_URL?: string;
  AWS_REGION?: string;
}): AwsVideoClient | null {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    console.error('[AwsVideoClient] Missing AWS credentials in environment');
    return null;
  }
  return new AwsVideoClient(
    env.AWS_ACCESS_KEY_ID,
    env.AWS_SECRET_ACCESS_KEY,
    env.AWS_ORCH_BASE_URL,
    env.AWS_REGION
  );
}

// ====================================================================
// S3 Presigned URL Generation (Direct, without AWS Video Proxy)
// ====================================================================

const S3_SERVICE = 's3';
const DEFAULT_S3_BUCKET = 'rilarc-video-results';
const DEFAULT_PRESIGN_EXPIRES = 86400; // 24 hours

/**
 * Generate S3 presigned URL for GET request
 * This allows Cloudflare Workers to directly generate presigned URLs
 * without relying on AWS Video Proxy
 */
export async function generateS3PresignedUrl(
  s3Key: string,
  env: {
    AWS_ACCESS_KEY_ID?: string;
    AWS_SECRET_ACCESS_KEY?: string;
    AWS_REGION?: string;
  },
  options?: {
    bucket?: string;
    expiresIn?: number;
  }
): Promise<string | null> {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    console.error('[S3Presign] Missing AWS credentials');
    return null;
  }

  const bucket = options?.bucket || DEFAULT_S3_BUCKET;
  const region = env.AWS_REGION || DEFAULT_AWS_REGION;
  const expiresIn = options?.expiresIn || DEFAULT_PRESIGN_EXPIRES;

  try {
    const presignedUrl = await createS3PresignedUrl(
      'GET',
      bucket,
      s3Key,
      env.AWS_ACCESS_KEY_ID,
      env.AWS_SECRET_ACCESS_KEY,
      region,
      expiresIn
    );
    return presignedUrl;
  } catch (error) {
    console.error('[S3Presign] Failed to generate presigned URL:', error);
    return null;
  }
}

/**
 * Create S3 presigned URL using SigV4 signing
 * Implements AWS Signature Version 4 for S3 presigned URLs
 */
async function createS3PresignedUrl(
  method: string,
  bucket: string,
  key: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  expiresIn: number
): Promise<string> {
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const encodedKey = key.split('/').map(part => encodeURIComponent(part)).join('/');
  
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  
  const credentialScope = `${dateStamp}/${region}/${S3_SERVICE}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;
  
  // Query parameters for presigned URL
  const queryParams: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };
  
  // Build canonical query string (sorted)
  const sortedKeys = Object.keys(queryParams).sort();
  const canonicalQueryString = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
    .join('&');
  
  // Canonical request
  const canonicalUri = `/${encodedKey}`;
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const payloadHash = 'UNSIGNED-PAYLOAD';
  
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  
  // String to sign
  const canonicalRequestHash = await sha256(canonicalRequest);
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    canonicalRequestHash
  ].join('\n');
  
  // Calculate signature
  const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, S3_SERVICE);
  const signatureBuffer = await hmacSha256(signingKey, stringToSign);
  const signature = toHex(signatureBuffer);
  
  // Build final presigned URL
  const presignedUrl = `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
  
  return presignedUrl;
}

/**
 * Extract S3 bucket and key from various URL formats
 * 
 * Supported formats:
 * - Presigned: https://bucket.s3.region.amazonaws.com/key?X-Amz-...
 * - Public: https://bucket.s3.region.amazonaws.com/key
 * - Path style: https://s3.region.amazonaws.com/bucket/key
 */
export function parseS3Url(url: string): { bucket: string; key: string } | null {
  if (!url) return null;
  
  try {
    const parsed = new URL(url);
    
    // Virtual-hosted style: bucket.s3.region.amazonaws.com/key
    const virtualHostMatch = parsed.hostname.match(/^([^.]+)\.s3\.([^.]+)\.amazonaws\.com$/);
    if (virtualHostMatch) {
      const bucket = virtualHostMatch[1];
      const key = parsed.pathname.slice(1); // Remove leading /
      return { bucket, key };
    }
    
    // Path style: s3.region.amazonaws.com/bucket/key
    const pathStyleMatch = parsed.hostname.match(/^s3\.([^.]+)\.amazonaws\.com$/);
    if (pathStyleMatch) {
      const parts = parsed.pathname.slice(1).split('/');
      if (parts.length >= 2) {
        const bucket = parts[0];
        const key = parts.slice(1).join('/');
        return { bucket, key };
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Refresh an expired S3 presigned URL
 * 
 * This function:
 * 1. Parses the existing URL to extract bucket and key
 * 2. Generates a new presigned URL with fresh expiration
 * 
 * @param expiredUrl - The expired presigned URL
 * @param env - Environment with AWS credentials
 * @param s3Key - Optional: S3 key if known (more reliable than parsing)
 * @param s3Bucket - Optional: S3 bucket if known
 * @returns New presigned URL or null on failure
 */
export async function refreshS3PresignedUrl(
  expiredUrl: string,
  env: {
    AWS_ACCESS_KEY_ID?: string;
    AWS_SECRET_ACCESS_KEY?: string;
    AWS_REGION?: string;
  },
  s3Key?: string | null,
  s3Bucket?: string | null
): Promise<string | null> {
  // Use provided key/bucket if available
  if (s3Key) {
    return generateS3PresignedUrl(s3Key, env, { 
      bucket: s3Bucket || DEFAULT_S3_BUCKET 
    });
  }
  
  // Otherwise, parse from URL
  const parsed = parseS3Url(expiredUrl);
  if (!parsed) {
    console.error('[S3Presign] Failed to parse S3 URL:', expiredUrl);
    return null;
  }
  
  return generateS3PresignedUrl(parsed.key, env, { bucket: parsed.bucket });
}
