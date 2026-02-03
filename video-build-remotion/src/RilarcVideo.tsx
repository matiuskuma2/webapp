import React, { useMemo } from 'react';
import { AbsoluteFill, Sequence, Audio, useVideoConfig, useCurrentFrame, interpolate } from 'remotion';
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

// P6-4: BGMフェード設定（パツッとした切替を防ぐ）
const BGM_FADE_MS = 120; // フェード時間（ms）

interface RilarcVideoProps {
  projectJson: ProjectJson;
  showSubtitle?: boolean;
  /** @deprecated subtitleStyle より build_settings.telops を使用 */
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
  
  // PR-5-3b + Phase 1: テロップ設定を取得
  const telopsSettings = projectJson?.build_settings?.telops;
  const globalTelopEnabled = telopsSettings?.enabled ?? true;
  const sceneOverrides = telopsSettings?.scene_overrides || {};
  
  // Phase 1: スタイルプリセットを取得（後方互換: undefinedの場合は 'outline'）
  const telopStylePreset = (telopsSettings as any)?.style_preset || 'outline';
  const telopSizePreset = telopsSettings?.size_preset || 'md';
  const telopPosition = telopsSettings?.position_preset || 'bottom';
  // Vrew風カスタムスタイル
  const telopCustomStyle = (telopsSettings as any)?.custom_style || null;
  // PR-Remotion-Typography: 文字組み設定
  const telopTypography = (telopsSettings as any)?.typography || null;
  
  console.log('[RilarcVideo] telops settings:', JSON.stringify(telopsSettings));
  console.log('[RilarcVideo] globalTelopEnabled:', globalTelopEnabled);
  console.log('[RilarcVideo] telopStylePreset:', telopStylePreset);
  console.log('[RilarcVideo] telopSizePreset:', telopSizePreset);
  console.log('[RilarcVideo] telopPosition:', telopPosition);
  console.log('[RilarcVideo] telopCustomStyle:', JSON.stringify(telopCustomStyle));
  console.log('[RilarcVideo] telopTypography:', JSON.stringify(telopTypography));
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
  
  // P6-4: BGMフェードフレーム数
  const fadeFrames = msToFrames(BGM_FADE_MS, fps);
  
  // P6-3/P6-4 SSOT: projectBGMの音量を計算（sceneBGMがある区間ではミュート + フェード）
  const globalBgmVolume = useMemo(() => {
    const baseVolume = projectJson?.build_settings?.audio?.bgm_volume ?? 0.3;
    
    // sceneBGM区間内なら完全ミュート
    if (isInSceneBgmInterval) {
      return GLOBAL_BGM_MUTE_VOLUME;
    }
    
    // P6-4: sceneBGM区間の前後でフェードイン/アウト
    // 直近のsceneBGM区間を探してフェード計算
    for (const interval of sceneBgmIntervals) {
      // sceneBGM開始直前（fadeOut: baseVolume → 0）
      if (frame >= interval.startFrame - fadeFrames && frame < interval.startFrame) {
        return interpolate(
          frame,
          [interval.startFrame - fadeFrames, interval.startFrame],
          [baseVolume, GLOBAL_BGM_MUTE_VOLUME],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
        );
      }
      // sceneBGM終了直後（fadeIn: 0 → baseVolume）
      if (frame >= interval.endFrame && frame < interval.endFrame + fadeFrames) {
        return interpolate(
          frame,
          [interval.endFrame, interval.endFrame + fadeFrames],
          [GLOBAL_BGM_MUTE_VOLUME, baseVolume],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
        );
      }
    }
    
    return baseVolume;
  }, [isInSceneBgmInterval, frame, sceneBgmIntervals, fadeFrames, projectJson?.build_settings?.audio?.bgm_volume]);
  
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* 全体BGM（あれば） - P6: シーン別BGMがある区間ではduck */}
      {projectJson?.assets?.bgm?.url && (() => {
        const bgm = projectJson.assets.bgm;
        // タイムライン制御: 動画上の再生範囲
        const videoStartMs = bgm?.video_start_ms ?? 0;
        const videoEndMs = bgm?.video_end_ms ?? null; // null = 動画終了まで
        // BGMファイルのオフセット（startFrom用）
        const audioOffsetMs = bgm?.audio_offset_ms ?? 0;
        const audioOffsetFrames = msToFrames(audioOffsetMs, fps);
        // ループ設定（デフォルトOFF）
        const shouldLoop = bgm?.loop ?? false;
        
        const videoStartFrame = msToFrames(videoStartMs, fps);
        
        // video_end_ms が未指定の場合は全体を通して再生
        if (videoEndMs === null || videoEndMs === undefined) {
          // 従来通り、Sequenceなしで全体再生
          return (
            <Audio
              src={bgm.url}
              volume={globalBgmVolume}
              loop={shouldLoop}
              startFrom={audioOffsetFrames}
            />
          );
        }
        
        // video_end_ms が指定されている場合はSequenceで範囲を制御
        const videoEndFrame = msToFrames(videoEndMs, fps);
        const bgmDurationFrames = videoEndFrame - videoStartFrame;
        
        if (bgmDurationFrames <= 0) return null;
        
        return (
          <Sequence from={videoStartFrame} durationInFrames={bgmDurationFrames}>
            <Audio
              src={bgm.url}
              volume={globalBgmVolume}
              loop={shouldLoop}
              startFrom={audioOffsetFrames}
            />
          </Sequence>
        );
      })()}
      
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
              telopStylePreset={telopStylePreset}
              telopSizePreset={telopSizePreset}
              telopPosition={telopPosition}
              telopCustomStyle={telopCustomStyle}
              telopTypography={telopTypography}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
