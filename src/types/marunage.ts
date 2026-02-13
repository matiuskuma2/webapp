/**
 * Marunage Chat MVP - Type Definitions
 * 
 * Ref: docs/MARUNAGE_CHAT_MVP_PLAN_v3.md §2-3, §3
 * Ref: docs/MARUNAGE_EXPERIENCE_SPEC_v1.md §13
 */

// ============================================================
// Phase & Transitions
// ============================================================

export type MarunagePhase =
  | 'init'
  | 'formatting'
  | 'awaiting_ready'
  | 'generating_images'
  | 'generating_audio'
  | 'building_video'    // P1: video build phase
  | 'video_ready'       // P1: video complete (new terminal)
  | 'ready'             // MVP terminal (material ready, video not built)
  | 'failed'
  | 'canceled'

export const TERMINAL_PHASES: readonly MarunagePhase[] = ['ready', 'video_ready', 'failed', 'canceled'] as const

export const ALLOWED_TRANSITIONS: Record<MarunagePhase, readonly MarunagePhase[]> = {
  'init':              ['formatting'],
  'formatting':        ['awaiting_ready', 'failed'],
  'awaiting_ready':    ['generating_images', 'failed', 'canceled'],
  'generating_images': ['generating_audio', 'failed', 'canceled'],
  'generating_audio':  ['building_video', 'ready', 'failed', 'canceled'],  // ready = skip video; building_video = full pipeline
  'building_video':    ['video_ready', 'failed', 'canceled'],
  'video_ready':       [],  // terminal
  'ready':             ['building_video'],  // can start video build from ready state
  'failed':            ['formatting', 'awaiting_ready', 'generating_images', 'generating_audio', 'building_video'],  // retry
  'canceled':          [],  // terminal
} as const

// Retry: which phase to roll back to from error_phase
export const RETRY_ROLLBACK_MAP: Record<string, MarunagePhase> = {
  'formatting':        'formatting',
  'awaiting_ready':    'awaiting_ready',
  'generating_images': 'awaiting_ready',   // re-generate from awaiting_ready
  'generating_audio':  'generating_images', // re-generate audio after images confirmed
  'building_video':    'building_video',    // retry video build directly
} as const

export const MAX_RETRY_COUNT = 5

// ============================================================
// Config (frozen at run creation)
// ============================================================

export interface MarunageNarrationVoice {
  provider: 'google' | 'elevenlabs' | 'fish'
  voice_id: string
}

export interface MarunageConfig {
  experience_tag: 'marunage_chat_v1'
  target_scene_count: number       // MVP: always 5
  split_mode: 'ai' | 'preserve'   // MVP: always 'ai'
  output_preset: string            // e.g. 'yt_long', 'short_vertical'
  narration_voice: MarunageNarrationVoice
  bgm_mode: 'none' | 'auto'       // MVP: always 'none'
}

export const DEFAULT_CONFIG: MarunageConfig = {
  experience_tag: 'marunage_chat_v1',
  target_scene_count: 5,
  split_mode: 'ai',
  output_preset: 'yt_long',
  narration_voice: { provider: 'google', voice_id: 'ja-JP-Neural2-B' },
  bgm_mode: 'none',
}

// ============================================================
// DB Row Type
// ============================================================

export interface MarunageRunRow {
  id: number
  project_id: number
  phase: MarunagePhase
  config_json: string
  started_by_user_id: number | null
  started_from: string | null
  error_code: string | null
  error_message: string | null
  error_phase: string | null
  retry_count: number
  audio_job_id: number | null
  video_build_id: number | null  // P1: link to video_builds table
  locked_at: string | null
  locked_until: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

// ============================================================
// API Request / Response Types
// ============================================================

export interface MarunageStartRequest {
  title?: string           // 1-200 chars, optional
  text: string             // 100-50000 chars, required
  narration_voice?: {
    provider?: string
    voice_id: string
  }
  output_preset?: string   // 'yt_long' | 'short_vertical'
  target_scene_count?: number  // 3-10, default 5
}

export interface MarunageStatusResponse {
  run_id: number
  project_id: number
  phase: MarunagePhase
  config: MarunageConfig
  error: {
    code: string | null
    message: string | null
    phase: string | null
  } | null
  progress: {
    format: {
      state: 'pending' | 'running' | 'done' | 'failed'
      scene_count: number
      chunks: { total: number; done: number; failed: number; pending: number }
    }
    scenes_ready: {
      state: 'pending' | 'done'
      visible_count: number
      utterances_ready: boolean
      scenes: Array<{
        id: number
        idx: number
        title: string | null
        has_image: boolean
        image_url: string | null
        has_audio: boolean
        utterance_count: number
      }>
    }
    images: {
      state: 'pending' | 'running' | 'done' | 'failed'
      total: number
      completed: number
      generating: number
      failed: number
      pending: number
    }
    audio: {
      state: 'pending' | 'running' | 'done' | 'failed'
      job_id: number | null
      job_status: string | null
      total_utterances: number
      completed: number
      failed: number
    }
    video: {
      state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
      build_id: number | null
      build_status: string | null
      progress_percent: number | null
      download_url: string | null
    }
  }
  timestamps: {
    created_at: string
    updated_at: string
    completed_at: string | null
  }
}

export interface MarunageAdvanceResponse {
  run_id: number
  previous_phase: MarunagePhase
  new_phase: MarunagePhase
  action: string
  message: string
}

// ============================================================
// Error codes specific to Marunage
// ============================================================

export const MARUNAGE_ERRORS = {
  UNAUTHORIZED:    { code: 'UNAUTHORIZED',    status: 401 },
  NOT_FOUND:       { code: 'NOT_FOUND',       status: 404 },
  FORBIDDEN:       { code: 'FORBIDDEN',       status: 403 },
  INVALID_REQUEST: { code: 'INVALID_REQUEST', status: 400 },
  CONFLICT:        { code: 'CONFLICT',        status: 409 },
  INVALID_PHASE:   { code: 'INVALID_PHASE',   status: 400 },
  RETRY_EXHAUSTED: { code: 'RETRY_EXHAUSTED', status: 400 },
  INTERNAL_ERROR:  { code: 'INTERNAL_ERROR',  status: 500 },
} as const
