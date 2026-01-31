import React, { useMemo } from 'react';
import { AbsoluteFill, Sequence, Audio, useVideoConfig, useCurrentFrame } from 'remotion';
import type { ProjectJson } from './schemas/project-schema';
import { Scene } from './components/Scene';
import { msToFrames } from './utils/timing';

// P6: シーン別BGMがある区間の情報
interface SceneBgmInterval {
  startFrame: number;
  endFrame: number;
  sceneIdx: number;
}

// P6-3 SSOT: sceneBGM区間ではprojectBGMを即時ミュート（二重BGM事故防止）
// 以前は duck (0.12) だったが、SSOT方針では完全ミュートを推奨
const GLOBAL_BGM_MUTE_VOLUME = 0; // sceneBGMがある区間でのprojectBGM音量

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
  const frame = useCurrentFrame();
  
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
    if (scene.bgm) {
      console.log(`[RilarcVideo] Scene ${index + 1} has scene BGM: ${scene.bgm.name || scene.bgm.url}`);
    }
    
    return { scene, startFrame, durationFrames };
  });
  
  console.log(`[RilarcVideo] Total scenesWithFrames: ${scenesWithFrames.length}`);
  
  // P6-3 SSOT: sceneBGMが「鳴っている区間だけ」をミュート対象にする
  // 以前はシーン全体だったが、start_ms/end_ms を反映して正確な区間を計算
  const sceneBgmIntervals: SceneBgmInterval[] = useMemo(() => {
    return scenesWithFrames
      .filter(({ scene }) => scene.bgm?.url)
      .map(({ scene, startFrame, durationFrames }) => {
        const durationMs = scene.timing?.duration_ms ?? 0;
        
        // scene.bgm の start_ms/end_ms は「シーン内の相対ms」
        const startMsRaw = scene.bgm?.start_ms ?? 0;
        const endMsRaw = scene.bgm?.end_ms ?? durationMs;
        
        // safety clamp: はみ出し防止
        const startMs = Math.max(0, Math.min(startMsRaw, durationMs));
        const endMs = Math.max(startMs, Math.min(endMsRaw, durationMs));
        
        // シーン内相対msをフレームに変換し、シーン開始フレームを加算
        const bgmStartFrame = startFrame + msToFrames(startMs, fps);
        const bgmEndFrame = Math.min(
          startFrame + durationFrames,
          startFrame + msToFrames(endMs, fps)
        );
        
        return {
          startFrame: bgmStartFrame,
          endFrame: bgmEndFrame,
          sceneIdx: scene.idx,
        };
      })
      // ゴミ区間（start >= end）を除外
      .filter((interval) => interval.endFrame > interval.startFrame);
  }, [scenesWithFrames, fps]);
  
  // P6: 現在フレームがシーン別BGM区間内かどうかを判定
  const isInSceneBgmInterval = useMemo(() => {
    return sceneBgmIntervals.some(
      interval => frame >= interval.startFrame && frame < interval.endFrame
    );
  }, [frame, sceneBgmIntervals]);
  
  // P6-3 SSOT: projectBGMの音量を計算（sceneBGMがある区間では即時ミュート）
  const globalBgmVolume = useMemo(() => {
    const baseVolume = projectJson?.build_settings?.audio?.bgm_volume ?? 0.3;
    if (isInSceneBgmInterval) {
      // P6-3: sceneBGM区間ではprojectBGMを完全ミュート（二重BGM事故防止）
      console.log(`[RilarcVideo] Frame ${frame}: muting projectBGM (sceneBGM active)`);
      return GLOBAL_BGM_MUTE_VOLUME;
    }
    return baseVolume;
  }, [isInSceneBgmInterval, frame, projectJson?.build_settings?.audio?.bgm_volume]);
  
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* 全体BGM（あれば） - P6: シーン別BGMがある区間ではduck */}
      {projectJson?.assets?.bgm?.url && (
        <Audio
          src={projectJson.assets.bgm.url}
          volume={globalBgmVolume}
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
