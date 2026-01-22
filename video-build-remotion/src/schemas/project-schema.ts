/**
 * Project Schema - R1.5 Compatible
 * 
 * 後方互換性を維持しつつ R1.5 の voices[] をサポート
 */

import { z } from 'zod';

// ====================================================================
// VoiceAsset - R1.5
// ====================================================================

export const VoiceAssetSchema = z.object({
  id: z.string(),
  role: z.enum(['narration', 'dialogue']),
  character_key: z.string().optional().nullable(),
  character_name: z.string().optional().nullable(),
  audio_url: z.string(),
  duration_ms: z.number(),
  text: z.string(),
  start_ms: z.number().optional(),
  format: z.enum(['mp3', 'wav']).default('mp3'),
});

export type VoiceAsset = z.infer<typeof VoiceAssetSchema>;

// ====================================================================
// MotionPreset - R2-C モーションプリセット
// ====================================================================

export const MotionPresetSchema = z.object({
  id: z.string(),
  motion_type: z.enum(['none', 'zoom', 'pan', 'combined']),
  params: z.object({
    start_scale: z.number().optional(),
    end_scale: z.number().optional(),
    start_x: z.number().optional(),
    end_x: z.number().optional(),
    start_y: z.number().optional(),
    end_y: z.number().optional(),
  }),
});

export type MotionPreset = z.infer<typeof MotionPresetSchema>;

// ====================================================================
// BalloonAsset - R2 吹き出し
// ====================================================================

export const BalloonAssetSchema = z.object({
  id: z.string(),
  utterance_id: z.number().optional(),
  text: z.string(),
  start_ms: z.number(),
  end_ms: z.number(),
  position: z.object({
    x: z.number(),
    y: z.number(),
  }),
  size: z.object({
    w: z.number(),
    h: z.number(),
  }),
  shape: z.enum(['round', 'square', 'thought', 'shout', 'caption', 'telop_bar']).default('round'),
  tail: z.object({
    enabled: z.boolean(),
    tip_x: z.number().optional(),
    tip_y: z.number().optional(),
  }).optional(),
  style: z.object({
    writing_mode: z.enum(['horizontal', 'vertical']).optional(),
    font_family: z.string().optional(),
    font_weight: z.enum(['normal', 'bold']).optional(),
    font_scale: z.number().optional(),
    bg_color: z.string().optional(),
    text_color: z.string().optional(),
    border_color: z.string().optional(),
    border_width: z.number().optional(),
  }).optional(),
  z_index: z.number().default(10),
  /**
   * A案 baked: 文字入りバブル画像のURL
   * - text_render_mode='baked' の場合に使用
   * - Remotionはこの画像を start_ms <= t < end_ms の間だけ表示
   * - Remotion側でテキスト描画は行わない
   */
  bubble_image_url: z.string().optional(),
  /**
   * A案 baked: バブル画像のサイズ（px）
   * - 表示時のアスペクト比維持に使用
   */
  bubble_image_size: z.object({
    width: z.number(),
    height: z.number(),
  }).optional(),
});

export type BalloonAsset = z.infer<typeof BalloonAssetSchema>;

// ====================================================================
// ProjectScene - R1.1/R1.5/R2 対応
// ====================================================================

export const ProjectSceneSchema = z.object({
  idx: z.number(),
  role: z.string(),
  title: z.string(),
  dialogue: z.string(),
  timing: z.object({
    start_ms: z.number(),
    duration_ms: z.number(),
    head_pad_ms: z.number().default(0),
    tail_pad_ms: z.number().default(0),
  }),
  /**
   * R2: text_render_mode - 文字描画モード
   * - 'remotion': Remotionで吹き出し/テロップ/字幕を描画
   * - 'baked': 画像に文字が焼き込み済み → Remotionでは描画しない（二重事故防止）
   * - 'none': 文字を一切描画しない
   */
  text_render_mode: z.enum(['remotion', 'baked', 'none']).default('remotion'),
  /**
   * R2: balloons - 吹き出し配列（remotionモード時に使用）
   */
  balloons: z.array(BalloonAssetSchema).optional(),
  /**
   * R2-C: motion - モーションプリセット
   * - シーン毎のカメラワーク（Ken Burns, Pan等）
   * - 未指定時は kenburns_soft がデフォルト適用
   */
  motion: MotionPresetSchema.optional(),
  assets: z.object({
    image: z.object({
      url: z.string(),
      width: z.number(),
      height: z.number(),
    }).optional(),
    /** @deprecated R1.5では voices を使用 */
    audio: z.object({
      url: z.string(),
      duration_ms: z.number(),
      format: z.enum(['mp3', 'wav']),
    }).optional(),
    /** R1.5: 複数話者音声配列 */
    voices: z.array(VoiceAssetSchema).optional(),
    video_clip: z.object({
      url: z.string(),
      duration_ms: z.number(),
    }).optional(),
  }),
  characters: z.object({
    image: z.array(z.string()).optional(),
    voice: z.string().optional(),
  }).optional(),
});

// ====================================================================
// ProjectJson - R1.1/R1.5 両対応
// ====================================================================

export const ProjectJsonSchema = z.object({
  schema_version: z.union([z.literal('1.1'), z.literal('1.5')]),
  project_id: z.number(),
  project_title: z.string(),
  created_at: z.string(),
  
  build_settings: z.object({
    preset: z.string(),
    /** R1.5: アスペクト比選択 */
    aspect_ratio: z.enum(['9:16', '16:9', '1:1']).optional(),
    resolution: z.object({
      width: z.number(),
      height: z.number(),
    }),
    fps: z.number(),
    codec: z.enum(['h264', 'h265']).default('h264'),
    audio: z.object({
      bgm_enabled: z.boolean().default(false),
      bgm_volume: z.number().default(0.3),
      narration_volume: z.number().default(1.0),
      duck_bgm_on_voice: z.boolean().default(true),
    }).optional(),
    transition: z.object({
      type: z.enum(['none', 'fade', 'slide', 'wipe']).default('fade'),
      duration_ms: z.number().default(300),
    }).optional(),
  }),
  
  global: z.object({
    default_scene_duration_ms: z.number().default(5000),
    transition_duration_ms: z.number().default(300),
  }),
  
  assets: z.object({
    bgm: z.object({
      url: z.string(),
      duration_ms: z.number().optional(),
      volume: z.number(),
    }).optional(),
  }).optional(),
  
  scenes: z.array(ProjectSceneSchema),
  
  summary: z.object({
    total_scenes: z.number(),
    total_duration_ms: z.number(),
    has_audio: z.boolean(),
    has_video_clips: z.boolean(),
    scenes_with_voices: z.number().optional(),
  }),
});

export type ProjectJson = z.infer<typeof ProjectJsonSchema>;
export type ProjectScene = z.infer<typeof ProjectSceneSchema>;
