/**
 * LaoZhang.ai Video Generation API Client
 * 
 * OpenAI互換のAPIゲートウェイを通じてVeo 3.1/Sora 2を利用。
 * コスト：公式の約1/10（$0.15/本、失敗時は無料）。
 * 
 * サポートモデル:
 *   - veo-3.1-fast   Veo 3.1 Fast（1-3分）$2.00/call
 *   - veo-3.1        Veo 3.1 Standard（3-8分）$2.00/call
 *   - veo3-pro       Veo 3 Pro（5-15分）$10.00/call
 *   - sora-2         Sora 2（10/15秒）$0.15/call（失敗無料）
 *   - sora-2-pro     Sora 2 Pro（HD）$0.80/call（非同期のみ）
 * 
 * APIs:
 *   - VEO: POST /veo/v1/api/video/submit → GET /veo/v1/api/video/status/{taskId}
 *   - Sora 2 Async: POST /v1/videos → GET /v1/videos/{id} → GET /v1/videos/{id}/content
 *   - Sora 2 Sync: POST /v1/chat/completions（テスト用、本番非推奨）
 * 
 * @see https://docs.laozhang.ai/
 */

// ====================================================================
// Types
// ====================================================================

export type LaozhangModel = 
  | 'veo-3.1-fast' 
  | 'veo-3.1' 
  | 'veo3-pro' 
  | 'sora-2' 
  | 'sora-2-pro';

export type LaozhangProvider = 'laozhang_veo' | 'laozhang_sora';

export interface LaozhangVideoRequest {
  model: LaozhangModel;
  prompt: string;
  /** For VEO: reference image URLs (max 5) for image-to-video */
  imageUrls?: string[];
  /** For Sora 2: image binary data for I2V (async only, requires upload) */
  imageData?: ArrayBuffer;
  imageMimeType?: string;
  /** Sora 2 specific */
  size?: '1280x720' | '720x1280';
  seconds?: '10' | '15';
  /** VEO specific */
  enhancePrompt?: boolean;
}

export interface LaozhangSubmitResponse {
  success: boolean;
  taskId?: string;
  provider: LaozhangProvider;
  model: LaozhangModel;
  error?: { code: string; message: string };
}

export interface LaozhangStatusResponse {
  success: boolean;
  status: 'submitted' | 'processing' | 'completed' | 'failed';
  progress?: number;
  videoUrl?: string;
  error?: { code: string; message: string };
  rawData?: any;
}

// ====================================================================
// Constants
// ====================================================================

const LAOZHANG_BASE_URL = 'https://api.laozhang.ai';
const VEO_SUBMIT_URL = `${LAOZHANG_BASE_URL}/veo/v1/api/video/submit`;
const VEO_STATUS_URL = `${LAOZHANG_BASE_URL}/veo/v1/api/video/status`;
const SORA_VIDEOS_URL = `${LAOZHANG_BASE_URL}/v1/videos`;

// ====================================================================
// Cost estimation
// ====================================================================

export function estimateLaozhangCost(model: LaozhangModel): number {
  switch (model) {
    case 'veo-3.1-fast':
    case 'veo-3.1':
      return 2.00;
    case 'veo3-pro':
      return 10.00;
    case 'sora-2':
      return 0.15;
    case 'sora-2-pro':
      return 0.80;
    default:
      return 2.00;
  }
}

/** Detect provider from model */
export function detectLaozhangProvider(model: LaozhangModel): LaozhangProvider {
  if (model.startsWith('sora')) return 'laozhang_sora';
  return 'laozhang_veo';
}

// ====================================================================
// VEO API Client (Custom API)
// ====================================================================

async function submitVeoTask(
  apiKey: string,
  request: LaozhangVideoRequest
): Promise<LaozhangSubmitResponse> {
  const body: Record<string, any> = {
    model: request.model === 'veo-3.1-fast' ? 'veo3-fast' : 
           request.model === 'veo-3.1' ? 'veo3' :
           request.model === 'veo3-pro' ? 'veo3-pro' : 'veo3-fast',
    prompt: request.prompt,
    enhance_prompt: request.enhancePrompt ?? false,
  };

  // Image-to-Video: add reference image URLs
  if (request.imageUrls && request.imageUrls.length > 0) {
    body.images = request.imageUrls;
  }

  try {
    const response = await fetch(VEO_SUBMIT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json() as any;

    if (!response.ok || !data.success) {
      console.error('[LaozhangVEO] Submit failed:', response.status, data);
      return {
        success: false,
        provider: 'laozhang_veo',
        model: request.model,
        error: {
          code: data.error_code || `HTTP_${response.status}`,
          message: data.message || `VEO submit failed: HTTP ${response.status}`,
        },
      };
    }

    const taskId = data.data?.taskId;
    if (!taskId) {
      return {
        success: false,
        provider: 'laozhang_veo',
        model: request.model,
        error: { code: 'NO_TASK_ID', message: 'VEO submit succeeded but no taskId returned' },
      };
    }

    console.log(`[LaozhangVEO] Task submitted: ${taskId}`);
    return {
      success: true,
      taskId,
      provider: 'laozhang_veo',
      model: request.model,
    };
  } catch (error) {
    console.error('[LaozhangVEO] Submit error:', error);
    return {
      success: false,
      provider: 'laozhang_veo',
      model: request.model,
      error: { code: 'NETWORK_ERROR', message: String(error) },
    };
  }
}

async function getVeoStatus(
  apiKey: string,
  taskId: string
): Promise<LaozhangStatusResponse> {
  try {
    const response = await fetch(`${VEO_STATUS_URL}/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    const data = await response.json() as any;

    if (!response.ok || !data.success) {
      return {
        success: false,
        status: 'failed',
        error: {
          code: data.error_code || `HTTP_${response.status}`,
          message: data.message || `VEO status failed: HTTP ${response.status}`,
        },
      };
    }

    const taskData = data.data;
    const taskStatus = taskData?.status;

    if (taskStatus === 'completed') {
      const videoUrl = taskData?.result?.video_url;
      return {
        success: true,
        status: 'completed',
        videoUrl,
        rawData: taskData,
      };
    }

    if (taskStatus === 'failed') {
      return {
        success: true,
        status: 'failed',
        error: {
          code: 'GENERATION_FAILED',
          message: taskData?.error?.message || 'VEO video generation failed',
        },
        rawData: taskData,
      };
    }

    // processing or other intermediate states
    const progress = taskData?.progress;
    return {
      success: true,
      status: 'processing',
      progress: progress?.retryCount != null ? undefined : undefined,
      rawData: taskData,
    };
  } catch (error) {
    console.error('[LaozhangVEO] Status error:', error);
    return {
      success: false,
      status: 'failed',
      error: { code: 'NETWORK_ERROR', message: String(error) },
    };
  }
}

// ====================================================================
// Sora 2 Async API Client
// ====================================================================

async function submitSoraTask(
  apiKey: string,
  request: LaozhangVideoRequest
): Promise<LaozhangSubmitResponse> {
  const model = request.model === 'sora-2-pro' ? 'sora-2-pro' : 'sora-2';
  const size = request.size || '1280x720';
  const seconds = request.seconds || '10';

  try {
    let response: Response;

    if (request.imageData) {
      // Image-to-Video: requires multipart/form-data upload
      // Note: In Cloudflare Workers, FormData is available via the standard Web API
      const formData = new FormData();
      formData.append('model', model);
      formData.append('prompt', request.prompt);
      formData.append('size', size);
      formData.append('seconds', seconds);
      
      const blob = new Blob([request.imageData], { type: request.imageMimeType || 'image/png' });
      formData.append('input_reference', blob, 'image.png');

      response = await fetch(SORA_VIDEOS_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        body: formData,
      });
    } else {
      // Text-to-Video: JSON body
      response = await fetch(SORA_VIDEOS_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt: request.prompt,
          size,
          seconds,
        }),
      });
    }

    const data = await response.json() as any;

    if (!response.ok) {
      console.error('[LaozhangSora] Submit failed:', response.status, data);
      return {
        success: false,
        provider: 'laozhang_sora',
        model: request.model,
        error: {
          code: data.error?.code || `HTTP_${response.status}`,
          message: data.error?.message || `Sora submit failed: HTTP ${response.status}`,
        },
      };
    }

    const taskId = data.id;
    if (!taskId) {
      return {
        success: false,
        provider: 'laozhang_sora',
        model: request.model,
        error: { code: 'NO_TASK_ID', message: 'Sora submit succeeded but no task ID returned' },
      };
    }

    console.log(`[LaozhangSora] Task submitted: ${taskId}, model=${model}`);
    return {
      success: true,
      taskId,
      provider: 'laozhang_sora',
      model: request.model,
    };
  } catch (error) {
    console.error('[LaozhangSora] Submit error:', error);
    return {
      success: false,
      provider: 'laozhang_sora',
      model: request.model,
      error: { code: 'NETWORK_ERROR', message: String(error) },
    };
  }
}

async function getSoraStatus(
  apiKey: string,
  taskId: string
): Promise<LaozhangStatusResponse> {
  try {
    const response = await fetch(`${SORA_VIDEOS_URL}/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    const data = await response.json() as any;

    if (!response.ok) {
      return {
        success: false,
        status: 'failed',
        error: {
          code: data.error?.code || `HTTP_${response.status}`,
          message: data.error?.message || `Sora status failed: HTTP ${response.status}`,
        },
      };
    }

    const taskStatus = data.status;

    if (taskStatus === 'completed') {
      // Sora async API: video URL is in data.url, or download via /content endpoint
      const videoUrl = data.url || `${SORA_VIDEOS_URL}/${encodeURIComponent(taskId)}/content`;
      return {
        success: true,
        status: 'completed',
        videoUrl,
        rawData: data,
      };
    }

    if (taskStatus === 'failed') {
      return {
        success: true,
        status: 'failed',
        error: {
          code: 'GENERATION_FAILED',
          message: data.error?.message || 'Sora video generation failed',
        },
        rawData: data,
      };
    }

    // submitted or in_progress
    return {
      success: true,
      status: taskStatus === 'submitted' ? 'submitted' : 'processing',
      progress: data.progress || 0,
      rawData: data,
    };
  } catch (error) {
    console.error('[LaozhangSora] Status error:', error);
    return {
      success: false,
      status: 'failed',
      error: { code: 'NETWORK_ERROR', message: String(error) },
    };
  }
}

// ====================================================================
// Unified Client
// ====================================================================

/**
 * LaoZhang.ai ビデオ生成クライアント
 * VEO 3.1 / Sora 2 の統一インターフェース
 */
export class LaozhangVideoClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * 動画生成タスクを送信
   */
  async submitTask(request: LaozhangVideoRequest): Promise<LaozhangSubmitResponse> {
    const provider = detectLaozhangProvider(request.model);
    
    if (provider === 'laozhang_sora') {
      return submitSoraTask(this.apiKey, request);
    } else {
      return submitVeoTask(this.apiKey, request);
    }
  }

  /**
   * タスクの状態を取得
   */
  async getStatus(taskId: string, model: LaozhangModel): Promise<LaozhangStatusResponse> {
    const provider = detectLaozhangProvider(model);
    
    if (provider === 'laozhang_sora') {
      return getSoraStatus(this.apiKey, taskId);
    } else {
      return getVeoStatus(this.apiKey, taskId);
    }
  }

  /**
   * 動画コンテンツをダウンロード（Sora 2 async APIのみ）
   * Returns: Response body (stream)
   */
  async downloadVideo(taskId: string): Promise<Response> {
    const url = `${SORA_VIDEOS_URL}/${encodeURIComponent(taskId)}/content`;
    return fetch(url, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
  }
}

/**
 * Factory: Create LaoZhang client from environment
 */
export function createLaozhangClient(env: {
  LAOZHANG_API_KEY?: string;
}): LaozhangVideoClient | null {
  if (!env.LAOZHANG_API_KEY) {
    return null;
  }
  return new LaozhangVideoClient(env.LAOZHANG_API_KEY);
}
