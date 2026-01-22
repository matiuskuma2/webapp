/**
 * BalloonOverlay - A案 baked 専用バルーン表示コンポーネント
 * 
 * A案 baked（確定）:
 * - 漫画化で「文字入りバブルPNG」を作る（フォント/縦横/サイズ/色も全部そこで確定）
 * - 動画化では そのPNGを"素材として" 持ち、喋っている区間だけ表示
 * - 文字をRemotionで描くのは しない（二重事故回避）
 * 
 * 表示ルール:
 * - text_render_mode='baked' の場合のみ表示
 * - bubble_image_url がないバルーンはスキップ（安全にスキップ）
 * - start_ms <= currentMs < end_ms の間だけ表示
 * 
 * 座標系:
 * - useVideoConfig() の width/height を使用（9:16 = 1080x1920 が基本）
 * - position.x/y は 0-1 の正規化座標
 */

import React from 'react';
import { useCurrentFrame, useVideoConfig, Img, interpolate, Easing } from 'remotion';
import type { BalloonAsset } from '../schemas/project-schema';

interface BalloonOverlayProps {
  balloons: BalloonAsset[];
  textRenderMode: 'remotion' | 'baked' | 'none';
}

// フェードイン/アウト用の定数
const FADE_DURATION_MS = 150;

/**
 * BalloonOverlay - A案 baked 用
 * 
 * 使用例:
 * <BalloonOverlay balloons={scene.balloons} textRenderMode={scene.text_render_mode} />
 */
export const BalloonOverlay: React.FC<BalloonOverlayProps> = ({
  balloons,
  textRenderMode,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  
  // 現在時刻（ms）
  const currentMs = (frame / fps) * 1000;

  // A案 baked: text_render_mode='baked' の場合のみ表示
  // remotion モードは将来対応（今は何も表示しない）
  if (textRenderMode !== 'baked') {
    return null;
  }

  // バルーンがない場合は何も表示しない
  if (!balloons || balloons.length === 0) {
    return null;
  }

  // Debug: 最初のフレームでログ
  if (frame === 0) {
    console.log(`[BalloonOverlay] baked mode: ${balloons.length} balloons, video size: ${width}x${height}`);
    balloons.forEach((b, i) => {
      console.log(`[BalloonOverlay] balloon[${i}]: start=${b.start_ms}ms, end=${b.end_ms}ms, hasImage=${!!b.bubble_image_url}`);
    });
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    >
      {balloons.map((balloon) => (
        <BakedBalloonItem
          key={balloon.id}
          balloon={balloon}
          currentMs={currentMs}
          videoWidth={width}
          videoHeight={height}
        />
      ))}
    </div>
  );
};

// 個別バルーンアイテム（baked専用）
interface BakedBalloonItemProps {
  balloon: BalloonAsset;
  currentMs: number;
  videoWidth: number;
  videoHeight: number;
}

const BakedBalloonItem: React.FC<BakedBalloonItemProps> = ({
  balloon,
  currentMs,
  videoWidth,
  videoHeight,
}) => {
  const { start_ms, end_ms, position, size, bubble_image_url, z_index } = balloon;
  
  // A案 baked: bubble_image_url がない場合は何も表示しない（安全にスキップ）
  if (!bubble_image_url) {
    return null;
  }
  
  // 表示タイミング判定: start_ms <= currentMs < end_ms
  const isVisible = currentMs >= start_ms && currentMs < end_ms;
  
  // 非表示時はレンダリングしない（パフォーマンス最適化）
  if (!isVisible) {
    return null;
  }
  
  // フェードイン/アウト計算
  let opacity = 1;
  const fadeInEnd = start_ms + FADE_DURATION_MS;
  const fadeOutStart = end_ms - FADE_DURATION_MS;
  
  if (currentMs < fadeInEnd) {
    // フェードイン中
    opacity = interpolate(
      currentMs,
      [start_ms, fadeInEnd],
      [0, 1],
      { easing: Easing.ease }
    );
  } else if (currentMs >= fadeOutStart) {
    // フェードアウト中
    opacity = interpolate(
      currentMs,
      [fadeOutStart, end_ms],
      [1, 0],
      { easing: Easing.ease }
    );
  }

  // 位置・サイズ計算（正規化座標 0-1 → ピクセル）
  // useVideoConfig() の width/height を使用
  const left = position.x * videoWidth;
  const top = position.y * videoHeight;
  const width = size.w * videoWidth;
  const height = size.h * videoHeight;

  return (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        width,
        height,
        opacity,
        zIndex: z_index ?? 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Img
        src={bubble_image_url}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
        }}
      />
    </div>
  );
};

// named export のみ（default export は使わない）
