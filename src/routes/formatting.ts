import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'
import { validateRILARCScenario, type RILARCScenarioV1 } from '../utils/rilarc-validator'

const formatting = new Hono<{ Bindings: Bindings }>()

// GET /api/projects/:id/format/status - フォーマット進捗取得
formatting.get('/:id/format/status', async (c) => {
  try {
    const projectId = c.req.param('id')

    const project = await c.env.DB.prepare(`
      SELECT id, status FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Project not found' }
      }, 404)
    }

    // text_chunks の進捗を取得
    const { results: chunks } = await c.env.DB.prepare(`
      SELECT status, COUNT(*) as count
      FROM text_chunks
      WHERE project_id = ?
      GROUP BY status
    `).bind(projectId).all()

    const statusMap = new Map(chunks.map((c: any) => [c.status, c.count]))
    const total = Array.from(statusMap.values()).reduce((sum, count) => sum + count, 0)
    const done = statusMap.get('done') || 0
    const failed = statusMap.get('failed') || 0
    const processing = statusMap.get('processing') || 0

    return c.json({
      project_id: parseInt(projectId),
      status: project.status,
      total_chunks: total,
      processed: done,
      failed: failed,
      processing: processing,
      pending: total - done - failed - processing
    })

  } catch (error) {
    console.error('Error getting format status:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get format status' }
    }, 500)
  }
})

// POST /api/projects/:id/format - 整形・シーン分割実行（chunk単位処理）
formatting.post('/:id/format', async (c) => {
  try {
    const projectId = c.req.param('id')

    // 1. プロジェクトの存在確認とステータスチェック
    const project = await c.env.DB.prepare(`
      SELECT id, title, status, source_type, source_text
      FROM projects
      WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // 2. source_type に応じた処理分岐
    if (project.source_type === 'text') {
      // テキスト入力の場合：chunk単位処理
      return await processTextChunks(c, projectId, project)
    } else {
      // 音声入力の場合：従来のフロー（全文を1回で処理）
      return await processAudioTranscription(c, projectId, project)
    }

  } catch (error) {
    console.error('Error in format endpoint:', error)

    // エラー時は error_message を記録（status は変更しない）
    try {
      const projectId = c.req.param('id')
      await c.env.DB.prepare(`
        UPDATE projects 
        SET error_message = ?,
            last_error = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        error instanceof Error ? error.message : 'Unknown error',
        projectId
      ).run()
    } catch (updateError) {
      console.error('Failed to update error message:', updateError)
    }

    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to format and split scenes'
      }
    }, 500)
  }
})

/**
 * テキスト入力の chunk 単位処理
 */
async function processTextChunks(c: any, projectId: string, project: any) {
  // ステータスチェック（parsed または formatting を許可）
  const validStatuses = ['parsed', 'formatting']
  if (!validStatuses.includes(project.status)) {
    return c.json({
      error: {
        code: 'INVALID_STATUS',
        message: `Cannot format project with status: ${project.status}`,
        details: {
          current_status: project.status,
          expected_statuses: validStatuses
        }
      }
    }, 400)
  }

  // ステータスを 'formatting' に更新（初回のみ）
  if (project.status === 'parsed') {
    await c.env.DB.prepare(`
      UPDATE projects 
      SET status = 'formatting', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(projectId).run()
  }

  // 未処理の chunk を取得（最大3件まで）
  const BATCH_SIZE = 3
  const { results: pendingChunks } = await c.env.DB.prepare(`
    SELECT id, idx, text
    FROM text_chunks
    WHERE project_id = ? AND status = 'pending'
    ORDER BY idx ASC
    LIMIT ?
  `).bind(projectId, BATCH_SIZE).all()

  if (pendingChunks.length === 0) {
    // すべてのチャンクが処理済み → ステータスを 'formatted' に
    await c.env.DB.prepare(`
      UPDATE projects 
      SET status = 'formatted', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(projectId).run()

    // 統計を取得
    const stats = await getChunkStats(c.env.DB, projectId)

    return c.json({
      project_id: parseInt(projectId),
      status: 'formatted',
      ...stats,
      message: 'All chunks processed'
    }, 200)
  }

  // 各 chunk を処理
  let successCount = 0
  let failedCount = 0

  for (const chunk of pendingChunks) {
    try {
      // chunk のステータスを 'processing' に
      await c.env.DB.prepare(`
        UPDATE text_chunks 
        SET status = 'processing', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(chunk.id).run()

      // OpenAI API でシーン生成
      const scenarioResult = await generateRILARCScenario(
        chunk.text as string,
        `${project.title} - Part ${chunk.idx}`,
        c.env.OPENAI_API_KEY
      )

      if (!scenarioResult.success) {
        // 生成失敗 → chunk を 'failed' に
        await c.env.DB.prepare(`
          UPDATE text_chunks 
          SET status = 'failed',
              error_message = ?,
              processed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          scenarioResult.error || 'Failed to generate scenario',
          chunk.id
        ).run()

        failedCount++
        continue
      }

      // バリデーション
      const validationResult = validateRILARCScenario(scenarioResult.scenario)

      if (!validationResult.valid) {
        await c.env.DB.prepare(`
          UPDATE text_chunks 
          SET status = 'failed',
              error_message = ?,
              processed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          'Generated scenario does not conform to schema',
          chunk.id
        ).run()

        failedCount++
        continue
      }

      const scenario = scenarioResult.scenario as RILARCScenarioV1

      // scenes に挿入
      const insertStatements = scenario.scenes.map(scene => {
        return c.env.DB.prepare(`
          INSERT INTO scenes (
            project_id, idx, role, title, dialogue, bullets, image_prompt, chunk_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          projectId,
          scene.idx,
          scene.role,
          scene.title,
          scene.dialogue,
          JSON.stringify(scene.bullets),
          scene.image_prompt,
          chunk.id
        )
      })

      await c.env.DB.batch(insertStatements)

      // chunk を 'done' に
      await c.env.DB.prepare(`
        UPDATE text_chunks 
        SET status = 'done',
            scene_count = ?,
            processed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(scenario.scenes.length, chunk.id).run()

      successCount++

    } catch (chunkError) {
      console.error(`Failed to process chunk ${chunk.id}:`, chunkError)

      // chunk を 'failed' に
      await c.env.DB.prepare(`
        UPDATE text_chunks 
        SET status = 'failed',
            error_message = ?,
            processed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        chunkError instanceof Error ? chunkError.message : 'Unknown error',
        chunk.id
      ).run()

      failedCount++
    }
  }

  // 統計を取得
  const stats = await getChunkStats(c.env.DB, projectId)

  return c.json({
    project_id: parseInt(projectId),
    status: 'formatting',
    batch_processed: successCount,
    batch_failed: failedCount,
    ...stats
  }, 200)
}

/**
 * 音声入力の従来フロー（全文を1回で処理）
 */
async function processAudioTranscription(c: any, projectId: string, project: any) {
  // ステータスチェック
  if (project.status !== 'transcribed') {
    return c.json({
      error: {
        code: 'INVALID_STATUS',
        message: `Cannot format project with status: ${project.status}`,
        details: {
          current_status: project.status,
          expected_status: 'transcribed'
        }
      }
    }, 400)
  }

  // transcription 取得
  const transcription = await c.env.DB.prepare(`
    SELECT id, raw_text, word_count
    FROM transcriptions
    WHERE project_id = ?
  `).bind(projectId).first()

  if (!transcription || !transcription.raw_text) {
    return c.json({
      error: {
        code: 'NO_TRANSCRIPTION',
        message: 'No transcription found for this project'
      }
    }, 400)
  }

  // ステータスを 'formatting' に
  await c.env.DB.prepare(`
    UPDATE projects 
    SET status = 'formatting', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(projectId).run()

  // OpenAI API でシーン生成
  const scenarioResult = await generateRILARCScenario(
    transcription.raw_text as string,
    project.title as string,
    c.env.OPENAI_API_KEY
  )

  if (!scenarioResult.success) {
    // 生成失敗 → status を 'failed' に
    await c.env.DB.prepare(`
      UPDATE projects 
      SET status = 'failed',
          error_message = ?,
          last_error = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      scenarioResult.error || 'Failed to generate scenario',
      projectId
    ).run()

    return c.json({
      error: {
        code: 'GENERATION_FAILED',
        message: scenarioResult.error || 'Failed to generate RILARC scenario'
      }
    }, 500)
  }

  // バリデーション
  const validationResult = validateRILARCScenario(scenarioResult.scenario)

  if (!validationResult.valid) {
    await c.env.DB.prepare(`
      UPDATE projects 
      SET status = 'failed',
          error_message = 'Validation failed',
          last_error = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(projectId).run()

    return c.json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Generated scenario does not conform to RILARCScenarioV1 schema',
        details: {
          errors: validationResult.errors
        }
      }
    }, 500)
  }

  const scenario = scenarioResult.scenario as RILARCScenarioV1

  // scenes に挿入
  try {
    const insertStatements = scenario.scenes.map(scene => {
      return c.env.DB.prepare(`
        INSERT INTO scenes (
          project_id, idx, role, title, dialogue, bullets, image_prompt, chunk_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `).bind(
        projectId,
        scene.idx,
        scene.role,
        scene.title,
        scene.dialogue,
        JSON.stringify(scene.bullets),
        scene.image_prompt
      )
    })

    await c.env.DB.batch(insertStatements)

  } catch (dbError) {
    console.error('Failed to insert scenes:', dbError)

    await c.env.DB.prepare(`
      UPDATE projects 
      SET status = 'failed',
          error_message = 'Failed to save scenes',
          last_error = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(projectId).run()

    return c.json({
      error: {
        code: 'DB_INSERT_FAILED',
        message: 'Failed to save scenes to database'
      }
    }, 500)
  }

  // ステータスを 'formatted' に
  await c.env.DB.prepare(`
    UPDATE projects 
    SET status = 'formatted', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(projectId).run()

  // 保存されたシーンを取得
  const { results: savedScenes } = await c.env.DB.prepare(`
    SELECT id, idx, role, title, dialogue, bullets, image_prompt
    FROM scenes
    WHERE project_id = ?
    ORDER BY idx ASC
  `).bind(projectId).all()

  return c.json({
    project_id: parseInt(projectId),
    total_scenes: savedScenes.length,
    status: 'formatted',
    scenes: savedScenes.map((scene: any) => ({
      id: scene.id,
      idx: scene.idx,
      role: scene.role,
      title: scene.title,
      dialogue: scene.dialogue,
      bullets: JSON.parse(scene.bullets),
      image_prompt: scene.image_prompt
    }))
  }, 200)
}

/**
 * chunk統計を取得
 */
async function getChunkStats(db: any, projectId: string) {
  const { results: chunks } = await db.prepare(`
    SELECT status, COUNT(*) as count
    FROM text_chunks
    WHERE project_id = ?
    GROUP BY status
  `).bind(projectId).all()

  const statusMap = new Map(chunks.map((c: any) => [c.status, c.count]))
  const total = Array.from(statusMap.values()).reduce((sum, count) => sum + count, 0)
  const done = statusMap.get('done') || 0
  const failed = statusMap.get('failed') || 0
  const processing = statusMap.get('processing') || 0

  return {
    total_chunks: total,
    processed: done,
    failed: failed,
    processing: processing,
    pending: total - done - failed - processing
  }
}

/**
 * OpenAI Chat API を使ってRILARCシナリオを生成
 */
async function generateRILARCScenario(
  rawText: string,
  projectTitle: string,
  apiKey: string
): Promise<{
  success: boolean
  scenario?: any
  error?: string
}> {
  try {
    const systemPrompt = `あなたは動画シナリオ作成の専門家です。
提供された文字起こしテキストを、RILARCシナリオ形式（JSON）に変換してください。

【厳守ルール】
1. version は "1.0" 固定
2. シーン数は 3〜50 個
3. 各シーンの dialogue は 40〜220 文字（10〜30秒の読み上げ目安）
4. 各シーンの bullets は 2〜4 個、各 6〜26 文字
5. role は以下のいずれか: hook, context, main_point, evidence, timeline, analysis, summary, cta
6. idx は 1 から連番（欠番なし）
7. image_prompt は画像生成用のシーン描写（20〜500文字、英語推奨だが日本語も可）
8. metadata.total_scenes は scenes.length と一致させること

【role の使い方】
- hook: 視聴者の興味を引くオープニング
- context: 背景情報、前提知識
- main_point: 最も重要な論点・主張
- evidence: データ、事実、引用
- timeline: 経緯、歴史的流れ
- analysis: 深掘り、解釈、意味づけ
- summary: 重要ポイントの振り返り
- cta: 視聴者への呼びかけ、次のアクション

【JSON構造】
{
  "version": "1.0",
  "metadata": {
    "title": "...",
    "total_scenes": 5,
    "estimated_duration_seconds": 90
  },
  "scenes": [
    {
      "idx": 1,
      "role": "hook",
      "title": "...",
      "dialogue": "...",
      "bullets": ["...", "..."],
      "image_prompt": "..."
    }
  ]
}

必ず有効なJSONのみを返してください。`

    const userPrompt = `以下の文字起こしテキストをRILARCシナリオに変換してください。

【プロジェクトタイトル】
${projectTitle}

【文字起こしテキスト】
${rawText}

上記のテキストを元に、視聴者にとって魅力的で分かりやすいニュース風インフォグラフィック動画のシナリオを作成してください。`

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7
      })
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const errorMessage = errorData.error?.message || `API error: ${response.status}`
      console.error('OpenAI API error:', errorMessage)
      return {
        success: false,
        error: errorMessage
      }
    }

    const result = await response.json()
    const content = result.choices?.[0]?.message?.content

    if (!content) {
      return {
        success: false,
        error: 'No content in API response'
      }
    }

    // JSONパース
    try {
      const scenario = JSON.parse(content)
      return {
        success: true,
        scenario
      }
    } catch (parseError) {
      console.error('Failed to parse JSON:', parseError)
      return {
        success: false,
        error: 'Generated content is not valid JSON'
      }
    }

  } catch (error) {
    console.error('Error generating RILARC scenario:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export default formatting
