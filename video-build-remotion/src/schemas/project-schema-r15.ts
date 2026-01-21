/**
 * R1.5 Project Schema
 * 
 * R1.5の核心: 音声を「Scene内の複数Voice配列」として管理
 * 
 * ## 変更点 (R1.1 → R1.5)
 * - scenes[].assets.audio (単一) → scenes[].assets.voices[] (配列)
 * - VoiceAsset: ナレーション/キャラ別音声の両方に対応
 * - duration_ms の計算: Σ(voices[].duration_ms) + padding
 * - dialogue は後方互換として維持（R2で廃止予定）
 * 
 * ## SSOT ルール
 * - 音声: VoiceAsset[] が唯一の真実
 * - 字幕: VoiceAsset.text から表示
 * - 尺: Σ(voices[].duration_ms) + head_pad_ms + tail_pad_ms
 */

import { z } from 'zod';

// ====================================================================
// VoiceAsset - R1.5の核心
// ====================================================================

export const VoiceAssetSchema = z.object({
  /** 一意識別子 */
  id: z.string(),
  
  /** 話者種別: narration=地の文, dialogue=キャラセリフ */
  role: z.enum(['narration', 'dialogue']),
  
  /** キャラクターキー (narrationの場合はnull/undefined) */
  character_key: z.string().optional().nullable(),
  
  /** キャラクター表示名 (UI用) */
  character_name: z.string().optional().nullable(),
  
  /** 音声URL (mp3/wav) */
  audio_url: z.string(),
  
  /** 音声の長さ (ms) - 実測値 */
  duration_ms: z.number(),
  
  /** テキスト内容 - 字幕/再生成用のSSOT */
  text: z.string(),
  
  /** シーン内相対開始時間 (ms) - 省略時は前のvoiceの直後 */
  start_ms: z.number().optional(),
  
  /** 音声フォーマット */
  format: z.enum(['mp3', 'wav']).default('mp3'),
});

export type VoiceAsset = z.infer<typeof VoiceAssetSchema>;

// ====================================================================
// ImageAsset
// ====================================================================

export const ImageAssetSchema = z.object({
  url: z.string(),
  width: z.number(),
  height: z.number(),
});

export type ImageAsset = z.infer<typeof ImageAssetSchema>;

// ====================================================================
// VideoClipAsset
// ====================================================================

export const VideoClipAssetSchema = z.object({
  url: z.string(),
  duration_ms: z.number(),
});

export type VideoClipAsset = z.infer<typeof VideoClipAssetSchema>;

// ====================================================================
// SceneAssets - R1.5
// ====================================================================

export const SceneAssetsSchema = z.object({
  /** 背景画像 */
  image: ImageAssetSchema.optional(),
  
  /** 動画クリップ (R2で本格対応) */
  video_clip: VideoClipAssetSchema.optional(),
  
  /** 
   * 音声配列 - R1.5の核心
   * ナレーション + キャラ別音声を順番に配置
   */
  voices: z.array(VoiceAssetSchema).optional(),
  
  /**
   * @deprecated R1.5では voices[] を使用
   * 後方互換性のため維持（R2で削除予定）
   */
  audio: z.object({
    url: z.string(),
    duration_ms: z.number(),
    format: z.enum(['mp3', 'wav']),
  }).optional(),
});

export type SceneAssets = z.infer<typeof SceneAssetsSchema>;

// ====================================================================
// SceneTiming
// ====================================================================

export const SceneTimingSchema = z.object({
  /** シーン開始時間 (ms) - 累積計算 */
  start_ms: z.number(),
  
  /** 
   * シーンの長さ (ms)
   * R1.5ルール: voices があれば Σ(voices[].duration_ms) + padding
   */
  duration_ms: z.number(),
  
  /** 先頭余白 (ms) */
  head_pad_ms: z.number().default(0),
  
  /** 末尾余白 (ms) */
  tail_pad_ms: z.number().default(0),
});

export type SceneTiming = z.infer<typeof SceneTimingSchema>;

// ====================================================================
// ProjectScene - R1.5
// ====================================================================

export const ProjectSceneSchema_R15 = z.object({
  /** シーン番号 (1-indexed) */
  idx: z.number(),
  
  /** シーンの役割 */
  role: z.string(),
  
  /** シーンタイトル */
  title: z.string(),
  
  /** 
   * @deprecated R1.5では assets.voices[].text を使用
   * 後方互換性のため維持
   */
  dialogue: z.string(),
  
  /** タイミング情報 */
  timing: SceneTimingSchema,
  
  /** アセット */
  assets: SceneAssetsSchema,
  
  /** キャラクター情報 (R2で拡張予定) */
  characters: z.object({
    image: z.array(z.string()).optional(),
    voice: z.string().optional(),
  }).optional(),
});

export type ProjectScene_R15 = z.infer<typeof ProjectSceneSchema_R15>;

// ====================================================================
// BuildSettings - R1.5 (画角選択対応)
// ====================================================================

export const BuildSettingsSchema_R15 = z.object({
  preset: z.string().default('none'),
  
  /** 
   * アスペクト比 - R1.5で追加
   * '9:16' = ショート/TikTok
   * '16:9' = YouTube標準
   * '1:1' = Instagram
   */
  aspect_ratio: z.enum(['9:16', '16:9', '1:1']).default('9:16'),
  
  /** 解像度 */
  resolution: z.object({
    width: z.number(),
    height: z.number(),
  }),
  
  /** フレームレート */
  fps: z.number().default(30),
  
  /** コーデック */
  codec: z.enum(['h264', 'h265']).default('h264'),
  
  /** 音声設定 */
  audio: z.object({
    bgm_enabled: z.boolean().default(false),
    bgm_volume: z.number().default(0.3),
    narration_volume: z.number().default(1.0),
    duck_bgm_on_voice: z.boolean().default(true),
  }).optional(),
  
  /** トランジション設定 */
  transition: z.object({
    type: z.enum(['none', 'fade', 'slide', 'wipe']).default('fade'),
    duration_ms: z.number().default(300),
  }).optional(),
});

export type BuildSettings_R15 = z.infer<typeof BuildSettingsSchema_R15>;

// ====================================================================
// ProjectAssets (グローバル)
// ====================================================================

export const ProjectAssetsSchema = z.object({
  /** BGM - R1.5では「入れる/入れない」のみ対応 */
  bgm: z.object({
    url: z.string(),
    duration_ms: z.number().optional(),
    volume: z.number().default(0.3),
  }).optional(),
});

export type ProjectAssets = z.infer<typeof ProjectAssetsSchema>;

// ====================================================================
// ProjectSummary
// ====================================================================

export const ProjectSummarySchema = z.object({
  total_scenes: z.number(),
  total_duration_ms: z.number(),
  has_audio: z.boolean(),
  has_video_clips: z.boolean(),
  /** R1.5で追加: 音声付きシーン数 */
  scenes_with_voices: z.number().optional(),
});

export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

// ====================================================================
// ProjectJson - R1.5
// ====================================================================

export const ProjectJsonSchema_R15 = z.object({
  /** スキーマバージョン - R1.5 */
  schema_version: z.literal('1.5'),
  
  /** プロジェクトID */
  project_id: z.number(),
  
  /** プロジェクトタイトル */
  project_title: z.string(),
  
  /** 作成日時 */
  created_at: z.string(),
  
  /** ビルド設定 */
  build_settings: BuildSettingsSchema_R15,
  
  /** グローバル設定 */
  global: z.object({
    default_scene_duration_ms: z.number().default(5000),
    transition_duration_ms: z.number().default(300),
  }),
  
  /** グローバルアセット */
  assets: ProjectAssetsSchema.optional(),
  
  /** シーン配列 */
  scenes: z.array(ProjectSceneSchema_R15),
  
  /** サマリー */
  summary: ProjectSummarySchema,
});

export type ProjectJson_R15 = z.infer<typeof ProjectJsonSchema_R15>;

// ====================================================================
// Constants
// ====================================================================

export const R15_CONSTANTS = {
  /** 音声がないシーンのデフォルト尺 (ms) */
  DEFAULT_SCENE_DURATION_MS: 5000,
  
  /** 音声後の余白 (ms) */
  AUDIO_TAIL_PADDING_MS: 500,
  
  /** 日本語テキストの推定: ms/文字 */
  TEXT_DURATION_MS_PER_CHAR: 300,
  
  /** 最小シーン尺 (ms) */
  MIN_SCENE_DURATION_MS: 2000,
  
  /** 解像度マッピング */
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
  } as const,
} as const;

// ====================================================================
// Duration Calculation (SSOT)
// ====================================================================

/**
 * シーンの尺を計算 - R1.5 SSOT
 * 
 * ルール:
 * 1. voices[] がある → Σ(voices[].duration_ms) + tail_padding
 * 2. video_clip がある → video_clip.duration_ms
 * 3. legacy audio がある → audio.duration_ms + tail_padding
 * 4. dialogue から推定 → text.length × 300ms
 * 5. デフォルト → 5000ms
 */
export function computeSceneDuration_R15(
  assets: SceneAssets,
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
 * 明示的な start_ms がない場合は前の voice の直後
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
