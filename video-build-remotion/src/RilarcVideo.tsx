import React from 'react';
import { AbsoluteFill, Sequence, Audio, useVideoConfig } from 'remotion';
import type { ProjectJson } from './schemas/project-schema';
import { Scene } from './components/Scene';
import { msToFrames } from './utils/timing';

interface RilarcVideoProps {
  projectJson: ProjectJson;
  showSubtitle?: boolean;
  subtitleStyle?: 'default' | 'cinematic' | 'news' | 'minimal';
}

export const RilarcVideo: React.FC<RilarcVideoProps> = ({ 
  projectJson, 
  showSubtitle = true,
  subtitleStyle = 'default'
}) => {
  const { fps } = useVideoConfig();
  
  // Debug: projectJson の内容を確認
  console.log('[RilarcVideo] projectJson type:', typeof projectJson);
  console.log('[RilarcVideo] projectJson scenes count:', projectJson?.scenes?.length);
  
  // PR-5-3b: テロップ設定を取得
  const telopsSettings = projectJson?.build_settings?.telops;
  const globalTelopEnabled = telopsSettings?.enabled ?? true;
  const sceneOverrides = telopsSettings?.scene_overrides || {};
  
  console.log('[RilarcVideo] telops settings:', JSON.stringify(telopsSettings));
  console.log('[RilarcVideo] globalTelopEnabled:', globalTelopEnabled);
  console.log('[RilarcVideo] sceneOverrides:', JSON.stringify(sceneOverrides));
  
  // scenes が undefined の場合は空配列を使用
  const scenes = projectJson?.scenes || [];
  
  // 各シーンの開始フレームを計算
  const scenesWithFrames = scenes.map((scene, index) => {
    const startFrame = msToFrames(scene.timing.start_ms, fps);
    const durationFrames = msToFrames(scene.timing.duration_ms, fps);
    
    // Debug: 各シーンのタイミングをログ
    console.log(`[RilarcVideo] Scene ${index + 1} (idx=${scene.idx}): start_ms=${scene.timing.start_ms}, duration_ms=${scene.timing.duration_ms}`);
    console.log(`[RilarcVideo] Scene ${index + 1}: startFrame=${startFrame}, durationFrames=${durationFrames}`);
    console.log(`[RilarcVideo] Scene ${index + 1} image: ${scene.assets?.image?.url}`);
    
    return { scene, startFrame, durationFrames };
  });
  
  console.log(`[RilarcVideo] Total scenesWithFrames: ${scenesWithFrames.length}`);
  
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* BGM（あれば） */}
      {projectJson?.assets?.bgm?.url && (
        <Audio
          src={projectJson.assets.bgm.url}
          volume={projectJson.build_settings?.audio?.bgm_volume ?? 0.3}
          loop
        />
      )}
      
      {/* シーン群 */}
      {scenesWithFrames.map(({ scene, startFrame, durationFrames }, index) => {
        // PR-5-3b: シーン単位のテロップ表示制御
        // 1. グローバル設定がOFFなら全シーンOFF
        // 2. シーンオーバーライドがあればそれを優先
        // 3. なければshowSubtitle（props）を使用
        const sceneIdx = scene.idx;
        const sceneIdxKey = String(sceneIdx);
        
        let sceneShowSubtitle = showSubtitle && globalTelopEnabled;
        if (sceneIdxKey in sceneOverrides) {
          sceneShowSubtitle = sceneOverrides[sceneIdxKey];
        }
        
        console.log(`[RilarcVideo] Scene ${sceneIdx}: showSubtitle=${sceneShowSubtitle} (override=${sceneIdxKey in sceneOverrides ? sceneOverrides[sceneIdxKey] : 'none'})`);
        console.log(`[RilarcVideo] Rendering Sequence for scene ${index + 1}: from=${startFrame}, duration=${durationFrames}`);
        return (
          <Sequence
            key={`scene-${scene.idx}`}
            from={startFrame}
            durationInFrames={durationFrames}
          >
            <Scene 
              scene={scene} 
              showSubtitle={sceneShowSubtitle}
              subtitleStyle={subtitleStyle}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
