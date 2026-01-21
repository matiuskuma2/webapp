-- Add speech_type column to scenes table
-- Values: 'dialogue' (character speech) or 'narration' (narrator)
-- Default to 'dialogue' for backward compatibility

ALTER TABLE scenes ADD COLUMN speech_type TEXT DEFAULT 'dialogue';

-- Create index for filtering by speech_type
CREATE INDEX IF NOT EXISTS idx_scenes_speech_type ON scenes(speech_type);
