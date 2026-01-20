import React from 'react';
import { AbsoluteFill, Img, Audio, Video, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import type { ProjectScene } from '../schemas/project-schema';
import { msToFrames } from '../utils/timing';

interface SceneProps {
  scene: ProjectScene;
  startFrame: number;
}

export const Scene: React.FC<SceneProps> = ({ scene, startFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  
  const durationFrames = msToFrames(scene.timing.duration_ms, fps);
  const relativeFrame = frame - startFrame;
  
  // フェードイン・アウト（15フレーム = 0.5秒 @30fps）
  const fadeFrames = Math.min(15, Math.floor(durationFrames / 4));
  const opacity = interpolate(
    relativeFrame,
    [0, fadeFrames, durationFrames - fadeFrames, durationFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  
  // Ken Burns エフェクト（軽いズーム）
  const scale = interpolate(
    relativeFrame,
    [0, durationFrames],
    [1, 1.05],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  
  // 動画クリップがある場合は動画を使用
  if (scene.assets.video_clip) {
    return (
      <AbsoluteFill style={{ opacity }}>
        <Video
          src={scene.assets.video_clip.url}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
        {scene.assets.audio && (
          <Audio src={scene.assets.audio.url} />
        )}
      </AbsoluteFill>
    );
  }
  
  // 画像シーン
  return (
    <AbsoluteFill style={{ opacity, backgroundColor: 'black' }}>
      {scene.assets.image && (
        <Img
          src={scene.assets.image.url}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: `scale(${scale})`,
          }}
        />
      )}
      {scene.assets.audio && (
        <Audio src={scene.assets.audio.url} />
      )}
    </AbsoluteFill>
  );
};
