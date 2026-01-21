import React, { useEffect, useState } from 'react';
import { AbsoluteFill, Img, Audio, Video, useCurrentFrame, useVideoConfig, interpolate, delayRender, continueRender } from 'remotion';
import type { ProjectScene } from '../schemas/project-schema';
import { msToFrames } from '../utils/timing';

interface SceneProps {
  scene: ProjectScene;
  startFrame: number;
}

export const Scene: React.FC<SceneProps> = ({ scene, startFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const [imageLoaded, setImageLoaded] = useState(false);
  const [handle] = useState(() => {
    if (scene.assets?.image?.url) {
      return delayRender(`Loading image for scene ${scene.idx}`);
    }
    return null;
  });
  
  // 画像をプリロード
  useEffect(() => {
    if (!scene.assets?.image?.url || !handle) return;
    
    const img = new Image();
    img.crossOrigin = 'anonymous';
    
    img.onload = () => {
      console.log(`[Scene ${scene.idx}] Image loaded successfully:`, scene.assets.image?.url);
      setImageLoaded(true);
      continueRender(handle);
    };
    
    img.onerror = (error) => {
      console.error(`[Scene ${scene.idx}] Image load error:`, error);
      console.error(`[Scene ${scene.idx}] Failed URL:`, scene.assets.image?.url);
      // エラーでもレンダリングを続行（黒背景が表示される）
      setImageLoaded(false);
      continueRender(handle);
    };
    
    img.src = scene.assets.image.url;
    
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [scene.assets?.image?.url, scene.idx, handle]);
  
  // Debug: ログ出力（最初のフレームのみ）
  if (frame === startFrame) {
    console.log(`[Scene ${scene.idx}] Rendering at frame ${frame}`);
    console.log(`[Scene ${scene.idx}] image url:`, scene.assets?.image?.url);
    console.log(`[Scene ${scene.idx}] imageLoaded:`, imageLoaded);
  }
  
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
      {scene.assets?.image?.url && (
        <Img
          src={scene.assets.image.url}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: `scale(${scale})`,
          }}
          onError={(e) => {
            console.error(`[Scene ${scene.idx}] Img component error:`, e);
          }}
        />
      )}
      {scene.assets.audio && (
        <Audio src={scene.assets.audio.url} />
      )}
    </AbsoluteFill>
  );
};
