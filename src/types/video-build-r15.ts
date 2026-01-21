/**
 * R1.5 Video Build Types
 * 
 * webapp (SSOT) 側の型定義
 * Remotion側と同期を保つ
 * 
 * ## 変更点 (R1.1 → R1.5)
 * - scenes[].assets.audio → scenes[].assets.voices[]
 * - VoiceAsset: ナレーション/キャラ別音声の両方に対応
 * - build_settings.aspect_ratio: 画角選択
 */

// ====================================================================
// VoiceAsset
// ====================================================================

export interface VoiceAsset {
  /** 一意識別子 */
  id: string;
  
  /** 話者種別: narration=地の文, dialogue=キャラセリフ */
  role: 'narration' | 'dialogue';
  
  /** キャラクターキー (narrationの場合はnull/undefined) */
  character_key?: string | null;
  
  /** キャラクター表示名 (UI用) */
  character_name?: string | null;
  
  /** 音声URL (mp3/wav) */
  audio_url: string;
  
  /** 音声の長さ (ms) - 実測値 */
  duration_ms: number;
  
  /** テキスト内容 - 字幕/再生成用のSSOT */
  text: string;
  
  /** シーン内相対開始時間 (ms) */
  start_ms?: number;
  
  /** 音声フォーマット */
  format?: 'mp3' | 'wav';
}

// ====================================================================
// ImageAsset
// ====================================================================

export interface ImageAsset {
  url: string;
  width: number;
  height: number;
}

// ====================================================================
// VideoClipAsset
// ====================================================================

export interface VideoClipAsset {
  url: string;
  duration_ms: number;
}

// ====================================================================
// SceneAssets - R1.5
// ====================================================================

export interface SceneAssets_R15 {
  /** 背景画像 */
  image?: ImageAsset;
  
  /** 動画クリップ */
  video_clip?: VideoClipAsset;
  
  /** 音声配列 - R1.5の核心 */
  voices?: VoiceAsset[];
  
  /** @deprecated R1.5では voices[] を使用 */
  audio?: {
    url: string;
    duration_ms: number;
    format: 'mp3' | 'wav';
  };
}

// ====================================================================
// SceneTiming
// ====================================================================

export interface SceneTiming {
  start_ms: number;
  duration_ms: number;
  head_pad_ms?: number;
  tail_pad_ms?: number;
}

// ====================================================================
// ProjectScene - R1.5
// ====================================================================

export interface ProjectScene_R15 {
  idx: number;
  role: string;
  title: string;
  /** @deprecated R1.5では assets.voices[].text を使用 */
  dialogue: string;
  timing: SceneTiming;
  assets: SceneAssets_R15;
  characters?: {
    image?: string[];
    voice?: string;
  };
}

// ====================================================================
// BuildSettings - R1.5
// ====================================================================

export interface BuildSettings_R15 {
  preset: string;
  aspect_ratio: '9:16' | '16:9' | '1:1';
  resolution: {
    width: number;
    height: number;
  };
  fps: number;
  codec: 'h264' | 'h265';
  audio?: {
    bgm_enabled: boolean;
    bgm_volume: number;
    narration_volume: number;
    duck_bgm_on_voice: boolean;
  };
  transition?: {
    type: 'none' | 'fade' | 'slide' | 'wipe';
    duration_ms: number;
  };
}

// ====================================================================
// ProjectAssets (Global)
// ====================================================================

export interface ProjectAssets_R15 {
  bgm?: {
    url: string;
    duration_ms?: number;
    volume: number;
  };
}

// ====================================================================
// ProjectJson - R1.5
// ====================================================================

export interface ProjectJson_R15 {
  schema_version: '1.5';
  project_id: number;
  project_title: string;
  created_at: string;
  build_settings: BuildSettings_R15;
  global: {
    default_scene_duration_ms: number;
    transition_duration_ms: number;
  };
  assets?: ProjectAssets_R15;
  scenes: ProjectScene_R15[];
  summary: {
    total_scenes: number;
    total_duration_ms: number;
    has_audio: boolean;
    has_video_clips: boolean;
    scenes_with_voices?: number;
  };
}

// ====================================================================
// Constants
// ====================================================================

export const R15_CONSTANTS = {
  DEFAULT_SCENE_DURATION_MS: 5000,
  AUDIO_TAIL_PADDING_MS: 500,
  TEXT_DURATION_MS_PER_CHAR: 300,
  MIN_SCENE_DURATION_MS: 2000,
  
  RESOLUTION_MAP: {
    '1080p': {
      '9:16': { width: 1080, height: 1920 },
      '16:9': { width: 1920, height: 1080 },
      '1:1': { width: 1080, height: 1080 },
    },
    '720p': {
      '9:16': { width: 720, height: 1280 },
      '16:9': { width: 1280, height: 720 },
      '1:1': { width: 720, height: 720 },
    },
  },
} as const;

// ====================================================================
// Duration Calculation (SSOT)
// ====================================================================

/**
 * シーンの尺を計算 - R1.5 SSOT
 */
export function computeSceneDuration_R15(
  assets: SceneAssets_R15,
  dialogue?: string,
  headPadMs: number = 0,
  tailPadMs: number = R15_CONSTANTS.AUDIO_TAIL_PADDING_MS
): number {
  // 1. voices[] から計算
  if (assets.voices && assets.voices.length > 0) {
    const voicesDuration = assets.voices.reduce((sum, v) => sum + v.duration_ms, 0);
    return voicesDuration + headPadMs + tailPadMs;
  }
  
  // 2. video_clip から計算
  if (assets.video_clip?.duration_ms) {
    return assets.video_clip.duration_ms;
  }
  
  // 3. legacy audio から計算
  if (assets.audio?.duration_ms) {
    return assets.audio.duration_ms + headPadMs + tailPadMs;
  }
  
  // 4. dialogue から推定
  if (dialogue && dialogue.length > 0) {
    const estimated = dialogue.length * R15_CONSTANTS.TEXT_DURATION_MS_PER_CHAR;
    return Math.max(R15_CONSTANTS.MIN_SCENE_DURATION_MS, estimated) + headPadMs + tailPadMs;
  }
  
  // 5. デフォルト
  return R15_CONSTANTS.DEFAULT_SCENE_DURATION_MS;
}

/**
 * voices[] 内の各 voice の start_ms を計算（累積）
 */
export function computeVoiceTimings(voices: VoiceAsset[]): VoiceAsset[] {
  let currentMs = 0;
  
  return voices.map((voice) => {
    const startMs = voice.start_ms ?? currentMs;
    currentMs = startMs + voice.duration_ms;
    
    return {
      ...voice,
      start_ms: startMs,
    };
  });
}

// ====================================================================
// Migration Helper: R1.1 → R1.5
// ====================================================================

/**
 * R1.1 の audio を R1.5 の voices[] に変換
 */
export function migrateAudioToVoices(
  audio: { url: string; duration_ms: number; format: 'mp3' | 'wav' } | undefined,
  dialogue: string,
  sceneIdx: number
): VoiceAsset[] {
  if (!audio) {
    return [];
  }
  
  return [{
    id: `voice-scene${sceneIdx}-0`,
    role: 'narration',
    character_key: null,
    character_name: null,
    audio_url: audio.url,
    duration_ms: audio.duration_ms,
    text: dialogue,
    start_ms: 0,
    format: audio.format,
  }];
}
