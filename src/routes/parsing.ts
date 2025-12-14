import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'

const parsing = new Hono<{ Bindings: Bindings }>()

// POST /api/projects/:id/parse - 長文を構造的に分割
parsing.post('/:id/parse', async (c) => {
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

    // 2. ステータスチェック（uploaded のみ許可）
    if (project.status !== 'uploaded') {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot parse project with status: ${project.status}`,
          details: {
            current_status: project.status,
            expected_status: 'uploaded'
          }
        }
      }, 400)
    }

    // 3. source_text 確認
    if (!project.source_text) {
      return c.json({
        error: {
          code: 'NO_SOURCE_TEXT',
          message: 'No source text found for this project'
        }
      }, 400)
    }

    const sourceText = project.source_text as string

    // 4. ステータスを 'parsing' に更新
    await c.env.DB.prepare(`
      UPDATE projects 
      SET status = 'parsing', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(projectId).run()

    // 5. テキスト分割（意味単位）
    const chunks = intelligentChunking(sourceText)

    // 6. text_chunks に保存
    try {
      const insertStatements = chunks.map((chunk, index) => {
        return c.env.DB.prepare(`
          INSERT INTO text_chunks (project_id, idx, text, status)
          VALUES (?, ?, ?, 'pending')
        `).bind(projectId, index + 1, chunk)
      })

      await c.env.DB.batch(insertStatements)

    } catch (dbError) {
      console.error('Failed to insert chunks:', dbError)

      // DB挿入失敗 → status を元に戻す
      await c.env.DB.prepare(`
        UPDATE projects 
        SET status = 'uploaded', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(projectId).run()

      return c.json({
        error: {
          code: 'DB_INSERT_FAILED',
          message: 'Failed to save chunks to database'
        }
      }, 500)
    }

    // 7. ステータスを 'parsed' に更新
    await c.env.DB.prepare(`
      UPDATE projects 
      SET status = 'parsed', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(projectId).run()

    // 8. レスポンス返却
    return c.json({
      project_id: parseInt(projectId),
      total_chunks: chunks.length,
      status: 'parsed',
      chunks: chunks.map((text, index) => ({
        idx: index + 1,
        length: text.length,
        preview: text.substring(0, 100) + (text.length > 100 ? '...' : '')
      }))
    }, 200)

  } catch (error) {
    console.error('Error in parse endpoint:', error)

    // エラー時は status を元に戻す
    try {
      const projectId = c.req.param('id')
      await c.env.DB.prepare(`
        UPDATE projects 
        SET status = 'uploaded', 
            error_message = ?,
            last_error = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        error instanceof Error ? error.message : 'Unknown parse error',
        projectId
      ).run()
    } catch (updateError) {
      console.error('Failed to update project status:', updateError)
    }

    return c.json({
      error: {
        code: 'PARSE_ERROR',
        message: 'Failed to parse text'
      }
    }, 500)
  }
})

/**
 * 意味単位でテキストを分割
 * 
 * 戦略：
 * 1. 段落区切り（\n\n）を最優先
 * 2. 各チャンクは 500〜1500 文字を目安
 * 3. 文の途中で切らない
 */
function intelligentChunking(text: string): string[] {
  const chunks: string[] = []
  const MIN_CHUNK_SIZE = 500
  const MAX_CHUNK_SIZE = 1500
  const IDEAL_CHUNK_SIZE = 1000

  // 段落単位で分割
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0)

  let currentChunk = ''

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim()

    // 段落が大きすぎる場合は文単位でさらに分割
    if (trimmedParagraph.length > MAX_CHUNK_SIZE) {
      // 現在のチャンクを保存
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.trim())
        currentChunk = ''
      }

      // 大きな段落を文単位で分割
      const sentences = splitIntoSentences(trimmedParagraph)
      let tempChunk = ''

      for (const sentence of sentences) {
        if (tempChunk.length + sentence.length > MAX_CHUNK_SIZE && tempChunk.length > MIN_CHUNK_SIZE) {
          chunks.push(tempChunk.trim())
          tempChunk = sentence
        } else {
          tempChunk += (tempChunk.length > 0 ? ' ' : '') + sentence
        }
      }

      if (tempChunk.length > 0) {
        currentChunk = tempChunk
      }

      continue
    }

    // 段落を追加しても MAX_CHUNK_SIZE 以下なら追加
    if (currentChunk.length + trimmedParagraph.length + 2 <= MAX_CHUNK_SIZE) {
      currentChunk += (currentChunk.length > 0 ? '\n\n' : '') + trimmedParagraph
    } else {
      // 現在のチャンクを保存
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.trim())
      }
      currentChunk = trimmedParagraph
    }

    // IDEAL_CHUNK_SIZE を超えたら区切る
    if (currentChunk.length >= IDEAL_CHUNK_SIZE) {
      chunks.push(currentChunk.trim())
      currentChunk = ''
    }
  }

  // 最後のチャンクを保存
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.trim())
  }

  // 空のチャンクを除外
  return chunks.filter(chunk => chunk.length > 0)
}

/**
 * 文単位で分割
 */
function splitIntoSentences(text: string): string[] {
  // 日本語の句点（。！？）で分割
  const sentences = text.split(/([。！？]+)/).filter(s => s.trim().length > 0)
  
  // 句点と文を結合
  const result: string[] = []
  for (let i = 0; i < sentences.length; i++) {
    if (sentences[i].match(/^[。！？]+$/)) {
      if (result.length > 0) {
        result[result.length - 1] += sentences[i]
      }
    } else {
      result.push(sentences[i])
    }
  }

  return result
}

export default parsing
