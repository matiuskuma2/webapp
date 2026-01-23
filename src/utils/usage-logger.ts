/**
 * Usage Logger Utility
 * 
 * Unified logging for all cost-related events:
 * - bgm_upload / sfx_upload
 * - patch_dry_run / patch_apply
 * - chat_edit_dry_run / chat_edit_apply
 * - video_build_render
 * - (future) llm_intent
 */

/**
 * API types for usage logging
 */
export type ApiType = 
  // Audio uploads
  | 'bgm_upload'
  | 'sfx_upload'
  // Patch operations
  | 'patch_dry_run'
  | 'patch_apply'
  // Chat edit operations
  | 'chat_edit_dry_run'
  | 'chat_edit_apply'
  // Video build
  | 'video_build_render'
  // LLM (future)
  | 'llm_intent'
  // Legacy types (existing)
  | 'video_generation'
  | 'video_build'
  | 'image_generation';

/**
 * Usage log entry parameters
 */
export interface UsageLogParams {
  userId: number;
  projectId?: number | null;
  apiType: ApiType;
  provider: string;
  model?: string | null;
  status: 'success' | 'failed';
  estimatedCostUsd?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Log a usage event to api_usage_logs
 * 
 * @param db D1Database instance
 * @param params Log parameters
 */
export async function logUsageEvent(
  db: D1Database,
  params: UsageLogParams
): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO api_usage_logs (
        user_id, project_id, api_type, provider, model,
        estimated_cost_usd, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      params.userId,
      params.projectId || null,
      params.apiType,
      params.provider,
      params.model || null,
      params.estimatedCostUsd ?? 0,
      params.metadata ? JSON.stringify(params.metadata) : null
    ).run();
    
    console.log(`[UsageLog] ${params.apiType}: user=${params.userId}, project=${params.projectId}, status=${params.status}`);
  } catch (error) {
    // Don't fail the main operation if logging fails
    console.error('[UsageLog] Failed to log usage event:', error);
  }
}

/**
 * BGM Upload logging helper
 */
export async function logBgmUpload(
  db: D1Database,
  params: {
    userId: number;
    projectId: number;
    trackId: number;
    bytes: number;
    durationMs?: number | null;
    format?: string;
    status: 'success' | 'failed';
    errorMessage?: string;
  }
): Promise<void> {
  await logUsageEvent(db, {
    userId: params.userId,
    projectId: params.projectId,
    apiType: 'bgm_upload',
    provider: 'r2',
    status: params.status,
    estimatedCostUsd: 0, // R2 storage cost is separate (Cloudflare billing)
    metadata: {
      track_id: params.trackId,
      bytes: params.bytes,
      duration_ms: params.durationMs,
      format: params.format,
      error_message: params.errorMessage,
    },
  });
}

/**
 * SFX Upload logging helper
 */
export async function logSfxUpload(
  db: D1Database,
  params: {
    userId: number;
    projectId: number;
    sceneId: number;
    cueId: number;
    bytes: number;
    durationMs?: number | null;
    format?: string;
    status: 'success' | 'failed';
    errorMessage?: string;
  }
): Promise<void> {
  await logUsageEvent(db, {
    userId: params.userId,
    projectId: params.projectId,
    apiType: 'sfx_upload',
    provider: 'r2',
    status: params.status,
    estimatedCostUsd: 0, // R2 storage cost is separate
    metadata: {
      scene_id: params.sceneId,
      cue_id: params.cueId,
      bytes: params.bytes,
      duration_ms: params.durationMs,
      format: params.format,
      error_message: params.errorMessage,
    },
  });
}

/**
 * Patch operation logging helper
 */
export async function logPatchOperation(
  db: D1Database,
  params: {
    userId: number;
    projectId: number;
    patchRequestId: number;
    operation: 'dry_run' | 'apply';
    source: 'api' | 'chat';
    opsCount: number;
    entities: string[];
    newVideoBuildId?: number | null;
    status: 'success' | 'failed';
    errorMessage?: string;
  }
): Promise<void> {
  const apiType = params.source === 'chat' 
    ? (params.operation === 'dry_run' ? 'chat_edit_dry_run' : 'chat_edit_apply')
    : (params.operation === 'dry_run' ? 'patch_dry_run' : 'patch_apply');
    
  await logUsageEvent(db, {
    userId: params.userId,
    projectId: params.projectId,
    apiType: apiType as ApiType,
    provider: 'ssot',
    status: params.status,
    estimatedCostUsd: 0, // Patch operations have no direct cost
    metadata: {
      patch_request_id: params.patchRequestId,
      ops_count: params.opsCount,
      entities: params.entities,
      new_video_build_id: params.newVideoBuildId,
      error_message: params.errorMessage,
    },
  });
}

/**
 * Video Build render logging helper
 */
export async function logVideoBuildRender(
  db: D1Database,
  params: {
    userId: number;
    projectId: number;
    videoBuildId: number;
    totalScenes: number;
    totalDurationMs: number;
    fps?: number;
    renderTimeMs?: number | null;
    status: 'success' | 'failed';
    errorMessage?: string;
    errorCode?: string;
  }
): Promise<void> {
  // Rough estimate: $0.001 per second of video at 30fps
  // This is a very rough estimate for AWS Lambda rendering
  const estimatedCost = (params.totalDurationMs / 1000) * 0.001;
  
  await logUsageEvent(db, {
    userId: params.userId,
    projectId: params.projectId,
    apiType: 'video_build_render',
    provider: 'remotion_lambda',
    status: params.status,
    estimatedCostUsd: params.status === 'success' ? estimatedCost : 0,
    metadata: {
      video_build_id: params.videoBuildId,
      total_scenes: params.totalScenes,
      total_duration_ms: params.totalDurationMs,
      fps: params.fps ?? 30,
      render_time_ms: params.renderTimeMs,
      error_message: params.errorMessage,
      error_code: params.errorCode,
    },
  });
}

/**
 * LLM Intent generation logging helper (for Safe Chat v1)
 */
export async function logLlmIntent(
  db: D1Database,
  params: {
    userId: number;
    projectId: number;
    videoBuildId?: number | null;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    confidence?: number;
    needsConfirmation?: boolean;
    status: 'success' | 'failed';
    errorMessage?: string;
  }
): Promise<void> {
  // Cost estimation (OpenAI GPT-4o example)
  // Prompt: $0.005/1K tokens, Completion: $0.015/1K tokens
  const promptRate = params.provider === 'openai' ? 0.005 : 0.0025;
  const completionRate = params.provider === 'openai' ? 0.015 : 0.01;
  
  const estimatedCost = 
    (params.promptTokens * promptRate / 1000) +
    (params.completionTokens * completionRate / 1000);
  
  await logUsageEvent(db, {
    userId: params.userId,
    projectId: params.projectId,
    apiType: 'llm_intent',
    provider: params.provider,
    model: params.model,
    status: params.status,
    estimatedCostUsd: estimatedCost,
    metadata: {
      video_build_id: params.videoBuildId,
      prompt_tokens: params.promptTokens,
      completion_tokens: params.completionTokens,
      total_tokens: params.promptTokens + params.completionTokens,
      confidence: params.confidence,
      needs_confirmation: params.needsConfirmation,
      error_message: params.errorMessage,
    },
  });
}
