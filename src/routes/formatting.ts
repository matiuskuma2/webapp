import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'
import { validateRILARCScenario, type RILARCScenarioV1 } from '../utils/rilarc-validator'

const formatting = new Hono<{ Bindings: Bindings }>()

// POST /api/projects/:id/format - 整形・シーン分割実行
formatting.post('/:id/format', async (c) => {
  try {
    const projectId = c.req.param('id')

    // 1. プロジェクトの存在確認とステータスチェック
    const project = await c.env.DB.prepare(`
      SELECT id, title, status
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

    // 2. ステータスチェック（transcribedのみ許可）
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

    // 3. 文字起こしテキスト取得
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

    // 4. ステータスを 'formatting' に更新
    await c.env.DB.prepare(`
      UPDATE projects 
      SET status = 'formatting', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(projectId).run()

    // 5. OpenAI Chat API でRILARCシナリオ生成
    const scenarioResult = await generateRILARCScenario(
      transcription.raw_text as string,
      project.title as string,
      c.env.OPENAI_API_KEY
    )

    if (!scenarioResult.success) {
      // 生成失敗 → status を 'failed' に
      await c.env.DB.prepare(`
        UPDATE projects 
        SET status = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(projectId).run()

      return c.json({
        error: {
          code: 'GENERATION_FAILED',
          message: scenarioResult.error || 'Failed to generate RILARC scenario'
        }
      }, 500)
    }

    // 6. JSONバリデーション
    const validationResult = validateRILARCScenario(scenarioResult.scenario)

    if (!validationResult.valid) {
      // バリデーション失敗 → status を 'failed' に
      await c.env.DB.prepare(`
        UPDATE projects 
        SET status = 'failed', updated_at = CURRENT_TIMESTAMP
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

    // 7. scenesテーブルへ一括挿入（トランザクション）
    try {
      // D1 batch APIを使用して一括挿入
      const insertStatements = scenario.scenes.map(scene => {
        return c.env.DB.prepare(`
          INSERT INTO scenes (
            project_id, idx, role, title, dialogue, bullets, image_prompt
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          projectId,
          scene.idx,
          scene.role,
          scene.title,
          scene.dialogue,
          JSON.stringify(scene.bullets), // JSON配列として保存
          scene.image_prompt
        )
      })

      await c.env.DB.batch(insertStatements)

    } catch (dbError) {
      console.error('Failed to insert scenes:', dbError)

      // DB挿入失敗 → status を 'failed' に
      await c.env.DB.prepare(`
        UPDATE projects 
        SET status = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(projectId).run()

      return c.json({
        error: {
          code: 'DB_INSERT_FAILED',
          message: 'Failed to save scenes to database'
        }
      }, 500)
    }

    // 8. ステータスを 'formatted' に更新
    await c.env.DB.prepare(`
      UPDATE projects 
      SET status = 'formatted', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(projectId).run()

    // 9. 保存されたシーンを取得
    const { results: savedScenes } = await c.env.DB.prepare(`
      SELECT id, idx, role, title, dialogue, bullets, image_prompt
      FROM scenes
      WHERE project_id = ?
      ORDER BY idx ASC
    `).bind(projectId).all()

    // 10. レスポンス返却
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

  } catch (error) {
    console.error('Error in format endpoint:', error)

    // エラー時は status を 'failed' に更新
    try {
      const projectId = c.req.param('id')
      await c.env.DB.prepare(`
        UPDATE projects 
        SET status = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(projectId).run()
    } catch (updateError) {
      console.error('Failed to update project status to failed:', updateError)
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
7. image_prompt は英語で記述（20〜500文字）
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
