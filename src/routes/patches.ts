/**
 * R4: SSOT Patch API（チャット修正）
 * 
 * 目的:
 * - ユーザーのチャット指示をSSOTへのパッチとして適用
 * - コード生成ではなくデータ更新で修正を実現
 * - dry-run / apply の2段階で安全に適用
 * 
 * エンドポイント:
 * - POST /api/projects/:projectId/patches/dry-run
 * - POST /api/projects/:projectId/patches/apply
 * - GET /api/projects/:projectId/patches
 * - GET /api/projects/:projectId/patches/:patchId
 */

import { Hono } from 'hono';
import { buildProjectJson, hashProjectJson } from '../utils/video-build-helpers';

type Bindings = {
  DB: D1Database;
  R2: R2Bucket;
  SITE_URL?: string;
  // AWS Video Build 関連
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  VIDEO_BUILD_ORCHESTRATOR_URL?: string;
};

const patches = new Hono<{ Bindings: Bindings }>();

// ============================================================
// 型定義
// ============================================================

interface PatchOp {
  op: 'create' | 'update' | 'delete';
  entity: string;
  where?: Record<string, unknown>;  // update/delete時に必須
  set?: Record<string, unknown>;    // create/update時に必須
  reason?: string;                   // 変更理由（任意、監査用）
}

interface PatchRequest {
  schema: 'ssot_patch_v1';
  target: {
    project_id: number;
    video_build_id?: number;
    base_project_json_hash?: string;
  };
  intent: {
    user_message: string;
    parsed_intent?: Record<string, unknown>;
  };
  ops: PatchOp[];
  mode?: {
    dry_run?: boolean;
  };
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface DryRunResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  plan: {
    ops_normalized: NormalizedOp[];
    impact: {
      affected_scenes: number[];
      affected_layers: string[];
    };
  };
}

interface NormalizedOp {
  entity: string;
  action: 'create' | 'update' | 'delete';
  pk?: Record<string, unknown>;
  diff?: Record<string, { from: unknown; to: unknown }>;
  new_data?: Record<string, unknown>;
}

// ============================================================
// 許可エンティティ・フィールド（ホワイトリスト）
// ============================================================

const ALLOWED_ENTITIES: Record<string, {
  pk_field: string;
  scene_id_field?: string;
  allowed_fields: string[];
  required_for_create: string[];
}> = {
  scene_balloons: {
    pk_field: 'id',
    scene_id_field: 'scene_id',
    allowed_fields: [
      'x', 'y', 'w', 'h',           // 位置・サイズ (0-1)
      'start_ms', 'end_ms',          // タイミング
      'z_index',                     // 重なり順
      'is_active',                   // 有効/無効
    ],
    required_for_create: ['scene_id', 'x', 'y', 'w', 'h'],
  },
  scene_audio_cues: {
    pk_field: 'id',
    scene_id_field: 'scene_id',
    allowed_fields: [
      'name',                        // 名前
      'start_ms', 'end_ms',          // タイミング
      'volume',                      // 音量 (0-1)
      'loop',                        // ループ (0/1)
      'fade_in_ms', 'fade_out_ms',   // フェード
      'is_active',                   // 有効/無効
    ],
    required_for_create: ['scene_id', 'cue_type', 'start_ms'],
  },
  scene_motion: {
    pk_field: 'id',
    scene_id_field: 'scene_id',
    allowed_fields: [
      'motion_preset_id',            // プリセットID
      'custom_params',               // カスタムパラメータ（JSON）
    ],
    required_for_create: ['scene_id', 'motion_preset_id'],
  },
  project_audio_tracks: {
    pk_field: 'id',
    // scene_id_field なし（プロジェクト単位）
    allowed_fields: [
      'volume',                      // 音量 (0-1)
      'loop',                        // ループ (0/1)
      'is_active',                   // 有効/無効
      'ducking_enabled',             // ダッキング
      'ducking_volume',              // ダッキング時音量
    ],
    required_for_create: ['project_id', 'track_type'],
  },
  scene_utterances: {
    pk_field: 'id',
    scene_id_field: 'scene_id',
    allowed_fields: [
      'duration_ms',                 // 尺（手動調整用）
      'order_no',                    // 順序
      // 注: text, speaker_type, character_key は慎重に扱う
    ],
    required_for_create: ['scene_id', 'order_no'],
  },
};

// ============================================================
// バリデーション関数
// ============================================================

/**
 * パッチリクエスト全体のバリデーション
 */
function validatePatchRequest(
  req: PatchRequest,
  projectId: number
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. スキーマバージョン
  if (req.schema !== 'ssot_patch_v1') {
    errors.push(`Unsupported schema: ${req.schema}. Expected: ssot_patch_v1`);
  }

  // 2. ターゲット整合性
  if (req.target.project_id !== projectId) {
    errors.push(`project_id mismatch: request=${req.target.project_id}, URL=${projectId}`);
  }

  // 3. opsが空でないこと
  if (!req.ops || req.ops.length === 0) {
    errors.push('ops array is empty');
  }

  // 4. 各opのバリデーション
  for (let i = 0; i < (req.ops || []).length; i++) {
    const op = req.ops[i];
    const opErrors = validateOp(op, i);
    errors.push(...opErrors.errors);
    warnings.push(...opErrors.warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 個別opのバリデーション
 */
function validateOp(op: PatchOp, index: number): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prefix = `ops[${index}]`;

  // 1. op種別
  if (!['create', 'update', 'delete'].includes(op.op)) {
    errors.push(`${prefix}: Invalid op type: ${op.op}`);
    return { valid: false, errors, warnings };
  }

  // 2. エンティティがホワイトリストにあるか
  const entityConfig = ALLOWED_ENTITIES[op.entity];
  if (!entityConfig) {
    errors.push(`${prefix}: Entity not allowed: ${op.entity}`);
    return { valid: false, errors, warnings };
  }

  // 3. update/deleteにはwhereが必須
  if ((op.op === 'update' || op.op === 'delete') && !op.where) {
    errors.push(`${prefix}: 'where' is required for ${op.op}`);
  }

  // 4. update/deleteのwhereにPKが必要
  if (op.where && !op.where[entityConfig.pk_field]) {
    errors.push(`${prefix}: 'where' must include primary key '${entityConfig.pk_field}'`);
  }

  // 5. create/updateにはsetが必須
  if ((op.op === 'create' || op.op === 'update') && !op.set) {
    errors.push(`${prefix}: 'set' is required for ${op.op}`);
  }

  // 6. setのフィールドがホワイトリストにあるか
  if (op.set) {
    for (const field of Object.keys(op.set)) {
      // delta_ms などの特殊フィールドは元フィールドに変換
      const baseField = field.replace('_delta', '');
      
      // create時のscene_id/project_idは許可
      if (op.op === 'create' && (field === 'scene_id' || field === 'project_id' || field === 'cue_type')) {
        continue;
      }
      
      if (!entityConfig.allowed_fields.includes(baseField)) {
        errors.push(`${prefix}: Field not allowed for ${op.entity}: ${field}`);
      }
    }
  }

  // 7. create時の必須フィールドチェック
  if (op.op === 'create' && op.set) {
    for (const required of entityConfig.required_for_create) {
      if (!(required in op.set)) {
        errors.push(`${prefix}: Required field missing for create: ${required}`);
      }
    }
  }

  // 8. 値の範囲チェック
  if (op.set) {
    const rangeErrors = validateFieldRanges(op.entity, op.set, prefix);
    errors.push(...rangeErrors.errors);
    warnings.push(...rangeErrors.warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * フィールド値の範囲チェック
 */
function validateFieldRanges(
  entity: string,
  set: Record<string, unknown>,
  prefix: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 位置・サイズ (0-1)
  for (const field of ['x', 'y', 'w', 'h']) {
    if (field in set) {
      const value = set[field];
      if (typeof value === 'number' && (value < 0 || value > 1)) {
        errors.push(`${prefix}: ${field} must be between 0 and 1 (got: ${value})`);
      }
    }
  }

  // 音量 (0-1)
  for (const field of ['volume', 'ducking_volume']) {
    if (field in set) {
      const value = set[field];
      if (typeof value === 'number' && (value < 0 || value > 1)) {
        errors.push(`${prefix}: ${field} must be between 0 and 1 (got: ${value})`);
      }
    }
  }

  // タイミング (>=0)
  for (const field of ['start_ms', 'end_ms', 'duration_ms', 'fade_in_ms', 'fade_out_ms']) {
    if (field in set) {
      const value = set[field];
      if (typeof value === 'number' && value < 0) {
        errors.push(`${prefix}: ${field} must be >= 0 (got: ${value})`);
      }
      // delta_ms の場合はオブジェクト
      if (typeof value === 'object' && value !== null && 'delta_ms' in value) {
        // delta_msは負の値も許可（早めるため）
        continue;
      }
    }
  }

  // start_ms < end_ms チェック
  if ('start_ms' in set && 'end_ms' in set) {
    const start = set['start_ms'];
    const end = set['end_ms'];
    if (typeof start === 'number' && typeof end === 'number' && start >= end) {
      errors.push(`${prefix}: start_ms (${start}) must be < end_ms (${end})`);
    }
  }

  // is_active, loop (0 or 1)
  for (const field of ['is_active', 'loop', 'ducking_enabled']) {
    if (field in set) {
      const value = set[field];
      if (typeof value === 'number' && value !== 0 && value !== 1) {
        errors.push(`${prefix}: ${field} must be 0 or 1 (got: ${value})`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ============================================================
// Dry-run実行
// ============================================================

async function executeDryRun(
  db: D1Database,
  projectId: number,
  req: PatchRequest
): Promise<DryRunResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const normalizedOps: NormalizedOp[] = [];
  const affectedScenes = new Set<number>();
  const affectedLayers = new Set<string>();

  for (let i = 0; i < req.ops.length; i++) {
    const op = req.ops[i];
    const entityConfig = ALLOWED_ENTITIES[op.entity];
    
    affectedLayers.add(op.entity);

    if (op.op === 'update' && op.where && op.set) {
      // 既存レコードを取得
      const pk = op.where[entityConfig.pk_field];
      const existing = await db.prepare(
        `SELECT * FROM ${op.entity} WHERE ${entityConfig.pk_field} = ?`
      ).bind(pk).first();

      if (!existing) {
        errors.push(`ops[${i}]: Record not found: ${op.entity} ${entityConfig.pk_field}=${pk}`);
        continue;
      }

      // scene_id があれば影響シーンに追加
      if (entityConfig.scene_id_field && existing[entityConfig.scene_id_field]) {
        affectedScenes.add(existing[entityConfig.scene_id_field] as number);
      }

      // 差分を計算
      const diff: Record<string, { from: unknown; to: unknown }> = {};
      for (const [field, value] of Object.entries(op.set)) {
        let newValue = value;
        
        // delta_ms の処理
        if (typeof value === 'object' && value !== null && 'delta_ms' in value) {
          const delta = (value as { delta_ms: number }).delta_ms;
          const currentValue = existing[field] as number || 0;
          newValue = currentValue + delta;
          
          // 範囲チェック
          if (field.endsWith('_ms') && newValue < 0) {
            warnings.push(`ops[${i}]: ${field} would become negative (${newValue}), will be clamped to 0`);
            newValue = 0;
          }
        }

        if (existing[field] !== newValue) {
          diff[field] = { from: existing[field], to: newValue };
        }
      }

      if (Object.keys(diff).length === 0) {
        warnings.push(`ops[${i}]: No actual changes for ${op.entity} ${entityConfig.pk_field}=${pk}`);
      }

      normalizedOps.push({
        entity: op.entity,
        action: 'update',
        pk: op.where,
        diff,
      });

    } else if (op.op === 'create' && op.set) {
      // scene_id があれば影響シーンに追加
      if (entityConfig.scene_id_field && op.set[entityConfig.scene_id_field]) {
        affectedScenes.add(op.set[entityConfig.scene_id_field] as number);
      }

      normalizedOps.push({
        entity: op.entity,
        action: 'create',
        new_data: op.set,
      });

    } else if (op.op === 'delete' && op.where) {
      const pk = op.where[entityConfig.pk_field];
      const existing = await db.prepare(
        `SELECT * FROM ${op.entity} WHERE ${entityConfig.pk_field} = ?`
      ).bind(pk).first();

      if (!existing) {
        errors.push(`ops[${i}]: Record not found for delete: ${op.entity} ${entityConfig.pk_field}=${pk}`);
        continue;
      }

      // scene_id があれば影響シーンに追加
      if (entityConfig.scene_id_field && existing[entityConfig.scene_id_field]) {
        affectedScenes.add(existing[entityConfig.scene_id_field] as number);
      }

      normalizedOps.push({
        entity: op.entity,
        action: 'delete',
        pk: op.where,
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    plan: {
      ops_normalized: normalizedOps,
      impact: {
        affected_scenes: Array.from(affectedScenes),
        affected_layers: Array.from(affectedLayers),
      },
    },
  };
}

// ============================================================
// Apply実行
// ============================================================

async function executeApply(
  db: D1Database,
  patchRequestId: number,
  req: PatchRequest
): Promise<{ ok: boolean; applied_count: number; errors: string[] }> {
  const errors: string[] = [];
  let appliedCount = 0;

  // 各opを順番に適用
  for (let i = 0; i < req.ops.length; i++) {
    const op = req.ops[i];
    const entityConfig = ALLOWED_ENTITIES[op.entity];

    try {
      if (op.op === 'update' && op.where && op.set) {
        const pk = op.where[entityConfig.pk_field];
        
        // 変更前の値を取得（patch_effects用）
        const before = await db.prepare(
          `SELECT * FROM ${op.entity} WHERE ${entityConfig.pk_field} = ?`
        ).bind(pk).first();

        if (!before) {
          errors.push(`ops[${i}]: Record not found during apply`);
          continue;
        }

        // SET句を構築
        const setClauses: string[] = [];
        const values: unknown[] = [];

        for (const [field, value] of Object.entries(op.set)) {
          let newValue = value;
          
          // delta_ms の処理
          if (typeof value === 'object' && value !== null && 'delta_ms' in value) {
            const delta = (value as { delta_ms: number }).delta_ms;
            const currentValue = before[field] as number || 0;
            newValue = Math.max(0, currentValue + delta);  // clamp to 0
          }

          setClauses.push(`${field} = ?`);
          values.push(newValue);
        }

        // updated_at を更新
        setClauses.push('updated_at = CURRENT_TIMESTAMP');

        values.push(pk);
        await db.prepare(
          `UPDATE ${op.entity} SET ${setClauses.join(', ')} WHERE ${entityConfig.pk_field} = ?`
        ).bind(...values).run();

        // 変更後の値を取得
        const after = await db.prepare(
          `SELECT * FROM ${op.entity} WHERE ${entityConfig.pk_field} = ?`
        ).bind(pk).first();

        // patch_effectsに記録
        await db.prepare(`
          INSERT INTO patch_effects (patch_request_id, entity, pk_json, action, before_json, after_json)
          VALUES (?, ?, ?, 'update', ?, ?)
        `).bind(
          patchRequestId,
          op.entity,
          JSON.stringify(op.where),
          JSON.stringify(before),
          JSON.stringify(after)
        ).run();

        appliedCount++;

      } else if (op.op === 'create' && op.set) {
        // INSERT
        const fields = Object.keys(op.set);
        const placeholders = fields.map(() => '?').join(', ');
        const values = Object.values(op.set);

        const result = await db.prepare(
          `INSERT INTO ${op.entity} (${fields.join(', ')}) VALUES (${placeholders})`
        ).bind(...values).run();

        const newId = result.meta.last_row_id;

        // 新規レコードを取得
        const after = await db.prepare(
          `SELECT * FROM ${op.entity} WHERE ${entityConfig.pk_field} = ?`
        ).bind(newId).first();

        // patch_effectsに記録
        await db.prepare(`
          INSERT INTO patch_effects (patch_request_id, entity, pk_json, action, before_json, after_json)
          VALUES (?, ?, ?, 'create', NULL, ?)
        `).bind(
          patchRequestId,
          op.entity,
          JSON.stringify({ [entityConfig.pk_field]: newId }),
          JSON.stringify(after)
        ).run();

        appliedCount++;

      } else if (op.op === 'delete' && op.where) {
        const pk = op.where[entityConfig.pk_field];

        // 変更前の値を取得
        const before = await db.prepare(
          `SELECT * FROM ${op.entity} WHERE ${entityConfig.pk_field} = ?`
        ).bind(pk).first();

        if (!before) {
          errors.push(`ops[${i}]: Record not found for delete during apply`);
          continue;
        }

        // DELETE
        await db.prepare(
          `DELETE FROM ${op.entity} WHERE ${entityConfig.pk_field} = ?`
        ).bind(pk).run();

        // patch_effectsに記録
        await db.prepare(`
          INSERT INTO patch_effects (patch_request_id, entity, pk_json, action, before_json, after_json)
          VALUES (?, ?, ?, 'delete', ?, NULL)
        `).bind(
          patchRequestId,
          op.entity,
          JSON.stringify(op.where),
          JSON.stringify(before)
        ).run();

        appliedCount++;
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`ops[${i}]: Apply failed: ${message}`);
    }
  }

  return {
    ok: errors.length === 0,
    applied_count: appliedCount,
    errors,
  };
}

// ============================================================
// APIエンドポイント
// ============================================================

/**
 * POST /api/projects/:projectId/patches/dry-run
 * パッチの事前検証（DBは更新しない）
 */
patches.post('/projects/:projectId/patches/dry-run', async (c) => {
  const projectId = parseInt(c.req.param('projectId'), 10);
  if (isNaN(projectId)) {
    return c.json({ error: 'Invalid project ID' }, 400);
  }

  let body: PatchRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // 1. 基本バリデーション
  const validation = validatePatchRequest(body, projectId);
  if (!validation.valid) {
    return c.json({
      ok: false,
      errors: validation.errors,
      warnings: validation.warnings,
    }, 400);
  }

  // 2. プロジェクト存在確認
  const project = await c.env.DB.prepare(
    'SELECT id FROM projects WHERE id = ?'
  ).bind(projectId).first();
  
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  // 3. Dry-run実行
  const result = await executeDryRun(c.env.DB, projectId, body);

  // 4. patch_requestsに記録（status: draft or dry_run_ok/failed）
  const status = result.ok ? 'dry_run_ok' : 'dry_run_failed';
  
  const insertResult = await c.env.DB.prepare(`
    INSERT INTO patch_requests (
      project_id, video_build_id, base_project_json_hash,
      source, user_message, parsed_intent_json, ops_json,
      dry_run_result_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    projectId,
    body.target.video_build_id || null,
    body.target.base_project_json_hash || null,
    body.intent ? 'chat' : 'api',
    body.intent?.user_message || '',
    body.intent?.parsed_intent ? JSON.stringify(body.intent.parsed_intent) : null,
    JSON.stringify(body.ops),
    JSON.stringify(result),
    status
  ).run();

  const patchRequestId = insertResult.meta.last_row_id;

  return c.json({
    ...result,
    patch_request_id: patchRequestId,
    status,
  });
});

/**
 * POST /api/projects/:projectId/patches/apply
 * パッチの適用（DBを更新）
 */
patches.post('/projects/:projectId/patches/apply', async (c) => {
  const projectId = parseInt(c.req.param('projectId'), 10);
  if (isNaN(projectId)) {
    return c.json({ error: 'Invalid project ID' }, 400);
  }

  let body: { patch_request_id?: number } & Partial<PatchRequest>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // 既存のpatch_requestを使うか、新規リクエストか
  let patchRequestId: number;
  let patchRequest: PatchRequest;

  if (body.patch_request_id) {
    // 既存のdry-run済みリクエストを使用
    const existing = await c.env.DB.prepare(`
      SELECT * FROM patch_requests WHERE id = ? AND project_id = ?
    `).bind(body.patch_request_id, projectId).first();

    if (!existing) {
      return c.json({ error: 'Patch request not found' }, 404);
    }

    if (existing.status !== 'dry_run_ok') {
      return c.json({ 
        error: `Patch request status is '${existing.status}', expected 'dry_run_ok'` 
      }, 400);
    }

    patchRequestId = existing.id as number;
    patchRequest = {
      schema: 'ssot_patch_v1',
      target: {
        project_id: existing.project_id as number,
        video_build_id: existing.video_build_id as number | undefined,
        base_project_json_hash: existing.base_project_json_hash as string | undefined,
      },
      intent: {
        user_message: existing.user_message as string,
      },
      ops: JSON.parse(existing.ops_json as string),
    };

  } else if (body.schema === 'ssot_patch_v1' && body.ops) {
    // 新規リクエスト（dry-runをスキップして直接apply）
    // ⚠️ 本番では非推奨だが、API経由の自動処理用に残す
    patchRequest = body as PatchRequest;

    const validation = validatePatchRequest(patchRequest, projectId);
    if (!validation.valid) {
      return c.json({
        ok: false,
        errors: validation.errors,
        warnings: validation.warnings,
      }, 400);
    }

    // patch_requestsに記録
    const insertResult = await c.env.DB.prepare(`
      INSERT INTO patch_requests (
        project_id, video_build_id, base_project_json_hash,
        source, user_message, ops_json, status
      ) VALUES (?, ?, ?, 'api', ?, ?, 'draft')
    `).bind(
      projectId,
      patchRequest.target.video_build_id || null,
      patchRequest.target.base_project_json_hash || null,
      patchRequest.intent?.user_message || 'Direct API apply',
      JSON.stringify(patchRequest.ops)
    ).run();

    patchRequestId = insertResult.meta.last_row_id as number;

  } else {
    return c.json({ 
      error: 'Either patch_request_id or full patch request body is required' 
    }, 400);
  }

  // Apply実行
  const result = await executeApply(c.env.DB, patchRequestId, patchRequest);

  // patch_requestsを更新
  const applyStatus = result.ok ? 'apply_ok' : 'apply_failed';
  await c.env.DB.prepare(`
    UPDATE patch_requests 
    SET apply_result_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    JSON.stringify(result),
    applyStatus,
    patchRequestId
  ).run();

  // Apply失敗の場合は即座に返す
  if (!result.ok) {
    return c.json({
      ok: false,
      patch_request_id: patchRequestId,
      applied_count: result.applied_count,
      errors: result.errors,
      status: applyStatus,
      next_action: null,
    });
  }

  // ============================================================
  // R4: Apply成功時に新ビルドを自動生成
  // ============================================================
  
  let newVideoBuildId: number | null = null;
  let buildError: string | null = null;
  const sourceVideoBuildId = patchRequest.target.video_build_id || null;

  try {
    // 1. プロジェクト情報取得
    const project = await c.env.DB.prepare(`
      SELECT id, title, user_id FROM projects WHERE id = ?
    `).bind(projectId).first<{ id: number; title: string; user_id: number }>();

    if (!project) {
      throw new Error('Project not found');
    }

    // 2. シーンデータ取得（video-generation.ts と同じロジック）
    const scenesWithAssets = await fetchScenesWithAssets(c.env.DB, projectId, c.env.SITE_URL);

    if (scenesWithAssets.length === 0) {
      throw new Error('No scenes found');
    }

    // 3. 元ビルドの設定を取得（あれば）、なければデフォルト
    let buildSettings: Record<string, unknown> = {
      motion: { preset: 'none' },
      aspect_ratio: '9:16',
      resolution: '1080p',
      fps: 30,
    };

    if (sourceVideoBuildId) {
      const sourceBuild = await c.env.DB.prepare(`
        SELECT settings_json FROM video_builds WHERE id = ?
      `).bind(sourceVideoBuildId).first<{ settings_json: string }>();
      
      if (sourceBuild?.settings_json) {
        try {
          buildSettings = JSON.parse(sourceBuild.settings_json);
        } catch {
          // パース失敗時はデフォルトを使用
        }
      }
    }

    // 4. BGM設定取得
    const activeBgm = await c.env.DB.prepare(`
      SELECT id, r2_url, volume, loop FROM project_audio_tracks
      WHERE project_id = ? AND track_type = 'bgm' AND is_active = 1
      LIMIT 1
    `).bind(projectId).first<{ id: number; r2_url: string; volume: number; loop: number }>();

    if (activeBgm) {
      buildSettings.bgm = {
        enabled: true,
        url: activeBgm.r2_url,
        volume: activeBgm.volume ?? 0.3,
        loop: activeBgm.loop === 1,
      };
    }

    // 5. project.json生成
    const projectJson = buildProjectJson(
      { id: project.id, title: project.title, user_id: project.user_id },
      scenesWithAssets,
      buildSettings as any,
      {
        aspectRatio: (buildSettings.aspect_ratio as string) || '9:16',
        resolution: (buildSettings.resolution as string) || '1080p',
        fps: (buildSettings.fps as number) || 30,
      }
    );

    const projectJsonHash = await hashProjectJson(projectJson);
    const projectJsonString = JSON.stringify(projectJson);

    // 6. video_buildsレコード作成
    // user_id が NULL の場合はデフォルト値 1 を使用（テストデータ対応）
    const ownerUserId = project.user_id || 1;
    const executorUserId = project.user_id || 1; // パッチ適用者（将来は認証から取得）

    const insertResult = await c.env.DB.prepare(`
      INSERT INTO video_builds (
        project_id, owner_user_id, executor_user_id, 
        settings_json, status, progress_stage, progress_message,
        total_scenes, total_duration_ms, project_json_version, project_json_hash,
        source_video_build_id, patch_request_id
      ) VALUES (?, ?, ?, ?, 'validating', 'Preparing', 'パッチ適用後の新ビルド準備中...', ?, ?, '1.1', ?, ?, ?)
    `).bind(
      projectId,
      ownerUserId,
      executorUserId,
      JSON.stringify(buildSettings),
      scenesWithAssets.length,
      (projectJson as any).summary?.total_duration_ms ?? 0,
      projectJsonHash,
      sourceVideoBuildId,
      patchRequestId
    ).run();

    newVideoBuildId = insertResult.meta.last_row_id as number;

    // 7. R2にproject.jsonを保存
    const r2Key = `video-builds/${newVideoBuildId}/project.json`;
    await c.env.R2.put(r2Key, projectJsonString, {
      httpMetadata: { contentType: 'application/json' },
    });

    await c.env.DB.prepare(`
      UPDATE video_builds SET project_json_r2_key = ? WHERE id = ?
    `).bind(r2Key, newVideoBuildId).run();

    // 8. AWS Orchestrator呼び出し（オプション - 設定がなければスキップ）
    const hasAwsConfig = c.env.AWS_REGION && c.env.AWS_ACCESS_KEY_ID && 
                         c.env.AWS_SECRET_ACCESS_KEY && c.env.VIDEO_BUILD_ORCHESTRATOR_URL;

    if (hasAwsConfig) {
      try {
        const { startVideoBuild, createVideoBuildClientConfig } = await import('../utils/aws-video-build-client');
        const clientConfig = createVideoBuildClientConfig(c.env as any);
        
        if (clientConfig) {
          await startVideoBuild(clientConfig, {
            video_build_id: newVideoBuildId,
            project_id: projectId,
            owner_user_id: ownerUserId,
            executor_user_id: executorUserId,
            is_delegation: false,
            project_json: projectJson,
            build_settings: buildSettings,
          });
        }
      } catch (awsError) {
        // AWS呼び出し失敗はビルド自体の失敗にしない（手動リトライ可能）
        console.warn('[Patch Apply] AWS Orchestrator call failed:', awsError);
        await c.env.DB.prepare(`
          UPDATE video_builds 
          SET status = 'queued', progress_message = 'AWS呼び出し保留中（手動で開始してください）'
          WHERE id = ?
        `).bind(newVideoBuildId).run();
      }
    } else {
      // AWS設定なし - ステータスをqueuedに
      await c.env.DB.prepare(`
        UPDATE video_builds 
        SET status = 'queued', progress_message = 'AWS設定なし（開発環境）'
        WHERE id = ?
      `).bind(newVideoBuildId).run();
    }

  } catch (buildGenError) {
    buildError = buildGenError instanceof Error ? buildGenError.message : String(buildGenError);
    console.error('[Patch Apply] Video build generation error:', buildGenError);
  }

  return c.json({
    ok: true,
    patch_request_id: patchRequestId,
    applied_count: result.applied_count,
    errors: result.errors,
    status: applyStatus,
    // 新ビルド情報
    new_video_build_id: newVideoBuildId,
    build_generation_error: buildError,
    next_action: newVideoBuildId 
      ? `新ビルド #${newVideoBuildId} を作成しました。レンダリング進捗を確認してください。`
      : buildError 
        ? `パッチは適用されましたが、ビルド生成に失敗しました: ${buildError}`
        : 'Video Build を手動で実行してください',
  });
});

/**
 * GET /api/projects/:projectId/patches
 * パッチ履歴一覧
 */
patches.get('/projects/:projectId/patches', async (c) => {
  const projectId = parseInt(c.req.param('projectId'), 10);
  if (isNaN(projectId)) {
    return c.json({ error: 'Invalid project ID' }, 400);
  }

  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  // Get patches with ops_json for UI display
  const patches = await c.env.DB.prepare(`
    SELECT 
      pr.id, pr.project_id, pr.video_build_id, pr.source, 
      pr.user_message, pr.ops_json, pr.status, 
      pr.created_at, pr.updated_at,
      vb.id as generated_video_build_id
    FROM patch_requests pr
    LEFT JOIN video_builds vb ON vb.patch_request_id = pr.id
    WHERE pr.project_id = ?
    ORDER BY pr.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(projectId, limit, offset).all();

  // Parse ops_json for each patch
  const patchesWithParsedOps = patches.results.map((p: Record<string, unknown>) => {
    let ops_json = [];
    try {
      ops_json = p.ops_json ? JSON.parse(p.ops_json as string) : [];
    } catch {
      ops_json = [];
    }
    return {
      ...p,
      ops_json,
    };
  });

  const total = await c.env.DB.prepare(`
    SELECT COUNT(*) as count FROM patch_requests WHERE project_id = ?
  `).bind(projectId).first<{ count: number }>();

  return c.json({
    patches: patchesWithParsedOps,
    total: total?.count || 0,
    limit,
    offset,
  });
});

/**
 * GET /api/projects/:projectId/patches/:patchId
 * パッチ詳細
 */
patches.get('/projects/:projectId/patches/:patchId', async (c) => {
  const projectId = parseInt(c.req.param('projectId'), 10);
  const patchId = parseInt(c.req.param('patchId'), 10);
  
  if (isNaN(projectId) || isNaN(patchId)) {
    return c.json({ error: 'Invalid ID' }, 400);
  }

  const patch = await c.env.DB.prepare(`
    SELECT * FROM patch_requests WHERE id = ? AND project_id = ?
  `).bind(patchId, projectId).first();

  if (!patch) {
    return c.json({ error: 'Patch not found' }, 404);
  }

  // effectsも取得
  const effects = await c.env.DB.prepare(`
    SELECT * FROM patch_effects WHERE patch_request_id = ? ORDER BY id
  `).bind(patchId).all();

  return c.json({
    patch: {
      ...patch,
      ops: JSON.parse(patch.ops_json as string || '[]'),
      dry_run_result: patch.dry_run_result_json 
        ? JSON.parse(patch.dry_run_result_json as string) 
        : null,
      apply_result: patch.apply_result_json 
        ? JSON.parse(patch.apply_result_json as string) 
        : null,
    },
    effects: effects.results.map(e => ({
      ...e,
      pk: JSON.parse(e.pk_json as string || '{}'),
      before: e.before_json ? JSON.parse(e.before_json as string) : null,
      after: e.after_json ? JSON.parse(e.after_json as string) : null,
    })),
  });
});

// ============================================================
// ヘルパー関数: シーンデータ取得（video-generation.ts と同等のロジック）
// ============================================================

const DEFAULT_SITE_URL = 'https://webapp-c7n.pages.dev';

function toAbsoluteUrl(relativeUrl: string | null, siteUrl?: string): string | null {
  if (!relativeUrl) return null;
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
    return relativeUrl;
  }
  const baseUrl = siteUrl || DEFAULT_SITE_URL;
  return `${baseUrl}${relativeUrl.startsWith('/') ? '' : '/'}${relativeUrl}`;
}

/**
 * シーンデータを取得（video-generation.ts の preview-json と同等）
 * 新ビルド生成に必要な最小限のデータを取得
 */
async function fetchScenesWithAssets(
  db: D1Database,
  projectId: number,
  siteUrl?: string
): Promise<any[]> {
  // シーン一覧取得
  const scenesResult = await db.prepare(`
    SELECT 
      s.id, s.idx, s.role, s.title, s.dialogue,
      s.display_asset_type, s.text_render_mode, s.duration_override_ms
    FROM scenes s
    WHERE s.project_id = ?
    ORDER BY s.idx ASC
  `).bind(projectId).all();

  const scenes: any[] = [];

  for (const scene of scenesResult.results) {
    const sceneId = scene.id as number;

    // アクティブ画像
    const activeImage = await db.prepare(`
      SELECT id, r2_key, r2_url FROM image_generations
      WHERE scene_id = ? AND is_active = 1 AND status = 'completed' AND r2_url IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).bind(sceneId).first<{ id: number; r2_key: string; r2_url: string }>();

    // アクティブ漫画（image_generations テーブルの asset_type = 'comic'）
    const activeComic = await db.prepare(`
      SELECT id, r2_key, r2_url FROM image_generations
      WHERE scene_id = ? AND is_active = 1 AND asset_type = 'comic' AND r2_url IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).bind(sceneId).first<{ id: number; r2_key: string; r2_url: string }>();

    // Utterances（音声パーツ）
    const utteranceRows = await db.prepare(`
      SELECT 
        su.id, su.order_no, su.role, su.character_key, su.text,
        su.audio_generation_id, su.duration_ms, ag.status as audio_status, ag.r2_url as audio_url
      FROM scene_utterances su
      LEFT JOIN audio_generations ag ON su.audio_generation_id = ag.id
      WHERE su.scene_id = ?
      ORDER BY su.order_no ASC
    `).bind(sceneId).all();

    // Balloons
    const balloonRows = await db.prepare(`
      SELECT 
        id, utterance_id, x, y, w, h, shape, display_mode,
        start_ms, end_ms, bubble_r2_url, bubble_width_px, bubble_height_px, z_index,
        tail_enabled, tail_tip_x, tail_tip_y,
        writing_mode, text_align, font_family, font_weight, font_size, line_height,
        padding, bg_color, text_color, border_color, border_width
      FROM scene_balloons
      WHERE scene_id = ?
      ORDER BY z_index ASC, id ASC
    `).bind(sceneId).all();

    // SFX
    const sfxRows = await db.prepare(`
      SELECT id, name, r2_url, start_ms, end_ms, volume, loop, fade_in_ms, fade_out_ms
      FROM scene_audio_cues
      WHERE scene_id = ? AND is_active = 1
      ORDER BY start_ms ASC
    `).bind(sceneId).all();

    // Motion
    const motionRow = await db.prepare(`
      SELECT sm.motion_preset_id, mp.motion_type, sm.custom_params
      FROM scene_motion sm
      LEFT JOIN motion_presets mp ON sm.motion_preset_id = mp.id
      WHERE sm.scene_id = ?
    `).bind(sceneId).first<{ motion_preset_id: string; motion_type: string; custom_params: string }>();

    // display_asset_type と text_render_mode
    const displayAssetType = (scene.display_asset_type as string) || 'image';
    const textRenderMode = (scene.text_render_mode as string) || 
      (displayAssetType === 'comic' ? 'baked' : 'remotion');

    // シーンデータ構築
    const sceneData: any = {
      id: sceneId,
      idx: scene.idx,
      role: scene.role || '',
      title: scene.title || '',
      dialogue: scene.dialogue || '',
      display_asset_type: displayAssetType,
      text_render_mode: textRenderMode,
      duration_override_ms: scene.duration_override_ms || null,
    };

    // 画像
    if (displayAssetType === 'comic' && activeComic) {
      sceneData.active_comic = {
        id: activeComic.id,
        r2_key: activeComic.r2_key,
        r2_url: toAbsoluteUrl(activeComic.r2_url, siteUrl),
      };
    } else if (activeImage) {
      sceneData.active_image = {
        id: activeImage.id,
        r2_key: activeImage.r2_key,
        r2_url: toAbsoluteUrl(activeImage.r2_url, siteUrl),
      };
    }

    // Utterances
    sceneData.utterances = utteranceRows.results.map(u => ({
      id: u.id,
      order_no: u.order_no,
      role: u.role,  // 'narration' | 'dialogue'
      character_key: u.character_key,
      text: u.text,
      duration_ms: u.duration_ms || 0,
      audio_status: u.audio_status,
      audio_url: toAbsoluteUrl(u.audio_url as string | null, siteUrl),
    }));

    // Balloons
    sceneData.balloons = balloonRows.results.map(b => ({
      id: b.id,
      utterance_id: b.utterance_id,
      position: { x: b.x, y: b.y },
      size: { w: b.w, h: b.h },
      shape: b.shape,
      display_mode: b.display_mode,
      timing: b.display_mode === 'manual_window' 
        ? { start_ms: b.start_ms, end_ms: b.end_ms }
        : null,
      tail: {
        enabled: b.tail_enabled === 1,
        tip_x: b.tail_tip_x ?? 0.5,
        tip_y: b.tail_tip_y ?? 1.2,
      },
      style: {
        writing_mode: b.writing_mode || 'horizontal',
        text_align: b.text_align || 'center',
        font_family: b.font_family || 'sans-serif',
        font_weight: b.font_weight ?? 700,
        font_size: b.font_size ?? 24,
        line_height: b.line_height ?? 1.4,
        padding: b.padding ?? 12,
        bg_color: b.bg_color || '#FFFFFF',
        text_color: b.text_color || '#000000',
        border_color: b.border_color || '#000000',
        border_width: b.border_width ?? 2,
      },
      z_index: b.z_index,
      bubble_r2_url: toAbsoluteUrl(b.bubble_r2_url as string | null, siteUrl),
      bubble_width_px: b.bubble_width_px,
      bubble_height_px: b.bubble_height_px,
    }));

    // SFX
    sceneData.sfx = sfxRows.results.map(s => ({
      id: s.id,
      name: s.name,
      url: toAbsoluteUrl(s.r2_url as string | null, siteUrl),
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      volume: s.volume,
      loop: s.loop === 1,
      fade_in_ms: s.fade_in_ms,
      fade_out_ms: s.fade_out_ms,
    }));

    // Motion
    if (motionRow) {
      let params = {};
      if (motionRow.custom_params) {
        try {
          params = JSON.parse(motionRow.custom_params);
        } catch { /* ignore */ }
      }
      sceneData.motion = {
        preset_id: motionRow.motion_preset_id,
        motion_type: motionRow.motion_type || 'none',
        params,
      };
    }

    scenes.push(sceneData);
  }

  return scenes;
}

export default patches;
