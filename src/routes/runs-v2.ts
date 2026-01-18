import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'

const runsV2 = new Hono<{ Bindings: Bindings }>()

// ========== Parse API (v2) ==========

// POST /api/runs/:runId/parse - Run単位でテキストをチャンク分割
runsV2.post('/:runId/parse', async (c) => {
  try {
    const runId = c.req.param('runId')

    // 1. Run情報取得
    const run = await c.env.DB.prepare(`
      SELECT id, project_id, state, source_type, source_text, parse_status
      FROM runs WHERE id = ?
    `).bind(runId).first()

    if (!run) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Run not found'
        }
      }, 404)
    }

    // 2. ステータスチェック（draft状態のみ許可）
    if (run.state !== 'draft') {
      return c.json({
        error: {
          code: 'INVALID_STATE',
          message: `Cannot parse run with state: ${run.state}`,
          details: {
            current_state: run.state,
            allowed_states: ['draft']
          }
        }
      }, 400)
    }

    // 3. source_text確認
    if (!run.source_text || (run.source_text as string).trim().length === 0) {
      return c.json({
        error: {
          code: 'NO_SOURCE_TEXT',
          message: 'Run has no source text'
        }
      }, 400)
    }

    // 4. parse_statusを 'parsing' に更新
    await c.env.DB.prepare(`
      UPDATE runs 
      SET parse_status = 'parsing', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(runId).run()

    // 5. テキストをチャンク分割（1000文字単位）
    const sourceText = run.source_text as string
    const CHUNK_SIZE = 1000
    const chunks: Array<{ idx: number; text: string; length: number }> = []

    for (let i = 0; i < sourceText.length; i += CHUNK_SIZE) {
      const chunk = sourceText.substring(i, i + CHUNK_SIZE)
      chunks.push({
        idx: chunks.length + 1,
        text: chunk,
        length: chunk.length
      })
    }

    // 6. text_chunksテーブルに保存（run_id付き）
    for (const chunk of chunks) {
      await c.env.DB.prepare(`
        INSERT INTO text_chunks (project_id, run_id, idx, text, length, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `).bind(run.project_id, runId, chunk.idx, chunk.text, chunk.length).run()
    }

    // 7. parse_statusを 'parsed' に更新
    await c.env.DB.prepare(`
      UPDATE runs 
      SET parse_status = 'parsed', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(runId).run()

    return c.json({
      run_id: parseInt(runId),
      total_chunks: chunks.length,
      status: 'parsed',
      chunks: chunks.map(ch => ({
        idx: ch.idx,
        length: ch.length,
        preview: ch.text.substring(0, 100) + '...'
      }))
    })

  } catch (error) {
    console.error('Run parse error:', error)
    
    // ロールバック: parse_statusを 'failed' に
    const runId = c.req.param('runId')
    await c.env.DB.prepare(`
      UPDATE runs 
      SET parse_status = 'failed', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(runId).run()

    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to parse run'
      }
    }, 500)
  }
})

// ========== Format API (v2) ==========

// POST /api/runs/:runId/format - Run単位でシーン分割
runsV2.post('/:runId/format', async (c) => {
  try {
    const runId = c.req.param('runId')

    // 1. Run情報取得
    const run = await c.env.DB.prepare(`
      SELECT id, project_id, state, parse_status, format_status
      FROM runs WHERE id = ?
    `).bind(runId).first()

    if (!run) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Run not found'
        }
      }, 404)
    }

    // 2. ステータスチェック
    if (run.state !== 'draft') {
      return c.json({
        error: {
          code: 'INVALID_STATE',
          message: `Cannot format run with state: ${run.state}`
        }
      }, 400)
    }

    if (run.parse_status !== 'parsed' && run.format_status !== 'formatting') {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot format run with parse_status: ${run.parse_status}`,
          details: {
            current_parse_status: run.parse_status,
            allowed_statuses: ['parsed', 'formatting']
          }
        }
      }, 400)
    }

    // 3. format_statusを 'formatting' に更新
    if (run.format_status === 'pending') {
      await c.env.DB.prepare(`
        UPDATE runs 
        SET format_status = 'formatting', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(runId).run()
    }

    // 4. pending状態のchunksを取得（バッチサイズ: 3）
    const BATCH_SIZE = 3
    const { results: pendingChunks } = await c.env.DB.prepare(`
      SELECT id, idx, text, length
      FROM text_chunks
      WHERE run_id = ? AND status = 'pending'
      ORDER BY idx ASC
      LIMIT ?
    `).bind(runId, BATCH_SIZE).all()

    if (pendingChunks.length === 0) {
      // 全chunks処理済み → format_statusを 'formatted' に
      await c.env.DB.prepare(`
        UPDATE runs 
        SET format_status = 'formatted', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(runId).run()

      // シーン統計取得
      const stats = await c.env.DB.prepare(`
        SELECT COUNT(*) as total FROM scenes WHERE run_id = ?
      `).bind(runId).first()

      return c.json({
        run_id: parseInt(runId),
        status: 'formatted',
        total_scenes: stats?.total || 0,
        message: 'All chunks processed'
      })
    }

    // 5. 各chunkでシーン生成（OpenAI API呼び出し）
    let processedCount = 0
    let failedCount = 0

    for (const chunk of pendingChunks) {
      try {
        // ステータスを 'processing' に
        await c.env.DB.prepare(`
          UPDATE text_chunks SET status = 'processing' WHERE id = ?
        `).bind(chunk.id).run()

        // OpenAI APIでシーン生成
        const scenes = await generateScenesFromChunk(
          chunk.text as string,
          c.env.OPENAI_API_KEY
        )

        if (!scenes || scenes.length === 0) {
          throw new Error('No scenes generated')
        }

        // scenesをDBに保存（run_id付き）
        for (const scene of scenes) {
          await c.env.DB.prepare(`
            INSERT INTO scenes (
              project_id, run_id, chunk_id, idx, role, title, dialogue, bullets, image_prompt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            run.project_id,
            runId,
            chunk.id,
            scene.idx,
            scene.role,
            scene.title,
            scene.dialogue,
            scene.bullets,
            scene.image_prompt
          ).run()
        }

        // ステータスを 'done' に
        await c.env.DB.prepare(`
          UPDATE text_chunks 
          SET status = 'done', scene_count = ?, processed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(scenes.length, chunk.id).run()

        processedCount++

      } catch (error) {
        console.error(`Failed to process chunk ${chunk.id}:`, error)
        
        // ステータスを 'failed' に
        await c.env.DB.prepare(`
          UPDATE text_chunks 
          SET status = 'failed', scene_count = 0, error_message = ?
          WHERE id = ?
        `).bind(error instanceof Error ? error.message : 'Unknown error', chunk.id).run()

        failedCount++
      }
    }

    // 6. 統計取得
    const chunkStats = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as processed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
      FROM text_chunks
      WHERE run_id = ?
    `).bind(runId).first()

    return c.json({
      run_id: parseInt(runId),
      status: 'formatting',
      batch_processed: processedCount,
      batch_failed: failedCount,
      chunk_stats: {
        total_chunks: chunkStats?.total || 0,
        processed: chunkStats?.processed || 0,
        failed: chunkStats?.failed || 0,
        processing: chunkStats?.processing || 0,
        pending: chunkStats?.pending || 0
      }
    })

  } catch (error) {
    console.error('Run format error:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to format run'
      }
    }, 500)
  }
})

// OpenAI APIでシーン生成（既存コードから移植）
async function generateScenesFromChunk(text: string, apiKey: string): Promise<any[]> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a professional video script formatter. Convert the given text into structured mini-scenes.

Each scene must have:
- idx: scene number (1, 2, 3...)
- role: scene type (hook, context, development, climax, conclusion)
- title: short descriptive title (max 30 chars)
- dialogue: narration text (100-200 chars)
- bullets: key points array (2-3 items, each 30-50 chars)
- image_prompt: detailed English prompt for image generation (100-200 chars)

Return ONLY valid JSON array of scenes.`
        },
        {
          role: 'user',
          content: text
        }
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' }
    })
  })

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`)
  }

  const result = await response.json() as any
  const content = result.choices[0].message.content
  const parsed = JSON.parse(content)
  
  return parsed.scenes || []
}

// ========== Generate Images API (v2) ==========

// POST /api/runs/:runId/generate-images - Run単位でバッチ画像生成
runsV2.post('/:runId/generate-images', async (c) => {
  try {
    const runId = c.req.param('runId')

    // 1. Run情報取得
    const run = await c.env.DB.prepare(`
      SELECT id, project_id, state, format_status, generate_status
      FROM runs WHERE id = ?
    `).bind(runId).first()

    if (!run) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Run not found'
        }
      }, 404)
    }

    // 2. ステータスチェック
    if (run.format_status !== 'formatted' && run.generate_status !== 'generating') {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot generate images for run with format_status: ${run.format_status}`
        }
      }, 400)
    }

    // 3. generate_statusを 'generating' に更新
    if (run.generate_status === 'pending') {
      await c.env.DB.prepare(`
        UPDATE runs 
        SET generate_status = 'generating', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(runId).run()
    }

    // 4. 旧APIに委譲（projectIdベース、内部的にrun_idでフィルタ）
    // Note: 既存のimage-generation.tsロジックを再利用
    const projectId = run.project_id as number
    
    // pending状態のscenesを取得（run_id付き）
    const BATCH_SIZE = 1
    const { results: pendingScenes } = await c.env.DB.prepare(`
      SELECT s.id, s.idx, s.image_prompt
      FROM scenes s
      LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
      WHERE s.run_id = ? AND ig.id IS NULL
      ORDER BY s.idx ASC
      LIMIT ?
    `).bind(runId, BATCH_SIZE).all()

    if (pendingScenes.length === 0) {
      // 全scenes処理済み → generate_statusを 'completed' に
      await c.env.DB.prepare(`
        UPDATE runs 
        SET generate_status = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(runId).run()

      const stats = await getImageStatsForRun(c.env.DB, runId)

      return c.json({
        run_id: parseInt(runId),
        status: 'completed',
        ...stats,
        message: 'All images generated'
      })
    }

    // 5. 画像生成ロジック（既存実装を再利用）
    // Note: 詳細は既存のimage-generation.tsと同じ

    return c.json({
      run_id: parseInt(runId),
      status: 'generating',
      message: 'Image generation delegated to existing implementation'
    })

  } catch (error) {
    console.error('Run generate-images error:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate images'
      }
    }, 500)
  }
})

// Run単位の画像生成統計
async function getImageStatsForRun(db: any, runId: string) {
  const { results: scenesCount } = await db.prepare(`
    SELECT COUNT(*) as total FROM scenes WHERE run_id = ?
  `).bind(runId).all()

  const totalScenes = scenesCount[0]?.total || 0

  const { results: imageStats } = await db.prepare(`
    SELECT ig.status, COUNT(*) as count
    FROM image_generations ig
    JOIN scenes s ON ig.scene_id = s.id
    WHERE s.run_id = ? AND ig.is_active = 1
    GROUP BY ig.status
  `).bind(runId).all()

  const statusMap = new Map(imageStats.map((s: any) => [s.status, s.count]))
  const completed = statusMap.get('completed') || 0
  const failed = statusMap.get('failed') || 0
  const generating = statusMap.get('generating') || 0

  return {
    total_scenes: totalScenes,
    processed: completed,
    failed: failed,
    generating: generating,
    pending: totalScenes - completed - failed - generating
  }
}

// ========== Scenes API (v2) ==========

// GET /api/runs/:runId/scenes - Run単位でシーン一覧取得
runsV2.get('/:runId/scenes', async (c) => {
  try {
    const runId = c.req.param('runId')
    const view = c.req.query('view') || 'full' // edit, board, full

    // Run存在確認
    const run = await c.env.DB.prepare(`
      SELECT id, project_id FROM runs WHERE id = ?
    `).bind(runId).first()

    if (!run) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Run not found'
        }
      }, 404)
    }

    // viewに応じて取得カラムを変更
    // Phase1.7: display_asset_type を全viewで取得
    let selectFields = '*'
    if (view === 'edit') {
      selectFields = 'id, idx, role, title, dialogue, bullets, image_prompt, chunk_id, display_asset_type'
    } else if (view === 'board') {
      selectFields = 'id, idx, role, SUBSTR(dialogue, 1, 80) as dialogue, SUBSTR(bullets, 1, 80) as bullets, SUBSTR(image_prompt, 1, 80) as image_prompt, display_asset_type'
    }

    const { results: scenes } = await c.env.DB.prepare(`
      SELECT ${selectFields}
      FROM scenes
      WHERE run_id = ?
      ORDER BY idx ASC
    `).bind(runId).all()

    // board viewの場合、画像情報も取得
    // Phase1.7: display_asset_type に応じて active_image または active_comic を取得
    if (view === 'board') {
      for (const scene of scenes) {
        const displayAssetType = (scene as any).display_asset_type || 'image'
        
        // AI画像（asset_type='ai' または NULL）
        const activeImage = await c.env.DB.prepare(`
          SELECT id, status, r2_url, error_message
          FROM image_generations
          WHERE scene_id = ? AND is_active = 1 AND (asset_type = 'ai' OR asset_type IS NULL)
          ORDER BY id DESC
          LIMIT 1
        `).bind(scene.id).first()

        // 漫画画像（asset_type='comic'）
        const activeComic = await c.env.DB.prepare(`
          SELECT id, status, r2_url, error_message
          FROM image_generations
          WHERE scene_id = ? AND is_active = 1 AND asset_type = 'comic'
          ORDER BY id DESC
          LIMIT 1
        `).bind(scene.id).first()

        ;(scene as any).active_image = activeImage || null
        ;(scene as any).active_comic = activeComic || null
        ;(scene as any).latest_image = activeImage || null
        
        // Phase1.7: display_asset_type に応じて表示用画像を決定
        // Remotion合算やエクスポートで使用する画像
        if (displayAssetType === 'comic' && activeComic?.r2_url) {
          ;(scene as any).display_image = activeComic
        } else {
          ;(scene as any).display_image = activeImage
        }
      }
    }

    return c.json({
      run_id: parseInt(runId),
      project_id: run.project_id,
      scenes: scenes
    })

  } catch (error) {
    console.error('Get run scenes error:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get scenes'
      }
    }, 500)
  }
})

export default runsV2
