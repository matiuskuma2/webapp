-- Migration: 0015_create_user_api_keys
-- Description: Create user_api_keys table for storing encrypted API keys
-- Source: D1 Production Schema (2026-01-17)
--
-- Supported providers:
-- - 'gemini': Google Gemini API Key (for image/text generation, Veo2)
-- - 'openai': OpenAI API Key (for transcription, formatting)
-- - 'vertex': Vertex AI Service Account JSON (for Veo3) - encrypted

-- Table: user_api_keys
-- Purpose: ユーザーごとのAPIキー（暗号化済み）を管理
CREATE TABLE IF NOT EXISTS user_api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,              
    encrypted_key TEXT NOT NULL,         
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, provider),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes for user_api_keys
CREATE INDEX IF NOT EXISTS idx_user_api_keys_provider 
ON user_api_keys(provider, is_active);

CREATE INDEX IF NOT EXISTS idx_user_api_keys_user_id 
ON user_api_keys(user_id);
