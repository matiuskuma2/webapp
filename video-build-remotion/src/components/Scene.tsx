import React from 'react';
import { AbsoluteFill, Img, Audio, Video, Sequence, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import type { ProjectScene, VoiceAsset, SfxAsset, SceneBgmAsset } from '../schemas/project-schema';
import { msToFrames } from '../utils/timing';
import { Subtitle } from './Subtitle';
import { MotionWrapper, getMotionPreset } from './MotionWrapper';
import { BalloonOverlay } from './BalloonOverlay';

interface SceneProps {
  scene: ProjectScene;
  showSubtitle?: boolean;
  subtitleStyle?: 'default' | 'cinematic' | 'news' | 'minimal';
}

/**
 * Scene Component - R1.5/R2/A案baked/P6 対応
 * 
 * ## R1.5 変更点
 * - voices[] 配列をサポート（複数話者音声）
 * - 字幕は voice.text から表示
 * - 後方互換: audio 単体もサポート
 * 
 * ## R2 変更点
 * - text_render_mode 対応（baked時は字幕描画しない）
 * - balloons 配列サポート
 * 
 * ## A案 baked 変更点
 * - text_render_mode='baked' の場合:
 *   - bubble_image_url の画像をタイミング表示（start_ms <= t < end_ms）
 *   - Remotionでテキスト描画は行わない
 *   - 漫画の文字入りバブルPNGを100%維持
 * - text_render_mode='remotion' の場合:
 *   - balloons をスタイルに基づいてテキスト描画（従来方式）
 * 
 * ## R3-B SFX 対応
 * - scene.sfx[] 配列をサポート
 * - 各SFXは start_ms で再生開始、volume/loop を考慮
 * 
 * ## P6 シーン別BGM 対応
 * - scene.bgm がある場合、そのシーンでのみ再生
 * - プロジェクト全体BGMより優先（全体BGMはRilarcVideo.tsxでduck）
 */
export const Scene: React.FC<SceneProps> = ({ 
  scene, 
  showSubtitle = true, 
  subtitleStyle = 'default' 
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  
  const durationFrames = msToFrames(scene.timing.duration_ms, fps);
  
  // ========================================
  // R2: text_render_mode による描画制御
  // ========================================
  const textRenderMode = scene.text_render_mode || 'remotion';
  
  // baked/none の場合は字幕を描画しない（二重事故防止）
  const shouldRenderSubtitle = showSubtitle && textRenderMode === 'remotion';
  
  // R2-C: モーションプリセットを取得
  const motionPreset = scene.motion ? scene.motion : getMotionPreset(null); // デフォルト: kenburns_soft
  
  // A案 baked: balloons 配列を取得
  const balloons = scene.balloons || [];
  const hasBalloons = balloons.length > 0;
  
  // R3-B: SFX配列を取得
  const sfxList: SfxAsset[] = scene.sfx || [];
  const hasSfx = sfxList.length > 0;
  
  // P6: シーン別BGMを取得
  const sceneBgm: SceneBgmAsset | undefined = scene.bgm;
  const hasSceneBgm = !!sceneBgm?.url;
  
  // Debug: 最初のフレームでログ出力
  if (frame === 0) {
    console.log(`[Scene ${scene.idx}] Rendering first frame (relative frame 0)`);
    console.log(`[Scene ${scene.idx}] Image URL: ${scene.assets?.image?.url}`);
    console.log(`[Scene ${scene.idx}] Duration frames: ${durationFrames}`);
    console.log(`[Scene ${scene.idx}] Voices count: ${scene.assets?.voices?.length || 0}`);
    console.log(`[Scene ${scene.idx}] text_render_mode: ${textRenderMode}`);
    console.log(`[Scene ${scene.idx}] motion preset: ${motionPreset?.id || 'default'}`);
    console.log(`[Scene ${scene.idx}] balloons count: ${balloons.length}`);
    console.log(`[Scene ${scene.idx}] sfx count: ${sfxList.length}`);
    if (textRenderMode === 'baked' && hasBalloons) {
      console.log(`[Scene ${scene.idx}] A案 baked: バブル画像をタイミング表示`);
    }
    if (hasSfx) {
      console.log(`[Scene ${scene.idx}] R3-B: SFXを再生`, sfxList.map(s => ({ id: s.id, url: s.url, start_ms: s.start_ms })));
    }
    if (hasSceneBgm) {
      console.log(`[Scene ${scene.idx}] P6: シーン別BGMを再生`, { name: sceneBgm?.name, url: sceneBgm?.url, volume: sceneBgm?.volume });
    }
  }
  
  // フェードイン・アウト（15フレーム = 0.5秒 @30fps）
  const fadeFrames = Math.min(15, Math.floor(durationFrames / 4));
  const opacity = interpolate(
    frame,
    [0, fadeFrames, durationFrames - fadeFrames, durationFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  
  // ========================================
  // R1.5: voices[] または legacy audio を取得
  // ========================================
  const voices = scene.assets?.voices || [];
  const hasVoices = voices.length > 0;
  
  // 後方互換: audio がある場合は voices に変換
  const effectiveVoices: VoiceAsset[] = hasVoices 
    ? voices 
    : scene.assets?.audio?.url 
      ? [{
          id: `legacy-audio-${scene.idx}`,
          role: 'narration' as const,
          character_key: null,
          character_name: null,
          audio_url: scene.assets.audio.url,
          duration_ms: scene.assets.audio.duration_ms,
          text: scene.dialogue || '',
          start_ms: 0,
          format: scene.assets.audio.format || 'mp3',
        }]
      : [];
  
  // ========================================
  // 現在再生中の voice を特定（字幕表示用）
  // ========================================
  const currentMs = (frame / fps) * 1000;
  const currentVoice = effectiveVoices.find((voice) => {
    const startMs = voice.start_ms ?? 0;
    const endMs = startMs + voice.duration_ms;
    return currentMs >= startMs && currentMs < endMs;
  });
  
  // 字幕テキスト: currentVoice があればそのtext、なければ dialogue
  const subtitleText = currentVoice?.text || (showSubtitle && !hasVoices ? scene.dialogue : '');
  
  // ========================================
  // 動画クリップがある場合
  // ========================================
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
        {/* R1.5: voices[] を再生 */}
        {effectiveVoices.map((voice) => {
          const voiceStartFrame = msToFrames(voice.start_ms ?? 0, fps);
          const voiceDurationFrames = msToFrames(voice.duration_ms, fps);
          
          return (
            <Sequence 
              key={voice.id} 
              from={voiceStartFrame} 
              durationInFrames={voiceDurationFrames}
            >
              <Audio src={voice.audio_url} />
            </Sequence>
          );
        })}
        
        {/* P6-2: SFXを再生（SSOT: end_ms優先、ワンショット音） */}
        {sfxList.map((sfx) => {
          const sfxStartFrame = msToFrames(sfx.start_ms ?? 0, fps);
          
          // P6-2 SSOT: end_ms を優先、なければ duration_ms、どちらもなければシーン終了まで
          let sfxDurationFrames: number;
          if (sfx.end_ms !== undefined && sfx.end_ms !== null) {
            // end_ms が指定されている場合
            const sfxEndFrame = msToFrames(sfx.end_ms, fps);
            sfxDurationFrames = sfxEndFrame - sfxStartFrame;
          } else if (sfx.duration_ms !== undefined && sfx.duration_ms !== null) {
            // duration_ms が指定されている場合
            sfxDurationFrames = msToFrames(sfx.duration_ms, fps);
          } else {
            // どちらもなければシーン終了まで
            sfxDurationFrames = durationFrames - sfxStartFrame;
          }
          
          // safety: 不正データ防止
          if (sfxDurationFrames <= 0) return null;
          
          return (
            <Sequence
              key={sfx.id}
              from={sfxStartFrame}
              durationInFrames={Math.max(1, sfxDurationFrames)}
            >
              <Audio 
                src={sfx.url} 
                volume={sfx.volume ?? 0.8}
                // P6-2 SSOT: SFXはワンショット音、loop原則不使用
              />
            </Sequence>
          );
        })}
        
        {/* P6-1: シーン別BGMを再生（SSOT: start_ms/end_ms フレーム精度、loop禁止） */}
        {hasSceneBgm && sceneBgm && (() => {
          // P6-1: start_ms / end_ms をフレーム精度で反映
          const bgmStartFrame = msToFrames(sceneBgm.start_ms ?? 0, fps);
          // end_ms が未指定 or null の場合はシーン終了まで再生
          const bgmEndMs = sceneBgm.end_ms ?? scene.timing.duration_ms;
          const bgmEndFrame = msToFrames(bgmEndMs, fps);
          const bgmDurationFrames = Math.max(1, bgmEndFrame - bgmStartFrame);
          
          // safety: 不正データ防止
          if (bgmDurationFrames <= 0) return null;
          
          return (
            <Sequence
              from={bgmStartFrame}
              durationInFrames={bgmDurationFrames}
            >
              <Audio
                src={sceneBgm.url}
                volume={sceneBgm.volume ?? 0.25}
                // P6-1 SSOT: loop禁止（途中で切れてOK、次シーンに持ち越さない）
              />
            </Sequence>
          );
        })()}
        
        {/* 字幕表示 - R2: baked/none時は描画しない */}
        {shouldRenderSubtitle && subtitleText && (
          <Subtitle
            text={subtitleText}
            durationFrames={durationFrames}
            style={subtitleStyle}
            position="bottom"
          />
        )}
        
        {/* A案 baked: バルーンオーバーレイ表示 */}
        {hasBalloons && (
          <BalloonOverlay
            balloons={balloons}
            textRenderMode={textRenderMode}
          />
        )}
      </AbsoluteFill>
    );
  }
  
  // ========================================
  // 画像シーン
  // ========================================
  const imageUrl = scene.assets?.image?.url;
  
  return (
    <AbsoluteFill style={{ opacity, backgroundColor: 'black' }}>
      {/* R2-C: MotionWrapper でカメラワークを適用 */}
      <MotionWrapper preset={motionPreset} durationFrames={durationFrames}>
        {imageUrl ? (
          <Img
            src={imageUrl}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        ) : (
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
      </MotionWrapper>
      
      {/* R1.5: voices[] を再生 */}
      {effectiveVoices.map((voice) => {
        const voiceStartFrame = msToFrames(voice.start_ms ?? 0, fps);
        const voiceDurationFrames = msToFrames(voice.duration_ms, fps);
        
        return (
          <Sequence 
            key={voice.id} 
            from={voiceStartFrame} 
            durationInFrames={voiceDurationFrames}
          >
            <Audio src={voice.audio_url} />
          </Sequence>
        );
      })}
      
      {/* P6-2: SFXを再生（SSOT: end_ms優先、ワンショット音） */}
      {sfxList.map((sfx) => {
        const sfxStartFrame = msToFrames(sfx.start_ms ?? 0, fps);
        
        // P6-2 SSOT: end_ms を優先、なければ duration_ms、どちらもなければシーン終了まで
        let sfxDurationFrames: number;
        if (sfx.end_ms !== undefined && sfx.end_ms !== null) {
          // end_ms が指定されている場合
          const sfxEndFrame = msToFrames(sfx.end_ms, fps);
          sfxDurationFrames = sfxEndFrame - sfxStartFrame;
        } else if (sfx.duration_ms !== undefined && sfx.duration_ms !== null) {
          // duration_ms が指定されている場合
          sfxDurationFrames = msToFrames(sfx.duration_ms, fps);
        } else {
          // どちらもなければシーン終了まで
          sfxDurationFrames = durationFrames - sfxStartFrame;
        }
        
        // safety: 不正データ防止
        if (sfxDurationFrames <= 0) return null;
        
        return (
          <Sequence
            key={sfx.id}
            from={sfxStartFrame}
            durationInFrames={Math.max(1, sfxDurationFrames)}
          >
            <Audio 
              src={sfx.url} 
              volume={sfx.volume ?? 0.8}
              // P6-2 SSOT: SFXはワンショット音、loop原則不使用
            />
          </Sequence>
        );
      })}
      
      {/* P6-1: シーン別BGMを再生（SSOT: start_ms/end_ms フレーム精度、loop禁止） */}
      {hasSceneBgm && sceneBgm && (() => {
        const durationMs = scene.timing.duration_ms;
        
        // P6-1: start_ms / end_ms をフレーム精度で反映 + safety clamp
        const startMsRaw = sceneBgm.start_ms ?? 0;
        const endMsRaw = sceneBgm.end_ms ?? durationMs;
        
        // safety clamp: はみ出し防止
        const startMs = Math.max(0, Math.min(startMsRaw, durationMs));
        const endMs = Math.max(startMs, Math.min(endMsRaw, durationMs));
        
        const bgmStartFrame = msToFrames(startMs, fps);
        const bgmEndFrame = msToFrames(endMs, fps);
        const bgmDurationFrames = bgmEndFrame - bgmStartFrame;
        
        // safety: 不正データ防止（ゴミ区間は再生しない）
        if (bgmDurationFrames <= 0) return null;
        
        return (
          <Sequence
            from={bgmStartFrame}
            durationInFrames={bgmDurationFrames}
          >
            <Audio
              src={sceneBgm.url}
              volume={sceneBgm.volume ?? 0.25}
              // P6-1 SSOT: loop禁止（途中で切れてOK、次シーンに持ち越さない）
            />
          </Sequence>
        );
      })()}
      
      {/* 字幕表示 - R2: baked/none時は描画しない */}
      {shouldRenderSubtitle && subtitleText && (
        <Subtitle
          text={subtitleText}
          durationFrames={durationFrames}
          style={subtitleStyle}
          position="bottom"
        />
      )}
      
      {/* A案 baked: バルーンオーバーレイ表示 */}
      {hasBalloons && (
        <BalloonOverlay
          balloons={balloons}
          textRenderMode={textRenderMode}
        />
      )}
    </AbsoluteFill>
  );
};
