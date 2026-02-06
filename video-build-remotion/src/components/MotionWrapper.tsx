import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing } from 'remotion';

/**
 * MotionPreset - シーンモーションのプリセット定義
 * 
 * ## SSOT (Single Source of Truth)
 * - Remotion は motion.id と motion.params のみを参照
 * - ランダム要素は buildProjectJson で事前に確定
 * - auto の場合、params.chosen に実際のプリセットIDが入る
 */
export interface MotionPreset {
  id: string;
  motion_type: 'none' | 'zoom' | 'pan' | 'combined' | 'hold_then_pan';
  params: {
    // Zoom params
    start_scale?: number;
    end_scale?: number;
    // Pan params (% of image size)
    start_x?: number;
    end_x?: number;
    start_y?: number;
    end_y?: number;
    // Hold-then-pan params
    hold_ratio?: number;  // 0.0-1.0: ratio of duration to hold before pan starts
    // Auto params (SSOT: buildProjectJson で確定)
    seed?: number;
    chosen?: string;  // auto の場合、実際に選ばれたプリセットID
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
 * ## 重要: ランダム禁止
 * - auto の場合、params.chosen を使用（buildProjectJson で確定済み）
 * - この関数内で Math.random() や Date.now() を使用しない
 * - 再現性 100% を保証
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
  let effectivePreset: MotionPreset = preset || {
    id: 'kenburns_soft',
    motion_type: 'zoom',
    params: { start_scale: 1.0, end_scale: 1.05 }
  };
  
  // auto の場合: params.chosen から実際のプリセットを取得
  // ★ 重要: ここでランダムしない。chosen は buildProjectJson で確定済み
  if (effectivePreset.id === 'auto' && effectivePreset.params.chosen) {
    const chosenPreset = MOTION_PRESETS[effectivePreset.params.chosen];
    if (chosenPreset) {
      effectivePreset = {
        ...chosenPreset,
        params: {
          ...chosenPreset.params,
          // auto の seed を保持（デバッグ用）
          seed: effectivePreset.params.seed,
          chosen: effectivePreset.params.chosen,
        }
      };
    }
  }
  
  // モーションタイプに応じた transform を計算
  const transform = calculateTransform(effectivePreset, frame, durationFrames);
  
  // Debug: 最初のフレームでログ
  if (frame === 0) {
    console.log(`[MotionWrapper] preset: ${preset?.id || 'null'}, effective: ${effectivePreset.id}, type: ${effectivePreset.motion_type}`);
    console.log(`[MotionWrapper] params:`, effectivePreset.params);
    if (preset?.id === 'auto') {
      console.log(`[MotionWrapper] auto resolved to: ${effectivePreset.params.chosen} (seed: ${effectivePreset.params.seed})`);
    }
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
  
  // Pan エフェクト（スライド）
  if (motion_type === 'pan' || motion_type === 'combined') {
    const startX = params.start_x ?? 0;
    const endX = params.end_x ?? 0;
    const startY = params.start_y ?? 0;
    const endY = params.end_y ?? 0;
    
    const translateX = interpolate(
      frame,
      [0, durationFrames],
      [startX, endX],
      { 
        extrapolateLeft: 'clamp', 
        extrapolateRight: 'clamp',
        easing: Easing.inOut(Easing.ease),
      }
    );
    
    const translateY = interpolate(
      frame,
      [0, durationFrames],
      [startY, endY],
      { 
        extrapolateLeft: 'clamp', 
        extrapolateRight: 'clamp',
        easing: Easing.inOut(Easing.ease),
      }
    );
    
    transforms.push(`translate(${translateX}%, ${translateY}%)`);
  }
  
  // Hold-then-pan エフェクト（途中停止→スライド）
  if (motion_type === 'hold_then_pan') {
    const holdRatio = params.hold_ratio ?? 0.3;  // デフォルト: 30%で停止
    const holdFrames = Math.floor(durationFrames * holdRatio);
    
    const startX = params.start_x ?? 0;
    const endX = params.end_x ?? 0;
    const startY = params.start_y ?? 0;
    const endY = params.end_y ?? 0;
    
    let translateX: number;
    let translateY: number;
    
    if (frame <= holdFrames) {
      // Hold phase: 開始位置で静止
      translateX = startX;
      translateY = startY;
    } else {
      // Pan phase: 残りの時間でスライド
      translateX = interpolate(
        frame,
        [holdFrames, durationFrames],
        [startX, endX],
        { 
          extrapolateLeft: 'clamp', 
          extrapolateRight: 'clamp',
          easing: Easing.out(Easing.ease),
        }
      );
      
      translateY = interpolate(
        frame,
        [holdFrames, durationFrames],
        [startY, endY],
        { 
          extrapolateLeft: 'clamp', 
          extrapolateRight: 'clamp',
          easing: Easing.out(Easing.ease),
        }
      );
    }
    
    transforms.push(`translate(${translateX}%, ${translateY}%)`);
  }
  
  return transforms.join(' ') || 'none';
}

/**
 * プリセットIDから MotionPreset オブジェクトを生成
 * （project_jsonに組み込む際に使用）
 * 
 * ## プリセット一覧
 * - none: 静止
 * - kenburns_soft: ゆっくりズーム（1.0 → 1.05）
 * - kenburns_strong: しっかりズーム（1.0 → 1.15）
 * - pan_lr / pan_rl / pan_tb / pan_bt: 軽いパン（-5% → +5%）
 * - slide_lr / slide_rl / slide_tb / slide_bt: 大きなスライド（-10% → +10%）
 * - hold_then_slide_lr / hold_then_slide_rl: 途中停止→スライド
 * - auto: 自動選択（SSOT: buildProjectJson で seed により確定）
 */
export const MOTION_PRESETS: Record<string, MotionPreset> = {
  // ========================================
  // 基本プリセット
  // ========================================
  none: {
    id: 'none',
    motion_type: 'none',
    params: {}
  },
  
  // ========================================
  // Ken Burns（ズーム）
  // ========================================
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
  kenburns_zoom_out: {
    id: 'kenburns_zoom_out',
    motion_type: 'zoom',
    params: { start_scale: 1.1, end_scale: 1.0 }
  },
  
  // ========================================
  // Pan（軽いパン: -5% → +5%）
  // ========================================
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
  
  // ========================================
  // Slide（大きなスライド: -10% → +10%）
  // ========================================
  slide_lr: {
    id: 'slide_lr',
    motion_type: 'pan',
    params: { start_x: -10, end_x: 10, start_y: 0, end_y: 0 }
  },
  slide_rl: {
    id: 'slide_rl',
    motion_type: 'pan',
    params: { start_x: 10, end_x: -10, start_y: 0, end_y: 0 }
  },
  slide_tb: {
    id: 'slide_tb',
    motion_type: 'pan',
    params: { start_x: 0, end_x: 0, start_y: -10, end_y: 10 }
  },
  slide_bt: {
    id: 'slide_bt',
    motion_type: 'pan',
    params: { start_x: 0, end_x: 0, start_y: 10, end_y: -10 }
  },
  
  // ========================================
  // Hold-then-slide（途中停止→スライド）
  // 30%の時間静止してから残りでスライド
  // ========================================
  hold_then_slide_lr: {
    id: 'hold_then_slide_lr',
    motion_type: 'hold_then_pan',
    params: { start_x: -5, end_x: 10, start_y: 0, end_y: 0, hold_ratio: 0.3 }
  },
  hold_then_slide_rl: {
    id: 'hold_then_slide_rl',
    motion_type: 'hold_then_pan',
    params: { start_x: 5, end_x: -10, start_y: 0, end_y: 0, hold_ratio: 0.3 }
  },
  hold_then_slide_tb: {
    id: 'hold_then_slide_tb',
    motion_type: 'hold_then_pan',
    params: { start_x: 0, end_x: 0, start_y: -5, end_y: 10, hold_ratio: 0.3 }
  },
  hold_then_slide_bt: {
    id: 'hold_then_slide_bt',
    motion_type: 'hold_then_pan',
    params: { start_x: 0, end_x: 0, start_y: 5, end_y: -10, hold_ratio: 0.3 }
  },
  
  // ========================================
  // Combined（ズーム + パン）
  // ========================================
  combined_zoom_pan_lr: {
    id: 'combined_zoom_pan_lr',
    motion_type: 'combined',
    params: { start_scale: 1.0, end_scale: 1.08, start_x: -3, end_x: 3, start_y: 0, end_y: 0 }
  },
  combined_zoom_pan_rl: {
    id: 'combined_zoom_pan_rl',
    motion_type: 'combined',
    params: { start_scale: 1.0, end_scale: 1.08, start_x: 3, end_x: -3, start_y: 0, end_y: 0 }
  },
  
  // ========================================
  // Auto（自動選択）
  // ★ 重要: このプリセット自体は使われない
  // buildProjectJson で seed に基づいて chosen が決定される
  // ========================================
  auto: {
    id: 'auto',
    motion_type: 'none',  // 仮の値（chosen で上書きされる）
    params: {}
  },
};

/**
 * Auto選択用のプリセットリスト（ランダム選択の候補）
 * 
 * ## 選択ルール
 * - seed を使って決定論的に選択
 * - 「none」は含めない（意図的に動きなしにする場合は明示指定）
 * - 極端な動きは含めない（視聴者に違和感を与えない）
 */
export const AUTO_MOTION_CANDIDATES: string[] = [
  'kenburns_soft',
  'kenburns_zoom_out',
  'pan_lr',
  'pan_rl',
  'slide_lr',
  'slide_rl',
  'hold_then_slide_lr',
  'hold_then_slide_rl',
];

/**
 * seed から auto モーションを決定論的に選択
 * 
 * ★ 重要: この関数は buildProjectJson でのみ呼ばれる
 * Remotion 側では呼ばない（再現性を保証するため）
 * 
 * @param seed シード値（scene_id や video_build_id から生成）
 * @returns 選ばれたプリセットID
 */
export function pickAutoMotion(seed: number): string {
  const index = Math.abs(seed) % AUTO_MOTION_CANDIDATES.length;
  return AUTO_MOTION_CANDIDATES[index];
}

/**
 * プリセットIDから MotionPreset を取得
 */
export function getMotionPreset(presetId: string | null | undefined): MotionPreset {
  if (!presetId || !MOTION_PRESETS[presetId]) {
    return MOTION_PRESETS.kenburns_soft; // デフォルト
  }
  return MOTION_PRESETS[presetId];
}

/**
 * 利用可能なプリセットIDのリストを取得
 */
export function getAvailablePresetIds(): string[] {
  return Object.keys(MOTION_PRESETS);
}
