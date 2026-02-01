import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Bindings } from '../types/bindings'
import { logAudit } from '../utils/audit-logger'

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

    const result = await c.env.DB.prepare(`
      INSERT INTO projects (title, status) 
      VALUES (?, 'created')
    `).bind(title.trim()).run()

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
        p.created_at,
        p.updated_at,
        p.source_updated_at
      FROM projects p
      WHERE p.id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }

    return c.json(project)
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
            dialogue: (scene.dialogue || '').substring(0, 100), // 最初の100文字のみ
            speech_type: scene.speech_type || 'narration',
            bullets: bulletsParsed,
            image_prompt: (scene.image_prompt || '').substring(0, 100), // 最初の100文字のみ
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
// is_hidden = 1 のシーンのみ返す（ソフトデリート済み）
projects.get('/:id/scenes/hidden', async (c) => {
  try {
    const projectId = c.req.param('id')

    // プロジェクト存在確認
    const project = await c.env.DB.prepare(`
      SELECT id, title
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

    // 非表示シーン一覧取得（idx は -scene_id なので id 降順で並べる = 最近非表示にしたものが先頭）
    const { results: hiddenScenes } = await c.env.DB.prepare(`
      SELECT 
        id, idx, role, title, dialogue, chunk_id, created_at, updated_at
      FROM scenes
      WHERE project_id = ? AND is_hidden = 1
      ORDER BY updated_at DESC
    `).bind(projectId).all()

    // 各シーンの関連データ数を取得（復元時に復元される内容の参考）
    const scenesWithStats = await Promise.all(
      hiddenScenes.map(async (scene: any) => {
        // 画像数（テーブルが存在しない場合は0を返す）
        let imageCount = 0
        try {
          const result = await c.env.DB.prepare(`
            SELECT COUNT(*) as count FROM image_generations WHERE scene_id = ?
          `).bind(scene.id).first<{ count: number }>()
          imageCount = result?.count || 0
        } catch (e) {
          // テーブルが存在しない場合など
          console.warn('image_generations table not found or error:', e)
        }

        // 発話数（テーブルが存在しない場合は0を返す）
        let utteranceCount = 0
        try {
          const result = await c.env.DB.prepare(`
            SELECT COUNT(*) as count FROM scene_utterances WHERE scene_id = ?
          `).bind(scene.id).first<{ count: number }>()
          utteranceCount = result?.count || 0
        } catch (e) {
          // テーブルが存在しない場合など
          console.warn('scene_utterances table not found or error:', e)
        }

        return {
          id: scene.id,
          idx: scene.idx,
          role: scene.role,
          title: scene.title,
          dialogue: scene.dialogue ? (scene.dialogue.length > 100 ? scene.dialogue.substring(0, 100) + '...' : scene.dialogue) : '',
          chunk_id: scene.chunk_id,
          is_manual: scene.chunk_id === null, // 手動追加シーンかどうか
          hidden_at: scene.updated_at,
          created_at: scene.created_at,
          stats: {
            image_count: imageCount,
            utterance_count: utteranceCount
          }
        }
      })
    )

    return c.json({
      project_id: parseInt(projectId),
      total_hidden: hiddenScenes.length,
      hidden_scenes: scenesWithStats
    })
  } catch (error: any) {
    console.error('Error fetching hidden scenes:', error)
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

export default projects
