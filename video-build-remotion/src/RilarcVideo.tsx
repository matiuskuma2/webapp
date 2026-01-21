import React, { useEffect, useState } from 'react';
import { AbsoluteFill, Sequence, Audio, useVideoConfig, prefetch, delayRender, continueRender } from 'remotion';
import type { ProjectJson } from './schemas/project-schema';
import { Scene } from './components/Scene';
import { msToFrames } from './utils/timing';

interface RilarcVideoProps {
  projectJson: ProjectJson;
}

export const RilarcVideo: React.FC<RilarcVideoProps> = ({ projectJson }) => {
  const { fps } = useVideoConfig();
  const [prefetchHandle] = useState(() => delayRender('Prefetching all images'));
  const [allImagesReady, setAllImagesReady] = useState(false);
  
  // 全シーンの画像を事前にプリフェッチ
  useEffect(() => {
    const imageUrls = (projectJson?.scenes || [])
      .map(scene => scene.assets?.image?.url)
      .filter((url): url is string => !!url);
    
    console.log('[RilarcVideo] Prefetching', imageUrls.length, 'images');
    imageUrls.forEach((url, i) => {
      console.log(`[RilarcVideo] Image ${i + 1}:`, url);
    });
    
    if (imageUrls.length === 0) {
      setAllImagesReady(true);
      continueRender(prefetchHandle);
      return;
    }
    
    // 全画像を並列でプリフェッチ
    const prefetches = imageUrls.map((url) => prefetch(url, { method: 'blob-url' }));
    
    Promise.all(prefetches.map(p => p.waitUntilDone()))
      .then(() => {
        console.log('[RilarcVideo] All images prefetched successfully');
        setAllImagesReady(true);
        continueRender(prefetchHandle);
      })
      .catch((error) => {
        console.error('[RilarcVideo] Prefetch error:', error);
        // エラーでもレンダリングを続行
        setAllImagesReady(true);
        continueRender(prefetchHandle);
      });
    
    // Cleanup
    return () => {
      prefetches.forEach(p => p.free());
    };
  }, [projectJson?.scenes, prefetchHandle]);
  
  // Debug: props を確認
  console.log('[RilarcVideo] projectJson scenes:', projectJson?.scenes?.length);
  console.log('[RilarcVideo] allImagesReady:', allImagesReady);
  
  // 各シーンの開始フレームを計算
  const scenesWithFrames = (projectJson?.scenes || []).map((scene) => {
    const startFrame = msToFrames(scene.timing.start_ms, fps);
    const durationFrames = msToFrames(scene.timing.duration_ms, fps);
    return { scene, startFrame, durationFrames };
  });
  
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* BGM（あれば） */}
      {projectJson.assets?.bgm && (
        <Audio
          src={projectJson.assets.bgm.url}
          volume={projectJson.build_settings.audio?.bgm_volume ?? 0.3}
          loop
        />
      )}
      
      {/* シーン群 */}
      {scenesWithFrames.map(({ scene, startFrame, durationFrames }) => (
        <Sequence
          key={scene.idx}
          from={startFrame}
          durationInFrames={durationFrames}
        >
          <Scene scene={scene} startFrame={startFrame} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
