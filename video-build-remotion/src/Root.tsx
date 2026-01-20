import React from 'react';
import { Composition } from 'remotion';
import { RilarcVideo } from './RilarcVideo';
import type { ProjectJson } from './schemas/project-schema';
import { calculateTotalFrames } from './utils/timing';

// デフォルトのproject.json（開発・プレビュー用）
const defaultProjectJson: ProjectJson = {
  schema_version: '1.1',
  project_id: 1,
  project_title: 'Sample Project',
  created_at: new Date().toISOString(),
  build_settings: {
    preset: 'youtube_standard',
    resolution: { width: 1080, height: 1920 },  // 9:16 デフォルト
    fps: 30,
    codec: 'h264',
  },
  global: {
    default_scene_duration_ms: 5000,
    transition_duration_ms: 300,
  },
  scenes: [
    {
      idx: 0,
      role: 'hook',
      title: 'Sample Scene 1',
      dialogue: 'This is the first scene.',
      timing: {
        start_ms: 0,
        duration_ms: 5000,
        head_pad_ms: 0,
        tail_pad_ms: 0,
      },
      assets: {
        image: {
          url: 'https://via.placeholder.com/1080x1920/3b82f6/ffffff?text=Scene+1',
          width: 1080,
          height: 1920,
        },
      },
    },
    {
      idx: 1,
      role: 'main_point',
      title: 'Sample Scene 2',
      dialogue: 'This is the second scene.',
      timing: {
        start_ms: 5000,
        duration_ms: 5000,
        head_pad_ms: 0,
        tail_pad_ms: 0,
      },
      assets: {
        image: {
          url: 'https://via.placeholder.com/1080x1920/10b981/ffffff?text=Scene+2',
          width: 1080,
          height: 1920,
        },
      },
    },
    {
      idx: 2,
      role: 'cta',
      title: 'Sample Scene 3',
      dialogue: 'This is the third scene.',
      timing: {
        start_ms: 10000,
        duration_ms: 5000,
        head_pad_ms: 0,
        tail_pad_ms: 0,
      },
      assets: {
        image: {
          url: 'https://via.placeholder.com/1080x1920/f59e0b/ffffff?text=Scene+3',
          width: 1080,
          height: 1920,
        },
      },
    },
  ],
  summary: {
    total_scenes: 3,
    total_duration_ms: 15000,
    has_audio: false,
    has_video_clips: false,
  },
};

/**
 * calculateMetadata を使用して動的に Composition のメタデータを計算
 * これにより inputProps から渡された projectJson に基づいて
 * durationInFrames, width, height, fps が決定される
 */
export const RilarcRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="RilarcVideo"
        component={RilarcVideo}
        calculateMetadata={({ props }) => {
          const pj = props.projectJson;
          const fps = pj.build_settings.fps;
          const totalDurationMs = pj.summary.total_duration_ms;
          const durationInFrames = calculateTotalFrames(totalDurationMs, fps);
          
          return {
            durationInFrames,
            fps,
            width: pj.build_settings.resolution.width,
            height: pj.build_settings.resolution.height,
          };
        }}
        defaultProps={{
          projectJson: defaultProjectJson,
        }}
      />
    </>
  );
};
