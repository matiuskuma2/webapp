-- Migration: 0035_add_output_preset.sql
-- Purpose: Add output_preset to projects for media platform targeting
-- Date: 2026-01-23

-- ============================================================
-- Output Preset: Media platform targeting
-- ============================================================
-- Values:
--   'yt_long'        - YouTube long-form (16:9, moderate text, clean layout)
--   'short_vertical' - Shorts/Reels/TikTok (9:16, large text, safe zones)
--   'yt_shorts'      - YouTube Shorts specific (9:16, YT branding safe)
--   'reels'          - Instagram Reels (9:16, bottom safe zone for UI)
--   'tiktok'         - TikTok (9:16, top safe zone for UI overlay)
--   'custom'         - User-defined settings

-- Add output_preset to projects (default: yt_long for backward compatibility)
ALTER TABLE projects ADD COLUMN output_preset TEXT DEFAULT 'yt_long';

-- Create index for querying by preset
CREATE INDEX IF NOT EXISTS idx_projects_output_preset ON projects(output_preset);

-- ============================================================
-- Preset Configuration Reference (stored in settings_json)
-- ============================================================
-- Each preset maps to:
--   aspect_ratio: '16:9' | '9:16'
--   resolution: '1080p' | '720p'
--   fps: 30 | 60
--   text_scale: 1.0 | 1.2 | 1.4 (relative size)
--   safe_zones: { top: px, bottom: px, left: px, right: px }
--   balloon_policy_default: 'voice_window' | 'always_on'
--   motion_default: 'none' | 'kenburns_soft' | 'kenburns_medium'
--   telop_style: 'bottom_bar' | 'center_large' | 'top_small'

-- Note: Actual preset configurations are defined in code (not DB)
-- This allows easy iteration without migrations
