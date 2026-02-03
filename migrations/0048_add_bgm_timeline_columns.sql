-- Migration: 0048_add_bgm_timeline_columns
-- Date: 2026-02-03
-- Purpose: Add audio offset columns for BGM timeline control
--
-- BACKWARD COMPATIBILITY:
-- - All new columns have DEFAULT values
-- - Existing BGM settings will continue to work (audio_offset_ms = 0 means "play from start")
-- - Remotion will fall back to legacy behavior if new fields are null/0

-- ============================================================
-- 1. scene_audio_assignments: Add audio offset columns
-- ============================================================
-- audio_offset_ms: Where in the BGM file to start playback (milliseconds)
-- Example: audio_offset_ms = 60000 means "start playing from 1:00 of the BGM file"
ALTER TABLE scene_audio_assignments ADD COLUMN audio_offset_ms INTEGER DEFAULT 0;

-- ============================================================
-- 2. project_audio_tracks: Add timeline and offset columns
-- ============================================================
-- video_start_ms: When in the video timeline to start BGM (milliseconds)
-- Example: video_start_ms = 10000 means "start BGM at 0:10 of the video"
ALTER TABLE project_audio_tracks ADD COLUMN video_start_ms INTEGER DEFAULT 0;

-- video_end_ms: When in the video timeline to end BGM (NULL = until video ends)
-- Example: video_end_ms = 120000 means "stop BGM at 2:00 of the video"
ALTER TABLE project_audio_tracks ADD COLUMN video_end_ms INTEGER DEFAULT NULL;

-- audio_offset_ms: Where in the BGM file to start playback (milliseconds)
-- Example: audio_offset_ms = 30000 means "start playing from 0:30 of the BGM file"
ALTER TABLE project_audio_tracks ADD COLUMN audio_offset_ms INTEGER DEFAULT 0;

-- ============================================================
-- NOTES:
-- ============================================================
-- For scene_audio_assignments:
--   - start_ms/end_ms: SCENE-relative timing (when BGM plays within the scene)
--   - audio_offset_ms: BGM-FILE offset (which part of the BGM file to play)
--
-- For project_audio_tracks:
--   - video_start_ms/video_end_ms: VIDEO-relative timing (when BGM plays in the video)
--   - audio_offset_ms: BGM-FILE offset (which part of the BGM file to play)
--
-- Remotion behavior:
--   - <Audio startFrom={audio_offset_ms / 1000 * fps}> for file offset
--   - <Sequence from={video_start_ms / 1000 * fps}> for video timeline
