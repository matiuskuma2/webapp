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
  
  // Debug: 最初のフレームでログ出力
  if (relativeFrame === 0) {
    console.log(`[Scene ${scene.idx}] Rendering first frame at absolute frame ${frame}`);
    console.log(`[Scene ${scene.idx}] Image URL: ${scene.assets?.image?.url}`);
    console.log(`[Scene ${scene.idx}] Has image: ${!!scene.assets?.image?.url}`);
  }
  
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
  if (scene.assets?.video_clip?.url) {
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
        {scene.assets?.audio?.url && (
          <Audio src={scene.assets.audio.url} />
        )}
      </AbsoluteFill>
    );
  }
  
  // 画像シーン
  const imageUrl = scene.assets?.image?.url;
  
  return (
    <AbsoluteFill style={{ opacity, backgroundColor: 'black' }}>
      {imageUrl ? (
        <Img
          src={imageUrl}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: `scale(${scale})`,
          }}
        />
      ) : (
        // 画像URLがない場合はプレースホルダー表示
        <div style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          fontSize: 48,
        }}>
          Scene {scene.idx} - No Image
        </div>
      )}
      {scene.assets?.audio?.url && (
        <Audio src={scene.assets.audio.url} />
      )}
    </AbsoluteFill>
  );
};
