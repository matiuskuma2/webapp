-- Migration: 0016_create_system_settings
-- Description: Create system_settings table for global configuration
-- Source: D1 Production Schema (2026-01-17)
--
-- Expected keys:
-- - 'sponsor_vertex_sa_json_encrypted': superadmin Vertex SA JSON (for sponsor billing)
-- - 'sponsor_vertex_project_id': GCP Project ID for sponsor
-- - 'sponsor_vertex_location': GCP Region for sponsor (e.g., 'us-central1')
-- - 'feature_veo3_enabled': Feature flag for Veo3 (true/false)
-- - 'feature_veo3_superadmin_only': Restrict Veo3 to superadmin (true/false)
-- - 'veo3_daily_limit': Daily generation limit per user
-- - 'veo3_concurrent_limit': Concurrent generation limit per user

-- Table: system_settings
-- Purpose: システム全体の設定を管理（キーバリュー形式）
CREATE TABLE IF NOT EXISTS system_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
