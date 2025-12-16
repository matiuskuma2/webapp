import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'

const transcriptions = new Hono<{ Bindings: Bindings }>()

// POST /api/projects/:id/transcribe - 文字起こし実行
transcriptions.post('/:id/transcribe', async (c) => {
  try {
    const projectId = c.req.param('id')

    // 1. プロジェクトの存在確認とステータスチェック
    const project = await c.env.DB.prepare(`
      SELECT id, title, status, audio_r2_key, audio_filename
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

    // 2. 音声ファイルがアップロード済みかチェック
    if (project.status !== 'uploaded') {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot transcribe project with status: ${project.status}`,
          details: {
            current_status: project.status,
            expected_status: 'uploaded'
          }
        }
      }, 400)
    }

    if (!project.audio_r2_key) {
      return c.json({
        error: {
          code: 'NO_AUDIO_FILE',
          message: 'No audio file uploaded'
        }
      }, 400)
    }

    // 3. ステータスを 'transcribing' に更新
    await c.env.DB.prepare(`
      UPDATE projects 
      SET status = 'transcribing', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(projectId).run()

    // 4. R2から音声ファイル取得
    const audioObject = await c.env.R2.get(project.audio_r2_key)
    
    if (!audioObject) {
      // R2取得失敗 → status を 'failed' に
      await c.env.DB.prepare(`
        UPDATE projects 
        SET status = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(projectId).run()

      return c.json({
        error: {
          code: 'AUDIO_NOT_FOUND',
          message: 'Audio file not found in storage'
        }
      }, 500)
    }

    const audioBlob = await audioObject.blob()

    // 5. OpenAI Whisper API呼び出し（429リトライ付き）
    const transcriptionResult = await transcribeWithRetry(
      audioBlob,
      project.audio_filename as string,
      c.env.OPENAI_API_KEY,
      3 // 最大3回リトライ
    )

    if (!transcriptionResult.success) {
      // 文字起こし失敗 → status を 'failed' に
      await c.env.DB.prepare(`
        UPDATE projects 
        SET status = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(projectId).run()

      return c.json({
        error: {
          code: 'TRANSCRIPTION_FAILED',
          message: transcriptionResult.error || 'Transcription failed'
        }
      }, 500)
    }

    // 6. transcriptions レコード作成
    const wordCount = countWords(transcriptionResult.text)
    
    const transcriptionInsert = await c.env.DB.prepare(`
      INSERT INTO transcriptions (
        project_id, raw_text, language, duration_seconds, word_count, provider, model
      ) VALUES (?, ?, ?, ?, ?, 'openai', 'whisper-1')
    `).bind(
      projectId,
      transcriptionResult.text,
      transcriptionResult.language || null,
      transcriptionResult.duration || null,
      wordCount
    ).run()

    // 7. ステータスを 'transcribed' に更新し、source_text に保存（重要！）
    await c.env.DB.prepare(`
      UPDATE projects 
      SET status = 'transcribed', 
          source_text = ?,
          source_type = 'audio',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(transcriptionResult.text, projectId).run()

    // 8. レスポンス返却
    return c.json({
      project_id: parseInt(projectId),
      transcription_id: transcriptionInsert.meta.last_row_id,
      raw_text: transcriptionResult.text,
      language: transcriptionResult.language || null,
      duration_seconds: transcriptionResult.duration || null,
      word_count: wordCount,
      status: 'transcribed'
    }, 200)

  } catch (error) {
    console.error('Error in transcribe endpoint:', error)

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
        message: 'Failed to transcribe audio'
      }
    }, 500)
  }
})

// 文字起こしAPIを429リトライ付きで実行
async function transcribeWithRetry(
  audioBlob: Blob,
  filename: string,
  apiKey: string,
  maxRetries: number = 3
): Promise<{
  success: boolean
  text?: string
  language?: string
  duration?: number
  error?: string
}> {
  let lastError: string = ''

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // FormData作成
      const formData = new FormData()
      formData.append('file', audioBlob, filename)
      formData.append('model', 'whisper-1')
      formData.append('response_format', 'verbose_json') // duration, languageを取得

      // OpenAI API呼び出し
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        },
        body: formData
      })

      // 429エラー時はリトライ
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After')
        const waitTime = retryAfter 
          ? parseInt(retryAfter) * 1000 
          : Math.pow(2, attempt) * 1000 // 指数バックオフ: 1s, 2s, 4s

        console.warn(`Rate limited (429). Retrying after ${waitTime}ms... (attempt ${attempt + 1}/${maxRetries})`)
        
        if (attempt < maxRetries - 1) {
          await sleep(waitTime)
          continue
        } else {
          lastError = 'Rate limit exceeded after max retries'
          break
        }
      }

      // その他のエラー
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        lastError = errorData.error?.message || `API error: ${response.status}`
        console.error('OpenAI API error:', lastError)
        break
      }

      // 成功
      const result = await response.json()
      
      return {
        success: true,
        text: result.text,
        language: result.language,
        duration: result.duration ? Math.round(result.duration) : undefined
      }

    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error'
      console.error(`Transcription attempt ${attempt + 1} failed:`, error)
      
      // 最後の試行でない場合はリトライ
      if (attempt < maxRetries - 1) {
        await sleep(Math.pow(2, attempt) * 1000)
        continue
      }
    }
  }

  return {
    success: false,
    error: lastError
  }
}

// 単語数カウント（日本語対応）
function countWords(text: string): number {
  // 空白で分割して英語の単語数をカウント
  const englishWords = text.match(/[a-zA-Z0-9]+/g) || []
  
  // 日本語文字（ひらがな、カタカナ、漢字）をカウント
  const japaneseChars = text.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g) || []
  
  // 英語単語 + 日本語文字数 / 2 (日本語は2文字で1単語相当)
  return englishWords.length + Math.ceil(japaneseChars.length / 2)
}

// Sleep utility
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export default transcriptions
