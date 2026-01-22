import React from 'react';
import { AbsoluteFill, Img, Audio, Video, Sequence, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import type { ProjectScene, VoiceAsset } from '../schemas/project-schema';
import { msToFrames } from '../utils/timing';
import { Subtitle } from './Subtitle';
import { MotionWrapper, getMotionPreset } from './MotionWrapper';

interface SceneProps {
  scene: ProjectScene;
  showSubtitle?: boolean;
  subtitleStyle?: 'default' | 'cinematic' | 'news' | 'minimal';
}

/**
 * Scene Component - R1.5/R2 対応
 * 
 * ## R1.5 変更点
 * - voices[] 配列をサポート（複数話者音声）
 * - 字幕は voice.text から表示
 * - 後方互換: audio 単体もサポート
 * 
 * ## R2 変更点
 * - text_render_mode 対応（baked時は字幕描画しない）
 * - balloons 配列サポート（remotion時のみ描画）
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
  
  // Debug: 最初のフレームでログ出力
  if (frame === 0) {
    console.log(`[Scene ${scene.idx}] Rendering first frame (relative frame 0)`);
    console.log(`[Scene ${scene.idx}] Image URL: ${scene.assets?.image?.url}`);
    console.log(`[Scene ${scene.idx}] Duration frames: ${durationFrames}`);
    console.log(`[Scene ${scene.idx}] Voices count: ${scene.assets?.voices?.length || 0}`);
    console.log(`[Scene ${scene.idx}] text_render_mode: ${textRenderMode}`);
    console.log(`[Scene ${scene.idx}] motion preset: ${motionPreset?.id || 'default'}`);
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
        {/* 字幕表示 - R2: baked/none時は描画しない */}
        {shouldRenderSubtitle && subtitleText && (
          <Subtitle
            text={subtitleText}
            durationFrames={durationFrames}
            style={subtitleStyle}
            position="bottom"
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
      
      {/* 字幕表示 - R2: baked/none時は描画しない */}
      {shouldRenderSubtitle && subtitleText && (
        <Subtitle
          text={subtitleText}
          durationFrames={durationFrames}
          style={subtitleStyle}
          position="bottom"
        />
      )}
    </AbsoluteFill>
  );
};
