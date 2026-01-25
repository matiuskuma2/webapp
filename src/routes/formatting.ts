import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'
import { validateRILARCScenario, type RILARCScenarioV1 } from '../utils/rilarc-validator'

const formatting = new Hono<{ Bindings: Bindings }>()

// POST /api/text_chunks/:id/retry - Failed chunk retry
formatting.post('/text_chunks/:id/retry', async (c) => {
  try {
    const chunkId = c.req.param('id')

    // 1. Chunk取得
    const chunk = await c.env.DB.prepare(`
      SELECT id, project_id, status FROM text_chunks WHERE id = ?
    `).bind(chunkId).first()

    if (!chunk) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Chunk not found'
        }
      }, 404)
    }

    // 2. statusを pending にリセット
    await c.env.DB.prepare(`
      UPDATE text_chunks
      SET status = 'pending',
          error_message = NULL,
          processed_at = NULL,
          scene_count = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(chunkId).run()

    // 3. このchunkに紐づくscenesを削除
    await c.env.DB.prepare(`
      DELETE FROM scenes WHERE chunk_id = ?
    `).bind(chunkId).run()

    // 4. projects.statusを formatting に戻す（再実行可能にする）
    await c.env.DB.prepare(`
      UPDATE projects
      SET status = 'formatting',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(chunk.project_id).run()

    return c.json({
      chunk_id: parseInt(chunkId),
      status: 'pending',
      message: 'Chunk reset to pending. Call /format to retry.'
    }, 200)

  } catch (error) {
    console.error('Retry chunk error:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to retry chunk'
      }
    }, 500)
  }
})

// GET /api/projects/:id/format/status - フォーマット進捗取得
formatting.get('/:id/format/status', async (c) => {
  try {
    const projectId = c.req.param('id')

    const project = await c.env.DB.prepare(`
      SELECT id, status, error_message, updated_at FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Project not found' }
      }, 404)
    }

    // 最新の run を取得（run_no表示用）
    const latestRun = await c.env.DB.prepare(`
      SELECT id, run_no, state, created_at FROM runs
      WHERE project_id = ?
      ORDER BY run_no DESC
      LIMIT 1
    `).bind(projectId).first()

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
      error_message: project.error_message || null,
      total_chunks: total,
      processed: done,
      failed: failed,
      processing: processing,
      pending: total - done - failed - processing,
      // サポート用追加情報
      run_id: latestRun?.id || null,
      run_no: latestRun?.run_no || null,
      started_at: latestRun?.created_at || project.updated_at
    })

  } catch (error) {
    console.error('Error getting format status:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get format status' }
    }, 500)
  }
})

// POST /api/projects/:id/merge - Scene merge & idx正規化
formatting.post('/:id/merge', async (c) => {
  try {
    const projectId = c.req.param('id')

    // 1. プロジェクトの存在確認
    const project = await c.env.DB.prepare(`
      SELECT id, title, status, source_type
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

    // 2. text入力のみ対応
    if (project.source_type !== 'text') {
      return c.json({
        error: {
          code: 'INVALID_SOURCE_TYPE',
          message: 'Merge is only supported for text input projects'
        }
      }, 400)
    }

    // 3. ステータスチェック（formatting のみ許可）
    if (project.status !== 'formatting') {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot merge project with status: ${project.status}`,
          details: {
            current_status: project.status,
            expected_status: 'formatting'
          }
        }
      }, 400)
    }

    // 4. chunk進捗確認（pending=0 & processing=0）
    const stats = await getChunkStats(c.env.DB, projectId)
    if (stats.pending > 0 || stats.processing > 0) {
      return c.json({
        error: {
          code: 'CHUNKS_NOT_READY',
          message: 'Cannot merge: some chunks are still pending or processing',
          details: {
            pending: stats.pending,
            processing: stats.processing,
            processed: stats.processed,
            failed: stats.failed
          }
        }
      }, 400)
    }

    // 5. scenes取得（tempIdx順）
    const { results: scenes } = await c.env.DB.prepare(`
      SELECT id, idx, role, chunk_id
      FROM scenes
      WHERE project_id = ?
      ORDER BY idx ASC
    `).bind(projectId).all()

    if (scenes.length === 0) {
      return c.json({
        error: {
          code: 'NO_SCENES',
          message: 'No scenes to merge'
        }
      }, 400)
    }

    // 6. idx正規化 & role最小整形（transaction）
    const updateStatements = []

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]
      const newIdx = i + 1
      let newRole = scene.role

      // 先頭scene → hook
      if (i === 0 && scene.role !== 'hook') {
        newRole = 'hook'
      }

      // 末尾scene → summary or cta（既存がsummary/ctaならそのまま）
      if (i === scenes.length - 1) {
        if (scene.role !== 'summary' && scene.role !== 'cta') {
          newRole = 'summary'
        }
      }

      updateStatements.push(
        c.env.DB.prepare(`
          UPDATE scenes
          SET idx = ?, role = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(newIdx, newRole, scene.id)
      )
    }

    // Batch実行（transaction的動作）
    await c.env.DB.batch(updateStatements)

    // 7. projects.status更新
    const finalStatus = stats.failed > 0 ? 'formatted' : 'formatted'
    await c.env.DB.prepare(`
      UPDATE projects
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(finalStatus, projectId).run()

    // 8. 結果返却
    return c.json({
      project_id: parseInt(projectId),
      status: finalStatus,
      total_scenes: scenes.length,
      renormalized: true,
      chunk_stats: {
        total: stats.total_chunks,
        processed: stats.processed,
        failed: stats.failed
      },
      message: stats.failed > 0
        ? `Merge completed with ${stats.failed} failed chunks`
        : 'Merge completed successfully'
    }, 200)

  } catch (error) {
    console.error('Error in merge endpoint:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to merge scenes'
      }
    }, 500)
  }
})

// POST /api/projects/:id/format - 整形・シーン分割実行（chunk単位処理）
// 新: split_mode=preserve|ai, target_scene_count, reset=true をサポート
formatting.post('/:id/format', async (c) => {
  try {
    const projectId = c.req.param('id')
    
    // リクエストボディからオプション取得
    let body: {
      split_mode?: 'preserve' | 'ai'
      target_scene_count?: number
      reset?: boolean
    } = {}
    try {
      body = await c.req.json()
    } catch {
      // body がない場合は空オブジェクト（後方互換）
    }
    
    const splitMode = body.split_mode || 'ai' // デフォルトは ai
    const targetSceneCount = body.target_scene_count || 5 // デフォルトは 5
    const shouldReset = body.reset === true
    
    console.log(`[Format] project=${projectId}, mode=${splitMode}, target=${targetSceneCount}, reset=${shouldReset}`)

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
    
    // 2. reset=true の場合：既存データを全削除して再実行
    if (shouldReset) {
      console.log(`[Format] Resetting project ${projectId} - deleting existing scenes and related data`)
      await hardResetProject(c.env.DB, projectId)
      // status を 'uploaded' に戻す
      await c.env.DB.prepare(`
        UPDATE projects SET status = 'uploaded', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(projectId).run()
      // project オブジェクトを更新
      project.status = 'uploaded'
    }

    // 3. source_type に応じた処理分岐
    // Note: Parse API実行済み（status='parsed'）の場合は chunk単位処理を使用
    if (project.status === 'parsed' || project.status === 'formatting') {
      // Parse API実行済み → chunk単位処理（テキスト・音声共通）
      return await processTextChunks(c, projectId, project, splitMode, targetSceneCount)
    } else if (project.source_type === 'audio' && project.status === 'transcribed') {
      // 音声入力 + Parse未実行の場合：従来のフロー（全文を1回で処理）
      // ※このケースは Parse をスキップした場合のみ
      return await processAudioTranscription(c, projectId, project)
    } else if (project.source_type === 'text') {
      // テキスト入力の場合：chunk単位処理
      // まず parse を実行する必要がある
      return await processTextChunks(c, projectId, project, splitMode, targetSceneCount)
    } else {
      // 想定外のステータス
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot format project with status: ${project.status}`,
          details: {
            current_status: project.status,
            source_type: project.source_type,
            hint: 'Run /parse first for audio projects'
          }
        }
      }, 400)
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
 * ハードリセット: プロジェクトの全データを削除
 * 
 * 削除対象（子→親の順）:
 * - scene_balloons (吹き出し)
 * - scene_audio_cues (SFX/BGM)
 * - scene_telops (テロップ)
 * - scene_motion (モーション設定)
 * - scene_style_settings (シーン別スタイル)
 * - scene_utterances (発話)
 * - scene_character_map (キャラクター割当)
 * - scene_character_traits (キャラクター特性)
 * - audio_generations (音声生成)
 * - image_generations (画像生成)
 * - scenes
 * 
 * 保持対象:
 * - video_builds (ビルド履歴 - 監査用)
 * - project_audio_tracks (BGM設定 - project単位)
 * - project_character_models (キャラ定義 - project単位)
 */
async function hardResetProject(db: any, projectId: string) {
  console.log(`[HardReset] Starting reset for project ${projectId}`)
  
  // 1. scenes取得
  const { results: scenes } = await db.prepare(`SELECT id FROM scenes WHERE project_id = ?`).bind(projectId).all()
  const sceneIds = scenes.map((s: any) => s.id)
  
  if (sceneIds.length > 0) {
    // 2. 関連データ削除（子→親の順、漏れ防止のため全テーブル列挙）
    for (const sceneId of sceneIds) {
      // 吹き出し
      await db.prepare(`DELETE FROM scene_balloons WHERE scene_id = ?`).bind(sceneId).run()
      // SFX/BGMキュー
      await db.prepare(`DELETE FROM scene_audio_cues WHERE scene_id = ?`).bind(sceneId).run()
      // テロップ
      await db.prepare(`DELETE FROM scene_telops WHERE scene_id = ?`).bind(sceneId).run()
      // モーション設定
      await db.prepare(`DELETE FROM scene_motion WHERE scene_id = ?`).bind(sceneId).run()
      // シーン別スタイル
      await db.prepare(`DELETE FROM scene_style_settings WHERE scene_id = ?`).bind(sceneId).run()
      // 発話
      await db.prepare(`DELETE FROM scene_utterances WHERE scene_id = ?`).bind(sceneId).run()
      // キャラクター割当
      await db.prepare(`DELETE FROM scene_character_map WHERE scene_id = ?`).bind(sceneId).run()
      // キャラクター特性
      await db.prepare(`DELETE FROM scene_character_traits WHERE scene_id = ?`).bind(sceneId).run()
      // 音声生成
      await db.prepare(`DELETE FROM audio_generations WHERE scene_id = ?`).bind(sceneId).run()
      // 画像生成
      await db.prepare(`DELETE FROM image_generations WHERE scene_id = ?`).bind(sceneId).run()
    }
    
    // 3. scenes削除
    await db.prepare(`DELETE FROM scenes WHERE project_id = ?`).bind(projectId).run()
    
    console.log(`[HardReset] Deleted ${sceneIds.length} scenes and all related data`)
  }
  
  // 4. text_chunks をリセット（statusをpendingに戻す）
  await db.prepare(`
    UPDATE text_chunks 
    SET status = 'pending', scene_count = 0, error_message = NULL, processed_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE project_id = ?
  `).bind(projectId).run()
  
  // 5. プロジェクトのエラー状態をクリア
  await db.prepare(`
    UPDATE projects 
    SET error_message = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(projectId).run()
  
  console.log(`[HardReset] Project ${projectId}: reset complete`)
}

/**
 * テキスト入力の chunk 単位処理
 * @param splitMode 'preserve' = 原文維持（空行分割）, 'ai' = AI整理（省略なし）
 * @param targetSceneCount 目標シーン数（preserve: 段落数調整、ai: シーン数目標）
 */
async function processTextChunks(
  c: any, 
  projectId: string, 
  project: any,
  splitMode: 'preserve' | 'ai' = 'ai',
  targetSceneCount: number = 5
) {
  console.log(`[processTextChunks] mode=${splitMode}, target=${targetSceneCount}`)
  
  // ステータスチェック（parsed, formatting, uploaded を許可）
  const validStatuses = ['parsed', 'formatting', 'uploaded']
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
  
  // preserve モード: 原文をそのまま分割（AI呼び出し不要）
  if (splitMode === 'preserve') {
    return await processPreserveMode(c, projectId, project, targetSceneCount)
  }

  // ステータスを 'formatting' に更新（初回のみ）
  if (project.status === 'parsed') {
    // ✅ 既存image_generationsを削除（整合性確保）
    // Note: scenes削除前に実行する必要がある
    const { results: existingScenes } = await c.env.DB.prepare(`
      SELECT id FROM scenes WHERE project_id = ?
    `).bind(projectId).all()
    
    if (existingScenes.length > 0) {
      const sceneIds = existingScenes.map((s: any) => s.id)
      // D1はIN句に制限があるため、batch処理
      for (const sceneId of sceneIds) {
        await c.env.DB.prepare(`
          DELETE FROM image_generations WHERE scene_id = ?
        `).bind(sceneId).run()
      }
    }
    
    // ✅ 既存シーンを削除（UNIQUE制約エラー防止）
    await c.env.DB.prepare(`
      DELETE FROM scenes WHERE project_id = ?
    `).bind(projectId).run()
    
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
    // すべてのチャンクが処理済み → 統計を取得
    const stats = await getChunkStats(c.env.DB, projectId)

    // processing中のchunkがある場合は継続
    if (stats.processing > 0) {
      return c.json({
        project_id: parseInt(projectId),
        status: 'formatting',
        ...stats,
        message: 'Some chunks are still processing'
      }, 200)
    }

    // pending=0 & processing=0 → 自動的にmerge実行して 'formatted' へ
    return await autoMergeScenes(c, projectId, stats)
  }

  // 各 chunk を処理
  let successCount = 0
  let failedCount = 0
  
  // ★ target配分ロジック: chunk数に応じてシーン数を按分
  const totalChunks = await c.env.DB.prepare(`
    SELECT COUNT(*) as count FROM text_chunks WHERE project_id = ?
  `).bind(projectId).first() as { count: number }
  
  const currentSceneCount = await c.env.DB.prepare(`
    SELECT COUNT(*) as count FROM scenes WHERE project_id = ?
  `).bind(projectId).first() as { count: number }
  
  const remainingTarget = Math.max(1, targetSceneCount - (currentSceneCount?.count || 0))
  const remainingChunks = Math.max(1, (totalChunks?.count || 1) - (currentSceneCount?.count || 0) / 2)
  
  console.log(`[AIMode] target=${targetSceneCount}, currentScenes=${currentSceneCount?.count}, remainingTarget=${remainingTarget}, remainingChunks=${remainingChunks}`)

  for (const chunk of pendingChunks) {
    try {
      // chunk のステータスを 'processing' に
      await c.env.DB.prepare(`
        UPDATE text_chunks 
        SET status = 'processing', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(chunk.id).run()
      
      // このchunkに割り当てるシーン数を計算
      const chunkTargetScenes = Math.max(1, Math.ceil(remainingTarget / remainingChunks))
      console.log(`[AIMode] Chunk ${chunk.idx}: target ${chunkTargetScenes} scenes`)

      // OpenAI API で MiniScene 生成（AI整理モード）
      const miniScenesResult = await generateMiniScenesAI(
        chunk.text as string,
        project.title as string,
        chunk.idx as number,
        c.env.OPENAI_API_KEY,
        chunkTargetScenes  // chunk単位の目標シーン数
      )

      if (!miniScenesResult.success) {
        // 生成失敗 → chunk を 'failed' に（scene_count = 0）
        await c.env.DB.prepare(`
          UPDATE text_chunks 
          SET status = 'failed',
              scene_count = 0,
              error_message = ?,
              processed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          miniScenesResult.error || 'Failed to generate mini scenes',
          chunk.id
        ).run()

        failedCount++
        continue
      }

      const miniScenes = miniScenesResult.scenes || []

      if (miniScenes.length === 0) {
        // シーンが生成されなかった → failed扱い
        await c.env.DB.prepare(`
          UPDATE text_chunks 
          SET status = 'failed',
              scene_count = 0,
              error_message = 'No scenes generated',
              processed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(chunk.id).run()

        failedCount++
        continue
      }

      // scenes に挿入（idx は後で振り直すため、暫定値を使用）
      const insertStatements = miniScenes.map((scene, localIdx) => {
        // 暫定idx: chunk.idx * 100 + localIdx（後でmerge時に振り直す）
        const tempIdx = (chunk.idx as number) * 100 + localIdx

        return c.env.DB.prepare(`
          INSERT INTO scenes (
            project_id, idx, role, title, dialogue, speech_type, bullets, image_prompt, chunk_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          projectId,
          tempIdx,
          scene.role || 'context',
          scene.title || '',
          scene.dialogue || '',
          scene.speech_type || 'narration', // デフォルトはnarration
          JSON.stringify(scene.bullets || []),
          scene.image_prompt || '',
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
      `).bind(miniScenes.length, chunk.id).run()

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

  // 最新のrun_id/run_noを取得（SSOT: UI側でmismatch検出に使用）
  const latestRun = await c.env.DB.prepare(`
    SELECT id, run_no FROM runs
    WHERE project_id = ?
    ORDER BY run_no DESC
    LIMIT 1
  `).bind(projectId).first()

  return c.json({
    project_id: parseInt(projectId),
    status: 'formatting',
    batch_processed: successCount,
    batch_failed: failedCount,
    run_id: latestRun?.id || null,
    run_no: latestRun?.run_no || null,
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
          project_id, idx, role, title, dialogue, speech_type, bullets, image_prompt, chunk_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).bind(
        projectId,
        scene.idx,
        scene.role,
        scene.title,
        scene.dialogue,
        scene.speech_type || 'narration', // デフォルトはnarration
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
 * preserve モード: 原文維持で分割（AIによる改変なし）
 * 
 * 【重要: 原文不変ガード】
 * - dialogue は絶対にAIに渡さない（image_prompt生成のみAI使用）
 * - dialogue の文字列を再整形しない（trim以外禁止）
 * - 句読点・改行を維持（結合時は \n\n）
 * 
 * 分割ルール:
 * - 空行（\n\n）で段落分割
 * - 段落数 > targetSceneCount: 段落を結合（省略なし）
 * - 段落数 < targetSceneCount: 段落を文境界で分割（省略・言い換え禁止）
 */
async function processPreserveMode(
  c: any,
  projectId: string,
  project: any,
  targetSceneCount: number
) {
  console.log(`[PreserveMode] Starting for project ${projectId}, target=${targetSceneCount}`)
  
  // source_text を取得
  const sourceText = project.source_text as string || ''
  if (!sourceText.trim()) {
    return c.json({
      error: {
        code: 'NO_TEXT',
        message: 'No source text available for preserve mode'
      }
    }, 400)
  }
  
  // ★ 原文不変ガード: 元テキストの文字数を記録
  const originalCharCount = sourceText.length
  
  // 1. 既存データをクリア（hardResetProjectを使用）
  await hardResetProject(c.env.DB, projectId)
  
  // 2. テキストを段落に分割（空行区切り）
  // Note: trim() のみ許可、内容の改変は禁止
  let paragraphs = sourceText
    .split(/\n\s*\n/)
    .map(p => p.trim())  // 前後の空白のみ除去
    .filter(p => p.length > 0)
  
  console.log(`[PreserveMode] Found ${paragraphs.length} paragraphs, target=${targetSceneCount}`)
  
  // 3. 段落数を targetSceneCount に調整
  if (paragraphs.length > targetSceneCount) {
    // 段落を結合（省略なし、\n\n で結合）
    paragraphs = mergeParagraphsPreserve(paragraphs, targetSceneCount)
  } else if (paragraphs.length < targetSceneCount) {
    // 段落を文境界で分割（省略・言い換え禁止）
    paragraphs = splitParagraphsPreserve(paragraphs, targetSceneCount)
  }
  
  // ★ 原文不変ガード: 分割後の文字数チェック
  const totalCharAfterSplit = paragraphs.reduce((sum, p) => sum + p.length, 0)
  // 結合・分割で \n\n が追加/削除されるため、元の空白を除いた比較
  const originalContentLength = sourceText.replace(/\s+/g, '').length
  const afterContentLength = paragraphs.join('').replace(/\s+/g, '').length
  
  if (afterContentLength !== originalContentLength) {
    console.error(`[PreserveMode] INTEGRITY CHECK FAILED: original=${originalContentLength}, after=${afterContentLength}`)
    return c.json({
      error: {
        code: 'PRESERVE_INTEGRITY_ERROR',
        message: '原文維持チェックに失敗しました。文字が欠落または追加されています。',
        details: {
          original_chars: originalContentLength,
          after_chars: afterContentLength,
          diff: afterContentLength - originalContentLength
        }
      }
    }, 400)
  }
  
  console.log(`[PreserveMode] Integrity check passed: ${afterContentLength} chars preserved`)
  console.log(`[PreserveMode] Adjusted to ${paragraphs.length} scenes`)
  
  // 4. シーンを作成（dialogue = 原文そのまま、image_prompt はAI生成）
  const insertStatements = []
  for (let i = 0; i < paragraphs.length; i++) {
    const dialogue = paragraphs[i]  // 原文そのまま！AIに渡さない
    const role = i === 0 ? 'hook' : (i === paragraphs.length - 1 ? 'summary' : 'context')
    const title = `シーン ${i + 1}`
    
    // image_prompt のみAI生成（dialogue は渡さない、要約テキストのみ）
    const imagePrompt = await generateImagePromptFromText(
      dialogue.substring(0, 200),  // 先頭200文字を参考に
      project.title as string,
      c.env.OPENAI_API_KEY
    )
    
    insertStatements.push(
      c.env.DB.prepare(`
        INSERT INTO scenes (
          project_id, idx, role, title, dialogue, speech_type, bullets, image_prompt, chunk_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).bind(
        projectId,
        i + 1,
        role,
        title,
        dialogue,  // ★ 原文そのまま保存
        'narration',
        JSON.stringify([]),
        imagePrompt
      )
    )
  }
  
  // Batch実行
  await c.env.DB.batch(insertStatements)
  
  // 5. status更新
  await c.env.DB.prepare(`
    UPDATE projects SET status = 'formatted', updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(projectId).run()
  
  // 6. Auto-assign characters (non-blocking)
  try {
    const { autoAssignCharactersToScenes } = await import('../utils/character-auto-assign')
    const { extractAndUpdateCharacterTraits } = await import('../utils/character-trait-extractor')
    
    c.executionCtx.waitUntil(
      (async () => {
        const assignResult = await autoAssignCharactersToScenes(c.env.DB, parseInt(projectId))
        console.log(`[PreserveMode] Auto-assigned ${assignResult.assigned} characters`)
        
        const traitResult = await extractAndUpdateCharacterTraits(c.env.DB, parseInt(projectId))
        console.log(`[PreserveMode] Extracted traits for ${traitResult.updated} characters`)
      })().catch(err => {
        console.error(`[PreserveMode] Character processing failed:`, err.message)
      })
    )
  } catch (err) {
    console.warn(`[PreserveMode] Auto-assign skipped:`, err)
  }
  
  return c.json({
    project_id: parseInt(projectId),
    status: 'formatted',
    split_mode: 'preserve',
    total_scenes: paragraphs.length,
    message: `原文維持モードで ${paragraphs.length} シーンを生成しました`
  }, 200)
}

/**
 * 段落を結合（原文維持版: 省略なし、改変なし）
 * 結合時は \n\n で繋ぐ（段落感を維持）
 */
function mergeParagraphsPreserve(paragraphs: string[], targetCount: number): string[] {
  if (paragraphs.length <= targetCount) return paragraphs
  
  const result: string[] = []
  const groupSize = Math.ceil(paragraphs.length / targetCount)
  
  for (let i = 0; i < paragraphs.length; i += groupSize) {
    const group = paragraphs.slice(i, i + groupSize)
    // \n\n で結合（原文の改行を維持）
    result.push(group.join('\n\n'))
  }
  
  return result.slice(0, targetCount)
}

/**
 * 段落を文境界で分割（原文維持版: 省略・言い換え禁止）
 * 分割は「。」「！」「？」の後でのみ行う
 */
function splitParagraphsPreserve(paragraphs: string[], targetCount: number): string[] {
  if (paragraphs.length >= targetCount) return paragraphs
  
  const result: string[] = []
  const neededSplits = targetCount - paragraphs.length
  
  // 長い段落から順に分割対象を選ぶ
  const sortedByLength = [...paragraphs].sort((a, b) => b.length - a.length)
  const toSplit = new Set(sortedByLength.slice(0, neededSplits).map(p => paragraphs.indexOf(p)))
  
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]
    
    if (toSplit.has(i) && p.length > 100) {
      // 文境界（。！？）で分割（原文を変えない）
      const sentences = p.split(/(?<=[。！？])/g).filter(s => s.length > 0)
      if (sentences.length >= 2) {
        const mid = Math.ceil(sentences.length / 2)
        // join時に余計な文字を追加しない
        result.push(sentences.slice(0, mid).join(''))
        result.push(sentences.slice(mid).join(''))
      } else {
        result.push(p)
      }
    } else {
      result.push(p)
    }
  }
  
  return result.slice(0, targetCount)
}

/**
 * テキストから image_prompt を生成（簡易版）
 */
async function generateImagePromptFromText(
  text: string,
  projectTitle: string,
  apiKey: string
): Promise<string> {
  try {
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
            content: 'Generate a concise English image prompt (30-200 chars) for an infographic video scene. Focus on visual elements that represent the text content. Output only the prompt, no explanation.'
          },
          {
            role: 'user',
            content: `Project: ${projectTitle}\nText: ${text}`
          }
        ],
        max_tokens: 100,
        temperature: 0.7
      })
    })
    
    if (!response.ok) {
      console.error('Image prompt generation failed:', response.status)
      return 'Abstract digital illustration representing the concept'
    }
    
    const result = await response.json() as any
    return result.choices?.[0]?.message?.content?.trim() || 'Abstract digital illustration'
  } catch (error) {
    console.error('Image prompt generation error:', error)
    return 'Abstract digital illustration representing the concept'
  }
}

/**
 * 自動merge実行（全chunk完了時）
 */
async function autoMergeScenes(c: any, projectId: string, stats: any) {
  try {
    // 1. scenes取得（tempIdx順）
    const { results: scenes } = await c.env.DB.prepare(`
      SELECT id, idx, role, chunk_id
      FROM scenes
      WHERE project_id = ?
      ORDER BY idx ASC
    `).bind(projectId).all()

    if (scenes.length === 0) {
      // scene無し → formatted_with_errors
      await c.env.DB.prepare(`
        UPDATE projects
        SET status = 'formatted', error_message = 'No scenes generated',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(projectId).run()

      return c.json({
        project_id: parseInt(projectId),
        status: 'formatted',
        total_scenes: 0,
        chunk_stats: stats,
        message: 'All chunks processed but no scenes generated'
      }, 200)
    }

    // 2. idx正規化 & role最小整形
    const updateStatements = []

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]
      const newIdx = i + 1
      let newRole = scene.role

      // 先頭scene → hook
      if (i === 0 && scene.role !== 'hook') {
        newRole = 'hook'
      }

      // 末尾scene → summary or cta
      if (i === scenes.length - 1) {
        if (scene.role !== 'summary' && scene.role !== 'cta') {
          newRole = 'summary'
        }
      }

      updateStatements.push(
        c.env.DB.prepare(`
          UPDATE scenes
          SET idx = ?, role = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(newIdx, newRole, scene.id)
      )
    }

    // Batch実行
    await c.env.DB.batch(updateStatements)

    // 3. projects.status更新
    await c.env.DB.prepare(`
      UPDATE projects
      SET status = 'formatted', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(projectId).run()

    // Phase X-2: Auto-assign characters (non-blocking, best-effort)
    // ✅ Runs asynchronously to avoid blocking response
    // ✅ Failures do not affect 'formatted' status
    try {
      const { autoAssignCharactersToScenes } = await import('../utils/character-auto-assign');
      const { extractAndUpdateCharacterTraits } = await import('../utils/character-trait-extractor');
      
      c.executionCtx.waitUntil(
        (async () => {
          // Step 1: Auto-assign characters to scenes
          const assignResult = await autoAssignCharactersToScenes(c.env.DB, parseInt(projectId));
          console.log(`[Phase X-2] Auto-assigned ${assignResult.assigned} characters to ${assignResult.scenes} scenes (project ${projectId})`);
          
          // Step 2: Extract and update character traits from scene dialogues
          // Phase X-3: This ensures visual consistency across all scenes
          const traitResult = await extractAndUpdateCharacterTraits(c.env.DB, parseInt(projectId));
          console.log(`[Phase X-3] Extracted traits for ${traitResult.updated} characters: ${traitResult.characters.join(', ')}`);
        })()
          .catch(err => {
            console.error(`[Phase X-2/X-3] Character processing failed for project ${projectId}:`, err.message);
          })
      );
    } catch (err) {
      console.warn(`[Phase X-2] Auto-assign skipped for project ${projectId}:`, err);
    }

    // 4. 結果返却
    return c.json({
      project_id: parseInt(projectId),
      status: 'formatted',
      total_scenes: scenes.length,
      merged: true,
      chunk_stats: stats,
      message: stats.failed > 0
        ? `All chunks processed (${stats.failed} failed), ${scenes.length} scenes merged`
        : `All chunks processed successfully, ${scenes.length} scenes merged`
    }, 200)

  } catch (error) {
    console.error('Auto merge failed:', error)

    // merge失敗でもformattingは継続
    await c.env.DB.prepare(`
      UPDATE projects
      SET error_message = 'Auto merge failed',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(projectId).run()

    return c.json({
      error: {
        code: 'MERGE_FAILED',
        message: 'Failed to merge scenes automatically'
      }
    }, 500)
  }
}

/**
 * OpenAI Chat API を使って MiniScene を生成（AI整理モード、省略なし）
 * @param targetSceneCount 目標シーン数（プロジェクト全体での目標、chunkごとに按分）
 */
async function generateMiniScenesAI(
  chunkText: string,
  projectTitle: string,
  chunkIdx: number,
  apiKey: string,
  targetSceneCount: number = 5
): Promise<{
  success: boolean
  scenes?: any[]
  error?: string
}> {
  // 第1回目の生成試行
  const firstAttempt = await generateMiniScenesWithSchemaAI(chunkText, projectTitle, chunkIdx, apiKey, 0.7, targetSceneCount)
  if (firstAttempt.success) {
    return firstAttempt
  }

  console.warn('First attempt failed, retrying with lower temperature...', firstAttempt.error)

  // 第2回目の生成試行（temperature 下げ）
  const secondAttempt = await generateMiniScenesWithSchemaAI(chunkText, projectTitle, chunkIdx, apiKey, 0.3, targetSceneCount)
  if (secondAttempt.success) {
    return secondAttempt
  }

  console.warn('Second attempt failed, trying repair call...', secondAttempt.error)

  // 第3回目：Repair call（フォーマット修正のみ）
  const repairAttempt = await repairMiniScenes(firstAttempt.rawContent || '', apiKey)
  if (repairAttempt.success) {
    return repairAttempt
  }

  // すべて失敗
  return {
    success: false,
    error: `All generation attempts failed. Last error: ${repairAttempt.error}`
  }
}

/**
 * OpenAI Chat API を使ってRILARCシナリオを生成（音声入力用・従来フロー）
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
  // 第1回目の生成試行
  const firstAttempt = await generateWithSchema(rawText, projectTitle, apiKey, 0.7)
  if (firstAttempt.success) {
    return firstAttempt
  }

  console.warn('First attempt failed, retrying with lower temperature...', firstAttempt.error)

  // 第2回目の生成試行（temperature 下げ）
  const secondAttempt = await generateWithSchema(rawText, projectTitle, apiKey, 0.3)
  if (secondAttempt.success) {
    return secondAttempt
  }

  console.warn('Second attempt failed, trying repair call...', secondAttempt.error)

  // 第3回目：Repair call（フォーマット修正のみ、temperature 0.1）
  const repairAttempt = await repairScenarioFormat(firstAttempt.rawContent || '', apiKey)
  if (repairAttempt.success) {
    return repairAttempt
  }

  // すべて失敗
  return {
    success: false,
    error: `All generation attempts failed. Last error: ${repairAttempt.error}`
  }
}

/**
 * MiniScene生成（AI整理モード、省略なし、文字数緩和）
 * @param targetSceneCount 目標シーン数参考用
 */
async function generateMiniScenesWithSchemaAI(
  chunkText: string,
  projectTitle: string,
  chunkIdx: number,
  apiKey: string,
  temperature: number,
  targetSceneCount: number = 5
): Promise<{
  success: boolean
  scenes?: any[]
  error?: string
  rawContent?: string
}> {
  try {
    // AI整理モード: 省略を極力避ける指示を追加
    const systemPrompt = `あなたは動画シナリオ作成の専門家です。
提供された文章断片から、1-5個のシーンを生成してください。

【最重要: 省略禁止】
- **元の文章の内容を省略しないでください**
- 元の表現・言い回しをできるだけ残してください
- 要約ではなく、元の文章を構造化してください
- 情報を削除せず、適切なシーンに分配してください

【ルール】
1. シーン数は **1〜5 個**（文章の長さに応じて調整、長い場合は多く）
2. 各シーンの dialogue は **30〜500 文字**（元の文章を維持するため緩和）
3. 各シーンの bullets は **2〜3 個**、各 5〜40 文字
4. 各シーンの title は **5〜50 文字**
5. 各シーンの image_prompt は **30〜400 文字**（英語推奨、具体的に描写）
6. role は以下のいずれか: hook, context, main_point, evidence, timeline, analysis, summary, cta
7. speech_type は **必ず判定**:
   - "dialogue": キャラクターが話す台詞（「」で囲まれた発言、直接話法）
   - "narration": ナレーション、説明文、状況描写、第三者視点の語り

【speech_type の判定基準】
- 文章が「」や『』で囲まれた発言 → dialogue
- 「〜と言った」「〜と告げる」などの引用 → dialogue
- 状況説明、背景描写、解説 → narration
- 視聴者への直接的な語りかけ → narration
- 迷った場合は narration を選択

【role の使い方】
- hook: 視聴者の興味を引くオープニング
- context: 背景情報、前提知識
- main_point: 最も重要な論点・主張
- evidence: データ、事実、引用
- timeline: 経緯、歴史的流れ
- analysis: 深掘り、解釈、意味づけ
- summary: 重要ポイントの振り返り
- cta: 視聴者への呼びかけ、次のアクション

注意：idx、metadata は不要。シーン配列のみを返してください。`

    const userPrompt = `以下の文章断片からシーンを生成してください。
**元の文章の内容を省略せず、できるだけ原文を活かしてください。**

【プロジェクトタイトル】
${projectTitle}

【文章断片 (Part ${chunkIdx})】
${chunkText}

上記の文章を元に、視聴者にとって魅力的で分かりやすいニュース風インフォグラフィック動画のシーンを作成してください。
情報を省略せず、適切に複数シーンに分割してください。`

    // JSON Schema for MiniScenes (1-5 scenes, 文字数緩和)
    const jsonSchema = {
      type: 'object',
      properties: {
        scenes: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                enum: ['hook', 'context', 'main_point', 'evidence', 'timeline', 'analysis', 'summary', 'cta']
              },
              title: { type: 'string', minLength: 5, maxLength: 50 },
              dialogue: { type: 'string', minLength: 30, maxLength: 500 }, // 緩和: 30-500文字
              speech_type: {
                type: 'string',
                enum: ['dialogue', 'narration'],
                description: 'dialogue=キャラクターの台詞, narration=ナレーション・説明'
              },
              bullets: {
                type: 'array',
                minItems: 2,
                maxItems: 3,
                items: { type: 'string', minLength: 5, maxLength: 40 } // 緩和: 5-40文字
              },
              image_prompt: { type: 'string', minLength: 30, maxLength: 400 }
            },
            required: ['role', 'title', 'dialogue', 'speech_type', 'bullets', 'image_prompt'],
            additionalProperties: false
          }
        }
      },
      required: ['scenes'],
      additionalProperties: false
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-2024-08-06',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'mini_scenes',
            strict: true,
            schema: jsonSchema
          }
        },
        temperature
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
      const data = JSON.parse(content)
      return {
        success: true,
        scenes: data.scenes || [],
        rawContent: content
      }
    } catch (parseError) {
      console.error('Failed to parse JSON:', parseError)
      return {
        success: false,
        error: 'Generated content is not valid JSON',
        rawContent: content
      }
    }

  } catch (error) {
    console.error('Error generating mini scenes:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * MiniScene Repair call
 */
async function repairMiniScenes(
  brokenJson: string,
  apiKey: string
): Promise<{
  success: boolean
  scenes?: any[]
  error?: string
}> {
  if (!brokenJson) {
    return {
      success: false,
      error: 'No content to repair'
    }
  }

  try {
    const systemPrompt = `あなたはJSON修復の専門家です。
与えられたシーンJSONを、スキーマに厳密に適合するよう修正してください。

【修正ルール】
- シーン数は 1-3 個
- dialogue は 60〜140 文字
- speech_type は "dialogue"（台詞）または "narration"（ナレーション）
- bullets は 2〜3 個、各 8〜24 文字
- title は 10〜40 文字
- image_prompt は 30〜400 文字
- 全フィールド必須

内容を変えず、フォーマットのみ修正してください。speech_typeがない場合は内容から推測してください。`

    const userPrompt = `以下のJSONを修正してください：

${brokenJson}`

    const jsonSchema = {
      type: 'object',
      properties: {
        scenes: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                enum: ['hook', 'context', 'main_point', 'evidence', 'timeline', 'analysis', 'summary', 'cta']
              },
              title: { type: 'string', minLength: 10, maxLength: 40 },
              dialogue: { type: 'string', minLength: 60, maxLength: 140 },
              speech_type: {
                type: 'string',
                enum: ['dialogue', 'narration']
              },
              bullets: {
                type: 'array',
                minItems: 2,
                maxItems: 3,
                items: { type: 'string', minLength: 8, maxLength: 24 }
              },
              image_prompt: { type: 'string', minLength: 30, maxLength: 400 }
            },
            required: ['role', 'title', 'dialogue', 'speech_type', 'bullets', 'image_prompt'],
            additionalProperties: false
          }
        }
      },
      required: ['scenes'],
      additionalProperties: false
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-2024-08-06',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'mini_scenes_repaired',
            strict: true,
            schema: jsonSchema
          }
        },
        temperature: 0.1
      })
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const errorMessage = errorData.error?.message || `Repair API error: ${response.status}`
      console.error('OpenAI Repair API error:', errorMessage)
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
        error: 'No content in repair API response'
      }
    }

    const data = JSON.parse(content)
    return {
      success: true,
      scenes: data.scenes || []
    }

  } catch (error) {
    console.error('Error repairing mini scenes:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown repair error'
    }
  }
}

/**
 * JSON Schema (strict:true) を使った生成（音声入力用・全文一括）
 */
async function generateWithSchema(
  rawText: string,
  projectTitle: string,
  apiKey: string,
  temperature: number
): Promise<{
  success: boolean
  scenario?: any
  error?: string
  rawContent?: string
}> {
  try {
    const systemPrompt = `あなたは動画シナリオ作成の専門家です。
提供された文字起こしテキストを、RILARCシナリオ形式（JSON）に変換してください。

【厳守ルール】
1. version は "1.0" 固定
2. シーン数は 3〜50 個
3. 各シーンの dialogue は **60〜140 文字**（簡潔かつ明瞭に）
4. 各シーンの bullets は **2〜3 個**、各 8〜24 文字
5. 各シーンの title は **10〜40 文字**
6. 各シーンの image_prompt は **30〜400 文字**（英語推奨、具体的に描写）
7. role は以下のいずれか: hook, context, main_point, evidence, timeline, analysis, summary, cta
8. idx は 1 から連番（欠番なし）
9. metadata.total_scenes は scenes.length と一致させること
10. speech_type は **必ず判定**:
    - "dialogue": キャラクターが話す台詞（「」で囲まれた発言、直接話法）
    - "narration": ナレーション、説明文、状況描写、第三者視点の語り

【speech_type の判定基準】
- 文章が「」や『』で囲まれた発言 → dialogue
- 「〜と言った」「〜と告げる」などの引用 → dialogue
- 状況説明、背景描写、解説 → narration
- 視聴者への直接的な語りかけ → narration
- 迷った場合は narration を選択

【role の使い方】
- hook: 視聴者の興味を引くオープニング
- context: 背景情報、前提知識
- main_point: 最も重要な論点・主張
- evidence: データ、事実、引用
- timeline: 経緯、歴史的流れ
- analysis: 深掘り、解釈、意味づけ
- summary: 重要ポイントの振り返り
- cta: 視聴者への呼びかけ、次のアクション`

    const userPrompt = `以下の文字起こしテキストをRILARCシナリオに変換してください。

【プロジェクトタイトル】
${projectTitle}

【文字起こしテキスト】
${rawText}

上記のテキストを元に、視聴者にとって魅力的で分かりやすいニュース風インフォグラフィック動画のシナリオを作成してください。`

    // JSON Schema (strict:true)
    const jsonSchema = {
      type: 'object',
      properties: {
        version: {
          type: 'string',
          enum: ['1.0']
        },
        metadata: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 100 },
            total_scenes: { type: 'integer', minimum: 3, maximum: 50 },
            estimated_duration_seconds: { type: 'integer', minimum: 30 }
          },
          required: ['title', 'total_scenes', 'estimated_duration_seconds'],
          additionalProperties: false
        },
        scenes: {
          type: 'array',
          minItems: 3,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              idx: { type: 'integer', minimum: 1 },
              role: {
                type: 'string',
                enum: ['hook', 'context', 'main_point', 'evidence', 'timeline', 'analysis', 'summary', 'cta']
              },
              title: { type: 'string', minLength: 1, maxLength: 50 },
              dialogue: { type: 'string', minLength: 60, maxLength: 140 },
              speech_type: {
                type: 'string',
                enum: ['dialogue', 'narration']
              },
              bullets: {
                type: 'array',
                minItems: 2,
                maxItems: 3,
                items: { type: 'string', minLength: 8, maxLength: 24 }
              },
              image_prompt: { type: 'string', minLength: 30, maxLength: 400 }
            },
            required: ['idx', 'role', 'title', 'dialogue', 'speech_type', 'bullets', 'image_prompt'],
            additionalProperties: false
          }
        }
      },
      required: ['version', 'metadata', 'scenes'],
      additionalProperties: false
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-2024-08-06',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'rilarc_scenario_v1',
            strict: true,
            schema: jsonSchema
          }
        },
        temperature
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
        scenario,
        rawContent: content
      }
    } catch (parseError) {
      console.error('Failed to parse JSON:', parseError)
      return {
        success: false,
        error: 'Generated content is not valid JSON',
        rawContent: content
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

/**
 * Repair call: 既存のJSON（フォーマット不備）を修正する
 */
async function repairScenarioFormat(
  brokenJson: string,
  apiKey: string
): Promise<{
  success: boolean
  scenario?: any
  error?: string
}> {
  if (!brokenJson) {
    return {
      success: false,
      error: 'No content to repair'
    }
  }

  try {
    const systemPrompt = `あなたはJSON修復の専門家です。
与えられたRILARCシナリオJSONを、スキーマに厳密に適合するよう修正してください。

【修正ルール】
- dialogue は 60〜140 文字（短すぎる場合は補完、長すぎる場合は短縮）
- speech_type は "dialogue"（台詞）または "narration"（ナレーション）
- bullets は 2〜3 個、各 8〜24 文字
- title は 10〜40 文字
- image_prompt は 30〜400 文字
- 全フィールド必須
- idx は連番
- metadata.total_scenes は scenes.length と一致

内容を変えず、フォーマットのみ修正してください。speech_typeがない場合は内容から推測してください。`

    const userPrompt = `以下のJSONを修正してください：

${brokenJson}`

    const jsonSchema = {
      type: 'object',
      properties: {
        version: { type: 'string', enum: ['1.0'] },
        metadata: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 100 },
            total_scenes: { type: 'integer', minimum: 3, maximum: 50 },
            estimated_duration_seconds: { type: 'integer', minimum: 30 }
          },
          required: ['title', 'total_scenes', 'estimated_duration_seconds'],
          additionalProperties: false
        },
        scenes: {
          type: 'array',
          minItems: 3,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              idx: { type: 'integer', minimum: 1 },
              role: {
                type: 'string',
                enum: ['hook', 'context', 'main_point', 'evidence', 'timeline', 'analysis', 'summary', 'cta']
              },
              title: { type: 'string', minLength: 1, maxLength: 50 },
              dialogue: { type: 'string', minLength: 60, maxLength: 140 },
              speech_type: {
                type: 'string',
                enum: ['dialogue', 'narration']
              },
              bullets: {
                type: 'array',
                minItems: 2,
                maxItems: 3,
                items: { type: 'string', minLength: 8, maxLength: 24 }
              },
              image_prompt: { type: 'string', minLength: 30, maxLength: 400 }
            },
            required: ['idx', 'role', 'title', 'dialogue', 'speech_type', 'bullets', 'image_prompt'],
            additionalProperties: false
          }
        }
      },
      required: ['version', 'metadata', 'scenes'],
      additionalProperties: false
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-2024-08-06',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'rilarc_scenario_v1_repaired',
            strict: true,
            schema: jsonSchema
          }
        },
        temperature: 0.1
      })
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const errorMessage = errorData.error?.message || `Repair API error: ${response.status}`
      console.error('OpenAI Repair API error:', errorMessage)
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
        error: 'No content in repair API response'
      }
    }

    const scenario = JSON.parse(content)
    return {
      success: true,
      scenario
    }

  } catch (error) {
    console.error('Error repairing RILARC scenario:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown repair error'
    }
  }
}

export default formatting
