import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'

const debug = new Hono<{ Bindings: Bindings }>()

// GET /api/debug/env - 環境情報デバッグ（キー全文禁止）
debug.get('/env', async (c) => {
  try {
    const openaiKey = c.env.OPENAI_API_KEY || 'NOT_SET'
    const geminiKey = c.env.GEMINI_API_KEY || 'NOT_SET'
    const elevenLabsKey = c.env.ELEVENLABS_API_KEY || 'NOT_SET'
    const fishAudioKey = c.env.FISH_AUDIO_API_TOKEN || 'NOT_SET'
    const googleTtsKey = c.env.GOOGLE_TTS_API_KEY || 'NOT_SET'

    // 末尾4文字だけ返す
    const getSuffix = (key: string) => key === 'NOT_SET' ? 'NOT_SET' : key.slice(-4)

    return c.json({
      openai_key_suffix: getSuffix(openaiKey),
      gemini_key_suffix: getSuffix(geminiKey),
      elevenlabs_key_suffix: getSuffix(elevenLabsKey),
      fish_audio_key_suffix: getSuffix(fishAudioKey),
      google_tts_key_suffix: getSuffix(googleTtsKey),
      openai_key_length: openaiKey.length,
      gemini_key_length: geminiKey.length,
      elevenlabs_key_length: elevenLabsKey.length,
      fish_audio_key_length: fishAudioKey.length,
      google_tts_key_length: googleTtsKey.length,
      timestamp: new Date().toISOString()
    })

  } catch (error) {
    console.error('Debug env error:', error)
    return c.json({
      error: 'Failed to get env info',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

export default debug
