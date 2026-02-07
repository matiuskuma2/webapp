import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Bindings } from '../types/bindings'
import { logAudit } from '../utils/audit-logger'
import { getUserFromSession, validateProjectAccess } from '../utils/auth-helper'

const projects = new Hono<{ Bindings: Bindings }>()

// =============================================================================
// Scene Motion Column Compatibility Layer
// =============================================================================
// 本番DBと開発DBでscene_motionテーブルのカラム名が異なる可能性があるため、
// 実行時にカラム名を検出して互換性を確保する
//
// 可能なカラム名:
// - 'preset' (migration 0026)
// - 'motion_preset_id' (旧スキーマ/別環境)
// - null (テーブルが存在しない)
// =============================================================================

type MotionPresetColumnName = 'preset' | 'motion_preset_id' | null;

// リクエスト内キャッシュ用のWeakMap (Cloudflare Workersではリクエストごとにリセット)
const motionColumnCache = new Map<string, MotionPresetColumnName>();

/**
 * scene_motion テーブルのプリセットカラム名を検出
 * @param db D1Database instance
 * @returns カラム名 ('preset' | 'motion_preset_id') または null (テーブル/カラムなし)
 */
async function detectMotionPresetColumn(db: D1Database): Promise<MotionPresetColumnName> {
  // キャッシュチェック (同一リクエスト内での重複検出を防止)
  const cacheKey = 'motion_preset_column';
  if (motionColumnCache.has(cacheKey)) {
    return motionColumnCache.get(cacheKey)!;
  }

  try {
    const { results } = await db.prepare(`PRAGMA table_info(scene_motion)`).all<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>();

    const columnNames = new Set(results.map(r => r.name));
    
    let detectedColumn: MotionPresetColumnName = null;
    if (columnNames.has('preset')) {
      detectedColumn = 'preset';
    } else if (columnNames.has('motion_preset_id')) {
      detectedColumn = 'motion_preset_id';
    }

    // 検出結果をログ (1回のみ)
    console.log(`[MotionPresetColumn] Detected: ${detectedColumn ?? 'none'} (available: ${Array.from(columnNames).join(', ')})`);
    
    motionColumnCache.set(cacheKey, detectedColumn);
    return detectedColumn;
  } catch (error) {
    // テーブルが存在しない場合など
    console.warn(`[MotionPresetColumn] Failed to detect:`, error);
    motionColumnCache.set(cacheKey, null);
    return null;
  }
}

/**
 * シーンのモーションプリセットを取得
 * @param db D1Database instance
 * @param sceneId シーンID
 * @param defaultPreset デフォルト値
 * @returns プリセット名
 */
async function fetchMotionPreset(
  db: D1Database, 
  sceneId: number, 
  defaultPreset: string
): Promise<string> {
  const column = await detectMotionPresetColumn(db);
  
  if (!column) {
    // カラムが存在しない場合はデフォルト値を返す
    return defaultPreset;
  }

  try {
    // カラム名を動的に使用 (SQLインジェクション対策: 検証済みの値のみ使用)
    const query = `SELECT ${column} as preset_value FROM scene_motion WHERE scene_id = ?`;
    const row = await db.prepare(query).bind(sceneId).first<{ preset_value: string }>();
    return row?.preset_value ?? defaultPreset;
  } catch (error) {
    console.warn(`[fetchMotionPreset] Failed for scene ${sceneId}:`, error);
    return defaultPreset;
  }
}

// POST /api/projects - プロジェクト作成
projects.post('/', async (c) => {
  try {
    const { getCookie } = await import('hono/cookie')
    const { title } = await c.req.json()

    if (!title || title.trim() === '') {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Title is required',
          details: {
            field: 'title',
            constraint: 'required'
          }
        }
      }, 400)
    }

    // セッションからuser_idを取得
    let userId: number | null = null
    const sessionId = getCookie(c, 'session')
    if (sessionId) {
      const session = await c.env.DB.prepare(`
        SELECT user_id FROM sessions WHERE id = ? AND expires_at > datetime('now')
      `).bind(sessionId).first<{ user_id: number }>()
      userId = session?.user_id || null
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO projects (title, status, user_id) 
      VALUES (?, 'created', ?)
    `).bind(title.trim(), userId).run()

    const projectId = result.meta.last_row_id as number

    // Set default style preset to "インフォグラフィック" (ID=9)
    // Query to find "インフォグラフィック" style preset
    const defaultStyle = await c.env.DB.prepare(`
      SELECT id FROM style_presets 
      WHERE name = 'インフォグラフィック' AND is_active = 1
      LIMIT 1
    `).first()

    if (defaultStyle) {
      await c.env.DB.prepare(`
        INSERT INTO project_style_settings (project_id, default_style_preset_id)
        VALUES (?, ?)
      `).bind(projectId, defaultStyle.id).run()
    }

    // Phase B-2: Auto-create Run #1 for new project
    const runResult = await c.env.DB.prepare(`
      INSERT INTO runs (project_id, run_no, state, title, source_type)
      VALUES (?, 1, 'draft', 'Run #1', 'text')
    `).bind(projectId).run()

    const runId = runResult.meta.last_row_id as number

    const project = await c.env.DB.prepare(`
      SELECT id, title, status, created_at
      FROM projects
      WHERE id = ?
    `).bind(projectId).first()

    return c.json({
      ...project,
      run_id: runId
    }, 201)
  } catch (error) {
    console.error('Error creating project:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create project'
      }
    }, 500)
  }
})

// POST /api/projects/:id/upload - 音声アップロード
projects.post('/:id/upload', async (c) => {
  try {
    const projectId = c.req.param('id')

    // プロジェクト存在確認
    const project = await c.env.DB.prepare(`
      SELECT id, status FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // ファイル取得
    const formData = await c.req.formData()
    const audioFile = formData.get('audio') as File

    if (!audioFile) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Audio file is required',
          details: {
            field: 'audio',
            constraint: 'required'
          }
        }
      }, 400)
    }

    // ファイル形式チェック
    const allowedExtensions = ['.mp3', '.wav', '.m4a', '.ogg', '.webm']
    const fileName = audioFile.name.toLowerCase()
    const isValidFormat = allowedExtensions.some(ext => fileName.endsWith(ext))

    if (!isValidFormat) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid file format. Supported formats: MP3, WAV, M4A, OGG, WebM',
          details: {
            field: 'audio',
            constraint: 'format',
            allowed: allowedExtensions
          }
        }
      }, 400)
    }

    // ファイルサイズチェック (25MB)
    const maxSize = 25 * 1024 * 1024
    if (audioFile.size > maxSize) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'File size exceeds 25MB limit',
          details: {
            field: 'audio',
            constraint: 'size',
            maxSize: maxSize,
            actualSize: audioFile.size
          }
        }
      }, 400)
    }

    // R2キー生成: audio/{project_id}/{filename}_{timestamp}_{random}.{ext}
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(7)
    const extension = fileName.substring(fileName.lastIndexOf('.'))
    const cleanFileName = fileName.substring(0, fileName.lastIndexOf('.')).replace(/[^a-zA-Z0-9_-]/g, '_')
    const r2Key = `audio/${projectId}/${cleanFileName}_${timestamp}_${random}${extension}`

    // R2にアップロード
    await c.env.R2.put(r2Key, audioFile.stream(), {
      httpMetadata: {
        contentType: audioFile.type
      }
    })

    // ⚠️ FIX: 音声アップロード時も古いシーンを**先に**削除（データ不整合防止）
    const existingScenes = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM scenes WHERE project_id = ?
    `).bind(projectId).first<{ count: number }>()
    
    if (existingScenes && existingScenes.count > 0) {
      // Split由来シーンのみ削除（手動追加シーン chunk_id=NULL は保護）
      // ⚠️ 手動追加シーンはユーザー資産なので巻き込まない
      console.log(`[UploadAudio] Deleting split-based scenes for project ${projectId} BEFORE status update`)
      await c.env.DB.prepare(`DELETE FROM image_generations WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ? AND chunk_id IS NOT NULL)`).bind(projectId).run()
      await c.env.DB.prepare(`DELETE FROM utterances WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ? AND chunk_id IS NOT NULL)`).bind(projectId).run()
      await c.env.DB.prepare(`DELETE FROM scenes WHERE project_id = ? AND chunk_id IS NOT NULL`).bind(projectId).run()
    }

    // DB更新 (CRITICAL: source_type='audio' must be set for proper flow detection)
    await c.env.DB.prepare(`
      UPDATE projects
      SET audio_r2_key = ?,
          audio_filename = ?,
          audio_size_bytes = ?,
          source_type = 'audio',
          status = 'uploaded',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(r2Key, audioFile.name, audioFile.size, projectId).run()

    // 更新後のプロジェクト取得
    const updatedProject = await c.env.DB.prepare(`
      SELECT id, title, status, audio_filename, audio_size_bytes, audio_r2_key, updated_at
      FROM projects
      WHERE id = ?
    `).bind(projectId).first()

    return c.json(updatedProject, 200)
  } catch (error) {
    console.error('Error uploading audio:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to upload audio file'
      }
    }, 500)
  }
})

// GET /api/projects - プロジェクト一覧
projects.get('/', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(`
      SELECT id, title, status, audio_filename, audio_r2_key, audio_size_bytes, created_at, updated_at
      FROM projects
      ORDER BY created_at DESC
    `).all()

    return c.json({ projects: results })
  } catch (error) {
    console.error('Error fetching projects:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch projects'
      }
    }, 500)
  }
})

// GET /api/projects/:id - プロジェクト詳細
// SSOT: split_mode / target_scene_count を含める（Scene Split UI用）
projects.get('/:id', async (c) => {
  try {
    const projectId = c.req.param('id')

    const project = await c.env.DB.prepare(`
      SELECT 
        p.id,
        p.title,
        p.status,
        p.source_type,
        p.source_text,
        p.audio_filename,
        p.audio_size_bytes,
        p.audio_duration_seconds,
        p.audio_r2_key,
        p.output_preset,
        p.split_mode,
        p.target_scene_count,
        p.settings_json,
        p.created_at,
        p.updated_at,
        p.source_updated_at
      FROM projects p
      WHERE p.id = ?
    `).bind(projectId).first<{
      id: number;
      title: string;
      status: string;
      source_type: string | null;
      source_text: string | null;
      audio_filename: string | null;
      audio_size_bytes: number | null;
      audio_duration_seconds: number | null;
      audio_r2_key: string | null;
      output_preset: string | null;
      split_mode: string | null;
      target_scene_count: number | null;
      settings_json: string | null;
      created_at: string;
      updated_at: string;
      source_updated_at: string | null;
    }>()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // ========================================
    // ⚠️ BUG FIX: 不整合状態の自動修正
    // - text_chunks が全て完了（done>0, pending=0, processing=0）
    // - かつ scenes が存在する
    // - かつ projects.status が 'uploaded' または 'formatting' のまま
    // → status を 'formatted' に自動更新
    // ========================================
    if (['uploaded', 'formatting'].includes(project.status)) {
      const chunkStats = await c.env.DB.prepare(`
        SELECT 
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
          COUNT(*) as total
        FROM text_chunks WHERE project_id = ?
      `).bind(projectId).first<{ done: number; pending: number; processing: number; total: number }>()
      
      if (chunkStats && chunkStats.total > 0 && chunkStats.done > 0 && 
          chunkStats.pending === 0 && chunkStats.processing === 0) {
        const sceneCount = await c.env.DB.prepare(`
          SELECT COUNT(*) as count FROM scenes WHERE project_id = ?
        `).bind(projectId).first<{ count: number }>()
        
        if (sceneCount && sceneCount.count > 0) {
          console.log(`[Projects/:id] Auto-fixing inconsistent state for project ${projectId}: ` +
            `status='${project.status}' but ${chunkStats.done} chunks done and ${sceneCount.count} scenes exist`)
          
          await c.env.DB.prepare(`
            UPDATE projects SET status = 'formatted', updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `).bind(projectId).run()
          
          project.status = 'formatted'
          console.log(`[Projects/:id] Project ${projectId} status auto-fixed to 'formatted'`)
        }
      }
    }

    // SSOT: split_mode のノーマライズ（preserve → raw、未設定 → null）
    // Phase 2-1: settings_json をパースして返す（telops_comic などを含む）
    let settingsParsed: Record<string, unknown> = {};
    if (project.settings_json) {
      try {
        settingsParsed = JSON.parse(project.settings_json);
      } catch { /* ignore parse errors */ }
    }
    
    const normalizedProject = {
      ...project,
      split_mode: project.split_mode === 'preserve' ? 'raw' : (project.split_mode || null),
      target_scene_count: project.target_scene_count || null,
      // settings_json を文字列ではなくオブジェクトとして返す
      settings: settingsParsed,
    };
    // 重複を避けるため settings_json 文字列は削除
    delete (normalizedProject as Record<string, unknown>).settings_json;

    return c.json(normalizedProject)
  } catch (error) {
    console.error('Error fetching project:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch project'
      }
    }, 500)
  }
})

// POST /api/projects/:id/source/text - テキスト入力保存
projects.post('/:id/source/text', async (c) => {
  try {
    const projectId = c.req.param('id')
    const { text } = await c.req.json()

    // プロジェクト存在確認
    const project = await c.env.DB.prepare(`
      SELECT id FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // バリデーション
    if (!text || text.trim() === '') {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Text is required',
          details: {
            field: 'text',
            constraint: 'required'
          }
        }
      }, 400)
    }

    // ⚠️ FIX: ソース更新時は古いシーンを**先に**削除（データ不整合防止）
    // シーンが存在する状態で status='uploaded' になるとUIが混乱する
    // 順序: 1) シーン削除 → 2) ステータス更新（これで不整合が発生しない）
    const existingScenes = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM scenes WHERE project_id = ?
    `).bind(projectId).first<{ count: number }>()
    
    if (existingScenes && existingScenes.count > 0) {
      // Split由来シーンのみ削除（手動追加シーン chunk_id=NULL は保護）
      // ⚠️ 手動追加シーンはユーザー資産なので巻き込まない
      console.log(`[SaveSourceText] Deleting split-based scenes for project ${projectId} BEFORE status update`)
      // 関連データも削除（外部キー制約がないため手動で）
      await c.env.DB.prepare(`DELETE FROM image_generations WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ? AND chunk_id IS NOT NULL)`).bind(projectId).run()
      await c.env.DB.prepare(`DELETE FROM utterances WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ? AND chunk_id IS NOT NULL)`).bind(projectId).run()
      await c.env.DB.prepare(`DELETE FROM scenes WHERE project_id = ? AND chunk_id IS NOT NULL`).bind(projectId).run()
    }

    // テキスト保存（uploadedステータスに変更）
    await c.env.DB.prepare(`
      UPDATE projects
      SET source_type = 'text',
          source_text = ?,
          status = 'uploaded',
          source_updated_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(text.trim(), projectId).run()

    // 監査ログ: source_text.replace イベント（Split由来削除が発生した場合）
    if (existingScenes && existingScenes.count > 0) {
      const sessionId = getCookie(c, 'session');
      let userId: number | null = null;
      let userRole: string | null = null;
      if (sessionId) {
        const session = await c.env.DB.prepare(`
          SELECT u.id, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?
        `).bind(sessionId).first<{ id: number; role: string }>();
        if (session) {
          userId = session.id;
          userRole = session.role;
        }
      }
      await logAudit({
        db: c.env.DB,
        userId,
        userRole,
        entityType: 'project',
        entityId: parseInt(projectId),
        projectId: parseInt(projectId),
        action: 'source_text.replace',
        details: { 
          deleted_scenes_count: existingScenes.count,
          note: 'Split-based scenes deleted (chunk_id IS NOT NULL), manual scenes preserved'
        }
      });
    }

    // 更新後のプロジェクト取得
    const updatedProject = await c.env.DB.prepare(`
      SELECT id, title, status, source_type, source_updated_at, updated_at
      FROM projects
      WHERE id = ?
    `).bind(projectId).first()

    return c.json(updatedProject, 200)
  } catch (error) {
    console.error('Error saving source text:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to save source text'
      }
    }, 500)
  }
})

// GET /api/projects/:id/scenes - シーン一覧取得（idx順）
// Query params: ?view=edit (軽量版、画像情報なし), ?view=board (Builder用、最小画像情報)
projects.get('/:id/scenes', async (c) => {
  try {
    const projectId = c.req.param('id')
    const view = c.req.query('view') || 'full' // デフォルトは完全版（後方互換）

    // プロジェクト存在確認
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

    // シーン一覧取得（idx順、スタイル設定含む）
    // Phase1.7: display_asset_type, comic_data を追加
    // Phase X-3: speech_type を追加
    // R3: duration_override_ms を追加
    // ⚠️ is_hidden = 0 で非表示シーンを除外（ソフトデリート対応）
    const { results: scenes } = await c.env.DB.prepare(`
      SELECT 
        s.id, s.idx, s.role, s.title, s.dialogue, s.speech_type, s.bullets, s.image_prompt, 
        s.chunk_id, s.created_at, s.updated_at, s.display_asset_type, s.comic_data, s.duration_override_ms,
        sss.style_preset_id
      FROM scenes s
      LEFT JOIN scene_style_settings sss ON s.id = sss.scene_id
      WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
      ORDER BY s.idx ASC
    `).bind(projectId).all()

    // view=edit: 画像情報なし（Scene Split用、超軽量）
    if (view === 'edit') {
      return c.json({
        project_id: parseInt(projectId),
        total_scenes: scenes.length,
        scenes: scenes.map((scene: any) => {
          // Safe JSON parsing for bullets
          let bulletsParsed: any[] = []
          try {
            if (scene.bullets) {
              const parsed = JSON.parse(scene.bullets)
              bulletsParsed = Array.isArray(parsed) ? parsed : []
            }
          } catch (e) {
            bulletsParsed = []
          }
          return {
            id: scene.id,
            idx: scene.idx,
            role: scene.role,
            title: scene.title,
            dialogue: scene.dialogue || '',
            speech_type: scene.speech_type || 'narration',
            bullets: bulletsParsed,
            image_prompt: scene.image_prompt || '',
            chunk_id: scene.chunk_id
          }
        })
      })
    }

    // view=board: 最小画像情報のみ（Builder用、軽量）+ キャラクター情報
    // Phase1.7: display_asset_type と active_comic を追加
    if (view === 'board') {
      const scenesWithMinimalImages = await Promise.all(
        scenes.map(async (scene: any) => {
          // アクティブAI画像（asset_type='ai' または NULL、r2_urlが有効なもののみ）
          const activeRecord = await c.env.DB.prepare(`
            SELECT r2_key, r2_url FROM image_generations
            WHERE scene_id = ? AND is_active = 1 AND (asset_type = 'ai' OR asset_type IS NULL)
              AND r2_url IS NOT NULL AND r2_url != ''
            LIMIT 1
          `).bind(scene.id).first()

          // アクティブ漫画画像（asset_type='comic'、r2_urlが有効なもののみ）
          const activeComicRecord = await c.env.DB.prepare(`
            SELECT id, r2_key, r2_url FROM image_generations
            WHERE scene_id = ? AND is_active = 1 AND asset_type = 'comic'
              AND r2_url IS NOT NULL AND r2_url != ''
            LIMIT 1
          `).bind(scene.id).first()

          // 最新ステータス＋エラーメッセージ＋r2情報（AI画像のみ）
          const latestRecord = await c.env.DB.prepare(`
            SELECT status, r2_key, r2_url, substr(error_message, 1, 80) as error_message
            FROM image_generations
            WHERE scene_id = ? AND (asset_type = 'ai' OR asset_type IS NULL)
            ORDER BY created_at DESC
            LIMIT 1
          `).bind(scene.id).first()

          // アクティブ動画（is_active=1 または 最新の completed）
          const activeVideo = await c.env.DB.prepare(`
            SELECT id, status, r2_url, model, duration_sec
            FROM video_generations
            WHERE scene_id = ? AND (is_active = 1 OR (status = 'completed' AND r2_url IS NOT NULL))
            ORDER BY is_active DESC, created_at DESC
            LIMIT 1
          `).bind(scene.id).first()

          // comic_dataのパース
          let comicData = null
          try {
            if (scene.comic_data) {
              comicData = JSON.parse(scene.comic_data)
            }
          } catch (e) {
            console.warn(`Failed to parse comic_data for scene ${scene.id}:`, e)
          }

          // キャラクター情報取得（scene_character_map + project_character_models）
          const { results: characterMappings } = await c.env.DB.prepare(`
            SELECT 
              scm.character_key,
              scm.is_primary,
              pcm.character_name,
              pcm.voice_preset_id,
              pcm.reference_image_r2_url
            FROM scene_character_map scm
            LEFT JOIN project_character_models pcm 
              ON scm.character_key = pcm.character_key AND pcm.project_id = ?
            WHERE scm.scene_id = ?
          `).bind(projectId, scene.id).all()

          // SSOT: voice_character = is_primary=1 のキャラクター
          // voice_preset_id がなくても、is_primary=1 なら voice_character として返す
          const voiceCharacter = characterMappings.find((c: any) => c.is_primary === 1)
            || (characterMappings.length > 0 ? characterMappings[0] : null)
            || null

          // シーン別特徴（C層）取得
          const { results: sceneTraits } = await c.env.DB.prepare(`
            SELECT character_key, trait_description
            FROM scene_character_traits
            WHERE scene_id = ?
          `).bind(scene.id).all()

          // R1.6: scene_utterances の状態取得（preflight用）
          // R3-A: duration_ms 追加（音声尺の合計計算用）
          // PR-API-1: role, character_key 追加（話者サマリー用）
          const { results: utteranceRows } = await c.env.DB.prepare(`
            SELECT 
              u.id,
              u.text,
              u.role,
              u.character_key,
              u.audio_generation_id,
              ag.status as audio_status,
              ag.duration_ms
            FROM scene_utterances u
            LEFT JOIN audio_generations ag ON u.audio_generation_id = ag.id
            WHERE u.scene_id = ?
            ORDER BY u.order_no ASC
          `).bind(scene.id).all<{
            id: number;
            text: string;
            role: string;
            character_key: string | null;
            audio_generation_id: number | null;
            audio_status: string | null;
            duration_ms: number | null;
          }>()

          // R3-B: scene_audio_cues のカウント取得（SFX数）
          const sfxCountResult = await c.env.DB.prepare(`
            SELECT COUNT(*) as count
            FROM scene_audio_cues
            WHERE scene_id = ? AND is_active = 1
          `).bind(scene.id).first<{ count: number }>()
          const sfxCount = sfxCountResult?.count || 0

          // P3: SFX詳細情報取得（先頭2件のnameを含む）
          const { results: sfxDetails } = await c.env.DB.prepare(`
            SELECT name, start_ms
            FROM scene_audio_cues
            WHERE scene_id = ? AND is_active = 1
            ORDER BY start_ms ASC
            LIMIT 2
          `).bind(scene.id).all()

          // P3: シーン別BGM取得（scene_audio_assignments から）
          // 本番DBスキーマ: 
          //   scene_audio_assignments: audio_library_type, system_audio_id, user_audio_id, direct_r2_url, volume_override, loop_override
          //   system_audio_library: file_url (NOT r2_url)
          //   user_audio_library: r2_url
          const sceneBgm = await c.env.DB.prepare(`
            SELECT 
              saa.id,
              saa.audio_library_type as library_type,
              saa.volume_override as volume,
              saa.loop_override as loop,
              CASE 
                WHEN saa.audio_library_type = 'system' THEN sal.name
                WHEN saa.audio_library_type = 'user' THEN ual.name
                ELSE saa.direct_name
              END as name,
              CASE 
                WHEN saa.audio_library_type = 'system' THEN sal.file_url
                WHEN saa.audio_library_type = 'user' THEN ual.r2_url
                ELSE saa.direct_r2_url
              END as url
            FROM scene_audio_assignments saa
            LEFT JOIN system_audio_library sal ON saa.audio_library_type = 'system' AND saa.system_audio_id = sal.id
            LEFT JOIN user_audio_library ual ON saa.audio_library_type = 'user' AND saa.user_audio_id = ual.id
            WHERE saa.scene_id = ? AND saa.audio_type = 'bgm' AND saa.is_active = 1
            LIMIT 1
          `).bind(scene.id).first()

          // キャラクターの特徴情報をマージ（A/B/C層）
          // PR-API-1: character_name 追加（話者サマリー用）
          const { results: charDetails } = await c.env.DB.prepare(`
            SELECT character_key, character_name, appearance_description, story_traits
            FROM project_character_models
            WHERE project_id = ?
          `).bind(projectId).all()

          const charDetailsMap = new Map((charDetails as any[]).map((c: any) => [c.character_key, c]))
          const sceneTraitsMap = new Map((sceneTraits as any[]).map((t: any) => [t.character_key, t.trait_description]))

          // Safe JSON parsing for bullets
          let bulletsParsed: any[] = []
          try {
            if (scene.bullets) {
              const parsed = JSON.parse(scene.bullets)
              bulletsParsed = Array.isArray(parsed) ? parsed : []
            }
          } catch (e) {
            console.warn(`Failed to parse bullets for scene ${scene.id}:`, e)
            bulletsParsed = []
          }

          return {
            id: scene.id,
            idx: scene.idx,
            role: scene.role,
            title: scene.title,
            dialogue: scene.dialogue || '', // フルテキスト（詳細編集で使用）
            speech_type: scene.speech_type || 'narration',
            bullets: bulletsParsed,
            image_prompt: scene.image_prompt || '', // フルテキスト（プロンプト編集で使用）
            style_preset_id: scene.style_preset_id || null,
            // Phase1.7: display_asset_type と active_comic を追加
            display_asset_type: scene.display_asset_type || 'image',
            comic_data: comicData,
            // R3: 無音シーンの手動尺設定
            duration_override_ms: scene.duration_override_ms || null,
            active_image: activeRecord ? { 
              r2_key: activeRecord.r2_key,
              r2_url: activeRecord.r2_url,
              image_url: activeRecord.r2_url || (activeRecord.r2_key ? `/${activeRecord.r2_key}` : null) 
            } : null,
            // Phase1.7: 漫画画像情報
            active_comic: activeComicRecord ? {
              id: activeComicRecord.id,
              r2_key: activeComicRecord.r2_key,
              r2_url: activeComicRecord.r2_url,
              image_url: activeComicRecord.r2_url || (activeComicRecord.r2_key ? `/${activeComicRecord.r2_key}` : null)
            } : null,
            // Phase1.7: display_image SSOT（display_asset_typeに基づく採用素材）
            display_image: (() => {
              const displayType = scene.display_asset_type || 'image';
              if (displayType === 'comic' && activeComicRecord) {
                return {
                  type: 'comic',
                  r2_url: activeComicRecord.r2_url,
                  image_url: activeComicRecord.r2_url || (activeComicRecord.r2_key ? `/${activeComicRecord.r2_key}` : null)
                };
              }
              if (activeRecord) {
                return {
                  type: 'image',
                  r2_url: activeRecord.r2_url,
                  image_url: activeRecord.r2_url || (activeRecord.r2_key ? `/${activeRecord.r2_key}` : null)
                };
              }
              return null;
            })(),
            latest_image: latestRecord ? {
              status: latestRecord.status,
              r2_key: latestRecord.r2_key,
              r2_url: latestRecord.r2_url,
              image_url: latestRecord.r2_url || (latestRecord.r2_key ? `/${latestRecord.r2_key}` : null),
              error_message: latestRecord.error_message
            } : null,
            active_video: activeVideo ? {
              id: activeVideo.id,
              status: activeVideo.status,
              r2_url: activeVideo.r2_url,
              model: activeVideo.model,
              duration_sec: activeVideo.duration_sec
            } : null,
            // キャラクター情報追加（A/B/C層の特徴含む）
            characters: characterMappings.map((c: any) => {
              const charDetail = charDetailsMap.get(c.character_key) || {}
              const sceneTrait = sceneTraitsMap.get(c.character_key) || null
              return {
                character_key: c.character_key,
                character_name: c.character_name,
                is_primary: c.is_primary,
                voice_preset_id: c.voice_preset_id,
                reference_image_r2_url: c.reference_image_r2_url,
                // A層: キャラクター登録の外見
                appearance_description: charDetail.appearance_description || null,
                // B層: 物語共通の特徴
                story_traits: charDetail.story_traits || null,
                // C層: シーン別特徴
                scene_trait: sceneTrait
              }
            }),
            voice_character: voiceCharacter ? {
              character_key: voiceCharacter.character_key,
              character_name: voiceCharacter.character_name,
              voice_preset_id: voiceCharacter.voice_preset_id
            } : null,
            // R1.6: utterance_status for preflight check in UI
            // R3-A: total_duration_ms 追加（音声尺の合計）
            utterance_status: (() => {
              const total = utteranceRows.length;
              const withAudio = utteranceRows.filter(
                (u: any) => u.audio_generation_id && u.audio_status === 'completed'
              ).length;
              const withText = utteranceRows.filter(
                (u: any) => u.text && u.text.trim().length > 0
              ).length;
              const isReady = total > 0 && withText === total && withAudio === total;
              // R3-A: 音声の合計尺を計算（duration_ms を持つものの合計）
              const totalDurationMs = utteranceRows.reduce((sum: number, u: any) => {
                // audio_generation から duration_ms を取得（仮に audio_duration_ms というカラムで取得している場合）
                // 現在のスキーマでは duration_ms は audio_generations ではなく scene_utterances にある可能性
                // ここでは単純に推定値を返す（実装改善の余地あり）
                return sum + (u.duration_ms || 0);
              }, 0);
              return {
                total,
                with_audio: withAudio,
                with_text: withText,
                is_ready: isReady,
                total_duration_ms: totalDurationMs
              };
            })(),
            // PR-API-1: speaker_summary（話者サマリー）
            // scene_utterances から話者情報を集約（SSOTはscene_utterancesのみ）
            speaker_summary: (() => {
              const hasNarration = utteranceRows.some((u: any) => u.role === 'narration');
              const dialogueCharacterKeys = [...new Set(
                utteranceRows
                  .filter((u: any) => u.role === 'dialogue' && u.character_key)
                  .map((u: any) => u.character_key)
              )];
              // character_key から character_name を解決（charDetailsMap を使用）
              const speakers: string[] = [];
              const speakerKeys: string[] = [];
              
              for (const charKey of dialogueCharacterKeys) {
                const charDetail = charDetailsMap.get(charKey);
                if (charDetail && (charDetail as any).character_name) {
                  speakers.push((charDetail as any).character_name);
                } else {
                  // キャラ名が見つからない場合はキーをそのまま使用
                  speakers.push(charKey as string);
                }
                speakerKeys.push(charKey as string);
              }
              
              if (hasNarration) {
                speakers.push('ナレーション');
              }
              
              return {
                speakers,           // 表示用: ["レイラ", "レン", "ナレーション"]
                speaker_keys: speakerKeys,  // キー: ["char_leila", "char_ren"]
                has_narration: hasNarration,
                utterance_total: utteranceRows.length
              };
            })(),
            // P0-2: utterance_list（発話プレビュー用 — 各発話のテキスト・話者・音声状態を返す）
            utterance_list: utteranceRows.map((u: any) => ({
              id: u.id,
              role: u.role || 'narration',
              character_key: u.character_key || null,
              character_name: u.character_key
                ? ((charDetailsMap.get(u.character_key) as any)?.character_name || u.character_key)
                : null,
              text: u.text || '',
              has_audio: !!(u.audio_generation_id && u.audio_status === 'completed'),
              duration_ms: u.duration_ms || null
            })),
            // R2-C: text_render_mode (computed from display_asset_type)
            text_render_mode: scene.text_render_mode || ((scene.display_asset_type === 'comic') ? 'baked' : 'remotion'),
            // R3-B: SFX（効果音）数
            sfx_count: sfxCount,
            // P3: SFX詳細（先頭2件のname）
            sfx_preview: (sfxDetails || []).map((s: any) => s.name || 'SFX'),
            // P3: シーン別BGM
            scene_bgm: sceneBgm ? {
              id: sceneBgm.id,
              source: sceneBgm.library_type || 'direct',
              name: sceneBgm.name || 'BGM',
              url: sceneBgm.url,
              volume: sceneBgm.volume,
              loop: sceneBgm.loop
            } : null,
            // R2-C: motion preset
            // 互換レイヤー使用: detectMotionPresetColumn() でカラム名を検出
            motion_preset_id: await fetchMotionPreset(
              c.env.DB,
              scene.id,
              (scene.display_asset_type === 'comic') ? 'none' : 'kenburns_soft'
            )
          }
        })
      )

      return c.json({
        project_id: parseInt(projectId),
        total_scenes: scenes.length,
        scenes: scenesWithMinimalImages
      })
    }

    // デフォルト（full）: 完全版（既存の動作、後方互換）
    const scenesWithImages = await Promise.all(
      scenes.map(async (scene: any) => {
        // 1) アクティブな画像（表示用）
        const activeRecord = await c.env.DB.prepare(`
          SELECT id, prompt, r2_key, status, created_at
          FROM image_generations
          WHERE scene_id = ? AND is_active = 1
          ORDER BY created_at DESC
          LIMIT 1
        `).bind(scene.id).first()

        const activeImage = activeRecord ? {
          id: activeRecord.id,
          prompt: activeRecord.prompt,
          image_url: `/${activeRecord.r2_key}`, // SSOT: "/" + r2_key
          status: activeRecord.status,
          created_at: activeRecord.created_at
        } : null

        // 2) 最新の画像生成レコード（ステータス表示用、is_active無関係）
        const latestRecord = await c.env.DB.prepare(`
          SELECT id, status, error_message, created_at
          FROM image_generations
          WHERE scene_id = ?
          ORDER BY created_at DESC
          LIMIT 1
        `).bind(scene.id).first()

        const latestImage = latestRecord ? {
          id: latestRecord.id,
          status: latestRecord.status,
          error_message: latestRecord.error_message,
          created_at: latestRecord.created_at
        } : null

        // Safe JSON parsing for bullets
        let bulletsParsed: any[] = []
        try {
          if (scene.bullets) {
            const parsed = JSON.parse(scene.bullets)
            bulletsParsed = Array.isArray(parsed) ? parsed : []
          }
        } catch (e) {
          bulletsParsed = []
        }

        return {
          id: scene.id,
          idx: scene.idx,
          role: scene.role,
          title: scene.title,
          dialogue: scene.dialogue || '',
          speech_type: scene.speech_type || 'narration',
          bullets: bulletsParsed,
          image_prompt: scene.image_prompt || '',
          created_at: scene.created_at,
          updated_at: scene.updated_at,
          active_image: activeImage,
          latest_image: latestImage // ステータスバッジ用
        }
      })
    )

    return c.json({
      project_id: parseInt(projectId),
      total_scenes: scenes.length,
      scenes: scenesWithImages
    })
  } catch (error: any) {
    console.error('Error fetching scenes:', error)
    console.error('Error stack:', error?.stack)
    console.error('Error message:', error?.message)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch scenes',
        details: error?.message || 'Unknown error'
      }
    }, 500)
  }
})

// GET /api/projects/:id/scenes/hidden - 非表示シーン一覧取得（復元UI用）
// SSOT: ログイン必須 + project access 必須（owner or superadmin）
// SSOT: N+1排除（JOIN集計で返す）
projects.get('/:id/scenes/hidden', async (c) => {
  try {
    const projectId = parseInt(c.req.param('id'), 10)
    if (!Number.isFinite(projectId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project id' } }, 400)
    }

    // ===== Auth SSOT: ログイン必須 =====
    const user = await getUserFromSession(c)
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401)
    }

    // ===== Auth SSOT: プロジェクトアクセス権検証（owner or superadmin） =====
    const access = await validateProjectAccess(c, projectId, user)
    if (!access.valid) {
      // SSOT: 存在隠し（他人のプロジェクトは404で返す）
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404)
    }

    // ===== Data: N+1排除（JOIN集計で1クエリ） =====
    // Note: scene_utterances が存在しない環境でも動くよう LEFT JOIN を使用
    // Note: D1 では一部のSQLite関数が使えない場合があるため、シンプルな構文を使用
    let hiddenScenes: any[] = []
    
    try {
      // まず JOIN を使った最適なクエリを試す
      const { results } = await c.env.DB.prepare(`
        SELECT
          s.id,
          s.idx,
          s.role,
          s.title,
          s.dialogue,
          s.chunk_id,
          s.created_at,
          s.updated_at AS hidden_at,
          COUNT(DISTINCT ig.id) AS image_count,
          COUNT(DISTINCT su.id) AS utterance_count
        FROM scenes s
        LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
        LEFT JOIN scene_utterances su ON su.scene_id = s.id
        WHERE s.project_id = ? AND s.is_hidden = 1
        GROUP BY s.id
        ORDER BY s.updated_at DESC
      `).bind(projectId).all<any>()
      
      hiddenScenes = (results || []).map((r: any) => ({
        id: r.id,
        idx: r.idx,
        role: r.role,
        title: r.title,
        dialogue: r.dialogue 
          ? (r.dialogue.length > 100 ? r.dialogue.slice(0, 100) + '...' : r.dialogue) 
          : '',
        chunk_id: r.chunk_id,
        is_manual: r.chunk_id === null,
        hidden_at: r.hidden_at,
        created_at: r.created_at,
        stats: {
          image_count: Number(r.image_count || 0),
          utterance_count: Number(r.utterance_count || 0),
        }
      }))
    } catch (joinError) {
      // JOIN が失敗した場合（テーブルが存在しない等）、シンプルなクエリにフォールバック
      console.warn('[hidden-scenes] JOIN query failed, falling back to simple query:', joinError)
      
      const { results } = await c.env.DB.prepare(`
        SELECT id, idx, role, title, dialogue, chunk_id, created_at, updated_at AS hidden_at
        FROM scenes
        WHERE project_id = ? AND is_hidden = 1
        ORDER BY updated_at DESC
      `).bind(projectId).all<any>()
      
      hiddenScenes = (results || []).map((r: any) => ({
        id: r.id,
        idx: r.idx,
        role: r.role,
        title: r.title,
        dialogue: r.dialogue 
          ? (r.dialogue.length > 100 ? r.dialogue.slice(0, 100) + '...' : r.dialogue) 
          : '',
        chunk_id: r.chunk_id,
        is_manual: r.chunk_id === null,
        hidden_at: r.hidden_at,
        created_at: r.created_at,
        stats: {
          image_count: 0,
          utterance_count: 0,
        }
      }))
    }

    return c.json({
      project_id: projectId,
      total_hidden: hiddenScenes.length,
      hidden_scenes: hiddenScenes,
    })
  } catch (error: any) {
    console.error('[hidden-scenes] Error:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch hidden scenes',
        details: error?.message || 'Unknown error'
      }
    }, 500)
  }
})

// DELETE /api/projects/:id - プロジェクト削除（堅牢版：明示的な子テーブル削除）
projects.delete('/:id', async (c) => {
  try {
    const projectId = c.req.param('id')

    // PRAGMA foreign_keys を有効化（D1では自動有効だが念のため）
    try {
      await c.env.DB.prepare('PRAGMA foreign_keys = ON').run()
    } catch (error) {
      console.warn('PRAGMA foreign_keys = ON failed (might be auto-enabled):', error)
    }

    // プロジェクト存在確認
    const project = await c.env.DB.prepare(`
      SELECT id, audio_r2_key FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // ===== R2削除（ベストエフォート） =====
    
    // R2から音声ファイル削除
    if (project.audio_r2_key) {
      try {
        await c.env.R2.delete(project.audio_r2_key)
        console.log(`Deleted audio from R2: ${project.audio_r2_key}`)
      } catch (error) {
        console.error('Error deleting audio from R2:', error)
      }
    }

    // R2から画像ファイル削除
    try {
      const { results: imageGenerations } = await c.env.DB.prepare(`
        SELECT DISTINCT r2_key FROM image_generations 
        WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
        AND r2_key IS NOT NULL
      `).bind(projectId).all()

      let deletedCount = 0
      for (const img of imageGenerations) {
        try {
          await c.env.R2.delete(img.r2_key)
          deletedCount++
        } catch (error) {
          console.error(`Error deleting image from R2 (${img.r2_key}):`, error)
        }
      }
      console.log(`Deleted ${deletedCount}/${imageGenerations.length} images from R2`)
    } catch (error) {
      console.error('Error fetching/deleting images:', error)
    }

    // ===== DB削除（明示的 + CASCADE保険） =====
    
    try {
      // 1. image_generations を明示削除（scene_id経由）
      await c.env.DB.prepare(`
        DELETE FROM image_generations 
        WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
      `).bind(projectId).run()
      
      // 2. scenes を明示削除
      await c.env.DB.prepare(`
        DELETE FROM scenes WHERE project_id = ?
      `).bind(projectId).run()
      
      // 3. transcriptions を明示削除
      await c.env.DB.prepare(`
        DELETE FROM transcriptions WHERE project_id = ?
      `).bind(projectId).run()
      
      // 4. 最後に projects を削除
      await c.env.DB.prepare(`
        DELETE FROM projects WHERE id = ?
      `).bind(projectId).run()
      
      console.log(`Project ${projectId} and all related data deleted successfully`)
    } catch (dbError) {
      console.error('Error during DB deletion:', dbError)
      throw new Error(`Database deletion failed: ${dbError}`)
    }

    return c.json({
      success: true,
      message: 'Project deleted successfully',
      deleted_project_id: parseInt(projectId)
    })
  } catch (error) {
    console.error('Error deleting project:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete project',
        details: error instanceof Error ? error.message : String(error)
      }
    }, 500)
  }
})

// POST /api/projects/:id/reset - プロジェクトを失敗状態からリセット
projects.post('/:id/reset', async (c) => {
  try {
    const projectId = c.req.param('id')

    // プロジェクト存在確認
    const project = await c.env.DB.prepare(`
      SELECT id, status, source_type, source_text, audio_r2_key
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

    // リセット可能な状態チェック（failedのみ）
    if (project.status !== 'failed') {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: 'Can only reset failed projects',
          details: {
            current_status: project.status
          }
        }
      }, 400)
    }

    // リセット先のステータスを決定
    let resetStatus = 'created'
    
    if (project.source_type === 'text' && project.source_text) {
      // テキスト入力済み → uploaded
      resetStatus = 'uploaded'
    } else if (project.source_type === 'audio' && project.audio_r2_key) {
      // 音声アップロード済み → uploaded
      resetStatus = 'uploaded'
    } else {
      // 入力なし → created
      resetStatus = 'created'
    }

    // ステータスをリセット
    await c.env.DB.prepare(`
      UPDATE projects
      SET status = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(resetStatus, projectId).run()

    // 更新後のプロジェクト取得
    const updatedProject = await c.env.DB.prepare(`
      SELECT id, title, status, source_type, created_at, updated_at
      FROM projects
      WHERE id = ?
    `).bind(projectId).first()

    return c.json({
      success: true,
      message: 'Project reset successfully',
      project: updatedProject,
      reset_from: 'failed',
      reset_to: resetStatus
    }, 200)
  } catch (error) {
    console.error('Error resetting project:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to reset project'
      }
    }, 500)
  }
})

// GET /api/projects/:id/reset-to-input/preview - 入力からやり直しのプレビュー
projects.get('/:id/reset-to-input/preview', async (c) => {
  try {
    const projectId = c.req.param('id')

    // プロジェクト存在確認
    const project = await c.env.DB.prepare(`
      SELECT id, title, status, source_type, source_text, audio_r2_key
      FROM projects
      WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Project not found' }
      }, 404)
    }

    // 削除される項目をカウント + 動画・漫画の存在チェック + 保持される項目のカウント
    const [chunksCount, scenesCount, imagesCount, audiosCount, videosCount, videoBuildCount, comicCount, charactersCount, worldSettingsCount, styleSettingsCount] = await Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM text_chunks WHERE project_id = ?`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM scenes WHERE project_id = ?`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM image_generations WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM audio_generations WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM video_generations WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM video_builds WHERE project_id = ?`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM scenes WHERE project_id = ? AND comic_data IS NOT NULL`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM project_character_models WHERE project_id = ?`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM world_settings WHERE project_id = ?`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM project_style_settings WHERE project_id = ?`).bind(projectId).first()
    ])

    const videoBuildExists = ((videoBuildCount as any)?.count || 0) > 0
    const comicExists = ((comicCount as any)?.count || 0) > 0
    const sceneVideosExist = ((videosCount as any)?.count || 0) > 0

    // リセット可能条件:
    // 1. ステータスがリセット可能なもの
    // 2. Video Build（最終動画）が存在しない
    // 3. 漫画化データが存在しない
    // 4. シーン動画が存在しない
    const resetableStatuses = ['uploaded', 'transcribed', 'parsing', 'parsed', 'formatting', 'formatted', 'completed', 'failed']
    const statusOk = resetableStatuses.includes(project.status as string)
    const canReset = statusOk && !videoBuildExists && !comicExists && !sceneVideosExist

    // リセット不可の理由
    let blockReason = null
    if (!statusOk) {
      blockReason = `現在のステータス（${project.status}）ではリセットできません`
    } else if (videoBuildExists) {
      blockReason = '最終動画（Video Build）が作成済みのため、リセットできません。動画を削除してから再度お試しください。'
    } else if (comicExists) {
      blockReason = '漫画化データが存在するため、リセットできません。漫画データを削除してから再度お試しください。'
    } else if (sceneVideosExist) {
      blockReason = 'シーン動画が生成済みのため、リセットできません。動画を削除してから再度お試しください。'
    }

    return c.json({
      project: {
        id: project.id,
        title: project.title,
        status: project.status,
        source_type: project.source_type
      },
      can_reset: canReset,
      block_reason: blockReason,
      has_video_build: videoBuildExists,
      has_comic: comicExists,
      has_scene_videos: sceneVideosExist,
      will_delete: {
        chunks: (chunksCount as any)?.count || 0,
        scenes: (scenesCount as any)?.count || 0,
        images: (imagesCount as any)?.count || 0,
        audios: (audiosCount as any)?.count || 0,
        videos: (videosCount as any)?.count || 0
      },
      will_preserve: {
        source_text: project.source_type === 'text' && !!project.source_text,
        audio_r2_key: project.source_type === 'audio' && !!project.audio_r2_key,
        characters: (charactersCount as any)?.count || 0,
        world_settings: (worldSettingsCount as any)?.count || 0,
        style_settings: (styleSettingsCount as any)?.count || 0,
        video_builds: (videoBuildCount as any)?.count || 0 // Video Buildは保持される
      }
    })
  } catch (error) {
    console.error('Error in reset-to-input preview:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get reset preview' }
    }, 500)
  }
})

// POST /api/projects/:id/reset-to-input - 入力からやり直し（シーン・チャンクを削除）
projects.post('/:id/reset-to-input', async (c) => {
  try {
    const projectId = c.req.param('id')

    // プロジェクト存在確認
    const project = await c.env.DB.prepare(`
      SELECT id, title, status, source_type, source_text, audio_r2_key
      FROM projects
      WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Project not found' }
      }, 404)
    }

    // リセット可能なステータス確認
    const resetableStatuses = ['uploaded', 'transcribed', 'parsing', 'parsed', 'formatting', 'formatted', 'completed', 'failed']
    if (!resetableStatuses.includes(project.status as string)) {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot reset from status: ${project.status}`
        }
      }, 400)
    }

    // 動画・漫画の存在チェック（これらがあればリセット不可）
    const [videoBuildCount, comicCount, sceneVideosCount] = await Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM video_builds WHERE project_id = ?`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM scenes WHERE project_id = ? AND comic_data IS NOT NULL`).bind(projectId).first(),
      c.env.DB.prepare(`SELECT COUNT(*) as count FROM video_generations WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)`).bind(projectId).first()
    ])

    if (((videoBuildCount as any)?.count || 0) > 0) {
      return c.json({
        error: {
          code: 'VIDEO_BUILD_EXISTS',
          message: '最終動画（Video Build）が作成済みのため、リセットできません'
        }
      }, 400)
    }

    if (((comicCount as any)?.count || 0) > 0) {
      return c.json({
        error: {
          code: 'COMIC_EXISTS',
          message: '漫画化データが存在するため、リセットできません'
        }
      }, 400)
    }

    if (((sceneVideosCount as any)?.count || 0) > 0) {
      return c.json({
        error: {
          code: 'SCENE_VIDEOS_EXIST',
          message: 'シーン動画が生成済みのため、リセットできません'
        }
      }, 400)
    }

    // 削除件数カウント用
    const deletedCounts = { scenes: 0, images: 0, audios: 0, videos: 0, chunks: 0 }

    // ===== R2ファイル削除（ベストエフォート、DB削除前に実行） =====
    
    // 1. 画像R2ファイル削除
    const { results: imageR2Keys } = await c.env.DB.prepare(`
      SELECT DISTINCT r2_key FROM image_generations 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
      AND r2_key IS NOT NULL
    `).bind(projectId).all()
    
    for (const row of imageR2Keys || []) {
      try {
        if (row.r2_key) {
          await c.env.R2.delete(row.r2_key as string)
        }
      } catch (e) {
        console.error(`[ResetToInput] Failed to delete image R2: ${row.r2_key}`, e)
      }
    }
    deletedCounts.images = imageR2Keys?.length || 0

    // 2. 音声R2ファイル削除
    const { results: audioR2Keys } = await c.env.DB.prepare(`
      SELECT DISTINCT r2_key FROM audio_generations 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
      AND r2_key IS NOT NULL
    `).bind(projectId).all()
    
    for (const row of audioR2Keys || []) {
      try {
        if (row.r2_key) {
          await c.env.R2.delete(row.r2_key as string)
        }
      } catch (e) {
        console.error(`[ResetToInput] Failed to delete audio R2: ${row.r2_key}`, e)
      }
    }
    deletedCounts.audios = audioR2Keys?.length || 0

    // 3. 動画R2ファイル削除
    const { results: videoR2Keys } = await c.env.DB.prepare(`
      SELECT DISTINCT r2_key FROM video_generations 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
      AND r2_key IS NOT NULL
    `).bind(projectId).all()
    
    for (const row of videoR2Keys || []) {
      try {
        if (row.r2_key) {
          await c.env.R2.delete(row.r2_key as string)
        }
      } catch (e) {
        console.error(`[ResetToInput] Failed to delete video R2: ${row.r2_key}`, e)
      }
    }
    deletedCounts.videos = videoR2Keys?.length || 0

    // ===== DBデータ削除 =====
    
    // 1. image_generations削除
    await c.env.DB.prepare(`
      DELETE FROM image_generations 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
    `).bind(projectId).run()

    // 2. audio_generations削除
    await c.env.DB.prepare(`
      DELETE FROM audio_generations 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
    `).bind(projectId).run()

    // 3. video_generations削除
    await c.env.DB.prepare(`
      DELETE FROM video_generations 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
    `).bind(projectId).run()

    // 4. scene_character_map削除
    await c.env.DB.prepare(`
      DELETE FROM scene_character_map 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
    `).bind(projectId).run()

    // 5. scene_style_settings削除
    await c.env.DB.prepare(`
      DELETE FROM scene_style_settings 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
    `).bind(projectId).run()

    // 6. scenes削除（件数取得）
    const scenesCountResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM scenes WHERE project_id = ?
    `).bind(projectId).first()
    deletedCounts.scenes = (scenesCountResult?.count as number) || 0
    
    await c.env.DB.prepare(`
      DELETE FROM scenes WHERE project_id = ?
    `).bind(projectId).run()

    // 7. text_chunks削除（件数取得）
    const chunksCountResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM text_chunks WHERE project_id = ?
    `).bind(projectId).first()
    deletedCounts.chunks = (chunksCountResult?.count as number) || 0
    
    await c.env.DB.prepare(`
      DELETE FROM text_chunks WHERE project_id = ?
    `).bind(projectId).run()

    // 8. runs削除
    await c.env.DB.prepare(`
      DELETE FROM runs WHERE project_id = ?
    `).bind(projectId).run()

    // 9. transcriptions削除（入力音声ファイルはR2に残す）
    await c.env.DB.prepare(`
      DELETE FROM transcriptions WHERE project_id = ?
    `).bind(projectId).run()

    // リセット先のステータスを決定
    let resetStatus = 'created'
    if (project.source_type === 'text' && project.source_text) {
      resetStatus = 'uploaded'
    } else if (project.source_type === 'audio' && project.audio_r2_key) {
      resetStatus = 'uploaded'
    }

    // ステータス更新
    await c.env.DB.prepare(`
      UPDATE projects
      SET status = ?,
          error_message = NULL,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(resetStatus, projectId).run()

    console.log(`[ResetToInput] Project ${projectId} reset to ${resetStatus}`, deletedCounts)

    return c.json({
      success: true,
      message: 'Project reset to input successfully',
      project_id: parseInt(projectId),
      reset_to: resetStatus,
      deleted: deletedCounts  // フロントエンド互換のため追加
    })
  } catch (error) {
    console.error('Error in reset-to-input:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to reset project' }
    }, 500)
  }
})

// GET /api/projects/:id/chunks - チャンク一覧取得（失敗チャンク確認用）
projects.get('/:id/chunks', async (c) => {
  try {
    const projectId = c.req.param('id')

    // プロジェクト存在確認
    const project = await c.env.DB.prepare(`
      SELECT id FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    // チャンク一覧取得
    const { results: chunks } = await c.env.DB.prepare(`
      SELECT 
        id,
        project_id,
        idx,
        text,
        status,
        error_message,
        scene_count,
        processed_at,
        created_at,
        updated_at
      FROM text_chunks
      WHERE project_id = ?
      ORDER BY idx ASC
    `).bind(projectId).all()

    // 統計情報
    const stats = {
      total: chunks.length,
      pending: chunks.filter((c: any) => c.status === 'pending').length,
      processing: chunks.filter((c: any) => c.status === 'processing').length,
      done: chunks.filter((c: any) => c.status === 'done').length,
      failed: chunks.filter((c: any) => c.status === 'failed').length
    }

    return c.json({
      chunks,
      stats
    })

  } catch (error) {
    console.error('Error fetching chunks:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch chunks'
      }
    }, 500)
  }
})

/**
 * GET /api/projects/:id/scene-split-settings
 * Get scene split settings for a project
 */
projects.get('/:id/scene-split-settings', async (c) => {
  try {
    const projectId = parseInt(c.req.param('id'), 10)
    if (isNaN(projectId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project id' } }, 400)
    }

    // Get settings or return defaults
    const settings = await c.env.DB.prepare(`
      SELECT target_scene_count, min_chars, max_chars, pacing, use_world_bible
      FROM scene_split_settings
      WHERE project_id = ?
    `).bind(projectId).first()

    if (settings) {
      return c.json(settings)
    }

    // Return defaults if no settings exist
    return c.json({
      target_scene_count: 20,
      min_chars: 800,
      max_chars: 1500,
      pacing: 'normal',
      use_world_bible: 1
    })
  } catch (error) {
    console.error('[Projects] Failed to get scene split settings:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get settings' } }, 500)
  }
})

/**
 * PUT /api/projects/:id/scene-split-settings
 * Update scene split settings for a project
 */
projects.put('/:id/scene-split-settings', async (c) => {
  try {
    const projectId = parseInt(c.req.param('id'), 10)
    if (isNaN(projectId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project id' } }, 400)
    }

    const body = await c.req.json()
    const { target_scene_count, min_chars, max_chars, pacing, use_world_bible } = body

    // Validate
    if (target_scene_count && (target_scene_count < 5 || target_scene_count > 200)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'target_scene_count must be 5-200' } }, 400)
    }
    if (min_chars && (min_chars < 200 || min_chars > 3000)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'min_chars must be 200-3000' } }, 400)
    }
    if (max_chars && (max_chars < 500 || max_chars > 5000)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'max_chars must be 500-5000' } }, 400)
    }
    if (min_chars && max_chars && min_chars >= max_chars) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'min_chars must be less than max_chars' } }, 400)
    }

    // Upsert settings (SQLite INSERT OR REPLACE)
    await c.env.DB.prepare(`
      INSERT INTO scene_split_settings (project_id, target_scene_count, min_chars, max_chars, pacing, use_world_bible)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        target_scene_count = excluded.target_scene_count,
        min_chars = excluded.min_chars,
        max_chars = excluded.max_chars,
        pacing = excluded.pacing,
        use_world_bible = excluded.use_world_bible
    `).bind(
      projectId,
      target_scene_count ?? 20,
      min_chars ?? 800,
      max_chars ?? 1500,
      pacing ?? 'normal',
      use_world_bible ?? 1
    ).run()

    return c.json({ success: true })
  } catch (error) {
    console.error('[Projects] Failed to save scene split settings:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to save settings' } }, 500)
  }
})

// ====================================================================
// Output Preset (Media Platform Targeting)
// ====================================================================

import { getOutputPreset, getAllOutputPresets, isValidPresetId, type OutputPresetId } from '../utils/output-presets'

/**
 * GET /api/projects/:id/output-preset
 * Get current output preset for a project
 */
projects.get('/:id/output-preset', async (c) => {
  try {
    const projectId = parseInt(c.req.param('id'), 10)
    if (isNaN(projectId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project id' } }, 400)
    }

    const project = await c.env.DB.prepare(`
      SELECT output_preset FROM projects WHERE id = ?
    `).bind(projectId).first<{ output_preset: string | null }>()

    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404)
    }

    const presetId = project.output_preset || 'yt_long'
    const preset = getOutputPreset(presetId)
    const allPresets = getAllOutputPresets()

    return c.json({
      current_preset_id: presetId,
      current_preset: preset,
      available_presets: allPresets,
    })
  } catch (error) {
    console.error('[Projects] Failed to get output preset:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get output preset' } }, 500)
  }
})

/**
 * PUT /api/projects/:id/output-preset
 * Update output preset for a project
 */
projects.put('/:id/output-preset', async (c) => {
  try {
    const projectId = parseInt(c.req.param('id'), 10)
    if (isNaN(projectId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project id' } }, 400)
    }

    const body = await c.req.json<{ preset_id: string }>()
    const { preset_id } = body

    if (!preset_id || !isValidPresetId(preset_id)) {
      return c.json({ 
        error: { 
          code: 'INVALID_REQUEST', 
          message: `Invalid preset_id. Valid values: yt_long, short_vertical, yt_shorts, reels, tiktok, custom` 
        } 
      }, 400)
    }

    // Check project exists
    const project = await c.env.DB.prepare(`
      SELECT id FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404)
    }

    // Update output_preset
    await c.env.DB.prepare(`
      UPDATE projects SET output_preset = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(preset_id, projectId).run()

    const preset = getOutputPreset(preset_id)

    return c.json({
      success: true,
      preset_id,
      preset,
      message: `Output preset updated to: ${preset.label}`,
    })
  } catch (error) {
    console.error('[Projects] Failed to update output preset:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update output preset' } }, 500)
  }
})

/**
 * PUT /api/projects/:id/comic-telop-settings
 * Phase 2-1: 漫画の文字（焼き込み）設定を保存
 * 保存のみで反映はしない（次回の漫画生成時に適用）
 */
projects.put('/:id/comic-telop-settings', async (c) => {
  try {
    const projectId = parseInt(c.req.param('id'), 10)
    if (isNaN(projectId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project id' } }, 400)
    }

    const body = await c.req.json<{
      style_preset?: string
      size_preset?: string
      position_preset?: string
    }>()

    // Validate presets
    const validStyles = ['minimal', 'outline', 'band', 'pop', 'cinematic']
    const validSizes = ['sm', 'md', 'lg']
    const validPositions = ['bottom', 'center', 'top']

    if (body.style_preset && !validStyles.includes(body.style_preset)) {
      return c.json({
        error: { code: 'INVALID_REQUEST', message: `Invalid style_preset. Valid: ${validStyles.join(', ')}` }
      }, 400)
    }
    if (body.size_preset && !validSizes.includes(body.size_preset)) {
      return c.json({
        error: { code: 'INVALID_REQUEST', message: `Invalid size_preset. Valid: ${validSizes.join(', ')}` }
      }, 400)
    }
    if (body.position_preset && !validPositions.includes(body.position_preset)) {
      return c.json({
        error: { code: 'INVALID_REQUEST', message: `Invalid position_preset. Valid: ${validPositions.join(', ')}` }
      }, 400)
    }

    // Get existing project and settings
    const project = await c.env.DB.prepare(`
      SELECT id, settings_json FROM projects WHERE id = ?
    `).bind(projectId).first<{ id: number; settings_json: string | null }>()

    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404)
    }

    // Parse existing settings
    let settingsJson: Record<string, unknown> = {}
    if (project.settings_json) {
      try {
        settingsJson = JSON.parse(project.settings_json)
      } catch { /* ignore */ }
    }

    // Update telops_comic (Phase 2-1: 保存のみ、反映は再生成が必要)
    const currentTelopComic = (settingsJson.telops_comic as Record<string, unknown>) || {}
    const newTelopComic = {
      ...currentTelopComic,
      style_preset: body.style_preset ?? currentTelopComic.style_preset ?? 'outline',
      size_preset: body.size_preset ?? currentTelopComic.size_preset ?? 'md',
      position_preset: body.position_preset ?? currentTelopComic.position_preset ?? 'bottom',
    }
    settingsJson.telops_comic = newTelopComic

    // Save to DB
    await c.env.DB.prepare(`
      UPDATE projects SET settings_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(JSON.stringify(settingsJson), projectId).run()

    console.log(`[Projects] Phase2-1: Comic telop settings saved for project ${projectId}:`, newTelopComic)

    return c.json({
      success: true,
      telops_comic: newTelopComic,
      message: '漫画の文字設定を保存しました。次回の漫画生成から反映されます。',
    })
  } catch (error) {
    console.error('[Projects] Failed to update comic telop settings:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update comic telop settings' } }, 500)
  }
})

// =============================================================================
// PR-Remotion-Telop-DefaultSave: Remotionテロップ設定の永続化
// =============================================================================

/**
 * PUT /api/projects/:id/telop-settings
 * Remotionテロップ設定をプロジェクト既定として保存
 * 次回のVideo Build時に自動で復元される
 */
projects.put('/:id/telop-settings', async (c) => {
  try {
    const projectId = parseInt(c.req.param('id'), 10)
    if (isNaN(projectId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project id' } }, 400)
    }

    const body = await c.req.json<{
      enabled?: boolean
      style_preset?: string
      size_preset?: string
      position_preset?: string
      custom_style?: {
        text_color?: string
        stroke_color?: string
        stroke_width?: number
        bg_color?: string
        bg_opacity?: number
        font_family?: string
        font_weight?: string
      } | null
      typography?: {
        max_lines?: number
        line_height?: number
        letter_spacing?: number
      } | null
    }>()

    // Validate presets
    const validStyles = ['minimal', 'outline', 'band', 'pop', 'cinematic']
    const validSizes = ['sm', 'md', 'lg']
    const validPositions = ['bottom', 'center', 'top']
    const validFonts = ['noto-sans', 'noto-serif', 'rounded', 'zen-maru']
    const validWeights = ['400', '500', '600', '700', '800']

    if (body.style_preset && !validStyles.includes(body.style_preset)) {
      return c.json({
        error: { code: 'INVALID_REQUEST', message: `Invalid style_preset. Valid: ${validStyles.join(', ')}` }
      }, 400)
    }
    if (body.size_preset && !validSizes.includes(body.size_preset)) {
      return c.json({
        error: { code: 'INVALID_REQUEST', message: `Invalid size_preset. Valid: ${validSizes.join(', ')}` }
      }, 400)
    }
    if (body.position_preset && !validPositions.includes(body.position_preset)) {
      return c.json({
        error: { code: 'INVALID_REQUEST', message: `Invalid position_preset. Valid: ${validPositions.join(', ')}` }
      }, 400)
    }

    // Validate custom_style
    if (body.custom_style) {
      const cs = body.custom_style
      if (cs.stroke_width !== undefined && (cs.stroke_width < 0 || cs.stroke_width > 6)) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: 'stroke_width must be 0-6' } }, 400)
      }
      if (cs.bg_opacity !== undefined && (cs.bg_opacity < 0 || cs.bg_opacity > 1)) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: 'bg_opacity must be 0-1' } }, 400)
      }
      if (cs.font_family && !validFonts.includes(cs.font_family)) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: `Invalid font_family. Valid: ${validFonts.join(', ')}` } }, 400)
      }
      if (cs.font_weight && !validWeights.includes(cs.font_weight)) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: `Invalid font_weight. Valid: ${validWeights.join(', ')}` } }, 400)
      }
    }

    // Validate typography
    if (body.typography) {
      const tp = body.typography
      if (tp.max_lines !== undefined && (tp.max_lines < 1 || tp.max_lines > 5)) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: 'max_lines must be 1-5' } }, 400)
      }
      if (tp.line_height !== undefined && (tp.line_height < 100 || tp.line_height > 200)) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: 'line_height must be 100-200' } }, 400)
      }
      if (tp.letter_spacing !== undefined && (tp.letter_spacing < -2 || tp.letter_spacing > 6)) {
        return c.json({ error: { code: 'INVALID_REQUEST', message: 'letter_spacing must be -2 to 6' } }, 400)
      }
    }

    // Get existing project and settings
    const project = await c.env.DB.prepare(`
      SELECT id, settings_json FROM projects WHERE id = ?
    `).bind(projectId).first<{ id: number; settings_json: string | null }>()

    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404)
    }

    // Parse existing settings
    let settingsJson: Record<string, unknown> = {}
    if (project.settings_json) {
      try {
        settingsJson = JSON.parse(project.settings_json)
      } catch { /* ignore */ }
    }

    // Build telops_remotion (SSOT for Remotion subtitle defaults)
    const currentTelopsRemotion = (settingsJson.telops_remotion as Record<string, unknown>) || {}
    const newTelopsRemotion: Record<string, unknown> = {
      enabled: body.enabled ?? currentTelopsRemotion.enabled ?? true,
      style_preset: body.style_preset ?? currentTelopsRemotion.style_preset ?? 'outline',
      size_preset: body.size_preset ?? currentTelopsRemotion.size_preset ?? 'md',
      position_preset: body.position_preset ?? currentTelopsRemotion.position_preset ?? 'bottom',
      updated_at: new Date().toISOString(),
    }

    // custom_style: null means "use preset defaults", undefined means "keep existing"
    if (body.custom_style !== undefined) {
      newTelopsRemotion.custom_style = body.custom_style
    } else if (currentTelopsRemotion.custom_style !== undefined) {
      newTelopsRemotion.custom_style = currentTelopsRemotion.custom_style
    }

    // typography: null means "use defaults", undefined means "keep existing"
    if (body.typography !== undefined) {
      newTelopsRemotion.typography = body.typography
    } else if (currentTelopsRemotion.typography !== undefined) {
      newTelopsRemotion.typography = currentTelopsRemotion.typography
    }

    settingsJson.telops_remotion = newTelopsRemotion

    // Save to DB
    await c.env.DB.prepare(`
      UPDATE projects SET settings_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(JSON.stringify(settingsJson), projectId).run()

    // Audit log
    await c.env.DB.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, details, created_at)
      VALUES ('project', ?, 'telop.remotion.defaults_updated', ?, datetime('now'))
    `).bind(projectId, JSON.stringify({
      telops_remotion: newTelopsRemotion,
      note: 'Remotionテロップ設定をプロジェクト既定として保存',
    })).run()

    console.log(`[Projects] PR-Telop-DefaultSave: Saved telops_remotion for project ${projectId}:`, newTelopsRemotion)

    return c.json({
      success: true,
      telops_remotion: newTelopsRemotion,
      message: 'テロップ設定を保存しました。次回のVideo Buildから自動で適用されます。',
    })
  } catch (error) {
    console.error('[Projects] Failed to update telop settings:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update telop settings' } }, 500)
  }
})

/**
 * GET /api/output-presets
 * List all available output presets (no auth required)
 */
projects.get('/output-presets', async (c) => {
  try {
    const allPresets = getAllOutputPresets()
    return c.json({ presets: allPresets })
  } catch (error) {
    console.error('[Projects] Failed to list output presets:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list presets' } }, 500)
  }
})

// =============================================================================
// PR-Comic-Rebake-All: 全シーン一括「再焼き込み」予約
// =============================================================================

/**
 * POST /api/projects/:id/comic/rebake
 * プロジェクト内の全漫画シーンに telops_comic 設定を一括で反映予約
 * 
 * SSOT:
 * - 大元のAI画像は再生成しない（ベース画像固定）
 * - 各sceneの pending_regeneration に telops_comic をセット
 * - 実際の再焼き込みはユーザーが「公開」したときに行われる
 * 
 * 対象シーン判定:
 * - display_asset_type = 'comic' または
 * - text_render_mode = 'baked'
 */
projects.post('/:id/comic/rebake', async (c) => {
  try {
    const projectId = parseInt(c.req.param('id'))
    if (isNaN(projectId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project ID' } }, 400)
    }

    // プロジェクト取得
    const project = await c.env.DB.prepare(`
      SELECT id, user_id, settings_json FROM projects WHERE id = ?
    `).bind(projectId).first<{
      id: number
      user_id: number | null
      settings_json: string | null
    }>()

    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404)
    }

    // telops_comic 設定を取得（なければデフォルト）
    let settingsJson: Record<string, unknown> = {}
    if (project.settings_json) {
      try {
        settingsJson = JSON.parse(project.settings_json)
      } catch { /* ignore */ }
    }
    const telopsComic = (settingsJson.telops_comic as Record<string, unknown>) || {
      style_preset: 'outline',
      size_preset: 'md',
      position_preset: 'bottom'
    }

    // クールダウンチェック（プロジェクト単位で60秒）
    const recentRequest = await c.env.DB.prepare(`
      SELECT created_at FROM audit_logs
      WHERE entity_type = 'project' AND entity_id = ? 
        AND action IN ('comic.rebake.project_requested', 'comic.regenerate.project_requested')
      ORDER BY created_at DESC LIMIT 1
    `).bind(projectId).first<{ created_at: string }>()

    if (recentRequest) {
      const lastRequestTime = new Date(recentRequest.created_at).getTime()
      const now = Date.now()
      const cooldownMs = 60 * 1000 // 60秒
      if (now - lastRequestTime < cooldownMs) {
        const remainingSec = Math.ceil((cooldownMs - (now - lastRequestTime)) / 1000)
        return c.json({
          error: { 
            code: 'CONFLICT', 
            message: `一括反映予約のクールダウン中です。${remainingSec}秒後にお試しください。` 
          }
        }, 409)
      }
    }

    // 対象シーンを取得（漫画シーンのみ）
    // 判定: display_asset_type='comic' OR text_render_mode='baked'
    const targetScenes = await c.env.DB.prepare(`
      SELECT id, comic_data, display_asset_type, text_render_mode
      FROM scenes
      WHERE project_id = ?
        AND (display_asset_type = 'comic' OR text_render_mode = 'baked')
    `).bind(projectId).all<{
      id: number
      comic_data: string | null
      display_asset_type: string | null
      text_render_mode: string | null
    }>()

    const scenes = targetScenes.results || []
    
    if (scenes.length === 0) {
      return c.json({
        success: true,
        affected_scenes: 0,
        message: '対象の漫画シーンがありません。',
      })
    }

    // 各シーンに pending_regeneration をセット
    const now = new Date().toISOString()
    let updatedCount = 0

    for (const scene of scenes) {
      const existingComicData = scene.comic_data ? JSON.parse(scene.comic_data) : {}
      
      const newComicData = {
        ...existingComicData,
        pending_regeneration: {
          requested_at: now,
          telops_comic: telopsComic,
          reason: 'bulk_apply_telops_comic'
        }
      }

      await c.env.DB.prepare(`
        UPDATE scenes 
        SET comic_data = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(JSON.stringify(newComicData), scene.id).run()

      updatedCount++
    }

    // 監査ログ
    const auditDetails = {
      telops_comic: telopsComic,
      affected_scene_count: updatedCount,
      affected_scene_ids: scenes.map(s => s.id),
      note: 'AI画像は固定。全シーンの文字焼き込みを一括で反映予約。'
    }
    await c.env.DB.prepare(`
      INSERT INTO audit_logs (user_id, user_role, entity_type, entity_id, project_id, action, details, created_at)
      VALUES (?, ?, 'project', ?, ?, 'comic.rebake.project_requested', ?, CURRENT_TIMESTAMP)
    `).bind(
      project.user_id || null,
      project.user_id ? 'owner' : 'anonymous',
      projectId,
      projectId,
      JSON.stringify(auditDetails)
    ).run()

    console.log(`[Projects] PR-Comic-Rebake-All: Bulk rebake requested for project ${projectId}, ${updatedCount} scenes affected`)

    return c.json({
      success: true,
      affected_scenes: updatedCount,
      affected_scene_ids: scenes.map(s => s.id),
      telops_comic_applied: telopsComic,
      message: `${updatedCount}シーンに設定を反映予約しました。各シーンで「公開」すると新しい設定で焼き込まれます。`
    })

  } catch (error) {
    console.error('[Projects] Bulk rebake error:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to request bulk rebake' }
    }, 500)
  }
})

/**
 * GET /api/projects/:id/comic/rebake-status
 * プロジェクト内の漫画シーンの再焼き込みステータスを取得
 */
projects.get('/:id/comic/rebake-status', async (c) => {
  try {
    const projectId = parseInt(c.req.param('id'))
    if (isNaN(projectId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project ID' } }, 400)
    }

    // プロジェクトの telops_comic 設定を取得
    const project = await c.env.DB.prepare(`
      SELECT settings_json FROM projects WHERE id = ?
    `).bind(projectId).first<{ settings_json: string | null }>()

    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404)
    }

    let settingsJson: Record<string, unknown> = {}
    if (project.settings_json) {
      try {
        settingsJson = JSON.parse(project.settings_json)
      } catch { /* ignore */ }
    }
    const projectTelopComic = settingsJson.telops_comic || null

    // 漫画シーンのステータスを取得
    const scenes = await c.env.DB.prepare(`
      SELECT id, comic_data, display_asset_type, text_render_mode
      FROM scenes
      WHERE project_id = ?
        AND (display_asset_type = 'comic' OR text_render_mode = 'baked')
    `).bind(projectId).all<{
      id: number
      comic_data: string | null
      display_asset_type: string | null
      text_render_mode: string | null
    }>()

    const sceneStatuses = (scenes.results || []).map(scene => {
      const comicData = scene.comic_data ? JSON.parse(scene.comic_data) : {}
      const pendingRegen = comicData.pending_regeneration
      const appliedTelop = comicData.published?.applied_telops_comic

      // ステータス判定
      let status: 'pending' | 'outdated' | 'current' | 'no_publish'
      if (pendingRegen) {
        status = 'pending' // 反映予約中
      } else if (!comicData.published) {
        status = 'no_publish' // 未公開
      } else if (!appliedTelop) {
        status = 'outdated' // 旧形式（applied_telops_comic なし）
      } else if (projectTelopComic && 
        (appliedTelop.style_preset !== (projectTelopComic as any).style_preset ||
         appliedTelop.size_preset !== (projectTelopComic as any).size_preset ||
         appliedTelop.position_preset !== (projectTelopComic as any).position_preset)) {
        status = 'outdated' // 設定が最新と異なる
      } else {
        status = 'current' // 最新
      }

      return {
        scene_id: scene.id,
        status,
        pending_regeneration: pendingRegen || null,
        applied_telops_comic: appliedTelop || null
      }
    })

    const summary = {
      total: sceneStatuses.length,
      pending: sceneStatuses.filter(s => s.status === 'pending').length,
      outdated: sceneStatuses.filter(s => s.status === 'outdated').length,
      current: sceneStatuses.filter(s => s.status === 'current').length,
      no_publish: sceneStatuses.filter(s => s.status === 'no_publish').length,
    }

    return c.json({
      project_telops_comic: projectTelopComic,
      scenes: sceneStatuses,
      summary
    })

  } catch (error) {
    console.error('[Projects] Rebake status error:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get rebake status' }
    }, 500)
  }
})

// ====================================================================
// PUT /api/projects/:id/narration-voice - Set default narration voice
// ====================================================================
// SSOT: projects.settings_json.default_narration_voice
// This voice is used for all narration utterances in the project
// unless explicitly overridden in the generate request.

projects.put('/:id/narration-voice', async (c) => {
  const projectId = c.req.param('id')
  
  try {
    const body = await c.req.json<{
      provider?: string;
      voice_id: string;
    }>()
    
    // Validate voice_id
    if (!body.voice_id || typeof body.voice_id !== 'string') {
      return c.json({
        error: { code: 'INVALID_REQUEST', message: 'voice_id is required' }
      }, 400)
    }
    
    // Auto-detect provider if not specified
    let provider = body.provider || 'google'
    if (!body.provider) {
      if (body.voice_id.startsWith('elevenlabs:') || body.voice_id.startsWith('el-')) {
        provider = 'elevenlabs'
      } else if (body.voice_id.startsWith('fish:') || body.voice_id.startsWith('fish-')) {
        provider = 'fish'
      }
    }
    
    // Validate provider
    const validProviders = ['google', 'elevenlabs', 'fish']
    if (!validProviders.includes(provider)) {
      return c.json({
        error: { code: 'INVALID_REQUEST', message: `Invalid provider. Must be one of: ${validProviders.join(', ')}` }
      }, 400)
    }
    
    // Get current project settings
    const project = await c.env.DB.prepare(`
      SELECT settings_json FROM projects WHERE id = ?
    `).bind(projectId).first<{ settings_json: string | null }>()
    
    if (!project) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Project not found' }
      }, 404)
    }
    
    // Parse existing settings or create new
    let settings: Record<string, any> = {}
    if (project.settings_json) {
      try {
        settings = JSON.parse(project.settings_json)
      } catch (e) {
        console.warn(`[Project ${projectId}] Failed to parse existing settings_json, creating new`)
      }
    }
    
    // Update default_narration_voice
    settings.default_narration_voice = {
      provider,
      voice_id: body.voice_id
    }
    
    // Save back to DB
    await c.env.DB.prepare(`
      UPDATE projects 
      SET settings_json = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).bind(JSON.stringify(settings), projectId).run()
    
    console.log(`[Project ${projectId}] Updated default_narration_voice: provider=${provider}, voice_id=${body.voice_id}`)
    
    return c.json({
      success: true,
      default_narration_voice: settings.default_narration_voice
    })
    
  } catch (error) {
    console.error('[Projects] Set narration voice error:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to set narration voice' }
    }, 500)
  }
})

// ====================================================================
// GET /api/projects/:id/narration-voice - Get default narration voice
// ====================================================================

projects.get('/:id/narration-voice', async (c) => {
  const projectId = c.req.param('id')
  
  try {
    const project = await c.env.DB.prepare(`
      SELECT settings_json FROM projects WHERE id = ?
    `).bind(projectId).first<{ settings_json: string | null }>()
    
    if (!project) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Project not found' }
      }, 404)
    }
    
    let defaultVoice = {
      provider: 'google',
      voice_id: 'ja-JP-Neural2-B'  // Ultimate fallback
    }
    
    if (project.settings_json) {
      try {
        const settings = JSON.parse(project.settings_json)
        if (settings.default_narration_voice?.voice_id) {
          defaultVoice = settings.default_narration_voice
        }
      } catch (e) {
        console.warn(`[Project ${projectId}] Failed to parse settings_json`)
      }
    }
    
    return c.json({
      default_narration_voice: defaultVoice,
      is_custom: project.settings_json?.includes('default_narration_voice') || false
    })
    
  } catch (error) {
    console.error('[Projects] Get narration voice error:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get narration voice' }
    }, 500)
  }
})

export default projects
