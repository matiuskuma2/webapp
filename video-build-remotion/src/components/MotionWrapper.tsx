import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';

/**
 * MotionPreset - シーンモーションのプリセット定義
 */
export interface MotionPreset {
  id: string;
  motion_type: 'none' | 'zoom' | 'pan' | 'combined';
  params: {
    // Zoom params
    start_scale?: number;
    end_scale?: number;
    // Pan params (% of image size)
    start_x?: number;
    end_x?: number;
    start_y?: number;
    end_y?: number;
  };
}

interface MotionWrapperProps {
  children: React.ReactNode;
  preset: MotionPreset | null;
  durationFrames: number;
}

/**
 * MotionWrapper Component
 * 
 * 子要素（画像等）にモーションエフェクトを適用するラッパー
 * 
 * @param preset - モーションプリセット（nullの場合はkenburns_softをデフォルト適用）
 * @param durationFrames - シーンの総フレーム数
 */
export const MotionWrapper: React.FC<MotionWrapperProps> = ({ 
  children, 
  preset, 
  durationFrames 
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  
  // プリセットがない場合はデフォルト（kenburns_soft）
  const effectivePreset: MotionPreset = preset || {
    id: 'kenburns_soft',
    motion_type: 'zoom',
    params: { start_scale: 1.0, end_scale: 1.05 }
  };
  
  // モーションタイプに応じた transform を計算
  const transform = calculateTransform(effectivePreset, frame, durationFrames);
  
  // Debug: 最初のフレームでログ
  if (frame === 0) {
    console.log(`[MotionWrapper] preset: ${effectivePreset.id}, type: ${effectivePreset.motion_type}`);
    console.log(`[MotionWrapper] params:`, effectivePreset.params);
  }
  
  // none の場合は transform なし
  if (effectivePreset.motion_type === 'none') {
    return <AbsoluteFill>{children}</AbsoluteFill>;
  }
  
  return (
    <AbsoluteFill
      style={{
        transform,
        transformOrigin: 'center center',
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

/**
 * モーションパラメータから transform 文字列を計算
 */
function calculateTransform(
  preset: MotionPreset, 
  frame: number, 
  durationFrames: number
): string {
  const { motion_type, params } = preset;
  
  const transforms: string[] = [];
  
  // Zoom (Ken Burns) エフェクト
  if (motion_type === 'zoom' || motion_type === 'combined') {
    const startScale = params.start_scale ?? 1.0;
    const endScale = params.end_scale ?? 1.05;
    
    const scale = interpolate(
      frame,
      [0, durationFrames],
      [startScale, endScale],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );
    
    transforms.push(`scale(${scale})`);
  }
  
  // Pan エフェクト
  if (motion_type === 'pan' || motion_type === 'combined') {
    const startX = params.start_x ?? 0;
    const endX = params.end_x ?? 0;
    const startY = params.start_y ?? 0;
    const endY = params.end_y ?? 0;
    
    const translateX = interpolate(
      frame,
      [0, durationFrames],
      [startX, endX],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );
    
    const translateY = interpolate(
      frame,
      [0, durationFrames],
      [startY, endY],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );
    
    transforms.push(`translate(${translateX}%, ${translateY}%)`);
  }
  
  return transforms.join(' ') || 'none';
}

/**
 * プリセットIDから MotionPreset オブジェクトを生成
 * （project_jsonに組み込む際に使用）
 */
export const MOTION_PRESETS: Record<string, MotionPreset> = {
  none: {
    id: 'none',
    motion_type: 'none',
    params: {}
  },
  kenburns_soft: {
    id: 'kenburns_soft',
    motion_type: 'zoom',
    params: { start_scale: 1.0, end_scale: 1.05 }
  },
  kenburns_strong: {
    id: 'kenburns_strong',
    motion_type: 'zoom',
    params: { start_scale: 1.0, end_scale: 1.15 }
  },
  pan_lr: {
    id: 'pan_lr',
    motion_type: 'pan',
    params: { start_x: -5, end_x: 5, start_y: 0, end_y: 0 }
  },
  pan_rl: {
    id: 'pan_rl',
    motion_type: 'pan',
    params: { start_x: 5, end_x: -5, start_y: 0, end_y: 0 }
  },
  pan_tb: {
    id: 'pan_tb',
    motion_type: 'pan',
    params: { start_x: 0, end_x: 0, start_y: -5, end_y: 5 }
  },
  pan_bt: {
    id: 'pan_bt',
    motion_type: 'pan',
    params: { start_x: 0, end_x: 0, start_y: 5, end_y: -5 }
  },
};

/**
 * プリセットIDから MotionPreset を取得
 */
export function getMotionPreset(presetId: string | null | undefined): MotionPreset {
  if (!presetId || !MOTION_PRESETS[presetId]) {
    return MOTION_PRESETS.kenburns_soft; // デフォルト
  }
  return MOTION_PRESETS[presetId];
}
