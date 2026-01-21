-- Migration: 0022_create_scene_utterances
-- Purpose: Add scene_utterances table for R1.5 multi-speaker audio SSOT
-- Description: Manages per-scene utterances (narration/dialogue) with speaker assignment
--              and audio generation linkage. This is the Single Source of Truth for
--              what gets spoken in each scene and in what order.

-- scene_utterances: シーン内の発話（SSOT）
CREATE TABLE IF NOT EXISTS scene_utterances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- シーンへの参照
  scene_id INTEGER NOT NULL
    REFERENCES scenes(id) ON DELETE CASCADE,
  
  -- シーン内の表示・再生順（1から開始）
  order_no INTEGER NOT NULL,
  
  -- 発話タイプ: narration（ナレーション）/ dialogue（キャラの台詞）
  role TEXT NOT NULL
    CHECK (role IN ('narration', 'dialogue')),
  
  -- キャラクターキー（dialogueの場合必須、narrationの場合はNULL）
  -- scene_character_map に存在するキャラのみ指定可能（アプリ層でバリデーション）
  character_key TEXT NULL,
  
  -- 発話テキスト（字幕にも使用）
  text TEXT NOT NULL,
  
  -- 音声生成への参照（生成済みの場合）
  -- 削除時はSET NULLで音声参照だけ外す（utterance自体は残す）
  audio_generation_id INTEGER NULL
    REFERENCES audio_generations(id) ON DELETE SET NULL,
  
  -- 音声の長さ（ミリ秒）- audio_generationから複製してキャッシュ
  -- 音声未生成の場合はNULL
  duration_ms INTEGER NULL,
  
  -- タイムスタンプ
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes

-- シーン内の発話を順番に取得するための複合インデックス
CREATE UNIQUE INDEX IF NOT EXISTS idx_scene_utterances_scene_order 
  ON scene_utterances(scene_id, order_no);

-- シーン単位での検索用
CREATE INDEX IF NOT EXISTS idx_scene_utterances_scene 
  ON scene_utterances(scene_id);

-- 音声生成への逆引き用
CREATE INDEX IF NOT EXISTS idx_scene_utterances_audio_generation 
  ON scene_utterances(audio_generation_id);

-- 役割別検索用（統計などで使う可能性）
CREATE INDEX IF NOT EXISTS idx_scene_utterances_role 
  ON scene_utterances(role);
