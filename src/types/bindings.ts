export type Bindings = {
  DB: D1Database;
  R2: R2Bucket;
  OPENAI_API_KEY: string;
  GEMINI_API_KEY: string;
  GOOGLE_TTS_API_KEY: string;
  FISH_AUDIO_API_TOKEN: string;
  // ElevenLabs TTS
  ELEVENLABS_API_KEY: string;
  ELEVENLABS_DEFAULT_MODEL?: string;  // Default: eleven_multilingual_v2
  // Encryption for API keys (Key-Ring対応)
  // 鍵は必ず hex 64文字（32 bytes = 256 bit）で統一
  ENCRYPTION_KEY?: string;        // 現行鍵（新規暗号化に使用）
  ENCRYPTION_KEY_OLD_1?: string;  // 1世代前の旧鍵（Key-Ring用）
  ENCRYPTION_KEY_OLD_2?: string;  // 2世代前の旧鍵（Key-Ring用、必要な場合のみ）
  // Image URL signing (HMAC-SHA256)
  IMAGE_URL_SIGNING_SECRET?: string;  // For signed image URLs (prevents URL guessing)
  // AWS Video Proxy (Veo2/Veo3)
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_ORCH_BASE_URL?: string;  // e.g. https://sddd2nwesf.execute-api.ap-northeast-1.amazonaws.com/prod
  AWS_REGION?: string;          // e.g. ap-northeast-1
  // SendGrid (Email)
  SENDGRID_API_KEY?: string;
  SENDGRID_FROM_EMAIL?: string;
  // Site URL
  SITE_URL?: string;  // e.g. https://app.marumuviai.com
  // Asset versioning (auto-set by deployment pipeline)
  ASSET_VERSION?: string;  // e.g. "20260125-1" or git commit hash
  // Debug flags
  DEBUG_REFERENCE_IMAGES?: string;  // '1' で参照画像取得の詳細ログを出力
  // Cloudflare Analytics API
  CF_ACCOUNT_ID?: string;          // Cloudflare Account ID
  CF_API_TOKEN?: string;           // Cloudflare API Token (Analytics read permission)
}
