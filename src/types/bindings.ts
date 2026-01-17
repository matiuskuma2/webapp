export type Bindings = {
  DB: D1Database;
  R2: R2Bucket;
  OPENAI_API_KEY: string;
  GEMINI_API_KEY: string;
  GOOGLE_TTS_API_KEY: string;
  FISH_AUDIO_API_TOKEN: string;
  // Encryption for API keys
  ENCRYPTION_KEY?: string;      // For decrypting user_api_keys.encrypted_key
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
  SITE_URL?: string;  // e.g. https://webapp-c7n.pages.dev
}
