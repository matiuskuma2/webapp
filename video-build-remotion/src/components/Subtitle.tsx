import React from 'react';
import { useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';

/**
 * Phase 1: テロップスタイルプリセット
 * SSOT: build_settings.telops.style_preset で指定
 * 
 * プリセット一覧:
 * - minimal: 控えめな白文字（小さめ、影なし）
 * - outline: 黒縁取りの白文字（デフォルト、読みやすい）
 * - band: 帯付き字幕（TV風、背景あり）
 * - pop: ポップスタイル（バラエティ風、黄色背景）
 * - cinematic: 映画風（控えめ、シネマスコープ風）
 * 
 * 後方互換:
 * - 'default' → 'outline' として扱う
 * - 'news' → 'band' として扱う
 */
export type TelopStylePreset = 'minimal' | 'outline' | 'band' | 'pop' | 'cinematic';

// 後方互換マッピング
const STYLE_COMPAT_MAP: Record<string, TelopStylePreset> = {
  'default': 'outline',
  'news': 'band',
};

/**
 * Vrew風カスタムスタイル設定
 */
export interface CustomTelopStyle {
  text_color?: string;      // 文字色 (例: "#FFFFFF")
  stroke_color?: string;    // 縁取り色 (例: "#000000")
  stroke_width?: number;    // 縁取り太さ (0-6px)
  bg_color?: string;        // 背景色 (例: "#000000")
  bg_opacity?: number;      // 背景透過度 (0-1)
  font_family?: string;     // フォント (noto-sans, noto-serif, rounded, zen-maru)
  font_weight?: string;     // 太さ (400-800)
}

interface SubtitleProps {
  text: string;
  durationFrames: number;
  /** @deprecated 旧スタイル名 - stylePreset を使用してください */
  style?: 'default' | 'cinematic' | 'news' | 'minimal' | TelopStylePreset;
  /** Phase 1: 新しいスタイルプリセット */
  stylePreset?: TelopStylePreset;
  position?: 'bottom' | 'center' | 'top';
  /** サイズプリセット: sm=小, md=中, lg=大 */
  sizePreset?: 'sm' | 'md' | 'lg';
  /** @deprecated fontSize より sizePreset を推奨 */
  fontSize?: number;
  /** Vrew風カスタムスタイル（設定されていればプリセットより優先） */
  customStyle?: CustomTelopStyle | null;
}

// サイズプリセットから基本フォントサイズへのマッピング
const SIZE_PRESET_MAP: Record<string, number> = {
  'sm': 28,
  'md': 38,
  'lg': 52,
};

// フォントファミリーのマッピング
const FONT_FAMILY_MAP: Record<string, string> = {
  'noto-sans': "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif",
  'noto-serif': "'Noto Serif JP', 'Hiragino Mincho ProN', serif",
  'rounded': "'M PLUS Rounded 1c', 'Noto Sans JP', sans-serif",
  'zen-maru': "'Zen Maru Gothic', 'Noto Sans JP', sans-serif",
};

export const Subtitle: React.FC<SubtitleProps> = ({
  text,
  durationFrames,
  style,
  stylePreset,
  position = 'bottom',
  sizePreset = 'md',
  fontSize,
  customStyle,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // テキストがない場合は何も表示しない
  if (!text || text.trim() === '') {
    return null;
  }

  // スタイル解決: stylePreset > style（後方互換マッピング適用）
  const resolvedStyle: TelopStylePreset = 
    stylePreset || 
    STYLE_COMPAT_MAP[style || ''] as TelopStylePreset || 
    (style as TelopStylePreset) ||
    'outline';

  // フォントサイズ解決: fontSize > sizePreset
  const baseFontSize = fontSize || SIZE_PRESET_MAP[sizePreset] || 38;

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

  /**
   * Phase 1: スタイルプリセット定義
   * 各プリセットの特徴:
   * - minimal: シンプル、控えめ、邪魔にならない
   * - outline: 視認性重視、縁取りで読みやすい（デフォルト）
   * - band: TV風、帯背景で強調
   * - pop: バラエティ風、派手で目立つ
   * - cinematic: 映画風、上品で控えめ
   */
  const getTextStyle = (): React.CSSProperties => {
    const fontFamily = "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif";

    switch (resolvedStyle) {
      case 'minimal':
        // 控えめな白文字（小さめ、影のみ）
        return {
          color: 'white',
          fontSize: baseFontSize * 0.9,
          fontWeight: '400',
          fontFamily,
          textAlign: 'center' as const,
          lineHeight: 1.5,
          textShadow: '1px 1px 4px rgba(0,0,0,0.9)',
          maxWidth: '85%',
        };

      case 'outline':
        // 黒縁取りの白文字（デフォルト、読みやすい）
        return {
          color: 'white',
          fontSize: baseFontSize,
          fontWeight: '600',
          fontFamily,
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

      case 'band':
        // 帯付き字幕（TV風）
        return {
          color: 'white',
          fontSize: baseFontSize,
          fontWeight: '700',
          fontFamily,
          textAlign: 'center' as const,
          lineHeight: 1.4,
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          padding: '12px 24px',
          borderRadius: 4,
          maxWidth: '90%',
        };

      case 'pop':
        // ポップスタイル（バラエティ風）
        return {
          color: '#FF0000',
          fontSize: baseFontSize * 1.1,
          fontWeight: '800',
          fontFamily,
          textAlign: 'center' as const,
          lineHeight: 1.3,
          backgroundColor: 'rgba(255, 255, 0, 0.9)',
          padding: '8px 20px',
          borderRadius: 8,
          // 白い縁取り
          textShadow: `
            -3px -3px 0 #fff,
            3px -3px 0 #fff,
            -3px 3px 0 #fff,
            3px 3px 0 #fff,
            -3px 0 0 #fff,
            3px 0 0 #fff,
            0 -3px 0 #fff,
            0 3px 0 #fff
          `,
          maxWidth: '85%',
        };

      case 'cinematic':
        // 映画風（控えめ、上品）
        return {
          color: 'white',
          fontSize: baseFontSize * 0.85,
          fontWeight: '400',
          fontFamily,
          textAlign: 'center' as const,
          lineHeight: 1.6,
          letterSpacing: '0.05em',
          textShadow: '2px 2px 8px rgba(0,0,0,0.8), 0 0 20px rgba(0,0,0,0.5)',
          maxWidth: '90%',
        };

      default:
        // フォールバック: outline スタイル
        return {
          color: 'white',
          fontSize: baseFontSize,
          fontWeight: '600',
          fontFamily,
          textAlign: 'center' as const,
          lineHeight: 1.5,
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

  /**
   * カスタムスタイルを適用してテキストスタイルを生成
   * customStyle が指定されていればプリセットを上書き
   */
  const getCustomizedTextStyle = (): React.CSSProperties => {
    const baseStyle = getTextStyle();
    
    // カスタムスタイルがなければプリセットをそのまま使用
    if (!customStyle) {
      return baseStyle;
    }
    
    // カスタムスタイルを適用
    const customized: React.CSSProperties = { ...baseStyle };
    
    // 文字色
    if (customStyle.text_color) {
      customized.color = customStyle.text_color;
    }
    
    // フォント
    if (customStyle.font_family) {
      customized.fontFamily = FONT_FAMILY_MAP[customStyle.font_family] || FONT_FAMILY_MAP['noto-sans'];
    }
    
    // 太さ
    if (customStyle.font_weight) {
      customized.fontWeight = customStyle.font_weight;
    }
    
    // 縁取り（text-shadow）
    const strokeWidth = customStyle.stroke_width ?? 2;
    const strokeColor = customStyle.stroke_color || '#000000';
    
    if (strokeWidth > 0) {
      // 縁取りを8方向で生成
      const sw = strokeWidth;
      customized.textShadow = `
        -${sw}px -${sw}px 0 ${strokeColor},
        ${sw}px -${sw}px 0 ${strokeColor},
        -${sw}px ${sw}px 0 ${strokeColor},
        ${sw}px ${sw}px 0 ${strokeColor},
        -${sw}px 0 0 ${strokeColor},
        ${sw}px 0 0 ${strokeColor},
        0 -${sw}px 0 ${strokeColor},
        0 ${sw}px 0 ${strokeColor},
        0 0 10px rgba(0,0,0,0.5)
      `;
    } else {
      // 縁取りなし（影のみ）
      customized.textShadow = '2px 2px 8px rgba(0,0,0,0.8)';
    }
    
    // 背景（透過度 > 0 の場合のみ）
    const bgOpacity = customStyle.bg_opacity ?? 0;
    if (bgOpacity > 0) {
      const bgColor = customStyle.bg_color || '#000000';
      // HEX to RGBA
      const hex = bgColor.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      customized.backgroundColor = `rgba(${r}, ${g}, ${b}, ${bgOpacity})`;
      customized.padding = '12px 24px';
      customized.borderRadius = 4;
    } else {
      // 背景なし
      customized.backgroundColor = undefined;
      customized.padding = undefined;
      customized.borderRadius = undefined;
    }
    
    return customized;
  };

  return (
    <div style={getStylePreset()}>
      <div style={getCustomizedTextStyle()}>
        {text}
      </div>
    </div>
  );
};
