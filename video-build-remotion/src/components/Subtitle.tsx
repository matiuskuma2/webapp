import React from 'react';
import { useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';

interface SubtitleProps {
  text: string;
  durationFrames: number;
  style?: 'default' | 'cinematic' | 'news' | 'minimal';
  position?: 'bottom' | 'center' | 'top';
  fontSize?: number;
}

export const Subtitle: React.FC<SubtitleProps> = ({
  text,
  durationFrames,
  style = 'default',
  position = 'bottom',
  fontSize = 42,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // テキストがない場合は何も表示しない
  if (!text || text.trim() === '') {
    return null;
  }

  // フェードイン・アウト
  const fadeInFrames = 10;
  const fadeOutFrames = 10;
  const opacity = interpolate(
    frame,
    [0, fadeInFrames, durationFrames - fadeOutFrames, durationFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  // スプリングアニメーション for entrance
  const entrance = spring({
    frame,
    fps,
    config: {
      damping: 100,
      stiffness: 200,
      mass: 0.5,
    },
  });

  const translateY = interpolate(entrance, [0, 1], [20, 0]);

  // Position styles
  const positionStyles: Record<string, React.CSSProperties> = {
    bottom: {
      bottom: 80,
      left: 0,
      right: 0,
    },
    center: {
      top: '50%',
      left: 0,
      right: 0,
      transform: `translateY(-50%) translateY(${translateY}px)`,
    },
    top: {
      top: 80,
      left: 0,
      right: 0,
    },
  };

  // Style presets
  const getStylePreset = (): React.CSSProperties => {
    const baseStyle: React.CSSProperties = {
      position: 'absolute',
      ...positionStyles[position],
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      padding: '0 40px',
      opacity,
      transform: position !== 'center' ? `translateY(${translateY}px)` : undefined,
    };

    return baseStyle;
  };

  const getTextStyle = (): React.CSSProperties => {
    switch (style) {
      case 'cinematic':
        return {
          color: 'white',
          fontSize,
          fontWeight: '400',
          fontFamily: "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif",
          textAlign: 'center' as const,
          lineHeight: 1.6,
          letterSpacing: '0.05em',
          textShadow: '2px 2px 8px rgba(0,0,0,0.8), 0 0 20px rgba(0,0,0,0.5)',
          maxWidth: '90%',
        };
      case 'news':
        return {
          color: 'white',
          fontSize,
          fontWeight: '700',
          fontFamily: "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif",
          textAlign: 'center' as const,
          lineHeight: 1.4,
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          padding: '12px 24px',
          borderRadius: 4,
          maxWidth: '90%',
        };
      case 'minimal':
        return {
          color: 'white',
          fontSize: fontSize * 0.9,
          fontWeight: '300',
          fontFamily: "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif",
          textAlign: 'center' as const,
          lineHeight: 1.5,
          textShadow: '1px 1px 4px rgba(0,0,0,0.9)',
          maxWidth: '85%',
        };
      default:
        // Default style - 縁取り付きの読みやすいスタイル
        return {
          color: 'white',
          fontSize,
          fontWeight: '600',
          fontFamily: "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif",
          textAlign: 'center' as const,
          lineHeight: 1.5,
          // 縁取り効果（複数のtext-shadowで実現）
          textShadow: `
            -2px -2px 0 #000,
            2px -2px 0 #000,
            -2px 2px 0 #000,
            2px 2px 0 #000,
            -2px 0 0 #000,
            2px 0 0 #000,
            0 -2px 0 #000,
            0 2px 0 #000,
            0 0 10px rgba(0,0,0,0.8)
          `,
          maxWidth: '90%',
        };
    }
  };

  return (
    <div style={getStylePreset()}>
      <div style={getTextStyle()}>
        {text}
      </div>
    </div>
  );
};
