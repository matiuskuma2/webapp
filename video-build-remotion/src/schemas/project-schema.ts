import { z } from 'zod';

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
    audio: z.object({
      url: z.string(),
      duration_ms: z.number(),
      format: z.enum(['mp3', 'wav']),
    }).optional(),
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

export const ProjectJsonSchema = z.object({
  schema_version: z.literal('1.1'),
  project_id: z.number(),
  project_title: z.string(),
  created_at: z.string(),
  
  build_settings: z.object({
    preset: z.string(),
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
      duration_ms: z.number(),
      volume: z.number(),
    }).optional(),
  }).optional(),
  
  scenes: z.array(ProjectSceneSchema),
  
  summary: z.object({
    total_scenes: z.number(),
    total_duration_ms: z.number(),
    has_audio: z.boolean(),
    has_video_clips: z.boolean(),
  }),
});

export type ProjectJson = z.infer<typeof ProjectJsonSchema>;
export type ProjectScene = z.infer<typeof ProjectSceneSchema>;
