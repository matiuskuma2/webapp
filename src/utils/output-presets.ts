/**
 * Output Presets - Media Platform Configuration
 * 
 * Defines settings for different output targets (YouTube, Shorts, Reels, TikTok)
 * Each preset maps to: aspect ratio, safe zones, text scaling, motion defaults, etc.
 */

export type OutputPresetId = 'yt_long' | 'short_vertical' | 'yt_shorts' | 'reels' | 'tiktok' | 'custom';

// Display policy types for balloons
export type BalloonDisplayPolicy = 'always_on' | 'voice_window' | 'manual_window';

export interface SafeZones {
  top: number;      // px from top to avoid UI overlays
  bottom: number;   // px from bottom
  left: number;     // px from left
  right: number;    // px from right
}

export interface OutputPresetConfig {
  id: OutputPresetId;
  label: string;
  description: string;
  aspect_ratio: '16:9' | '9:16' | '1:1';
  resolution: '1080p' | '720p';
  fps: 30 | 60;
  text_scale: number;           // 1.0 = normal, 1.2 = 20% larger
  safe_zones: SafeZones;
  balloon_policy_default: BalloonDisplayPolicy;
  motion_default: 'none' | 'kenburns_soft' | 'kenburns_medium';
  telop_style: 'bottom_bar' | 'center_large' | 'top_small';
  bgm_volume_default: number;   // 0.0 - 1.0
  ducking_enabled: boolean;
}

/**
 * Output Preset Configurations
 */
export const OUTPUT_PRESETS: Record<OutputPresetId, OutputPresetConfig> = {
  yt_long: {
    id: 'yt_long',
    label: 'YouTube 長尺',
    description: '16:9 横型、字幕下部、落ち着いた演出',
    aspect_ratio: '16:9',
    resolution: '1080p',
    fps: 30,
    text_scale: 1.0,
    safe_zones: { top: 0, bottom: 80, left: 0, right: 0 },
    balloon_policy_default: 'voice_window',
    motion_default: 'kenburns_soft',
    telop_style: 'bottom_bar',
    bgm_volume_default: 0.25,
    ducking_enabled: true,
  },

  short_vertical: {
    id: 'short_vertical',
    label: '縦型ショート（汎用）',
    description: '9:16 縦型、大きめ字幕、Shorts/Reels/TikTok共通',
    aspect_ratio: '9:16',
    resolution: '1080p',
    fps: 30,
    text_scale: 1.3,
    safe_zones: { top: 60, bottom: 160, left: 20, right: 20 },
    balloon_policy_default: 'always_on',  // 縦型は出しっぱなしがデフォルト
    motion_default: 'kenburns_medium',
    telop_style: 'center_large',
    bgm_volume_default: 0.20,
    ducking_enabled: true,
  },

  yt_shorts: {
    id: 'yt_shorts',
    label: 'YouTube Shorts',
    description: '9:16 縦型、YouTube UI に最適化',
    aspect_ratio: '9:16',
    resolution: '1080p',
    fps: 30,
    text_scale: 1.25,
    safe_zones: { top: 50, bottom: 140, left: 20, right: 60 }, // 右にシェア等ボタン
    balloon_policy_default: 'always_on',  // Shortsは出しっぱなしがデフォルト
    motion_default: 'kenburns_medium',
    telop_style: 'center_large',
    bgm_volume_default: 0.20,
    ducking_enabled: true,
  },

  reels: {
    id: 'reels',
    label: 'Instagram Reels',
    description: '9:16 縦型、Instagram UI に最適化（下部余白広め）',
    aspect_ratio: '9:16',
    resolution: '1080p',
    fps: 30,
    text_scale: 1.3,
    safe_zones: { top: 80, bottom: 200, left: 20, right: 20 }, // 下部にUI被り多め
    balloon_policy_default: 'always_on',  // Reelsは出しっぱなしがデフォルト
    motion_default: 'kenburns_medium',
    telop_style: 'center_large',
    bgm_volume_default: 0.18,
    ducking_enabled: true,
  },

  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    description: '9:16 縦型、TikTok UI に最適化（上部テキスト寄せ）',
    aspect_ratio: '9:16',
    resolution: '1080p',
    fps: 30,
    text_scale: 1.35,
    safe_zones: { top: 100, bottom: 180, left: 20, right: 80 }, // 右にUIボタン多い
    balloon_policy_default: 'always_on',  // TikTokは出しっぱなしがデフォルト
    motion_default: 'kenburns_medium',
    telop_style: 'top_small',
    bgm_volume_default: 0.18,
    ducking_enabled: true,
  },

  custom: {
    id: 'custom',
    label: 'カスタム',
    description: '手動設定（詳細を個別指定）',
    aspect_ratio: '16:9',
    resolution: '1080p',
    fps: 30,
    text_scale: 1.0,
    safe_zones: { top: 0, bottom: 0, left: 0, right: 0 },
    balloon_policy_default: 'voice_window',
    motion_default: 'none',
    telop_style: 'bottom_bar',
    bgm_volume_default: 0.25,
    ducking_enabled: false,
  },
};

/**
 * Get preset configuration by ID
 */
export function getOutputPreset(presetId: string | null | undefined): OutputPresetConfig {
  const id = (presetId || 'yt_long') as OutputPresetId;
  return OUTPUT_PRESETS[id] || OUTPUT_PRESETS.yt_long;
}

/**
 * Get all presets as array (for UI dropdown)
 */
export function getAllOutputPresets(): OutputPresetConfig[] {
  return Object.values(OUTPUT_PRESETS);
}

/**
 * Get presets grouped by category (for UI)
 */
export function getOutputPresetsByCategory(): { label: string; presets: OutputPresetConfig[] }[] {
  return [
    {
      label: '横型（YouTube）',
      presets: [OUTPUT_PRESETS.yt_long],
    },
    {
      label: '縦型（ショート）',
      presets: [
        OUTPUT_PRESETS.short_vertical,
        OUTPUT_PRESETS.yt_shorts,
        OUTPUT_PRESETS.reels,
        OUTPUT_PRESETS.tiktok,
      ],
    },
    {
      label: 'その他',
      presets: [OUTPUT_PRESETS.custom],
    },
  ];
}

/**
 * Apply preset to build settings
 * Merges preset defaults with existing settings, preserving user overrides
 */
export function applyPresetToSettings(
  presetId: OutputPresetId,
  existingSettings: Record<string, unknown> = {}
): Record<string, unknown> {
  const preset = getOutputPreset(presetId);
  
  // Start with existing settings, then apply preset overrides
  return {
    // Preserve other existing settings first
    ...existingSettings,
    
    // Then apply preset settings (these override existing)
    aspect_ratio: preset.aspect_ratio,
    resolution: preset.resolution,
    fps: preset.fps,
    output_preset: preset.id,
    text_scale: preset.text_scale,
    safe_zones: preset.safe_zones,
    balloon_policy_default: preset.balloon_policy_default,
    motion: existingSettings.motion || preset.motion_default,
    telop_style: preset.telop_style,
    
    // BGM settings (preserve existing if set, but apply preset defaults)
    bgm: {
      ...(existingSettings.bgm as Record<string, unknown> || {}),
      volume: (existingSettings.bgm as Record<string, unknown>)?.volume ?? preset.bgm_volume_default,
      ducking: {
        enabled: preset.ducking_enabled,
        volume: 0.12,
        attack_ms: 120,
        release_ms: 220,
      },
    },
  };
}

/**
 * Validate preset ID
 */
export function isValidPresetId(id: string | null | undefined): id is OutputPresetId {
  if (!id) return false;
  return id in OUTPUT_PRESETS;
}
