/**
 * Fish Audio Test Endpoint (Phase X-0.5)
 * Temporary route for testing Fish Audio reference_id
 * 
 * DELETE THIS FILE after Phase X-0.5 is complete
 */

import { Hono } from 'hono';
import { Bindings } from '../types/bindings';
import { testFishReferenceId, generateFishTTS } from '../utils/fish-audio';

const app = new Hono<{ Bindings: Bindings }>();

/**
 * POST /api/fish-test/reference
 * Test a Fish Audio reference_id
 * 
 * Body:
 * {
 *   "reference_id": "71bf4cb71cd44df6aa603d51db8f92ff",
 *   "text": "こんにちは、これはテストです。"
 * }
 */
app.post('/reference', async (c) => {
  try {
    const { reference_id, text } = await c.req.json();
    
    if (!reference_id) {
      return c.json({ error: 'reference_id is required' }, 400);
    }
    
    const apiToken = c.env.FISH_AUDIO_API_TOKEN;
    if (!apiToken) {
      return c.json({ error: 'FISH_AUDIO_API_TOKEN not configured' }, 500);
    }
    
    console.log('[Fish Test] Testing reference_id:', reference_id);
    
    const result = await testFishReferenceId(
      apiToken,
      reference_id,
      text || 'こんにちは、これはテストです。'
    );
    
    return c.json({
      reference_id,
      test_text: text || 'こんにちは、これはテストです。',
      ...result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Fish Test] Error:', error);
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }, 500);
  }
});

/**
 * POST /api/fish-test/generate
 * Generate audio with Fish Audio (returns audio file)
 * 
 * Body:
 * {
 *   "reference_id": "71bf4cb71cd44df6aa603d51db8f92ff",
 *   "text": "こんにちは、これはテストです。",
 *   "format": "mp3"
 * }
 */
app.post('/generate', async (c) => {
  try {
    const { reference_id, text, format } = await c.req.json();
    
    if (!reference_id) {
      return c.json({ error: 'reference_id is required' }, 400);
    }
    
    if (!text) {
      return c.json({ error: 'text is required' }, 400);
    }
    
    const apiToken = c.env.FISH_AUDIO_API_TOKEN;
    if (!apiToken) {
      return c.json({ error: 'FISH_AUDIO_API_TOKEN not configured' }, 500);
    }
    
    console.log('[Fish Test] Generating audio:', {
      reference_id,
      text_length: text.length,
      format: format || 'mp3'
    });
    
    const result = await generateFishTTS(apiToken, {
      text,
      reference_id,
      format: format || 'mp3',
      mp3_bitrate: 128
    });
    
    // Return audio file
    return new Response(result.audio, {
      headers: {
        'Content-Type': format === 'wav' ? 'audio/wav' : 'audio/mpeg',
        'Content-Length': result.audio.byteLength.toString()
      }
    });
  } catch (error) {
    console.error('[Fish Test] Error:', error);
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }, 500);
  }
});

export default app;
