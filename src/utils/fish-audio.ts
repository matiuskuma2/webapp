/**
 * Fish Audio TTS Client (Phase X-0.5)
 * Documentation: https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
 */

export interface FishTTSRequest {
  text: string;
  reference_id?: string;
  model?: 's1' | 'speech-1.6' | 'speech-1.5';
  temperature?: number; // 0-1, default 0.7
  top_p?: number; // 0-1, default 0.7
  format?: 'wav' | 'pcm' | 'mp3' | 'opus';
  sample_rate?: number; // null for default (44100 Hz for mp3/wav, 48000 Hz for opus)
  mp3_bitrate?: 64 | 128 | 192; // default 128
  normalize?: boolean; // default true
  chunk_length?: number; // 100-300, default 300
  latency?: 'low' | 'normal' | 'balanced'; // default normal
}

export interface FishTTSResponse {
  audio: ArrayBuffer;
  format: string;
  sample_rate: number;
}

export interface FishErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

/**
 * Generate speech using Fish Audio TTS API
 */
export async function generateFishTTS(
  apiToken: string,
  request: FishTTSRequest
): Promise<FishTTSResponse> {
  const url = 'https://api.fish.audio/v1/tts';
  
  const payload = {
    text: request.text,
    reference_id: request.reference_id,
    model: request.model || 's1',
    temperature: request.temperature ?? 0.7,
    top_p: request.top_p ?? 0.7,
    format: request.format || 'mp3',
    sample_rate: request.sample_rate ?? null,
    mp3_bitrate: request.mp3_bitrate ?? 128,
    normalize: request.normalize ?? true,
    chunk_length: request.chunk_length ?? 300,
    latency: request.latency || 'normal'
  };

  console.log('[Fish TTS] Request:', {
    url,
    text_length: request.text.length,
    reference_id: request.reference_id,
    model: payload.model,
    format: payload.format
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Fish TTS] Error response:', {
      status: response.status,
      statusText: response.statusText,
      body: errorText
    });
    
    try {
      const errorJson: FishErrorResponse = JSON.parse(errorText);
      throw new Error(`Fish TTS Error (${response.status}): ${errorJson.error.message}`);
    } catch (parseError) {
      throw new Error(`Fish TTS Error (${response.status}): ${errorText}`);
    }
  }

  const audio = await response.arrayBuffer();
  
  console.log('[Fish TTS] Success:', {
    audio_size: audio.byteLength,
    format: payload.format
  });

  return {
    audio,
    format: payload.format,
    sample_rate: payload.sample_rate || (payload.format === 'opus' ? 48000 : 44100)
  };
}

/**
 * Test Fish Audio TTS with a reference_id (Phase X-0.5)
 * Returns true if successful, false if error
 */
export async function testFishReferenceId(
  apiToken: string,
  referenceId: string,
  testText: string = 'こんにちは、これはテストです。'
): Promise<{ success: boolean; error?: string; audioSize?: number }> {
  try {
    const result = await generateFishTTS(apiToken, {
      text: testText,
      reference_id: referenceId,
      format: 'mp3',
      mp3_bitrate: 128,
      latency: 'normal'
    });
    
    return {
      success: true,
      audioSize: result.audio.byteLength
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
