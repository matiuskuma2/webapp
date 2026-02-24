import React from 'react';
import { AbsoluteFill, Img, Audio, Video, Sequence, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import type { ProjectScene, VoiceAsset, SfxAsset, SceneBgmAsset } from '../schemas/project-schema';
import { msToFrames } from '../utils/timing';
import { Subtitle, TelopStylePreset, CustomTelopStyle, TelopTypography } from './Subtitle';
import { MotionWrapper, getMotionPreset } from './MotionWrapper';
import { BalloonOverlay } from './BalloonOverlay';

interface SceneProps {
  scene: ProjectScene;
  showSubtitle?: boolean;
  /** @deprecated style より stylePreset/sizePreset/position を使用 */
  subtitleStyle?: 'default' | 'cinematic' | 'news' | 'minimal';
  /** Phase 1: テロップスタイルプリセット */
  telopStylePreset?: TelopStylePreset;
  /** Phase 1: テロップサイズプリセット */
  telopSizePreset?: 'sm' | 'md' | 'lg';
  /** Phase 1: テロップ表示位置 */
  telopPosition?: 'bottom' | 'center' | 'top';
  /** Vrew風カスタムスタイル */
  telopCustomStyle?: CustomTelopStyle | null;
  /** PR-Remotion-Typography: 文字組み設定 */
  telopTypography?: TelopTypography | null;
  /** トランジションタイプ: 'none' の場合フェイドイン/アウトなし */
  transitionType?: 'none' | 'fade' | 'slide' | 'wipe';
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
  subtitleStyle = 'default',
  telopStylePreset = 'outline',
  telopSizePreset = 'md',
  telopPosition = 'bottom',
  telopCustomStyle = null,
  telopTypography = null,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  
  const durationFrames = msToFrames(scene.timing.duration_ms, fps);
  
  // ★ 安全検証: voices の合計尺がシーン尺を超えていないかチェック
  // buildProjectJson側で正しく計算されるべきだが、防御的にログ出力
  const voices_check = scene.assets?.voices || [];
  if (voices_check.length > 0) {
    const lastVoice = voices_check[voices_check.length - 1];
    const voiceEndMs = (lastVoice.start_ms ?? 0) + lastVoice.duration_ms;
    if (voiceEndMs > scene.timing.duration_ms) {
      console.warn(`[Scene ${scene.idx}] ⚠️ VOICE OVERFLOW: lastVoice ends at ${voiceEndMs}ms but scene duration is ${scene.timing.duration_ms}ms. Audio Sequence will use remaining scene frames to prevent clipping.`);
    }
  }
  
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
  
  // フェードイン・アウト（transitionType が 'none' の場合は常にopacity=1）
  const effectiveTransitionType = props.transitionType ?? 'fade';
  const fadeFrames = effectiveTransitionType === 'none' ? 0 : Math.min(15, Math.floor(durationFrames / 4));
  const opacity = effectiveTransitionType === 'none' ? 1 : interpolate(
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
  // ★ FIX: テロップ途中切れ防止
  // 音声は <Audio> + remainingFrames で実際のMP3長まで再生されるが、
  // テロップは voice.duration_ms (DB値) で判定すると短すぎて途中で消える。
  // 
  // 対策:
  //   1. voice.end_ms があればそれを使用（buildProjectJson の正確な計算値）
  //   2. 最後の voice は次の voice が来るまで（=シーン終了まで）テロップを維持
  //   3. voice 間のギャップでは直前の voice のテロップを維持（隙間でテロップが消えない）
  const currentMs = (frame / fps) * 1000;
  const sceneDurationMs = scene.timing.duration_ms;
  
  const currentVoice = (() => {
    if (effectiveVoices.length === 0) return undefined;
    
    // 各 voice のテロップ表示区間を計算
    // key: voice の start_ms から「次の voice の start_ms - 1」までテロップ表示
    // 最後の voice はシーン終了まで表示
    for (let i = 0; i < effectiveVoices.length; i++) {
      const voice = effectiveVoices[i];
      const voiceStartMs = voice.start_ms ?? 0;
      
      // テロップの終了時刻:
      //   - 次の voice がある場合: 次の voice の start_ms（隙間なく次のテロップに繋がる）
      //   - 最後の voice の場合: シーン終了まで
      const nextVoice = effectiveVoices[i + 1];
      const telopEndMs = nextVoice 
        ? (nextVoice.start_ms ?? 0)
        : sceneDurationMs;
      
      if (currentMs >= voiceStartMs && currentMs < telopEndMs) {
        return voice;
      }
    }
    
    return undefined;
  })();
  
  // 字幕テキスト: currentVoice があればそのtext、なければ dialogue
  const subtitleText = currentVoice?.text || (showSubtitle && !hasVoices ? scene.dialogue : '');
  
  // ========================================
  // 動画クリップがある場合
  // ★ FIX: <Video> のネイティブ最終フレーム保持を活用
  //   Remotion の <Video>/<Html5Video> は、動画の duration を超えても
  //   loop={false}（デフォルト）なら最終フレームを自動保持する。
  //   （公式ドキュメント: "When a video ends (and loop is not set),
  //    the last frame of the video remains visible by default."）
  //   以前は動画終了後に <Img thumbnail> へ切り替えていたが、
  //   これが「トップサムネイルに戻る」違和感の原因だったため削除。
  // ========================================
  if (scene.assets?.video_clip?.url) {
    // 動画の長さ（ミリ秒）- ログ用に保持
    const videoDurationMs = scene.assets.video_clip.duration_ms || scene.timing.duration_ms;
    const videoDurationFrames = msToFrames(videoDurationMs, fps);
    
    if (frame === 0) {
      console.log(`[Scene ${scene.idx}] Video mode: video=${videoDurationMs}ms (${videoDurationFrames}f), scene=${scene.timing.duration_ms}ms (${durationFrames}f)`);
      if (durationFrames > videoDurationFrames) {
        console.log(`[Scene ${scene.idx}] Video shorter than scene: last frame will be held for ${durationFrames - videoDurationFrames}f (Remotion native behavior)`);
      }
    }
    
    return (
      <AbsoluteFill style={{ opacity }}>
        {/* 動画再生: 終了後は Remotion が自動的に最終フレームを保持 */}
        <Video
          src={scene.assets.video_clip.url}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
        {/* R1.5: voices[] を再生 */}
        {/* ★ FIX: durationInFrames をシーン尺の残りまで拡張
            voice.duration_ms が不正確でも、実際の音声ファイルの長さまで再生される。
            Remotion の <Audio> は音声ファイル終了で自動停止するため、長めに取っても問題ない。
            これにより duration_ms の計算誤差による音声切れを構造的に防止する。 */}
        {effectiveVoices.map((voice) => {
          const voiceStartFrame = msToFrames(voice.start_ms ?? 0, fps);
          // シーン尺の残りフレーム = シーンの終わりまで音声再生を許可
          const remainingFrames = Math.max(1, durationFrames - voiceStartFrame);
          
          return (
            <Sequence 
              key={voice.id} 
              from={voiceStartFrame} 
              durationInFrames={remainingFrames}
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
        
        {/* P6-1: シーン別BGMを再生（SSOT: start_ms/end_ms フレーム精度、loop禁止、audio_offset_ms対応） */}
        {hasSceneBgm && sceneBgm && (() => {
          // P6-1: start_ms / end_ms をフレーム精度で反映
          const bgmStartFrame = msToFrames(sceneBgm.start_ms ?? 0, fps);
          // end_ms が未指定 or null の場合はシーン終了まで再生
          const bgmEndMs = sceneBgm.end_ms ?? scene.timing.duration_ms;
          const bgmEndFrame = msToFrames(bgmEndMs, fps);
          const bgmDurationFrames = Math.max(1, bgmEndFrame - bgmStartFrame);
          
          // audio_offset_ms: BGMファイルの再生開始位置（startFrom用）
          const audioOffsetMs = (sceneBgm as any).audio_offset_ms ?? 0;
          const audioOffsetFrames = msToFrames(audioOffsetMs, fps);
          
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
                startFrom={audioOffsetFrames}
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
            stylePreset={telopStylePreset}
            sizePreset={telopSizePreset}
            position={telopPosition}
            customStyle={telopCustomStyle}
            typography={telopTypography}
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
      {/* ★ FIX: durationInFrames をシーン尺の残りまで拡張（音声切れ防止） */}
      {effectiveVoices.map((voice) => {
        const voiceStartFrame = msToFrames(voice.start_ms ?? 0, fps);
        // シーン尺の残りフレーム = シーンの終わりまで音声再生を許可
        const remainingFrames = Math.max(1, durationFrames - voiceStartFrame);
        
        return (
          <Sequence 
            key={voice.id} 
            from={voiceStartFrame} 
            durationInFrames={remainingFrames}
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
      
      {/* P6-1/P6-4: シーン別BGMを再生（SSOT: start_ms/end_ms フレーム精度、loop禁止、フェード付き、audio_offset_ms対応） */}
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
        
        // audio_offset_ms: BGMファイルの再生開始位置（startFrom用）
        const audioOffsetMs = (sceneBgm as any).audio_offset_ms ?? 0;
        const audioOffsetFrames = msToFrames(audioOffsetMs, fps);
        
        // safety: 不正データ防止（ゴミ区間は再生しない）
        if (bgmDurationFrames <= 0) return null;
        
        // P6-4: フェード設定（パツッとした切替を防ぐ）
        const fadeMs = 120;
        const fadeFrames = msToFrames(fadeMs, fps);
        const baseVolume = sceneBgm.volume ?? 0.25;
        
        // P6-4: フレームに応じた音量計算（フェードイン/アウト）
        const volumeCallback = (f: number) => {
          // fはSequence内の相対フレーム（0から始まる）
          // fadeIn: 開始からfadeFramesの間
          if (f < fadeFrames) {
            return interpolate(f, [0, fadeFrames], [0, baseVolume], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });
          }
          // fadeOut: 終了前fadeFramesの間
          if (f >= bgmDurationFrames - fadeFrames) {
            return interpolate(
              f,
              [bgmDurationFrames - fadeFrames, bgmDurationFrames],
              [baseVolume, 0],
              { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
            );
          }
          return baseVolume;
        };
        
        return (
          <Sequence
            from={bgmStartFrame}
            durationInFrames={bgmDurationFrames}
          >
            <Audio
              src={sceneBgm.url}
              volume={volumeCallback}
              startFrom={audioOffsetFrames}
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
          stylePreset={telopStylePreset}
          sizePreset={telopSizePreset}
          position={telopPosition}
          customStyle={telopCustomStyle}
          typography={telopTypography}
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
