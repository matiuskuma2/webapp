/**
 * ElevenLabs TTS Integration
 * - 日本語メイン・既存ボイスのみ
 * - 同期生成 + R2保存
 * - 最小実装（Phase A）
 */

// ElevenLabs API Configuration
const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

// Supported models for Japanese
export const ELEVENLABS_MODELS = {
  MULTILINGUAL_V2: 'eleven_multilingual_v2',
  MULTILINGUAL_V1: 'eleven_multilingual_v1',
  TURBO_V2_5: 'eleven_turbo_v2_5',
} as const;

// Default output format: mp3 44100Hz 128kbps
export const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

// Pre-configured Japanese-friendly voices
// These are publicly available ElevenLabs voices that work well with Japanese
export const ELEVENLABS_VOICES = {
  // Female voices
  'el-aria': {
    voice_id: '9BWtsMINqrJLrRacOk9x', // Aria
    name: 'Aria（女性・落ち着き）',
    gender: 'female',
    description: '落ち着いた女性の声、ナレーション向き',
  },
  'el-sarah': {
    voice_id: 'EXAVITQu4vr4xnSDxMaL', // Sarah
    name: 'Sarah（女性・優しい）',
    gender: 'female',
    description: '優しく穏やかな女性の声',
  },
  'el-charlotte': {
    voice_id: 'XB0fDUnXU5powFXDhCwa', // Charlotte
    name: 'Charlotte（女性・明るい）',
    gender: 'female',
    description: '明るくエネルギッシュな女性の声',
  },
  // Male voices
  'el-adam': {
    voice_id: 'pNInz6obpgDQGcFmaJgB', // Adam
    name: 'Adam（男性・深い）',
    gender: 'male',
    description: '深みのある男性の声、ナレーション向き',
  },
  'el-bill': {
    voice_id: 'pqHfZKP75CvOlQylNhV4', // Bill
    name: 'Bill（男性・自然）',
    gender: 'male',
    description: '自然で聞きやすい男性の声',
  },
  'el-brian': {
    voice_id: 'nPczCjzI2devNBz1zQrb', // Brian
    name: 'Brian（男性・プロ）',
    gender: 'male',
    description: 'プロフェッショナルな男性の声',
  },
  // Character voices
  'el-lily': {
    voice_id: 'pFZP5JQG7iQjIQuC4Bku', // Lily
    name: 'Lily（若い女性）',
    gender: 'female',
    description: '若々しい女性の声、キャラクター向き',
  },
  'el-george': {
    voice_id: 'JBFqnCBsd6RMkjVDRZzb', // George
    name: 'George（男性・落ち着き）',
    gender: 'male',
    description: '落ち着いた中年男性の声',
  },
} as const;

export type ElevenLabsVoiceKey = keyof typeof ELEVENLABS_VOICES;

// Voice settings for natural Japanese speech
export interface VoiceSettings {
  stability: number;        // 0-1, higher = more consistent
  similarity_boost: number; // 0-1, higher = closer to original voice
  style?: number;           // 0-1, style exaggeration (for v2 models)
  use_speaker_boost?: boolean;
}

// Default settings optimized for Japanese narration
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0, // Keep style neutral for Japanese
  use_speaker_boost: true,
};

// TTS Request parameters
export interface TTSRequest {
  text: string;
  voice_id: string;
  model_id?: string;
  voice_settings?: Partial<VoiceSettings>;
  output_format?: string;
}

// TTS Response
export interface TTSResponse {
  success: boolean;
  audio?: ArrayBuffer;
  content_type?: string;
  error?: string;
  character_count?: number;
}

/**
 * Generate speech using ElevenLabs TTS API
 */
export async function generateElevenLabsTTS(
  apiKey: string,
  request: TTSRequest
): Promise<TTSResponse> {
  const {
    text,
    voice_id,
    model_id = ELEVENLABS_MODELS.MULTILINGUAL_V2,
    voice_settings = DEFAULT_VOICE_SETTINGS,
    output_format = DEFAULT_OUTPUT_FORMAT,
  } = request;

  // Validate input
  if (!text?.trim()) {
    return { success: false, error: 'Text is required' };
  }
  if (!voice_id) {
    return { success: false, error: 'Voice ID is required' };
  }

  // Character count for usage tracking
  const characterCount = text.length;

  try {
    const url = `${ELEVENLABS_API_BASE}/text-to-speech/${voice_id}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text,
        model_id,
        voice_settings: {
          stability: voice_settings.stability ?? DEFAULT_VOICE_SETTINGS.stability,
          similarity_boost: voice_settings.similarity_boost ?? DEFAULT_VOICE_SETTINGS.similarity_boost,
          style: voice_settings.style ?? DEFAULT_VOICE_SETTINGS.style,
          use_speaker_boost: voice_settings.use_speaker_boost ?? DEFAULT_VOICE_SETTINGS.use_speaker_boost,
        },
        output_format,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error('[ElevenLabs] API error:', response.status, errorText);
      
      // Parse specific error codes and messages
      if (response.status === 401) {
        // Check for Free Tier abuse detection
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson?.detail?.status === 'detected_unusual_activity') {
            return { success: false, error: 'ElevenLabs Free Tier is blocked from this IP. Please use a paid subscription.' };
          }
        } catch (e) {
          // Not JSON, use default message
        }
        return { success: false, error: 'Invalid API key' };
      }
      if (response.status === 422) {
        return { success: false, error: 'Invalid request parameters' };
      }
      if (response.status === 429) {
        return { success: false, error: 'Rate limit exceeded. Please try again later.' };
      }
      
      return { success: false, error: `API error: ${response.status}` };
    }

    const audioBuffer = await response.arrayBuffer();
    
    return {
      success: true,
      audio: audioBuffer,
      content_type: 'audio/mpeg',
      character_count: characterCount,
    };
  } catch (error: any) {
    console.error('[ElevenLabs] TTS generation failed:', error);
    return { success: false, error: error?.message || 'TTS generation failed' };
  }
}

/**
 * Get voice ID from preset key
 * Supports:
 * - Preset key: 'el-aria' -> '9BWtsMINqrJLrRacOk9x'
 * - Direct ID: 'elevenlabs:9BWtsMINqrJLrRacOk9x' -> '9BWtsMINqrJLrRacOk9x'
 * - Raw ID: '9BWtsMINqrJLrRacOk9x' -> '9BWtsMINqrJLrRacOk9x' (if 20+ chars)
 */
export function resolveElevenLabsVoiceId(voiceKey: string): string | null {
  // Check for elevenlabs: prefix
  if (voiceKey.startsWith('elevenlabs:')) {
    return voiceKey.substring(11);
  }
  
  // Check for preset key
  const preset = ELEVENLABS_VOICES[voiceKey as ElevenLabsVoiceKey];
  if (preset) {
    return preset.voice_id;
  }
  
  // Check if it's a raw voice ID (typically 20+ characters)
  if (voiceKey.length >= 20 && /^[a-zA-Z0-9]+$/.test(voiceKey)) {
    return voiceKey;
  }
  
  return null;
}

/**
 * Get available voices list for UI
 */
export function getElevenLabsVoiceList(): Array<{
  key: string;
  voice_id: string;
  name: string;
  gender: string;
  description: string;
}> {
  return Object.entries(ELEVENLABS_VOICES).map(([key, voice]) => ({
    key,
    voice_id: voice.voice_id,
    name: voice.name,
    gender: voice.gender,
    description: voice.description,
  }));
}

/**
 * Check if a voice ID is an ElevenLabs voice
 */
export function isElevenLabsVoice(voiceId: string): boolean {
  return voiceId.startsWith('elevenlabs:') || 
         voiceId.startsWith('el-') ||
         Object.keys(ELEVENLABS_VOICES).includes(voiceId);
}

/**
 * Estimate cost for TTS (characters to dollars)
 * ElevenLabs Starter: ~$0.30 per 1000 characters
 */
export function estimateCost(characterCount: number): number {
  const costPer1000 = 0.30;
  return (characterCount / 1000) * costPer1000;
}
