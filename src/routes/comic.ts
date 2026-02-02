// comic.ts - Phase1.5: 漫画公開API
// 既存の画像生成・動画生成・音声生成には影響しない

import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'

const comic = new Hono<{ Bindings: Bindings }>()

// ===== Phase 3: textStyle / timing デフォルト値 =====
// SSOT: docs/BUBBLE_TEXTSTYLE_SPEC.md
const DEFAULT_TEXT_STYLE = {
  writingMode: 'horizontal' as const,
  fontFamily: 'gothic' as const,
  fontWeight: 'normal' as const,
  fontScale: 1.0,
  textAlign: 'center' as const,
  lineHeight: 1.4
}

const DEFAULT_TIMING = {
  show_from_ms: 0,
  show_until_ms: -1, // -1 = シーン終了まで
  mode: 'scene_duration' as const,
  animation: {
    enter: 'fade' as const,
    exit: 'fade' as const,
    duration_ms: 200
  }
}

// bubble に textStyle/timing が無ければデフォルト値を適用
function normalizeBubble(bubble: any): any {
  return {
    ...bubble,
    textStyle: bubble.textStyle ? { ...DEFAULT_TEXT_STYLE, ...bubble.textStyle } : DEFAULT_TEXT_STYLE,
    timing: bubble.timing ? { ...DEFAULT_TIMING, ...bubble.timing } : DEFAULT_TIMING
  }
}

// draft 内の bubbles を正規化
function normalizeDraft(draft: any): any {
  if (!draft || !draft.bubbles) return draft
  return {
    ...draft,
    bubbles: draft.bubbles.map(normalizeBubble)
  }
}

/**
 * POST /api/scenes/:id/comic/publish
 * 漫画を公開（PNG画像をアップロードしてimage_generationsに登録）
 * 
 * Request Body (multipart/form-data or JSON with base64):
 * - image_data: base64エンコードされたPNG画像
 * - base_image_generation_id: 元画像のID（監査用）
 * - draft: 現在のdraft状態（JSON）
 */
comic.post('/:id/comic/publish', async (c) => {
  try {
    const sceneId = c.req.param('id')
    const body = await c.req.json()
    const { image_data, base_image_generation_id, draft } = body

    // バリデーション
    if (!image_data) {
      return c.json({
        error: { code: 'INVALID_REQUEST', message: 'image_data is required' }
      }, 400)
    }

    // シーン存在確認
    const scene = await c.env.DB.prepare(`
      SELECT id, project_id, comic_data FROM scenes WHERE id = ?
    `).bind(sceneId).first()

    if (!scene) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Scene not found' }
      }, 404)
    }

    // Base64デコード
    const base64Data = image_data.replace(/^data:image\/\w+;base64,/, '')
    const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0))

    // R2にアップロード
    const timestamp = Date.now()
    const r2Key = `images/${scene.project_id}/${sceneId}/comic_${timestamp}.png`
    
    await c.env.R2.put(r2Key, binaryData, {
      httpMetadata: {
        contentType: 'image/png',
      },
    })

    // R2公開URLを生成
    const r2PublicUrl = (c.env as any).R2_PUBLIC_URL
    const r2Url = r2PublicUrl ? `${r2PublicUrl}/${r2Key}` : `/${r2Key}`

    // image_generationsに登録（asset_type='comic'）
    const result = await c.env.DB.prepare(`
      INSERT INTO image_generations 
        (scene_id, prompt, r2_key, r2_url, status, provider, model, is_active, asset_type, created_at)
      VALUES 
        (?, ?, ?, ?, 'completed', 'comic', 'svg-render', 0, 'comic', CURRENT_TIMESTAMP)
    `).bind(
      sceneId,
      `Comic render from image #${base_image_generation_id || 'unknown'}`,
      r2Key,
      r2Url
    ).run()

    const imageGenerationId = result.meta.last_row_id

    // 既存のcomic asset_type画像のis_activeを0に
    await c.env.DB.prepare(`
      UPDATE image_generations 
      SET is_active = 0 
      WHERE scene_id = ? AND asset_type = 'comic' AND id != ?
    `).bind(sceneId, imageGenerationId).run()

    // 新しいcomic画像をactiveに
    await c.env.DB.prepare(`
      UPDATE image_generations 
      SET is_active = 1 
      WHERE id = ?
    `).bind(imageGenerationId).run()

    // comic_dataを更新（draft + published）
    // Phase1.7: published に utterances と bubbles も保存
    // Phase 3: textStyle/timing のデフォルト値を適用
    const existingComicData = scene.comic_data ? JSON.parse(scene.comic_data as string) : {}
    const normalizedDraft = normalizeDraft(draft || existingComicData.draft || null)
    const publishedUtterances = normalizedDraft?.utterances || []
    const publishedBubbles = normalizedDraft?.bubbles || []
    
    const newComicData = {
      draft: normalizedDraft,
      published: {
        image_generation_id: imageGenerationId,
        published_at: new Date().toISOString(),
        utterances: publishedUtterances,  // 最大3音声パーツを保存
        bubbles: publishedBubbles         // 吹き出し情報も保存（textStyle/timing付き）
      },
      base_image_generation_id: base_image_generation_id || existingComicData.base_image_generation_id || null
    }

    await c.env.DB.prepare(`
      UPDATE scenes 
      SET comic_data = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(JSON.stringify(newComicData), sceneId).run()

    console.log(`[Comic] Published comic for scene ${sceneId}, image_generation_id=${imageGenerationId}`)

    return c.json({
      success: true,
      image_generation_id: imageGenerationId,
      r2_url: r2Url,
      comic_data: newComicData
    })

  } catch (error) {
    console.error('[Comic] Publish error:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to publish comic' }
    }, 500)
  }
})

/**
 * POST /api/scenes/:id/comic/draft
 * Draft保存（公開せずに編集状態のみ保存）
 */
comic.post('/:id/comic/draft', async (c) => {
  try {
    const sceneId = c.req.param('id')
    const body = await c.req.json()
    const { draft, base_image_generation_id } = body

    // シーン存在確認
    const scene = await c.env.DB.prepare(`
      SELECT id, comic_data FROM scenes WHERE id = ?
    `).bind(sceneId).first()

    if (!scene) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Scene not found' }
      }, 404)
    }

    // 既存のcomic_dataを保持しつつdraftを更新
    // Phase 3: textStyle/timing のデフォルト値を適用
    const existingComicData = scene.comic_data ? JSON.parse(scene.comic_data as string) : {}
    const normalizedDraft = normalizeDraft(draft)
    const newComicData = {
      ...existingComicData,
      draft: normalizedDraft,
      base_image_generation_id: base_image_generation_id || existingComicData.base_image_generation_id || null
    }

    await c.env.DB.prepare(`
      UPDATE scenes 
      SET comic_data = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(JSON.stringify(newComicData), sceneId).run()

    console.log(`[Comic] Saved draft for scene ${sceneId}`)

    return c.json({
      success: true,
      comic_data: newComicData
    })

  } catch (error) {
    console.error('[Comic] Draft save error:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to save draft' }
    }, 500)
  }
})

/**
 * PUT /api/scenes/:id/display-asset-type
 * 採用切替（image ↔ comic ↔ video）
 * Phase1.8: 動画をサポート
 */
comic.put('/:id/display-asset-type', async (c) => {
  try {
    const sceneId = c.req.param('id')
    const body = await c.req.json()
    const { display_asset_type } = body

    // バリデーション
    if (!['image', 'comic', 'video'].includes(display_asset_type)) {
      return c.json({
        error: { code: 'INVALID_REQUEST', message: 'display_asset_type must be "image", "comic", or "video"' }
      }, 400)
    }

    // シーン存在確認
    const scene = await c.env.DB.prepare(`
      SELECT id, comic_data FROM scenes WHERE id = ?
    `).bind(sceneId).first()

    if (!scene) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Scene not found' }
      }, 404)
    }

    // comicに切り替える場合、公開済み漫画が存在するか確認
    if (display_asset_type === 'comic') {
      const comicData = scene.comic_data ? JSON.parse(scene.comic_data as string) : null
      if (!comicData?.published?.image_generation_id) {
        return c.json({
          error: { code: 'NO_PUBLISHED_COMIC', message: 'No published comic available. Please publish first.' }
        }, 400)
      }
    }

    // videoに切り替える場合、完了済み動画が存在するか確認
    if (display_asset_type === 'video') {
      const video = await c.env.DB.prepare(`
        SELECT id FROM video_generations 
        WHERE scene_id = ? AND is_active = 1 AND status = 'completed'
      `).bind(sceneId).first()
      if (!video) {
        return c.json({
          error: { code: 'NO_COMPLETED_VIDEO', message: 'No completed video available.' }
        }, 400)
      }
    }

    // 更新
    await c.env.DB.prepare(`
      UPDATE scenes 
      SET display_asset_type = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(display_asset_type, sceneId).run()

    console.log(`[Comic] Changed display_asset_type for scene ${sceneId} to ${display_asset_type}`)

    return c.json({
      success: true,
      display_asset_type: display_asset_type
    })

  } catch (error) {
    console.error('[Comic] Display asset type change error:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to change display asset type' }
    }, 500)
  }
})

/**
 * POST /api/scenes/:id/comic/regenerate
 * Phase 2-2: 漫画を再生成（telops_comic を適用）
 * - 既存の漫画は保持（新規生成のみ）
 * - 採用（activate）は別操作
 * - 監査ログに記録
 */
comic.post('/:id/comic/regenerate', async (c) => {
  try {
    const sceneId = c.req.param('id')
    const body = await c.req.json().catch(() => ({}))
    const reason = body.reason || 'apply_telops_comic'

    // シーン存在確認 + project_id 取得
    const scene = await c.env.DB.prepare(`
      SELECT s.id, s.project_id, s.comic_data, s.dialogue, p.settings_json, p.user_id
      FROM scenes s
      JOIN projects p ON s.project_id = p.id
      WHERE s.id = ?
    `).bind(sceneId).first<{
      id: number
      project_id: number
      comic_data: string | null
      dialogue: string | null
      settings_json: string | null
      user_id: number | null
    }>()

    if (!scene) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Scene not found' }
      }, 404)
    }

    // プロジェクト設定から telops_comic を取得
    let settingsJson: Record<string, unknown> = {}
    if (scene.settings_json) {
      try {
        settingsJson = JSON.parse(scene.settings_json)
      } catch { /* ignore */ }
    }
    const telopsComic = (settingsJson.telops_comic as Record<string, unknown>) || {
      style_preset: 'outline',
      size_preset: 'md',
      position_preset: 'bottom'
    }

    // 連打防止: 直近30秒以内に同一シーンで regenerate.requested があれば 409
    const recentRequest = await c.env.DB.prepare(`
      SELECT created_at FROM audit_logs
      WHERE entity_type = 'scene' AND entity_id = ? AND action = 'comic.regenerate.requested'
      ORDER BY created_at DESC LIMIT 1
    `).bind(sceneId).first<{ created_at: string }>()

    if (recentRequest) {
      const lastRequestTime = new Date(recentRequest.created_at).getTime()
      const now = Date.now()
      const cooldownMs = 30 * 1000 // 30秒
      if (now - lastRequestTime < cooldownMs) {
        const remainingSec = Math.ceil((cooldownMs - (now - lastRequestTime)) / 1000)
        return c.json({
          error: { 
            code: 'CONFLICT', 
            message: `再生成のクールダウン中です。${remainingSec}秒後にお試しください。` 
          }
        }, 409)
      }
    }

    // 監査ログ: comic.regenerate.requested
    const auditDetails = {
      reason,
      telops_comic: telopsComic,
      note: 'existing comics are kept; regeneration creates a new comic generation'
    }
    await c.env.DB.prepare(`
      INSERT INTO audit_logs (user_id, user_role, entity_type, entity_id, project_id, action, details, created_at)
      VALUES (?, ?, 'scene', ?, ?, 'comic.regenerate.requested', ?, CURRENT_TIMESTAMP)
    `).bind(
      scene.user_id || null,
      scene.user_id ? 'owner' : 'anonymous',
      sceneId,
      scene.project_id,
      JSON.stringify(auditDetails)
    ).run()

    // 既存の comic_data を取得（draft を引き継ぐ）
    const existingComicData = scene.comic_data ? JSON.parse(scene.comic_data) : {}
    const existingDraft = existingComicData.draft || null

    // Phase 2-2: 再生成リクエストを記録（applied_telops_comic を追加）
    // 実際の漫画再生成は「ユーザーが publish する」ときに行われる
    // ここでは「再生成フラグ」と「適用すべき telops_comic」をマークする
    const newComicData = {
      ...existingComicData,
      pending_regeneration: {
        requested_at: new Date().toISOString(),
        telops_comic: telopsComic,
        reason
      }
    }

    await c.env.DB.prepare(`
      UPDATE scenes 
      SET comic_data = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(JSON.stringify(newComicData), sceneId).run()

    console.log(`[Comic] Phase2-2: Regeneration requested for scene ${sceneId}, telops_comic:`, telopsComic)

    return c.json({
      accepted: true,
      scene_id: parseInt(sceneId),
      project_id: scene.project_id,
      telops_comic_applied: {
        ...telopsComic,
        updated_at: new Date().toISOString()
      },
      message: '漫画の再生成リクエストを受け付けました。漫画編集画面で「公開」を行うと、新しい設定が反映されます。'
    }, 202)

  } catch (error) {
    console.error('[Comic] Regenerate error:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to request comic regeneration' }
    }, 500)
  }
})

/**
 * GET /api/scenes/:id/comic
 * 漫画データ取得（draft + published + 公開画像）
 */
comic.get('/:id/comic', async (c) => {
  try {
    const sceneId = c.req.param('id')

    const scene = await c.env.DB.prepare(`
      SELECT id, comic_data, display_asset_type FROM scenes WHERE id = ?
    `).bind(sceneId).first()

    if (!scene) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Scene not found' }
      }, 404)
    }

    const comicData = scene.comic_data ? JSON.parse(scene.comic_data as string) : null

    // 公開済み漫画画像を取得
    let publishedImage = null
    if (comicData?.published?.image_generation_id) {
      publishedImage = await c.env.DB.prepare(`
        SELECT id, r2_url, created_at FROM image_generations WHERE id = ?
      `).bind(comicData.published.image_generation_id).first()
    }

    return c.json({
      scene_id: parseInt(sceneId),
      display_asset_type: scene.display_asset_type,
      comic_data: comicData,
      published_image: publishedImage
    })

  } catch (error) {
    console.error('[Comic] Get comic error:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get comic data' }
    }, 500)
  }
})

export default comic
