// src/routes/audio.ts
// Audio R2 distribution route (same pattern as images)
import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'

const audio = new Hono<{ Bindings: Bindings }>()

/**
 * GET /audio/* - Serve audio files from R2
 * Example: /audio/3/scene_1/1_1234567890.mp3
 */
audio.get('/*', async (c) => {
  try {
    // Extract the audio key from URL path
    // URL format: /audio/3/scene_1/1_1234567890.mp3
    // R2 key format: audio/3/scene_1/1_1234567890.mp3
    const path = c.req.path.replace(/^\/audio\//, '')
    const r2Key = `audio/${path}`

    const object = await c.env.R2.get(r2Key)
    
    if (!object) {
      return c.notFound()
    }

    // Determine content type based on file extension
    const ext = path.split('.').pop()?.toLowerCase()
    let contentType = 'audio/mpeg' // default to mp3
    
    if (ext === 'wav') {
      contentType = 'audio/wav'
    } else if (ext === 'ogg') {
      contentType = 'audio/ogg'
    } else if (ext === 'm4a') {
      contentType = 'audio/mp4'
    }

    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch (error) {
    console.error('[Audio Route] Error serving audio:', error)
    return c.text('Internal Server Error', 500)
  }
})

export default audio
