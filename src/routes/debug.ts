import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'

const debug = new Hono<{ Bindings: Bindings }>()

// GET /api/debug/env - 環境情報デバッグ（キー全文禁止）
debug.get('/env', async (c) => {
  try {
    const openaiKey = c.env.OPENAI_API_KEY || 'NOT_SET'
    const geminiKey = c.env.GEMINI_API_KEY || 'NOT_SET'

    // 末尾4文字だけ返す
    const openaiSuffix = openaiKey === 'NOT_SET' ? 'NOT_SET' : openaiKey.slice(-4)
    const geminiSuffix = geminiKey === 'NOT_SET' ? 'NOT_SET' : geminiKey.slice(-4)

    return c.json({
      openai_key_suffix: openaiSuffix,
      gemini_key_suffix: geminiSuffix,
      openai_key_length: openaiKey.length,
      gemini_key_length: geminiKey.length,
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
