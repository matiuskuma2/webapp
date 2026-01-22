/**
 * BalloonOverlay - A案 baked 用バルーン表示コンポーネント
 * 
 * 機能:
 * - text_render_mode='baked' の場合: bubble_image_url の画像をタイミング表示
 * - text_render_mode='remotion' の場合: スタイルに基づいてテキスト描画（従来方式）
 * - start_ms <= currentMs < end_ms の間だけ表示
 * 
 * SSOT: utterance の時間窓に連動
 */

import React from 'react';
import { useCurrentFrame, useVideoConfig, Img, interpolate, Easing } from 'remotion';
import type { BalloonAsset } from '../schemas/project-schema';

interface BalloonOverlayProps {
  balloons: BalloonAsset[];
  textRenderMode: 'remotion' | 'baked' | 'none';
  containerWidth: number;
  containerHeight: number;
}

// フェードイン/アウト用の定数
const FADE_DURATION_MS = 150;

export const BalloonOverlay: React.FC<BalloonOverlayProps> = ({
  balloons,
  textRenderMode,
  containerWidth,
  containerHeight,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  
  // 現在時刻（ms）
  const currentMs = (frame / fps) * 1000;

  // text_render_mode='none' の場合は何も表示しない
  if (textRenderMode === 'none') {
    return null;
  }

  // バルーンがない場合も何も表示しない
  if (!balloons || balloons.length === 0) {
    return null;
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
        <BalloonItem
          key={balloon.id}
          balloon={balloon}
          currentMs={currentMs}
          textRenderMode={textRenderMode}
          containerWidth={containerWidth}
          containerHeight={containerHeight}
          fps={fps}
        />
      ))}
    </div>
  );
};

// 個別バルーンアイテム
interface BalloonItemProps {
  balloon: BalloonAsset;
  currentMs: number;
  textRenderMode: 'remotion' | 'baked' | 'none';
  containerWidth: number;
  containerHeight: number;
  fps: number;
}

const BalloonItem: React.FC<BalloonItemProps> = ({
  balloon,
  currentMs,
  textRenderMode,
  containerWidth,
  containerHeight,
  fps,
}) => {
  const { start_ms, end_ms, position, size, bubble_image_url, bubble_image_size, style, text, z_index } = balloon;
  
  // 表示タイミング判定
  const isVisible = currentMs >= start_ms && currentMs < end_ms;
  
  // フェードイン/アウト計算
  let opacity = 0;
  if (isVisible) {
    // フェードイン (start_ms から FADE_DURATION_MS の間)
    const fadeInEnd = start_ms + FADE_DURATION_MS;
    // フェードアウト (end_ms - FADE_DURATION_MS から end_ms の間)
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
    } else {
      // 完全表示
      opacity = 1;
    }
  }
  
  // 非表示時はレンダリングしない
  if (opacity <= 0) {
    return null;
  }

  // 位置・サイズ計算（正規化座標 0-1 → ピクセル）
  const left = position.x * containerWidth;
  const top = position.y * containerHeight;
  const width = size.w * containerWidth;
  const height = size.h * containerHeight;

  // A案 baked: bubble_image_url がある場合は画像を表示
  if (textRenderMode === 'baked' && bubble_image_url) {
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
  }

  // text_render_mode='remotion': スタイルに基づいてテキスト描画
  if (textRenderMode === 'remotion') {
    return (
      <BalloonTextRender
        balloon={balloon}
        left={left}
        top={top}
        width={width}
        height={height}
        opacity={opacity}
      />
    );
  }

  // baked モードで bubble_image_url がない場合は何も表示しない
  return null;
};

// Remotionモード用テキスト描画コンポーネント
interface BalloonTextRenderProps {
  balloon: BalloonAsset;
  left: number;
  top: number;
  width: number;
  height: number;
  opacity: number;
}

const BalloonTextRender: React.FC<BalloonTextRenderProps> = ({
  balloon,
  left,
  top,
  width,
  height,
  opacity,
}) => {
  const { text, shape, style, tail, z_index } = balloon;

  // デフォルトスタイル
  const writingMode = style?.writing_mode ?? 'horizontal';
  const fontFamily = style?.font_family ?? 'Noto Sans JP, sans-serif';
  const fontWeight = style?.font_weight === 'bold' ? 700 : 400;
  const fontSize = (style?.font_scale ?? 1) * 24; // 基準サイズ24px
  const bgColor = style?.bg_color ?? '#FFFFFF';
  const textColor = style?.text_color ?? '#000000';
  const borderColor = style?.border_color ?? '#000000';
  const borderWidth = style?.border_width ?? 2;

  // 形状に応じたスタイル
  const getBorderRadius = () => {
    switch (shape) {
      case 'round': return '50%';
      case 'square': return '8px';
      case 'thought': return '50%';
      case 'shout': return '0px';
      case 'caption': return '4px';
      case 'telop_bar': return '0px';
      default: return '12px';
    }
  };

  // テロップバーの場合は特別なスタイル
  if (shape === 'telop_bar') {
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
          backgroundColor: bgColor,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '8px 16px',
        }}
      >
        <span
          style={{
            fontFamily,
            fontWeight,
            fontSize,
            color: textColor,
            writingMode: writingMode === 'vertical' ? 'vertical-rl' : 'horizontal-tb',
            textAlign: 'center',
          }}
        >
          {text}
        </span>
      </div>
    );
  }

  // 通常の吹き出し
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
        backgroundColor: bgColor,
        border: `${borderWidth}px solid ${borderColor}`,
        borderRadius: getBorderRadius(),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '8px',
        boxSizing: 'border-box',
      }}
    >
      <span
        style={{
          fontFamily,
          fontWeight,
          fontSize,
          color: textColor,
          writingMode: writingMode === 'vertical' ? 'vertical-rl' : 'horizontal-tb',
          textAlign: 'center',
          lineHeight: 1.4,
          wordBreak: 'break-word',
          overflow: 'hidden',
        }}
      >
        {text}
      </span>
    </div>
  );
};

export default BalloonOverlay;
