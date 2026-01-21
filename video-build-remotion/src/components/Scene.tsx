import React from 'react';
import { AbsoluteFill, Img, Audio, Video, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import type { ProjectScene } from '../schemas/project-schema';
import { msToFrames } from '../utils/timing';
import { Subtitle } from './Subtitle';

interface SceneProps {
  scene: ProjectScene;
  // startFrame は不要 - Sequence 内では useCurrentFrame() が相対フレームを返す
  showSubtitle?: boolean;
  subtitleStyle?: 'default' | 'cinematic' | 'news' | 'minimal';
}

export const Scene: React.FC<SceneProps> = ({ scene, showSubtitle = true, subtitleStyle = 'default' }) => {
  // Sequence 内では useCurrentFrame() は既に相対フレームを返す
  // 重要：Sequence の from が 555 でも、Sequence 内の frame は 0 から始まる
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  
  const durationFrames = msToFrames(scene.timing.duration_ms, fps);
  // frame は既に Sequence 内の相対フレームなので、そのまま使用
  const relativeFrame = frame;
  
  // Debug: 最初のフレームでログ出力
  if (frame === 0) {
    console.log(`[Scene ${scene.idx}] Rendering first frame (relative frame 0)`);
    console.log(`[Scene ${scene.idx}] Image URL: ${scene.assets?.image?.url}`);
    console.log(`[Scene ${scene.idx}] Duration frames: ${durationFrames}`);
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
        {/* テロップ表示 */}
        {showSubtitle && scene.dialogue && (
          <Subtitle
            text={scene.dialogue}
            durationFrames={durationFrames}
            style={subtitleStyle}
            position="bottom"
          />
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
      {/* テロップ表示 */}
      {showSubtitle && scene.dialogue && (
        <Subtitle
          text={scene.dialogue}
          durationFrames={durationFrames}
          style={subtitleStyle}
          position="bottom"
        />
      )}
    </AbsoluteFill>
  );
};
