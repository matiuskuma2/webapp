/**
 * AWS Video Build Client (Remotion Orchestrator)
 * 
 * Video Build（プロジェクト全体の合算レンダリング）用のAWS API クライアント
 * 
 * エンドポイント:
 * - POST /video/build/start  → Video Build開始（project.jsonを送信）
 * - GET /video/build/status/{buildId} → ビルドステータス確認
 * 
 * 認証: SigV4 署名（aws-video-client.ts と同じ API Gateway を使用）
 * 
 * 注意: AWS_ORCH_BASE_URLが /prod で終わっている場合と終わっていない場合の両方に対応
 */

// ====================================================================
// AWS SigV4 Constants
// ====================================================================

const AWS_SERVICE = 'execute-api';
const DEFAULT_AWS_REGION = 'ap-northeast-1';

// ====================================================================
// Types
// ====================================================================

export interface VideoBuildSettings {
  captions: {
    enabled: boolean;
    position?: 'top' | 'bottom';
    show_speaker?: boolean;
  };
  bgm: {
    enabled: boolean;
    track?: string;  // Legacy: track name
    url?: string;    // R3-A: BGM file URL
    volume?: number;
    loop?: boolean;  // R3-A: Loop BGM
    fade_in_ms?: number;   // R3-A: Fade in duration
    fade_out_ms?: number;  // R3-A: Fade out duration
    // R3-B: Voice ducking settings
    ducking?: {
      enabled: boolean;
      volume: number;      // Volume during voice (0.0-1.0)
      attack_ms: number;   // Time to duck
      release_ms: number;  // Time to restore
    };
  };
  motion: {
    preset?: 'none' | 'gentle-zoom' | 'ken-burns';
    transition?: 'cut' | 'crossfade' | 'fade';
  };
  // PR-5-3b: テロップ設定
  telops?: {
    enabled?: boolean;
    position_preset?: 'bottom' | 'center' | 'top';
    size_preset?: 'sm' | 'md' | 'lg';
    scene_overrides?: Record<number, boolean>;  // scene_idx -> enabled
  };
  // PR2: Timeline オーディオ自動化
  audio_automation?: {
    timeline_bgm?: Array<{
      id: string;
      type: 'duck' | 'set_volume';
      start_ms: number;
      end_ms: number;
      volume: number;
      fade_in_ms?: number;
      fade_out_ms?: number;
    }>;
  };
}

export interface ProjectJsonScene {
  scene_id: number;
  idx: number;
  role: string;
  title: string;
  dialogue: string;
  asset: {
    type: 'image' | 'comic' | 'video';
    src: string;  // R2 URL
  };
  audio?: {
    src: string;  // Audio URL
    duration_ms: number;
  };
  utterances?: Array<{
    id: string;
    text: string;
    audio_url?: string;
    duration_ms?: number;
  }>;
  duration_ms: number;
  effects: {
    ken_burns: boolean;
  };
}

export interface ProjectJson {
  version: string;
  project_id: number;
  project_title: string;
  output: {
    aspect_ratio: '9:16' | '16:9' | '1:1';
    fps: number;
    resolution: '720p' | '1080p';
  };
  global: {
    captions: VideoBuildSettings['captions'];
    bgm: VideoBuildSettings['bgm'];
    motion: VideoBuildSettings['motion'];
  };
  scenes: ProjectJsonScene[];
  total_duration_ms: number;
  created_at: string;
}

export interface StartVideoBuildRequest {
  video_build_id: number;
  project_id: number;
  owner_user_id: number;
  executor_user_id: number;
  is_delegation: boolean;
  project_json: ProjectJson;
  build_settings: VideoBuildSettings;
}

export interface StartVideoBuildResponse {
  success: boolean;
  aws_job_id?: string;
  remotion?: {
    render_id: string;
    site_name?: string;
  };
  output?: {
    bucket: string;
    key: string;
  };
  message?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface VideoBuildStatusResponse {
  success: boolean;
  status?: 'queued' | 'rendering' | 'completed' | 'failed';
  progress?: {
    percent: number;
    stage: string;
    message?: string;
  };
  output?: {
    bucket: string;
    key: string;
    presigned_url?: string;
    size_bytes?: number;
    duration_ms?: number;
  };
  error?: {
    code: string;
    message: string;
  };
  render_metadata?: {
    render_id: string;
    started_at?: string;
    completed_at?: string;
    duration_sec?: number;
  };
}

export interface VideoBuildClientConfig {
  baseUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
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
  
  // SigV4: クエリパラメータはアルファベット順にソートし、URI エンコードする必要がある
  const sortedParams = Array.from(parsedUrl.searchParams.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const queryString = sortedParams;
  
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
// URL Normalization (二重prod防止)
// ====================================================================

/**
 * エンドポイントURLを正規化する
 * AWS_ORCH_BASE_URL が /prod で終わっている場合と終わっていない場合の両方に対応
 * 
 * @param baseUrl - AWS_ORCH_BASE_URL
 * @param path - エンドポイントパス (例: '/start', '/status/123')
 * @returns 正規化されたURL
 */
export function normalizeOrchestratorUrl(baseUrl: string, path: string): string {
  // 末尾のスラッシュを削除
  const cleanBase = baseUrl.replace(/\/+$/, '');
  
  // pathの先頭のスラッシュを削除
  const cleanPath = path.replace(/^\/+/, '');
  
  // baseUrlが /prod で終わっているかチェック
  const hasProd = cleanBase.endsWith('/prod');
  
  // /prod が無ければ追加、あればそのまま
  if (hasProd) {
    return `${cleanBase}/${cleanPath}`;
  } else {
    return `${cleanBase}/prod/${cleanPath}`;
  }
}

// ====================================================================
// API Client Functions (SigV4 対応版)
// ====================================================================

/**
 * Video Build を開始する
 * POST /video/build/start
 * 
 * @param config - クライアント設定（認証情報含む）
 * @param request - リクエストボディ
 * @param options - オプション（タイムアウト等）
 */
export async function startVideoBuild(
  config: VideoBuildClientConfig,
  request: StartVideoBuildRequest,
  options?: { timeout?: number }
): Promise<StartVideoBuildResponse> {
  const url = normalizeOrchestratorUrl(config.baseUrl, '/video/build/start');
  const body = JSON.stringify(request);
  const timeout = options?.timeout || 25000;  // API Gateway 29秒制限を考慮
  
  console.log('[VideoBuildClient] Calling start:', url);
  console.log('[VideoBuildClient] Request body length:', body.length);
  console.log('[VideoBuildClient] Scenes count:', request.project_json.scenes.length);
  
  try {
    // SigV4 署名
    const signedHeaders = await signRequest(
      'POST',
      url,
      body,
      config.accessKeyId,
      config.secretAccessKey,
      config.region || DEFAULT_AWS_REGION
    );
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: signedHeaders,
      body,
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    console.log('[VideoBuildClient] Response status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[VideoBuildClient] Error response:', errorText);
      
      try {
        const errorJson = JSON.parse(errorText);
        return {
          success: false,
          message: errorJson.message || errorJson.error?.message || `HTTP ${response.status}`,
          error: errorJson.error || { code: `HTTP_${response.status}`, message: errorText },
        };
      } catch {
        return {
          success: false,
          message: `HTTP ${response.status}: ${errorText}`,
          error: { code: `HTTP_${response.status}`, message: errorText },
        };
      }
    }
    
    const data = await response.json() as StartVideoBuildResponse;
    console.log('[VideoBuildClient] Response data:', JSON.stringify(data).substring(0, 500));
    
    return data;
    
  } catch (error) {
    console.error('[VideoBuildClient] Request failed:', error);
    
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        success: false,
        message: 'Request timeout',
        error: { code: 'TIMEOUT', message: `Request timed out after ${timeout}ms` },
      };
    }
    
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
      error: { code: 'NETWORK_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
    };
  }
}

/**
 * Video Build のステータスを取得する
 * GET /video/build/status/{buildId}
 * 
 * @param config - クライアント設定（認証情報含む）
 * @param buildId - ビルドID（aws_job_id または video_build_id）
 * @param params - オプションのクエリパラメータ
 * @param options - オプション（タイムアウト等）
 */
export async function getVideoBuildStatus(
  config: VideoBuildClientConfig,
  buildId: number | string,
  params?: {
    render_id?: string;
    output_key?: string;
  },
  options?: { timeout?: number }
): Promise<VideoBuildStatusResponse> {
  // クエリパラメータを構築
  const queryParams = new URLSearchParams();
  if (params?.render_id) {
    queryParams.set('render_id', params.render_id);
  }
  if (params?.output_key) {
    queryParams.set('output_key', params.output_key);
  }
  
  const queryString = queryParams.toString();
  const path = `/video/build/status/${buildId}${queryString ? `?${queryString}` : ''}`;
  const url = normalizeOrchestratorUrl(config.baseUrl, path);
  const timeout = options?.timeout || 25000;
  
  console.log('[VideoBuildClient] Calling status:', url);
  
  try {
    // SigV4 署名（GET なのでボディは空）
    const signedHeaders = await signRequest(
      'GET',
      url,
      '',
      config.accessKeyId,
      config.secretAccessKey,
      config.region || DEFAULT_AWS_REGION
    );
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: signedHeaders,
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    console.log('[VideoBuildClient] Status response:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[VideoBuildClient] Status error:', errorText);
      
      return {
        success: false,
        error: { code: `HTTP_${response.status}`, message: errorText },
      };
    }
    
    const data = await response.json() as VideoBuildStatusResponse;
    console.log('[VideoBuildClient] Status data:', JSON.stringify(data).substring(0, 500));
    
    return data;
    
  } catch (error) {
    console.error('[VideoBuildClient] Status request failed:', error);
    
    return {
      success: false,
      error: { 
        code: 'NETWORK_ERROR', 
        message: error instanceof Error ? error.message : 'Unknown error' 
      },
    };
  }
}

// ====================================================================
// Factory Function (環境変数から設定を取得)
// ====================================================================

export interface VideoBuildEnv {
  AWS_ORCH_BASE_URL?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;
}

/**
 * 環境変数からクライアント設定を生成
 * 認証情報が不足している場合は null を返す
 */
export function createVideoBuildClientConfig(env: VideoBuildEnv): VideoBuildClientConfig | null {
  if (!env.AWS_ORCH_BASE_URL || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    console.warn('[VideoBuildClient] Missing AWS credentials or base URL');
    return null;
  }
  
  return {
    baseUrl: env.AWS_ORCH_BASE_URL,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.AWS_REGION || DEFAULT_AWS_REGION,
  };
}

// ====================================================================
// Default S3 Bucket and Key Patterns
// ====================================================================

export const DEFAULT_OUTPUT_BUCKET = 'rilarc-remotion-renders-prod-202601';

export function getDefaultOutputKey(ownerUserId: number, videoBuildId: number): string {
  return `video-builds/owner-${ownerUserId}/video-build-${videoBuildId}.mp4`;
}
