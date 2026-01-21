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
// ProjectScene - R1.1/R1.5 両対応
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
