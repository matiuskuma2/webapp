/**
 * AWS Video Build Client (Remotion Orchestrator)
 * 
 * Video Build（プロジェクト全体の合算レンダリング）用のAWS API クライアント
 * 
 * エンドポイント:
 * - POST /start  → Video Build開始（project.jsonを送信）
 * - GET /status/{buildId} → ビルドステータス確認
 * 
 * 注意: AWS_ORCH_BASE_URLが /prod で終わっている場合と終わっていない場合の両方に対応
 */

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
    track?: string;
    volume?: number;
  };
  motion: {
    preset?: 'none' | 'gentle-zoom' | 'ken-burns';
    transition?: 'cut' | 'crossfade' | 'fade';
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
// API Client Functions
// ====================================================================

/**
 * Video Build を開始する
 * POST /start
 */
export async function startVideoBuild(
  baseUrl: string,
  request: StartVideoBuildRequest,
  options?: { timeout?: number }
): Promise<StartVideoBuildResponse> {
  const url = normalizeOrchestratorUrl(baseUrl, '/start');
  const body = JSON.stringify(request);
  const timeout = options?.timeout || 25000;  // API Gateway 29秒制限を考慮
  
  console.log('[VideoBuildClient] Calling start:', url);
  console.log('[VideoBuildClient] Request body length:', body.length);
  console.log('[VideoBuildClient] Scenes count:', request.project_json.scenes.length);
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
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
 * GET /status/{buildId}
 */
export async function getVideoBuildStatus(
  baseUrl: string,
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
  const path = `/status/${buildId}${queryString ? `?${queryString}` : ''}`;
  const url = normalizeOrchestratorUrl(baseUrl, path);
  const timeout = options?.timeout || 25000;
  
  console.log('[VideoBuildClient] Calling status:', url);
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
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
// Default S3 Bucket and Key Patterns
// ====================================================================

export const DEFAULT_OUTPUT_BUCKET = 'rilarc-remotion-renders-prod-202601';

export function getDefaultOutputKey(ownerUserId: number, videoBuildId: number): string {
  return `video-builds/owner-${ownerUserId}/video-build-${videoBuildId}.mp4`;
}
