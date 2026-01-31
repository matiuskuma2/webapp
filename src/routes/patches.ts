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
import { logPatchOperation } from '../utils/usage-logger';

type Bindings = {
  DB: D1Database;
  R2: R2Bucket;
  SITE_URL?: string;
  // AWS Video Build 関連
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  VIDEO_BUILD_ORCHESTRATOR_URL?: string;
  // Phase C: AI Intent Parse
  GEMINI_API_KEY?: string;
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
      'display_policy',              // 表示ポリシー: always_on | voice_window | manual_window
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
  // P7: シーン別BGM/SFX（scene_audio_assignments SSOT）
  scene_audio_assignments: {
    pk_field: 'id',
    scene_id_field: 'scene_id',
    allowed_fields: [
      'scene_id',                    // create時に必要
      'audio_type',                  // 'bgm' | 'sfx'
      'audio_library_type',          // 'system' | 'user' | 'direct'
      'system_audio_id',             // system_audio_library.id
      'user_audio_id',               // user_audio_library.id
      'start_ms', 'end_ms',          // タイミング
      'volume_override',             // 音量上書き (0-1)
      'loop_override',               // ループ上書き (0/1)
      'fade_in_ms_override', 'fade_out_ms_override',  // フェード上書き（ms付き）
      'is_active',                   // 有効/無効
    ],
    required_for_create: ['scene_id', 'audio_type', 'audio_library_type'],
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

  // Usage logging: API patch apply
  try {
    const projectForLog = await c.env.DB.prepare(
      'SELECT user_id FROM projects WHERE id = ?'
    ).bind(projectId).first<{ user_id: number | null }>();
    
    const resolvedUserId = projectForLog?.user_id;
    
    if (!resolvedUserId) {
      console.error(`[Patch Apply] Cannot determine user_id for project=${projectId}, skipping usage log`);
    } else {
      const entities = [...new Set(patchRequest.ops.map(op => op.entity))];
      
      await logPatchOperation(c.env.DB, {
        userId: resolvedUserId,
        projectId,
        patchRequestId,
        operation: 'apply',
        source: 'api',
        opsCount: patchRequest.ops.length,
        entities,
        newVideoBuildId: null, // 後で更新
        status: result.ok ? 'success' : 'failed',
        errorMessage: result.ok ? undefined : result.errors.join('; '),
      });
    }
  } catch (logError) {
    console.error('[Patch Apply] Usage log failed:', logError);
  }

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
    // user_id が NULL の場合はエラー（データ整合性違反）
    if (!project.user_id) {
      throw new Error(`Project ${projectId} has no user_id, cannot create video build`);
    }
    const ownerUserId = project.user_id;
    const executorUserId = project.user_id; // パッチ適用者（将来は認証から取得）

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

const DEFAULT_SITE_URL = 'https://app.marumuviai.com';

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

// ============================================================
// Safe Chat v0: チャット経由の修正API
// ============================================================

/**
 * Safe Chat v0 Intent Schema (rilarc_intent_v1)
 * 
 * LLMが出力する意図構造。ID決定はサーバー側で行う。
 * entity/field はホワイトリストに限定。
 */
interface RilarcIntent {
  schema: 'rilarc_intent_v1';
  actions: IntentAction[];
}

type IntentAction =
  | BalloonAdjustWindowAction
  | BalloonAdjustPositionAction
  | BalloonSetPolicyAction  // ★ 追加
  | SfxAddFromLibraryAction
  | SfxSetVolumeAction
  | SfxSetTimingAction
  | SfxRemoveAction
  | BgmSetVolumeAction
  | BgmSetLoopAction
  // P7: シーン別BGM操作（scene_audio_assignments SSOT）
  | SceneBgmSetVolumeAction
  | SceneBgmSetTimingAction
  | SceneBgmAssignAction
  | SceneBgmRemoveAction
  // P7: シーン別SFX操作（scene_audio_assignments SSOT）
  | SceneSfxSetVolumeAction
  | SceneSfxSetTimingAction
  // PR-5-3b: テロップ設定（Build単位の上書き）
  | TelopSetEnabledAction
  | TelopSetPositionAction
  | TelopSetSizeAction;

interface BalloonAdjustWindowAction {
  action: 'balloon.adjust_window';
  scene_idx: number;
  balloon_no: number;  // 1-indexed, UI表示順
  delta_start_ms?: number;
  delta_end_ms?: number;
  absolute_start_ms?: number;
  absolute_end_ms?: number;
}

interface BalloonAdjustPositionAction {
  action: 'balloon.adjust_position';
  scene_idx: number;
  balloon_no: number;
  delta_x?: number;
  delta_y?: number;
  absolute_x?: number;
  absolute_y?: number;
}

// ★ display_policy 変更アクション
interface BalloonSetPolicyAction {
  action: 'balloon.set_policy';
  scene_idx: number;
  balloon_no: number;  // 1-indexed
  policy: 'always_on' | 'voice_window' | 'manual_window';
  // manual_window の場合のみ（任意）
  start_ms?: number;
  end_ms?: number;
}

interface SfxAddFromLibraryAction {
  action: 'sfx.add_from_library';
  scene_idx: number;
  sfx_library_id: string;
  start_ms: number;
  volume?: number;
}

interface SfxSetVolumeAction {
  action: 'sfx.set_volume';
  scene_idx: number;
  cue_no: number;  // 1-indexed
  volume: number;  // 0-1
}

interface SfxSetTimingAction {
  action: 'sfx.set_timing';
  scene_idx: number;
  cue_no: number;
  delta_start_ms?: number;
  absolute_start_ms?: number;
  delta_end_ms?: number;
  absolute_end_ms?: number;
}

interface SfxRemoveAction {
  action: 'sfx.remove';
  scene_idx: number;
  cue_no: number;
}

interface BgmSetVolumeAction {
  action: 'bgm.set_volume';
  volume: number;  // 0-1
}

interface BgmSetLoopAction {
  action: 'bgm.set_loop';
  loop: boolean;
}

// ====================================================================
// P7: シーン別BGM操作（scene_audio_assignments SSOT）
// ====================================================================
// 「このシーンのBGM」を操作する。プロジェクト全体BGM（bgm.set_volume）とは別。
// scene_audio_assignments テーブルの audio_type='bgm' レコードを対象。

/**
 * シーン別BGM音量変更
 * 例: 「このシーンのBGMを小さくして」→ scene_bgm.set_volume
 */
interface SceneBgmSetVolumeAction {
  action: 'scene_bgm.set_volume';
  scene_idx: number;
  volume: number;  // 0-1
}

/**
 * シーン別BGMタイミング変更
 * 例: 「このシーンのBGMを10秒で終わらせて」→ scene_bgm.set_timing
 */
interface SceneBgmSetTimingAction {
  action: 'scene_bgm.set_timing';
  scene_idx: number;
  start_ms?: number;
  end_ms?: number;
  delta_start_ms?: number;
  delta_end_ms?: number;
}

/**
 * シーン別BGM割当（ライブラリから）
 * 例: 「前のシーンのBGMをここで使って」→ scene_bgm.assign
 */
interface SceneBgmAssignAction {
  action: 'scene_bgm.assign';
  scene_idx: number;
  source_type: 'system' | 'user' | 'copy_from_scene';
  system_audio_id?: number;
  user_audio_id?: number;
  copy_from_scene_idx?: number;
  volume?: number;
  loop?: boolean;
}

/**
 * シーン別BGM削除
 * 例: 「このシーンのBGMを削除して」→ scene_bgm.remove
 */
interface SceneBgmRemoveAction {
  action: 'scene_bgm.remove';
  scene_idx: number;
}

// ====================================================================
// P7: シーン別SFX操作（scene_audio_assignments SSOT）
// ====================================================================
// scene_audio_assignments テーブルの audio_type='sfx' レコードを対象。
// sfx_no は start_ms 昇順で 1-indexed。

/**
 * シーン別SFX音量変更
 * 例: 「効果音#2を小さくして」→ scene_sfx.set_volume
 */
interface SceneSfxSetVolumeAction {
  action: 'scene_sfx.set_volume';
  scene_idx: number;
  sfx_no: number;  // 1-indexed, start_ms順
  volume: number;  // 0-1
}

/**
 * シーン別SFXタイミング変更
 * 例: 「効果音#1を3秒遅らせて」→ scene_sfx.set_timing
 */
interface SceneSfxSetTimingAction {
  action: 'scene_sfx.set_timing';
  scene_idx: number;
  sfx_no: number;  // 1-indexed
  start_ms?: number;
  end_ms?: number;
  delta_start_ms?: number;
  delta_end_ms?: number;
}

// PR-5-3b: テロップ設定アクション（Build単位の上書き）
// 注意: これらはDBエンティティを更新せず、次回ビルドの settings_json.telops を変更する
interface TelopSetEnabledAction {
  action: 'telop.set_enabled';
  enabled: boolean;  // true=全テロップON, false=全テロップOFF
}

// シーン単位のテロップON/OFF
interface TelopSetEnabledSceneAction {
  action: 'telop.set_enabled_scene';
  scene_idx: number;
  enabled: boolean;  // true=このシーンのテロップON, false=OFF
}

interface TelopSetPositionAction {
  action: 'telop.set_position';
  position_preset: 'bottom' | 'center' | 'top';  // 下 / 中央 / 上
}

interface TelopSetSizeAction {
  action: 'telop.set_size';
  size_preset: 'sm' | 'md' | 'lg';  // 小 / 中 / 大
}

// 許可されるアクションのホワイトリスト
const ALLOWED_CHAT_ACTIONS = new Set([
  'balloon.adjust_window',
  'balloon.adjust_position',
  'balloon.set_policy',  // ★ display_policy の変更
  'sfx.add_from_library',
  'sfx.set_volume',
  'sfx.set_timing',
  'sfx.remove',
  'bgm.set_volume',
  'bgm.set_loop',
  // P7: シーン別BGM操作（scene_audio_assignments SSOT）
  'scene_bgm.set_volume',
  'scene_bgm.set_timing',
  'scene_bgm.assign',
  'scene_bgm.remove',
  // P7: シーン別SFX操作（scene_audio_assignments SSOT）
  'scene_sfx.set_volume',
  'scene_sfx.set_timing',
  // PR-5-3b: テロップ設定（Build単位の上書き、scene_telopはいじらない）
  'telop.set_enabled',
  'telop.set_enabled_scene',  // シーン単位のテロップON/OFF
  'telop.set_position',
  'telop.set_size',
]);

/**
 * Intent → SafeOps 変換
 * 
 * 人間参照（scene_idx, balloon_no, cue_no）をDB IDに解決し、
 * ssot_patch_v1 形式の ops に変換する
 */
// PR-5-3b: テロップ設定はBuild単位の上書き（DBエンティティを更新しない）
interface TelopSettingsOverride {
  enabled?: boolean;
  position_preset?: 'bottom' | 'center' | 'top';
  size_preset?: 'sm' | 'md' | 'lg';
  // シーン単位のテロップON/OFF（scene_idx -> enabled）
  scene_overrides?: Record<number, boolean>;
}

async function resolveIntentToOps(
  db: D1Database,
  projectId: number,
  intent: RilarcIntent
): Promise<{
  ok: boolean;
  ops: PatchOp[];
  errors: string[];
  warnings: string[];
  resolution_log: Array<{ action: string; resolved: Record<string, unknown> }>;
  // PR-5-3b: テロップ設定の上書き（次回ビルドのsettings_json.telopsに反映）
  telop_settings_override?: TelopSettingsOverride;
}> {
  const ops: PatchOp[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolutionLog: Array<{ action: string; resolved: Record<string, unknown> }> = [];
  // PR-5-3b: テロップ設定の収集（DBは更新せず、次回ビルドに反映）
  const telopSettingsOverride: TelopSettingsOverride = {};

  for (let i = 0; i < intent.actions.length; i++) {
    const action = intent.actions[i];
    const prefix = `actions[${i}]`;

    // アクションがホワイトリストにあるか確認
    if (!ALLOWED_CHAT_ACTIONS.has(action.action)) {
      errors.push(`${prefix}: Action not allowed: ${action.action}`);
      continue;
    }

    try {
      // アクションタイプ別の処理
      if (action.action === 'balloon.adjust_window' || action.action === 'balloon.adjust_position') {
        const balloonAction = action as BalloonAdjustWindowAction | BalloonAdjustPositionAction;
        
        // scene_idx → scene_id 解決
        const scene = await db.prepare(`
          SELECT id FROM scenes WHERE project_id = ? AND idx = ?
        `).bind(projectId, balloonAction.scene_idx).first<{ id: number }>();
        
        if (!scene) {
          errors.push(`${prefix}: Scene not found: scene_idx=${balloonAction.scene_idx}`);
          continue;
        }

        // balloon_no → balloon_id 解決（z_index, id順で1-indexed）
        const balloonsResult = await db.prepare(`
          SELECT id FROM scene_balloons 
          WHERE scene_id = ?
          ORDER BY z_index ASC, id ASC
        `).bind(scene.id).all();

        const balloonIndex = balloonAction.balloon_no - 1;
        if (balloonIndex < 0 || balloonIndex >= balloonsResult.results.length) {
          errors.push(`${prefix}: Balloon not found: scene_idx=${balloonAction.scene_idx}, balloon_no=${balloonAction.balloon_no} (available: ${balloonsResult.results.length})`);
          continue;
        }

        const balloonId = balloonsResult.results[balloonIndex].id as number;

        resolutionLog.push({
          action: action.action,
          resolved: {
            scene_idx: balloonAction.scene_idx,
            scene_id: scene.id,
            balloon_no: balloonAction.balloon_no,
            balloon_id: balloonId,
          },
        });

        // OPを構築
        const setFields: Record<string, unknown> = {};

        if (action.action === 'balloon.adjust_window') {
          const windowAction = action as BalloonAdjustWindowAction;
          if (windowAction.delta_start_ms !== undefined) {
            setFields.start_ms = { delta_ms: windowAction.delta_start_ms };
          }
          if (windowAction.delta_end_ms !== undefined) {
            setFields.end_ms = { delta_ms: windowAction.delta_end_ms };
          }
          if (windowAction.absolute_start_ms !== undefined) {
            setFields.start_ms = windowAction.absolute_start_ms;
          }
          if (windowAction.absolute_end_ms !== undefined) {
            setFields.end_ms = windowAction.absolute_end_ms;
          }
        } else {
          const posAction = action as BalloonAdjustPositionAction;
          if (posAction.delta_x !== undefined) {
            setFields.x = { delta_ms: posAction.delta_x };  // Note: using delta notation even for position
          }
          if (posAction.delta_y !== undefined) {
            setFields.y = { delta_ms: posAction.delta_y };
          }
          if (posAction.absolute_x !== undefined) {
            setFields.x = posAction.absolute_x;
          }
          if (posAction.absolute_y !== undefined) {
            setFields.y = posAction.absolute_y;
          }
        }

        if (Object.keys(setFields).length > 0) {
          ops.push({
            op: 'update',
            entity: 'scene_balloons',
            where: { id: balloonId },
            set: setFields,
            reason: `Chat: ${action.action} (scene_idx=${balloonAction.scene_idx}, balloon_no=${balloonAction.balloon_no})`,
          });
        } else {
          warnings.push(`${prefix}: No changes specified for ${action.action}`);
        }

      } else if (action.action === 'balloon.set_policy') {
        // ★ display_policy 変更アクション
        const policyAction = action as BalloonSetPolicyAction;
        
        // scene_idx → scene_id 解決
        const scene = await db.prepare(`
          SELECT id FROM scenes WHERE project_id = ? AND idx = ?
        `).bind(projectId, policyAction.scene_idx).first<{ id: number }>();
        
        if (!scene) {
          errors.push(`${prefix}: Scene not found: scene_idx=${policyAction.scene_idx}`);
          continue;
        }

        // balloon_no → balloon_id 解決
        const balloonsResult = await db.prepare(`
          SELECT id FROM scene_balloons 
          WHERE scene_id = ?
          ORDER BY z_index ASC, id ASC
        `).bind(scene.id).all();

        const balloonIndex = policyAction.balloon_no - 1;
        if (balloonIndex < 0 || balloonIndex >= balloonsResult.results.length) {
          errors.push(`${prefix}: Balloon not found: scene_idx=${policyAction.scene_idx}, balloon_no=${policyAction.balloon_no}`);
          continue;
        }

        const balloonId = balloonsResult.results[balloonIndex].id as number;
        
        // policy バリデーション
        const validPolicies = ['always_on', 'voice_window', 'manual_window'];
        if (!validPolicies.includes(policyAction.policy)) {
          errors.push(`${prefix}: Invalid policy: ${policyAction.policy}. Must be one of: ${validPolicies.join(', ')}`);
          continue;
        }
        
        // manual_window の場合は start_ms/end_ms が必要（あれば設定、なければ警告）
        const setFields: Record<string, unknown> = {
          display_policy: policyAction.policy,
        };
        
        if (policyAction.policy === 'manual_window') {
          if (policyAction.start_ms !== undefined && policyAction.end_ms !== undefined) {
            if (policyAction.end_ms <= policyAction.start_ms) {
              errors.push(`${prefix}: end_ms must be greater than start_ms`);
              continue;
            }
            setFields.start_ms = policyAction.start_ms;
            setFields.end_ms = policyAction.end_ms;
          } else {
            warnings.push(`${prefix}: manual_window without start_ms/end_ms. Current DB values will be used.`);
          }
        }

        resolutionLog.push({
          action: action.action,
          resolved: {
            scene_idx: policyAction.scene_idx,
            scene_id: scene.id,
            balloon_no: policyAction.balloon_no,
            balloon_id: balloonId,
            policy: policyAction.policy,
          },
        });

        ops.push({
          op: 'update',
          entity: 'scene_balloons',
          where: { id: balloonId },
          set: setFields,
          reason: `Chat: balloon.set_policy (scene_idx=${policyAction.scene_idx}, balloon_no=${policyAction.balloon_no}, policy=${policyAction.policy})`,
        });

      } else if (action.action === 'sfx.set_volume' || action.action === 'sfx.set_timing' || action.action === 'sfx.remove') {
        const sfxAction = action as SfxSetVolumeAction | SfxSetTimingAction | SfxRemoveAction;
        
        // scene_idx → scene_id 解決
        const scene = await db.prepare(`
          SELECT id FROM scenes WHERE project_id = ? AND idx = ?
        `).bind(projectId, sfxAction.scene_idx).first<{ id: number }>();
        
        if (!scene) {
          errors.push(`${prefix}: Scene not found: scene_idx=${sfxAction.scene_idx}`);
          continue;
        }

        // cue_no → cue_id 解決（start_ms順で1-indexed）
        const cuesResult = await db.prepare(`
          SELECT id FROM scene_audio_cues 
          WHERE scene_id = ? AND is_active = 1
          ORDER BY start_ms ASC, id ASC
        `).bind(scene.id).all();

        const cueIndex = sfxAction.cue_no - 1;
        if (cueIndex < 0 || cueIndex >= cuesResult.results.length) {
          errors.push(`${prefix}: Audio cue not found: scene_idx=${sfxAction.scene_idx}, cue_no=${sfxAction.cue_no} (available: ${cuesResult.results.length})`);
          continue;
        }

        const cueId = cuesResult.results[cueIndex].id as number;

        resolutionLog.push({
          action: action.action,
          resolved: {
            scene_idx: sfxAction.scene_idx,
            scene_id: scene.id,
            cue_no: sfxAction.cue_no,
            cue_id: cueId,
          },
        });

        if (action.action === 'sfx.set_volume') {
          const volumeAction = action as SfxSetVolumeAction;
          ops.push({
            op: 'update',
            entity: 'scene_audio_cues',
            where: { id: cueId },
            set: { volume: volumeAction.volume },
            reason: `Chat: sfx.set_volume (scene_idx=${sfxAction.scene_idx}, cue_no=${sfxAction.cue_no})`,
          });
        } else if (action.action === 'sfx.set_timing') {
          const timingAction = action as SfxSetTimingAction;
          const setFields: Record<string, unknown> = {};
          if (timingAction.delta_start_ms !== undefined) {
            setFields.start_ms = { delta_ms: timingAction.delta_start_ms };
          }
          if (timingAction.absolute_start_ms !== undefined) {
            setFields.start_ms = timingAction.absolute_start_ms;
          }
          if (timingAction.delta_end_ms !== undefined) {
            setFields.end_ms = { delta_ms: timingAction.delta_end_ms };
          }
          if (timingAction.absolute_end_ms !== undefined) {
            setFields.end_ms = timingAction.absolute_end_ms;
          }
          if (Object.keys(setFields).length > 0) {
            ops.push({
              op: 'update',
              entity: 'scene_audio_cues',
              where: { id: cueId },
              set: setFields,
              reason: `Chat: sfx.set_timing (scene_idx=${sfxAction.scene_idx}, cue_no=${sfxAction.cue_no})`,
            });
          }
        } else if (action.action === 'sfx.remove') {
          ops.push({
            op: 'update',  // 論理削除
            entity: 'scene_audio_cues',
            where: { id: cueId },
            set: { is_active: 0 },
            reason: `Chat: sfx.remove (scene_idx=${sfxAction.scene_idx}, cue_no=${sfxAction.cue_no})`,
          });
        }

      } else if (action.action === 'sfx.add_from_library') {
        const addAction = action as SfxAddFromLibraryAction;
        
        // scene_idx → scene_id 解決
        const scene = await db.prepare(`
          SELECT id FROM scenes WHERE project_id = ? AND idx = ?
        `).bind(projectId, addAction.scene_idx).first<{ id: number }>();
        
        if (!scene) {
          errors.push(`${prefix}: Scene not found: scene_idx=${addAction.scene_idx}`);
          continue;
        }

        // SFXライブラリから取得（将来はsfx_library テーブルから）
        // 現在は固定のライブラリを想定
        // TODO: sfx_library テーブルの実装
        warnings.push(`${prefix}: sfx.add_from_library is not fully implemented yet. Library ID: ${addAction.sfx_library_id}`);
        
        resolutionLog.push({
          action: action.action,
          resolved: {
            scene_idx: addAction.scene_idx,
            scene_id: scene.id,
            sfx_library_id: addAction.sfx_library_id,
          },
        });

        // 仮実装: ライブラリIDをそのまま名前として使用
        ops.push({
          op: 'create',
          entity: 'scene_audio_cues',
          set: {
            scene_id: scene.id,
            cue_type: 'sfx',
            name: `Library: ${addAction.sfx_library_id}`,
            start_ms: addAction.start_ms,
            volume: addAction.volume ?? 0.8,
            is_active: 1,
          },
          reason: `Chat: sfx.add_from_library (scene_idx=${addAction.scene_idx})`,
        });

      } else if (action.action === 'bgm.set_volume' || action.action === 'bgm.set_loop') {
        // プロジェクトのアクティブBGMを取得
        const activeBgm = await db.prepare(`
          SELECT id FROM project_audio_tracks
          WHERE project_id = ? AND track_type = 'bgm' AND is_active = 1
          LIMIT 1
        `).bind(projectId).first<{ id: number }>();

        if (!activeBgm) {
          errors.push(`${prefix}: No active BGM found for project`);
          continue;
        }

        resolutionLog.push({
          action: action.action,
          resolved: {
            project_id: projectId,
            bgm_track_id: activeBgm.id,
          },
        });

        if (action.action === 'bgm.set_volume') {
          const volumeAction = action as BgmSetVolumeAction;
          ops.push({
            op: 'update',
            entity: 'project_audio_tracks',
            where: { id: activeBgm.id },
            set: { volume: volumeAction.volume },
            reason: `Chat: bgm.set_volume`,
          });
        } else {
          const loopAction = action as BgmSetLoopAction;
          ops.push({
            op: 'update',
            entity: 'project_audio_tracks',
            where: { id: activeBgm.id },
            set: { loop: loopAction.loop ? 1 : 0 },
            reason: `Chat: bgm.set_loop`,
          });
        }

      // ====================================================================
      // P7: シーン別BGM操作（scene_audio_assignments SSOT）
      // ====================================================================
      } else if (action.action === 'scene_bgm.set_volume') {
        const bgmAction = action as SceneBgmSetVolumeAction;
        
        // scene_idx → scene_id 解決
        const scene = await db.prepare(`
          SELECT id FROM scenes WHERE project_id = ? AND idx = ?
        `).bind(projectId, bgmAction.scene_idx).first<{ id: number }>();
        
        if (!scene) {
          errors.push(`${prefix}: Scene not found: scene_idx=${bgmAction.scene_idx}`);
          continue;
        }

        // シーンのアクティブBGM割当を取得
        const bgmAssignment = await db.prepare(`
          SELECT id FROM scene_audio_assignments
          WHERE scene_id = ? AND audio_type = 'bgm' AND is_active = 1
          LIMIT 1
        `).bind(scene.id).first<{ id: number }>();

        if (!bgmAssignment) {
          errors.push(`${prefix}: No active BGM found for scene_idx=${bgmAction.scene_idx}`);
          continue;
        }

        // volume バリデーション
        const volume = Math.max(0, Math.min(1, bgmAction.volume));

        resolutionLog.push({
          action: action.action,
          resolved: {
            scene_idx: bgmAction.scene_idx,
            scene_id: scene.id,
            assignment_id: bgmAssignment.id,
            volume,
          },
        });

        ops.push({
          op: 'update',
          entity: 'scene_audio_assignments',
          where: { id: bgmAssignment.id },
          set: { volume_override: volume },
          reason: `Chat: scene_bgm.set_volume (scene_idx=${bgmAction.scene_idx})`,
        });

      } else if (action.action === 'scene_bgm.set_timing') {
        const bgmAction = action as SceneBgmSetTimingAction;
        
        const scene = await db.prepare(`
          SELECT id FROM scenes WHERE project_id = ? AND idx = ?
        `).bind(projectId, bgmAction.scene_idx).first<{ id: number }>();
        
        if (!scene) {
          errors.push(`${prefix}: Scene not found: scene_idx=${bgmAction.scene_idx}`);
          continue;
        }

        const bgmAssignment = await db.prepare(`
          SELECT id FROM scene_audio_assignments
          WHERE scene_id = ? AND audio_type = 'bgm' AND is_active = 1
          LIMIT 1
        `).bind(scene.id).first<{ id: number }>();

        if (!bgmAssignment) {
          errors.push(`${prefix}: No active BGM found for scene_idx=${bgmAction.scene_idx}`);
          continue;
        }

        const setFields: Record<string, unknown> = {};
        if (bgmAction.start_ms !== undefined) setFields.start_ms = bgmAction.start_ms;
        if (bgmAction.end_ms !== undefined) setFields.end_ms = bgmAction.end_ms;
        if (bgmAction.delta_start_ms !== undefined) setFields.start_ms = { delta_ms: bgmAction.delta_start_ms };
        if (bgmAction.delta_end_ms !== undefined) setFields.end_ms = { delta_ms: bgmAction.delta_end_ms };

        if (Object.keys(setFields).length === 0) {
          warnings.push(`${prefix}: No timing changes specified`);
          continue;
        }

        resolutionLog.push({
          action: action.action,
          resolved: {
            scene_idx: bgmAction.scene_idx,
            scene_id: scene.id,
            assignment_id: bgmAssignment.id,
          },
        });

        ops.push({
          op: 'update',
          entity: 'scene_audio_assignments',
          where: { id: bgmAssignment.id },
          set: setFields,
          reason: `Chat: scene_bgm.set_timing (scene_idx=${bgmAction.scene_idx})`,
        });

      } else if (action.action === 'scene_bgm.remove') {
        const bgmAction = action as SceneBgmRemoveAction;
        
        const scene = await db.prepare(`
          SELECT id FROM scenes WHERE project_id = ? AND idx = ?
        `).bind(projectId, bgmAction.scene_idx).first<{ id: number }>();
        
        if (!scene) {
          errors.push(`${prefix}: Scene not found: scene_idx=${bgmAction.scene_idx}`);
          continue;
        }

        const bgmAssignment = await db.prepare(`
          SELECT id FROM scene_audio_assignments
          WHERE scene_id = ? AND audio_type = 'bgm' AND is_active = 1
          LIMIT 1
        `).bind(scene.id).first<{ id: number }>();

        if (!bgmAssignment) {
          warnings.push(`${prefix}: No active BGM to remove for scene_idx=${bgmAction.scene_idx}`);
          continue;
        }

        resolutionLog.push({
          action: action.action,
          resolved: {
            scene_idx: bgmAction.scene_idx,
            scene_id: scene.id,
            assignment_id: bgmAssignment.id,
          },
        });

        ops.push({
          op: 'update',  // 論理削除
          entity: 'scene_audio_assignments',
          where: { id: bgmAssignment.id },
          set: { is_active: 0 },
          reason: `Chat: scene_bgm.remove (scene_idx=${bgmAction.scene_idx})`,
        });

      } else if (action.action === 'scene_bgm.assign') {
        const bgmAction = action as SceneBgmAssignAction;
        
        const scene = await db.prepare(`
          SELECT id FROM scenes WHERE project_id = ? AND idx = ?
        `).bind(projectId, bgmAction.scene_idx).first<{ id: number }>();
        
        if (!scene) {
          errors.push(`${prefix}: Scene not found: scene_idx=${bgmAction.scene_idx}`);
          continue;
        }

        // ソースによって処理を分岐
        let sourceAudioId: number | null = null;
        let audioLibraryType: string = '';

        if (bgmAction.source_type === 'system' && bgmAction.system_audio_id) {
          const systemAudio = await db.prepare(`
            SELECT id FROM system_audio_library WHERE id = ? AND is_active = 1
          `).bind(bgmAction.system_audio_id).first<{ id: number }>();
          if (!systemAudio) {
            errors.push(`${prefix}: System audio not found: id=${bgmAction.system_audio_id}`);
            continue;
          }
          sourceAudioId = bgmAction.system_audio_id;
          audioLibraryType = 'system';
        } else if (bgmAction.source_type === 'user' && bgmAction.user_audio_id) {
          const userAudio = await db.prepare(`
            SELECT id FROM user_audio_library WHERE id = ? AND is_active = 1
          `).bind(bgmAction.user_audio_id).first<{ id: number }>();
          if (!userAudio) {
            errors.push(`${prefix}: User audio not found: id=${bgmAction.user_audio_id}`);
            continue;
          }
          sourceAudioId = bgmAction.user_audio_id;
          audioLibraryType = 'user';
        } else if (bgmAction.source_type === 'copy_from_scene' && bgmAction.copy_from_scene_idx !== undefined) {
          // 別シーンからコピー
          const sourceScene = await db.prepare(`
            SELECT id FROM scenes WHERE project_id = ? AND idx = ?
          `).bind(projectId, bgmAction.copy_from_scene_idx).first<{ id: number }>();
          if (!sourceScene) {
            errors.push(`${prefix}: Source scene not found: scene_idx=${bgmAction.copy_from_scene_idx}`);
            continue;
          }
          const sourceAssignment = await db.prepare(`
            SELECT audio_library_type, system_audio_id, user_audio_id, volume_override, loop_override
            FROM scene_audio_assignments
            WHERE scene_id = ? AND audio_type = 'bgm' AND is_active = 1
            LIMIT 1
          `).bind(sourceScene.id).first<{
            audio_library_type: string;
            system_audio_id: number | null;
            user_audio_id: number | null;
            volume_override: number | null;
            loop_override: number | null;
          }>();
          if (!sourceAssignment) {
            errors.push(`${prefix}: No BGM in source scene: scene_idx=${bgmAction.copy_from_scene_idx}`);
            continue;
          }
          audioLibraryType = sourceAssignment.audio_library_type;
          sourceAudioId = sourceAssignment.system_audio_id || sourceAssignment.user_audio_id;
          
          // コピー元の設定を使用（上書き指定がなければ）
          if (bgmAction.volume === undefined && sourceAssignment.volume_override) {
            bgmAction.volume = sourceAssignment.volume_override;
          }
          if (bgmAction.loop === undefined && sourceAssignment.loop_override !== null) {
            bgmAction.loop = sourceAssignment.loop_override === 1;
          }
        } else {
          errors.push(`${prefix}: Invalid source_type or missing required ID`);
          continue;
        }

        // 既存のBGMがあれば非アクティブ化opを追加
        const existingBgm = await db.prepare(`
          SELECT id FROM scene_audio_assignments
          WHERE scene_id = ? AND audio_type = 'bgm' AND is_active = 1
        `).bind(scene.id).first<{ id: number }>();

        if (existingBgm) {
          ops.push({
            op: 'update',
            entity: 'scene_audio_assignments',
            where: { id: existingBgm.id },
            set: { is_active: 0 },
            reason: `Chat: scene_bgm.assign deactivate old (scene_idx=${bgmAction.scene_idx})`,
          });
        }

        resolutionLog.push({
          action: action.action,
          resolved: {
            scene_idx: bgmAction.scene_idx,
            scene_id: scene.id,
            source_type: bgmAction.source_type,
            audio_library_type: audioLibraryType,
            source_audio_id: sourceAudioId,
            deactivated_assignment_id: existingBgm?.id ?? null,
          },
        });

        // 新規割当を作成
        ops.push({
          op: 'create',
          entity: 'scene_audio_assignments',
          set: {
            scene_id: scene.id,
            audio_type: 'bgm',
            audio_library_type: audioLibraryType,
            system_audio_id: audioLibraryType === 'system' ? sourceAudioId : null,
            user_audio_id: audioLibraryType === 'user' ? sourceAudioId : null,
            volume_override: bgmAction.volume ?? 0.25,
            loop_override: bgmAction.loop !== undefined ? (bgmAction.loop ? 1 : 0) : 1,
            is_active: 1,
          },
          reason: `Chat: scene_bgm.assign (scene_idx=${bgmAction.scene_idx}, source=${bgmAction.source_type})`,
        });

      // ====================================================================
      // P7: シーン別SFX操作（scene_audio_assignments SSOT）
      // ====================================================================
      } else if (action.action === 'scene_sfx.set_volume') {
        const sfxAction = action as SceneSfxSetVolumeAction;
        
        const scene = await db.prepare(`
          SELECT id FROM scenes WHERE project_id = ? AND idx = ?
        `).bind(projectId, sfxAction.scene_idx).first<{ id: number }>();
        
        if (!scene) {
          errors.push(`${prefix}: Scene not found: scene_idx=${sfxAction.scene_idx}`);
          continue;
        }

        // sfx_no → assignment_id 解決（start_ms順で1-indexed）
        const sfxResult = await db.prepare(`
          SELECT id FROM scene_audio_assignments
          WHERE scene_id = ? AND audio_type = 'sfx' AND is_active = 1
          ORDER BY start_ms ASC, id ASC
        `).bind(scene.id).all();

        const sfxIndex = sfxAction.sfx_no - 1;
        if (sfxIndex < 0 || sfxIndex >= sfxResult.results.length) {
          errors.push(`${prefix}: SFX not found: scene_idx=${sfxAction.scene_idx}, sfx_no=${sfxAction.sfx_no} (available: ${sfxResult.results.length})`);
          continue;
        }

        const sfxId = sfxResult.results[sfxIndex].id as number;
        const volume = Math.max(0, Math.min(1, sfxAction.volume));

        resolutionLog.push({
          action: action.action,
          resolved: {
            scene_idx: sfxAction.scene_idx,
            scene_id: scene.id,
            sfx_no: sfxAction.sfx_no,
            sfx_id: sfxId,
            volume,
          },
        });

        ops.push({
          op: 'update',
          entity: 'scene_audio_assignments',
          where: { id: sfxId },
          set: { volume_override: volume },
          reason: `Chat: scene_sfx.set_volume (scene_idx=${sfxAction.scene_idx}, sfx_no=${sfxAction.sfx_no})`,
        });

      } else if (action.action === 'scene_sfx.set_timing') {
        const sfxAction = action as SceneSfxSetTimingAction;
        
        const scene = await db.prepare(`
          SELECT id FROM scenes WHERE project_id = ? AND idx = ?
        `).bind(projectId, sfxAction.scene_idx).first<{ id: number }>();
        
        if (!scene) {
          errors.push(`${prefix}: Scene not found: scene_idx=${sfxAction.scene_idx}`);
          continue;
        }

        const sfxResult = await db.prepare(`
          SELECT id FROM scene_audio_assignments
          WHERE scene_id = ? AND audio_type = 'sfx' AND is_active = 1
          ORDER BY start_ms ASC, id ASC
        `).bind(scene.id).all();

        const sfxIndex = sfxAction.sfx_no - 1;
        if (sfxIndex < 0 || sfxIndex >= sfxResult.results.length) {
          errors.push(`${prefix}: SFX not found: scene_idx=${sfxAction.scene_idx}, sfx_no=${sfxAction.sfx_no}`);
          continue;
        }

        const sfxId = sfxResult.results[sfxIndex].id as number;

        const setFields: Record<string, unknown> = {};
        if (sfxAction.start_ms !== undefined) setFields.start_ms = sfxAction.start_ms;
        if (sfxAction.end_ms !== undefined) setFields.end_ms = sfxAction.end_ms;
        if (sfxAction.delta_start_ms !== undefined) setFields.start_ms = { delta_ms: sfxAction.delta_start_ms };
        if (sfxAction.delta_end_ms !== undefined) setFields.end_ms = { delta_ms: sfxAction.delta_end_ms };

        if (Object.keys(setFields).length === 0) {
          warnings.push(`${prefix}: No timing changes specified`);
          continue;
        }

        resolutionLog.push({
          action: action.action,
          resolved: {
            scene_idx: sfxAction.scene_idx,
            scene_id: scene.id,
            sfx_no: sfxAction.sfx_no,
            sfx_id: sfxId,
          },
        });

        ops.push({
          op: 'update',
          entity: 'scene_audio_assignments',
          where: { id: sfxId },
          set: setFields,
          reason: `Chat: scene_sfx.set_timing (scene_idx=${sfxAction.scene_idx}, sfx_no=${sfxAction.sfx_no})`,
        });

      // PR-5-3b: テロップ設定アクション（Build単位の上書き、DBは更新しない）
      } else if (action.action === 'telop.set_enabled') {
        const telopAction = action as TelopSetEnabledAction;
        telopSettingsOverride.enabled = telopAction.enabled;
        resolutionLog.push({
          action: action.action,
          resolved: { enabled: telopAction.enabled },
        });

      } else if (action.action === 'telop.set_enabled_scene') {
        // シーン単位のテロップON/OFF
        const telopAction = action as TelopSetEnabledSceneAction;
        const sceneIdx = telopAction.scene_idx;
        
        if (typeof sceneIdx !== 'number' || sceneIdx < 1) {
          errors.push(`${prefix}: Invalid scene_idx: ${sceneIdx}. Must be >= 1`);
          continue;
        }
        
        // scene_overrides を初期化
        if (!telopSettingsOverride.scene_overrides) {
          telopSettingsOverride.scene_overrides = {};
        }
        telopSettingsOverride.scene_overrides[sceneIdx] = telopAction.enabled;
        
        resolutionLog.push({
          action: action.action,
          resolved: { scene_idx: sceneIdx, enabled: telopAction.enabled },
        });

      } else if (action.action === 'telop.set_position') {
        const telopAction = action as TelopSetPositionAction;
        const validPositions = ['bottom', 'center', 'top'];
        if (!validPositions.includes(telopAction.position_preset)) {
          errors.push(`${prefix}: Invalid position_preset: ${telopAction.position_preset}. Must be one of: ${validPositions.join(', ')}`);
          continue;
        }
        telopSettingsOverride.position_preset = telopAction.position_preset;
        resolutionLog.push({
          action: action.action,
          resolved: { position_preset: telopAction.position_preset },
        });

      } else if (action.action === 'telop.set_size') {
        const telopAction = action as TelopSetSizeAction;
        const validSizes = ['sm', 'md', 'lg'];
        if (!validSizes.includes(telopAction.size_preset)) {
          errors.push(`${prefix}: Invalid size_preset: ${telopAction.size_preset}. Must be one of: ${validSizes.join(', ')}`);
          continue;
        }
        telopSettingsOverride.size_preset = telopAction.size_preset;
        resolutionLog.push({
          action: action.action,
          resolved: { size_preset: telopAction.size_preset },
        });
      }

    } catch (error) {
      errors.push(`${prefix}: Resolution error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // PR-5-3b: テロップ設定が空でない場合のみ含める
  const hasTelopOverride = Object.keys(telopSettingsOverride).length > 0;

  return {
    ok: errors.length === 0,
    ops,
    errors,
    warnings,
    resolution_log: resolutionLog,
    ...(hasTelopOverride && { telop_settings_override: telopSettingsOverride }),
  };
}

/**
 * POST /api/projects/:projectId/chat-edits/dry-run
 * 
 * チャット修正のdry-run
 * - user_message から Intent を受け取る（LLMは呼ばない、クライアント側で解析済み）
 * - Intent → SafeOps 変換
 * - 既存の patches/dry-run と同等のバリデーション
 */
patches.post('/projects/:projectId/chat-edits/dry-run', async (c) => {
  const projectId = parseInt(c.req.param('projectId'), 10);
  if (isNaN(projectId)) {
    return c.json({ error: 'Invalid project ID' }, 400);
  }

  let body: {
    user_message: string;
    intent: RilarcIntent;
    video_build_id?: number;
  };
  
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // 全体をtry-catchで囲んでエラーを詳細にログ
  try {
    // 1. Intent スキーマ確認
    if (!body.intent || body.intent.schema !== 'rilarc_intent_v1') {
    return c.json({ 
      error: 'Invalid intent schema. Expected: rilarc_intent_v1',
      received: body.intent?.schema,
    }, 400);
  }

  if (!body.intent.actions || body.intent.actions.length === 0) {
    return c.json({ error: 'No actions in intent' }, 400);
  }

  // 2. プロジェクト存在確認
  const project = await c.env.DB.prepare(
    'SELECT id FROM projects WHERE id = ?'
  ).bind(projectId).first();
  
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  // 3. Intent → SafeOps 変換
  const resolution = await resolveIntentToOps(c.env.DB, projectId, body.intent);
  
  if (!resolution.ok) {
    return c.json({
      ok: false,
      stage: 'intent_resolution',
      errors: resolution.errors,
      warnings: resolution.warnings,
      resolution_log: resolution.resolution_log,
    }, 400);
  }

  // 4. 既存の dry-run 実行
  const patchRequest: PatchRequest = {
    schema: 'ssot_patch_v1',
    target: {
      project_id: projectId,
      video_build_id: body.video_build_id,
    },
    intent: {
      user_message: body.user_message,
      parsed_intent: body.intent as unknown as Record<string, unknown>,
    },
    ops: resolution.ops,
  };

  // 基本バリデーション
  // PR-5-3b: telopアクションのみの場合はopsが空でもOK（telop_settings_overrideで処理）
  const hasTelopOverrideOnly = resolution.ops.length === 0 && resolution.telop_settings_override;
  
  if (!hasTelopOverrideOnly) {
    const validation = validatePatchRequest(patchRequest, projectId);
    if (!validation.valid) {
      return c.json({
        ok: false,
        stage: 'validation',
        errors: validation.errors,
        warnings: [...resolution.warnings, ...validation.warnings],
        resolution_log: resolution.resolution_log,
      }, 400);
    }
  }

  // Dry-run実行
  // PR-5-3b: telopアクションのみの場合はdry-runをスキップして成功扱い
  let dryRunResult: { ok: boolean; plan: unknown[]; errors: string[]; warnings: string[] };
  
  if (hasTelopOverrideOnly) {
    // telopアクションのみ: dry-runは不要、直接成功
    dryRunResult = {
      ok: true,
      plan: [],
      errors: [],
      warnings: [],
    };
  } else {
    dryRunResult = await executeDryRun(c.env.DB, projectId, patchRequest);
  }

  // patch_requestsに記録
  // PR-5-3b: テロップ設定のオーバーライドも保存
  const status = dryRunResult.ok ? 'dry_run_ok' : 'dry_run_failed';
  const dryRunResultWithTelop = {
    ...dryRunResult,
    telop_settings_override: resolution.telop_settings_override,
  };
  
  const insertResult = await c.env.DB.prepare(`
    INSERT INTO patch_requests (
      project_id, video_build_id, source, user_message, 
      parsed_intent_json, ops_json, dry_run_result_json, status
    ) VALUES (?, ?, 'chat', ?, ?, ?, ?, ?)
  `).bind(
    projectId,
    body.video_build_id || null,
    body.user_message,
    JSON.stringify(body.intent),
    JSON.stringify(resolution.ops),
    JSON.stringify(dryRunResultWithTelop),
    status
  ).run();

  const patchRequestId = insertResult.meta.last_row_id;

  // UI用のサマリー生成（テロップ設定のサマリーも含む）
  const summary = generateDiffSummary(dryRunResult, body.intent, resolution.telop_settings_override);

  // PR-5-3b: telopアクションの数もresolved_opsに含める
  const telopActionCount = resolution.telop_settings_override ? 
    (resolution.telop_settings_override.enabled !== undefined ? 1 : 0) +
    Object.keys(resolution.telop_settings_override.scene_overrides || {}).length +
    (resolution.telop_settings_override.position_preset ? 1 : 0) +
    (resolution.telop_settings_override.size_preset ? 1 : 0)
    : 0;

  return c.json({
    ok: dryRunResult.ok,
    patch_request_id: patchRequestId,
    status,
    intent_actions: body.intent.actions.length,
    resolved_ops: resolution.ops.length + telopActionCount,
    resolution_log: resolution.resolution_log,
    plan: dryRunResult.plan,
    summary,
    errors: [...resolution.errors, ...dryRunResult.errors],
    warnings: [...resolution.warnings, ...dryRunResult.warnings],
    // PR-5-3b: テロップ設定のオーバーライド
    telop_settings_override: resolution.telop_settings_override,
  });
  } catch (error) {
    // 詳細なエラーログ
    console.error('[chat-edits/dry-run] Error:', {
      projectId,
      user_message: body?.user_message,
      intent: body?.intent,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return c.json({ 
      error: 'Internal server error during dry-run',
      details: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});

/**
 * POST /api/projects/:projectId/chat-edits/apply
 * 
 * チャット修正の適用
 * - dry-run 済みの patch_request_id を受け取る
 * - 既存の patches/apply と同等の処理
 */
patches.post('/projects/:projectId/chat-edits/apply', async (c) => {
  const projectId = parseInt(c.req.param('projectId'), 10);
  if (isNaN(projectId)) {
    return c.json({ error: 'Invalid project ID' }, 400);
  }

  let body: { patch_request_id: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.patch_request_id) {
    return c.json({ error: 'patch_request_id is required' }, 400);
  }

  // 既存の dry-run済みリクエストを取得
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

  // source が chat であることを確認
  if (existing.source !== 'chat') {
    return c.json({ 
      error: `This endpoint is for chat edits only. Source: ${existing.source}` 
    }, 400);
  }

  const patchRequest: PatchRequest = {
    schema: 'ssot_patch_v1',
    target: {
      project_id: existing.project_id as number,
      video_build_id: existing.video_build_id as number | undefined,
    },
    intent: {
      user_message: existing.user_message as string,
    },
    ops: JSON.parse(existing.ops_json as string),
  };

  // PR-5-3b: dry_run_result_jsonからテロップ設定のオーバーライドを取得
  let telopSettingsOverride: TelopSettingsOverride | undefined;
  try {
    const dryRunResult = JSON.parse(existing.dry_run_result_json as string);
    telopSettingsOverride = dryRunResult.telop_settings_override;
  } catch { /* ignore */ }

  // Apply実行
  const result = await executeApply(c.env.DB, body.patch_request_id, patchRequest);

  // patch_requestsを更新
  const applyStatus = result.ok ? 'apply_ok' : 'apply_failed';
  await c.env.DB.prepare(`
    UPDATE patch_requests 
    SET apply_result_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    JSON.stringify(result),
    applyStatus,
    body.patch_request_id
  ).run();

  // Usage logging: Chat edit apply
  try {
    const projectForLog = await c.env.DB.prepare(
      'SELECT user_id FROM projects WHERE id = ?'
    ).bind(projectId).first<{ user_id: number | null }>();
    
    const resolvedUserId = projectForLog?.user_id;
    
    if (!resolvedUserId) {
      console.error(`[Chat Edit Apply] Cannot determine user_id for project=${projectId}, skipping usage log`);
    } else {
      const entities = [...new Set(patchRequest.ops.map(op => op.entity))];
      
      await logPatchOperation(c.env.DB, {
        userId: resolvedUserId,
        projectId,
        patchRequestId: body.patch_request_id,
        operation: 'apply',
        source: 'chat',
        opsCount: patchRequest.ops.length,
        entities,
        newVideoBuildId: null, // 後で更新
        status: result.ok ? 'success' : 'failed',
        errorMessage: result.ok ? undefined : result.errors.join('; '),
      });
    }
  } catch (logError) {
    console.error('[Chat Edit Apply] Usage log failed:', logError);
  }

  // Apply失敗の場合は即座に返す
  if (!result.ok) {
    return c.json({
      ok: false,
      patch_request_id: body.patch_request_id,
      applied_count: result.applied_count,
      errors: result.errors,
      status: applyStatus,
    });
  }

  // ============================================================
  // Apply成功時に新ビルドを自動生成（既存のpatches/applyと同じロジック）
  // ============================================================
  
  let newVideoBuildId: number | null = null;
  let buildError: string | null = null;
  const sourceVideoBuildId = patchRequest.target.video_build_id || null;

  try {
    const project = await c.env.DB.prepare(`
      SELECT id, title, user_id FROM projects WHERE id = ?
    `).bind(projectId).first<{ id: number; title: string; user_id: number }>();

    if (!project) {
      throw new Error('Project not found');
    }

    const scenesWithAssets = await fetchScenesWithAssets(c.env.DB, projectId, c.env.SITE_URL);

    if (scenesWithAssets.length === 0) {
      throw new Error('No scenes found');
    }

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
        } catch { /* ignore */ }
      }
    }

    // PR-5-3b: テロップ設定のオーバーライドを適用
    if (telopSettingsOverride) {
      const existingTelops = (buildSettings.telops as Record<string, unknown>) || { enabled: true };
      buildSettings.telops = {
        ...existingTelops,
        ...(telopSettingsOverride.enabled !== undefined && { enabled: telopSettingsOverride.enabled }),
        ...(telopSettingsOverride.position_preset && { position_preset: telopSettingsOverride.position_preset }),
        ...(telopSettingsOverride.size_preset && { size_preset: telopSettingsOverride.size_preset }),
        // ★ シーン単位のテロップON/OFFを適用
        ...(telopSettingsOverride.scene_overrides && { scene_overrides: telopSettingsOverride.scene_overrides }),
      };
      console.log(`[Chat Edit Apply] Telop settings override applied:`, JSON.stringify(buildSettings.telops));
    }

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

    // user_id が NULL の場合はエラー（データ整合性違反）
    if (!project.user_id) {
      throw new Error(`Project ${projectId} has no user_id, cannot create video build`);
    }
    const ownerUserId = project.user_id;
    const executorUserId = project.user_id;

    const insertResult = await c.env.DB.prepare(`
      INSERT INTO video_builds (
        project_id, owner_user_id, executor_user_id, 
        settings_json, status, progress_stage, progress_message,
        total_scenes, total_duration_ms, project_json_version, project_json_hash,
        source_video_build_id, patch_request_id
      ) VALUES (?, ?, ?, ?, 'validating', 'Preparing', 'チャット修正後の新ビルド準備中...', ?, ?, '1.1', ?, ?, ?)
    `).bind(
      projectId,
      ownerUserId,
      executorUserId,
      JSON.stringify(buildSettings),
      scenesWithAssets.length,
      (projectJson as any).summary?.total_duration_ms ?? 0,
      projectJsonHash,
      sourceVideoBuildId,
      body.patch_request_id
    ).run();

    newVideoBuildId = insertResult.meta.last_row_id as number;

    const r2Key = `video-builds/${newVideoBuildId}/project.json`;
    await c.env.R2.put(r2Key, projectJsonString, {
      httpMetadata: { contentType: 'application/json' },
    });

    await c.env.DB.prepare(`
      UPDATE video_builds SET project_json_r2_key = ? WHERE id = ?
    `).bind(r2Key, newVideoBuildId).run();

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
        console.warn('[Chat Edit Apply] AWS Orchestrator call failed:', awsError);
        await c.env.DB.prepare(`
          UPDATE video_builds 
          SET status = 'queued', progress_message = 'AWS呼び出し保留中'
          WHERE id = ?
        `).bind(newVideoBuildId).run();
      }
    } else {
      await c.env.DB.prepare(`
        UPDATE video_builds 
        SET status = 'queued', progress_message = 'AWS設定なし（開発環境）'
        WHERE id = ?
      `).bind(newVideoBuildId).run();
    }

  } catch (buildGenError) {
    buildError = buildGenError instanceof Error ? buildGenError.message : String(buildGenError);
    console.error('[Chat Edit Apply] Video build generation error:', buildGenError);
  }

  return c.json({
    ok: true,
    patch_request_id: body.patch_request_id,
    applied_count: result.applied_count,
    errors: result.errors,
    status: applyStatus,
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
 * UI用のdiffサマリー生成
 */
function generateDiffSummary(
  dryRunResult: DryRunResult, 
  intent: RilarcIntent,
  telopSettingsOverride?: TelopSettingsOverride
): {
  description: string;
  changes: Array<{
    type: string;
    target: string;
    detail: string;
  }>;
} {
  const changes: Array<{ type: string; target: string; detail: string }> = [];

  for (let i = 0; i < intent.actions.length; i++) {
    const action = intent.actions[i];
    // plan が配列の場合は ops_normalized にアクセス、そうでなければ undefined
    const planObj = dryRunResult.plan as { ops_normalized?: unknown[] } | unknown[] | undefined;
    const normalizedOp = (planObj && !Array.isArray(planObj) && planObj.ops_normalized) 
      ? planObj.ops_normalized[i] 
      : undefined;

    if (action.action.startsWith('balloon.')) {
      const balloonAction = action as BalloonAdjustWindowAction | BalloonAdjustPositionAction;
      let detail = '';
      
      if (action.action === 'balloon.adjust_window') {
        const wa = action as BalloonAdjustWindowAction;
        if (wa.delta_start_ms) detail += `開始: ${wa.delta_start_ms > 0 ? '+' : ''}${wa.delta_start_ms}ms `;
        if (wa.delta_end_ms) detail += `終了: ${wa.delta_end_ms > 0 ? '+' : ''}${wa.delta_end_ms}ms `;
        if (wa.absolute_start_ms !== undefined) detail += `開始: ${wa.absolute_start_ms}ms `;
        if (wa.absolute_end_ms !== undefined) detail += `終了: ${wa.absolute_end_ms}ms `;
      } else {
        const pa = action as BalloonAdjustPositionAction;
        if (pa.delta_x) detail += `X: ${pa.delta_x > 0 ? '+' : ''}${(pa.delta_x * 100).toFixed(1)}% `;
        if (pa.delta_y) detail += `Y: ${pa.delta_y > 0 ? '+' : ''}${(pa.delta_y * 100).toFixed(1)}% `;
      }

      changes.push({
        type: 'balloon',
        target: `シーン${balloonAction.scene_idx} / バブル${balloonAction.balloon_no}`,
        detail: detail.trim() || '変更なし',
      });

    } else if (action.action.startsWith('sfx.')) {
      if (action.action === 'sfx.set_volume') {
        const va = action as SfxSetVolumeAction;
        changes.push({
          type: 'sfx',
          target: `シーン${va.scene_idx} / SFX${va.cue_no}`,
          detail: `音量: ${Math.round(va.volume * 100)}%`,
        });
      } else if (action.action === 'sfx.set_timing') {
        const ta = action as SfxSetTimingAction;
        let detail = '';
        if (ta.delta_start_ms) detail += `開始: ${ta.delta_start_ms > 0 ? '+' : ''}${ta.delta_start_ms}ms `;
        if (ta.absolute_start_ms !== undefined) detail += `開始: ${ta.absolute_start_ms}ms `;
        changes.push({
          type: 'sfx',
          target: `シーン${ta.scene_idx} / SFX${ta.cue_no}`,
          detail: detail.trim() || 'タイミング変更',
        });
      } else if (action.action === 'sfx.remove') {
        const ra = action as SfxRemoveAction;
        changes.push({
          type: 'sfx',
          target: `シーン${ra.scene_idx} / SFX${ra.cue_no}`,
          detail: '削除',
        });
      } else if (action.action === 'sfx.add_from_library') {
        const aa = action as SfxAddFromLibraryAction;
        changes.push({
          type: 'sfx',
          target: `シーン${aa.scene_idx}`,
          detail: `追加: ${aa.sfx_library_id} @ ${aa.start_ms}ms`,
        });
      }

    } else if (action.action.startsWith('bgm.')) {
      if (action.action === 'bgm.set_volume') {
        const va = action as BgmSetVolumeAction;
        changes.push({
          type: 'bgm',
          target: 'BGM',
          detail: `音量: ${Math.round(va.volume * 100)}%`,
        });
      } else if (action.action === 'bgm.set_loop') {
        const la = action as BgmSetLoopAction;
        changes.push({
          type: 'bgm',
          target: 'BGM',
          detail: `ループ: ${la.loop ? 'ON' : 'OFF'}`,
        });
      }

    // PR-5-3b: テロップ設定アクション
    } else if (action.action.startsWith('telop.')) {
      if (action.action === 'telop.set_enabled') {
        const ta = action as TelopSetEnabledAction;
        changes.push({
          type: 'telop',
          target: 'テロップ（全体）',
          detail: ta.enabled ? '表示: ON' : '表示: OFF',
        });
      } else if (action.action === 'telop.set_enabled_scene') {
        const ta = action as TelopSetEnabledSceneAction;
        changes.push({
          type: 'telop',
          target: `シーン${ta.scene_idx}のテロップ`,
          detail: ta.enabled ? '表示: ON' : '表示: OFF',
        });
      } else if (action.action === 'telop.set_position') {
        const ta = action as TelopSetPositionAction;
        const posLabel = { bottom: '下', center: '中央', top: '上' }[ta.position_preset] || ta.position_preset;
        changes.push({
          type: 'telop',
          target: 'テロップ',
          detail: `位置: ${posLabel}`,
        });
      } else if (action.action === 'telop.set_size') {
        const ta = action as TelopSetSizeAction;
        const sizeLabel = { sm: '小', md: '中', lg: '大' }[ta.size_preset] || ta.size_preset;
        changes.push({
          type: 'telop',
          target: 'テロップ',
          detail: `サイズ: ${sizeLabel}`,
        });
      }
    }
  }

  // PR-5-3b: テロップ設定オーバーライドから追加のサマリー
  // （intentのactionsにない場合でも、オーバーライドとして設定されている場合を考慮）
  // 実際にはintentのactionsから生成されるため、ここでは重複チェックのみ

  const description = changes.length > 0
    ? `${changes.length}件の変更を適用します`
    : '変更なし';

  return { description, changes };
}

// ============================================================
// Phase C: AI Intent Parser
// - AIは「Intent JSONを作るだけ」
// - 適用可否は既存の resolveIntentToOps / dry-run で検証
// ============================================================

function safeJsonParseMaybe(text: string): any | null {
  if (!text) return null;
  // Try extract JSON block if model wrapped in text
  const m = text.match(/\{[\s\S]*\}/);
  const candidate = m ? m[0] : text;
  try { return JSON.parse(candidate); } catch { return null; }
}

function filterAllowedActions(actions: any[], allowed: Set<string>) {
  const filtered: any[] = [];
  const rejected: any[] = [];
  for (const a of actions || []) {
    const name = a?.action;
    if (!name || typeof name !== 'string') {
      rejected.push({ reason: 'missing action field', action: a });
      continue;
    }
    if (!allowed.has(name)) {
      rejected.push({ reason: 'action not allowed', action: a });
      continue;
    }
    filtered.push(a);
  }
  return { filtered, rejected };
}

async function geminiParseIntent(
  apiKey: string,
  userMessage: string,
  ctx: { scene_idx?: number; balloon_no?: number } | null
): Promise<{ ok: true; intent: any; rejected: any[] } | { ok: false; error: string; raw?: string }> {
  const allowedList = Array.from(ALLOWED_CHAT_ACTIONS);
  const ctxText = ctx?.scene_idx 
    ? `\nContext: scene_idx=${ctx.scene_idx}, balloon_no=${ctx.balloon_no ?? 1}\n` 
    : '\nContext: none\n';

  const system = `
You are a strict intent parser for a video editing tool.
Convert the user's instruction into JSON only (no markdown, no explanation).

Schema:
{
  "schema": "rilarc_intent_v1",
  "actions": [ ... ]
}

Allowed actions (MUST ONLY use these):
${allowedList.map(x => `- ${x}`).join('\n')}

Action schemas:
- balloon.adjust_window: { action, scene_idx, balloon_no, delta_start_ms?, delta_end_ms? }
- balloon.adjust_position: { action, scene_idx, balloon_no, delta_x?, delta_y? }
- balloon.set_policy: { action, scene_idx, balloon_no, policy: "voice_window"|"always_on"|"manual_window", start_ms?, end_ms? }
  * For manual_window with time range, convert seconds to ms (e.g., "3秒から5秒" -> start_ms: 3000, end_ms: 5000)
  * Supports: "X秒目からY秒目", "X秒〜Y秒", "X秒からY秒まで表示"
- sfx.set_volume: { action, scene_idx, cue_no, volume: 0-1 }
- bgm.set_volume: { action, volume: 0-1 }
- bgm.set_loop: { action, loop: boolean }
- telop.set_enabled: { action, enabled: boolean } (all scenes)
- telop.set_enabled_scene: { action, scene_idx, enabled: boolean } (specific scene only)
- telop.set_position: { action, position_preset: "bottom"|"center"|"top" }
- telop.set_size: { action, size_preset: "sm"|"md"|"lg" }

Rules:
1) Output JSON only.
2) If user is ambiguous, choose the safest minimal change.
3) If scene/balloon is missing and needed, use the provided context.
4) Do not invent unsupported actions.
5) For volume percentages, convert to 0-1 scale (e.g., 20% -> 0.2).
6) For time ranges in seconds, convert to milliseconds (e.g., "3秒から5秒" -> start_ms: 3000, end_ms: 5000).
7) **CRITICAL**: If the user's message is a greeting, question, casual chat, or NOT related to video editing (e.g., "よろしくね", "こんにちは", "ありがとう", "どうすればいい?"), return EMPTY actions array: {"schema": "rilarc_intent_v1", "actions": []}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: system.trim() }] },
    contents: [{ role: 'user', parts: [{ text: `${ctxText}\nUser: ${userMessage}` }] }],
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 512,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  
  if (!res.ok) {
    const t = await res.text();
    return { ok: false, error: `Gemini API error: ${res.status} ${t.slice(0, 200)}` };
  }
  
  const data: any = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const parsed = safeJsonParseMaybe(text);
  
  if (!parsed || parsed.schema !== 'rilarc_intent_v1' || !Array.isArray(parsed.actions)) {
    return { ok: false, error: 'AI returned invalid intent JSON', raw: text.slice(0, 300) };
  }

  // Safety filter: only allow whitelisted actions
  const { filtered, rejected } = filterAllowedActions(parsed.actions, ALLOWED_CHAT_ACTIONS);
  parsed.actions = filtered;

  return { ok: true, intent: parsed, rejected };
}

/**
 * POST /api/projects/:projectId/chat-edits/parse-ai
 * 
 * AI Intent Parser (safe)
 * - AI only generates intent JSON
 * - Final safety is enforced by dry-run/apply
 */
patches.post('/projects/:projectId/chat-edits/parse-ai', async (c) => {
  try {
    const projectId = parseInt(c.req.param('projectId'), 10);
    if (isNaN(projectId)) {
      return c.json({ ok: false, error: 'Invalid projectId' }, 400);
    }

    const body = await c.req.json().catch(() => null) as any;
    const userMessage = body?.user_message;
    if (!userMessage || typeof userMessage !== 'string') {
      return c.json({ ok: false, error: 'user_message is required' }, 400);
    }

    // Check API key
    if (!c.env.GEMINI_API_KEY) {
      return c.json({ ok: false, error: 'GEMINI_API_KEY is not configured' }, 500);
    }

    const ctx = body?.context && typeof body.context === 'object'
      ? {
          scene_idx: typeof body.context.scene_idx === 'number' ? body.context.scene_idx : undefined,
          balloon_no: typeof body.context.balloon_no === 'number' ? body.context.balloon_no : undefined,
        }
      : null;

    // Call Gemini
    const result = await geminiParseIntent(c.env.GEMINI_API_KEY, userMessage, ctx);
    
    if (!result.ok) {
      return c.json({ 
        ok: false, 
        stage: 'ai_parse', 
        error: result.error, 
        raw: (result as any).raw 
      }, 400);
    }

    return c.json({
      ok: true,
      intent: result.intent,
      rejected_actions: result.rejected || [],
      note: 'Intent is AI-generated. Final safety is enforced by dry-run/apply.',
    });
    
  } catch (e: any) {
    console.error('[parse-ai] Error:', e);
    return c.json({ ok: false, error: e?.message || String(e) }, 500);
  }
});

/**
 * POST /api/projects/:projectId/chat-edits/chat
 * 
 * 会話SSOT: ChatGPT体験 - 3層構造
 * 1. Conversation: 常に自然文で返答
 * 2. Suggestion: 必要時のみ編集提案を追加
 * 3. Execution: ユーザー確認後にdry-run/apply
 * 
 * リクエスト:
 * {
 *   user_message: string,
 *   context?: { scene_idx?: number, balloon_no?: number, video_build_id?: number },
 *   history?: Array<{ role: 'user'|'assistant', content: string }>,
 *   options?: { auto_suggest?: boolean }
 * }
 * 
 * レスポンス:
 * {
 *   ok: true,
 *   assistant_message: string,  // 必須: 会話返答
 *   suggestion?: {              // 任意: 編集提案
 *     needs_confirmation: boolean,
 *     summary: string,
 *     intent: { schema: 'rilarc_intent_v1', actions: [] },
 *     rejected_actions?: []
 *   }
 * }
 */
// SSOT: 強化版コンテキスト型定義
interface ChatContext {
  scene_idx?: number;
  balloon_no?: number;
  video_build_id?: number;
  has_bgm?: boolean;
  has_sfx?: boolean;
  has_system_bgm?: boolean;
  has_system_sfx?: boolean;
  // SSOT: 現在シーンの詳細情報
  current_scene?: {
    has_image?: boolean;
    has_audio?: boolean;
    telop_enabled?: boolean;
    balloon_count?: number;
    sfx_count?: number;
    // P7: シーン別BGM/SFX情報
    has_scene_bgm?: boolean;          // シーン別BGMがあるか
    scene_bgm_volume?: number | null; // シーンBGM音量（0-1）
    scene_sfx_count?: number;         // シーン別SFX数
  } | null;
  total_scenes?: number | null;
  playback_time_ms?: number | null;
}

async function geminiChatWithSuggestion(
  apiKey: string,
  userMessage: string,
  ctx: ChatContext | null,
  history: Array<{ role: 'user' | 'assistant'; content: string }> = []
): Promise<{
  ok: true;
  assistant_message: string;
  suggestion: {
    needs_confirmation: boolean;
    summary: string;
    intent: any;
    rejected_actions: any[];
  } | null;
} | { ok: false; error: string }> {
  const allowedList = Array.from(ALLOWED_CHAT_ACTIONS);
  
  // Build context text including asset status
  let ctxText = ctx?.scene_idx 
    ? `現在の文脈: シーン${ctx.scene_idx}${ctx.balloon_no ? `, バブル${ctx.balloon_no}` : ''}${ctx.video_build_id ? `, ビルド#${ctx.video_build_id}` : ''}`
    : '文脈: なし';
  
  // SSOT: 現在シーンの詳細情報を追加
  if (ctx?.current_scene) {
    const cs = ctx.current_scene;
    const sceneDetails: string[] = [];
    if (cs.has_image === true) sceneDetails.push('画像あり');
    if (cs.has_image === false) sceneDetails.push('画像なし');
    if (cs.has_audio === true) sceneDetails.push('音声あり');
    if (cs.has_audio === false) sceneDetails.push('音声なし');
    if (cs.telop_enabled === true) sceneDetails.push('テロップON');
    if (cs.telop_enabled === false) sceneDetails.push('テロップOFF');
    if (cs.balloon_count != null) sceneDetails.push(`バブル${cs.balloon_count}個`);
    if (cs.sfx_count != null) sceneDetails.push(`SFX${cs.sfx_count}個`);
    
    if (sceneDetails.length > 0) {
      ctxText += `\n現在シーンの状態: ${sceneDetails.join(', ')}`;
    }
  }
  
  // プロジェクト全体情報
  if (ctx?.total_scenes) {
    ctxText += `\n全シーン数: ${ctx.total_scenes}`;
  }
  
  // Phase 1: 素材状態をコンテキストに追加
  const assetStatus: string[] = [];
  if (ctx?.has_bgm === false) assetStatus.push('BGMなし（未アップロード）');
  if (ctx?.has_bgm === true) assetStatus.push('BGMあり');
  if (ctx?.has_sfx === false) assetStatus.push('SFXなし');
  if (ctx?.has_sfx === true) assetStatus.push('SFXあり');
  
  // Phase 2: システムライブラリの存在を追加
  if (ctx?.has_system_bgm === true) assetStatus.push('システムBGMライブラリあり');
  if (ctx?.has_system_sfx === true) assetStatus.push('システムSFXライブラリあり');
  
  if (assetStatus.length > 0) {
    ctxText += `\n素材状態: ${assetStatus.join(', ')}`;
  }

  const system = `
あなたは動画編集アシスタント「Rilarc」です。フレンドリーで親しみやすい口調で、ユーザーと自然に会話しながら編集をサポートします。

【キャラクター設定】
- 親しみやすく、でも丁寧
- 次のアクションに自然に誘導する
- 困っていそうなら具体例を出す
- 「！」を適度に使って明るく

【重要な役割】
1. 会話を自然に: 挨拶、質問、雑談には普通に会話として返答し、**次のアクションに誘導**
2. 編集提案は必要時のみ: 明確な編集指示があった場合のみ提案を生成
3. 確認を取る: 提案は「〜しましょうか？」と確認形式で
4. 曖昧なら質問: 「どのシーンですか？」「どのくらい下げますか？」など

【レスポンス形式】
必ず以下のJSON形式で返してください（他のテキストは不要）:
{
  "assistant_message": "自然な会話返答（必須）",
  "has_suggestion": true/false,
  "suggestion_summary": "Before → After形式の要約（提案時のみ）",
  "intent": {
    "schema": "rilarc_intent_v1",
    "actions": [...]
  }
}

【使用可能なアクション】
${allowedList.map(x => `- ${x}`).join('\n')}

【アクションスキーマ】
- balloon.adjust_window: { action, scene_idx, balloon_no, delta_start_ms?, delta_end_ms? }
- balloon.set_policy: { action, scene_idx, balloon_no, policy: "voice_window"|"always_on"|"manual_window", start_ms?, end_ms? }
- sfx.set_volume: { action, scene_idx, cue_no, volume: 0-1 }  ※プロジェクト全体SFX
- bgm.set_volume: { action, volume: 0-1 }  ※プロジェクト全体BGM
- bgm.set_loop: { action, loop: boolean }
- telop.set_enabled: { action, enabled: boolean } (全シーン一括)
- telop.set_enabled_scene: { action, scene_idx, enabled: boolean } (特定シーンのみ)
- telop.set_position: { action, position_preset: "bottom"|"center"|"top" }
- telop.set_size: { action, size_preset: "sm"|"md"|"lg" }

【P7: シーン別BGM/SFX操作 - NEW!】
- scene_bgm.set_volume: { action, scene_idx, volume: 0-1 }  ※特定シーンのBGM音量
- scene_bgm.set_timing: { action, scene_idx, start_ms?, end_ms?, delta_start_ms?, delta_end_ms? }  ※BGMのフェードイン/アウトタイミング
- scene_bgm.assign: { action, scene_idx, source_type: "system"|"user"|"copy_from_scene", system_audio_id?, user_audio_id?, copy_from_scene_idx?, volume?, loop? }  ※新規割当
- scene_bgm.remove: { action, scene_idx }  ※シーンBGMを削除（全体BGMに戻す）
- scene_sfx.set_volume: { action, scene_idx, sfx_no: 1-N, volume: 0-1 }  ※特定シーンの特定SFX
- scene_sfx.set_timing: { action, scene_idx, sfx_no: 1-N, start_ms?, end_ms?, delta_start_ms?, delta_end_ms? }  ※SFXのタイミング調整

【会話例 - 挨拶・雑談（次のアクションに誘導）】
ユーザー: よろしくね
→ {"assistant_message": "よろしくお願いします！今どんな動画を編集中ですか？気になるところがあれば教えてくださいね！", "has_suggestion": false, "intent": {"schema": "rilarc_intent_v1", "actions": []}}

ユーザー: ありがとう
→ {"assistant_message": "いえいえ！他に調整したいところがあれば、いつでも声かけてくださいね！", "has_suggestion": false, "intent": {"schema": "rilarc_intent_v1", "actions": []}}

ユーザー: どうすればいい？
→ {"assistant_message": "例えば「BGMを小さく」「吹き出しを声に合わせて」「テロップを大きく」などの指示ができますよ！どこから始めましょうか？", "has_suggestion": false, "intent": {"schema": "rilarc_intent_v1", "actions": []}}

ユーザー: 何ができるの？
→ {"assistant_message": "BGMの音量調整、吹き出しの表示タイミング変更、テロップの位置やサイズ変更などができます！「BGMがうるさい」「吹き出しを早く出して」みたいに話しかけてみてください！", "has_suggestion": false, "intent": {"schema": "rilarc_intent_v1", "actions": []}}

【会話例 - 編集提案（Before→After形式）】
ユーザー: BGMがちょっとうるさいかも
→ {"assistant_message": "BGMの音量を下げましょうか？20%くらいに調整するのはいかがでしょう？", "has_suggestion": true, "suggestion_summary": "BGM音量: 100% → 20%", "intent": {"schema": "rilarc_intent_v1", "actions": [{"action": "bgm.set_volume", "volume": 0.2}]}}

ユーザー: このシーンの吹き出し、声に合わせて表示したい
→ {"assistant_message": "シーン${ctx?.scene_idx || 1}のバブル${ctx?.balloon_no || 1}を、音声に合わせて表示するように設定しましょうか？セリフが始まるタイミングで自動的に表示されるようになります！", "has_suggestion": true, "suggestion_summary": "バブル表示: 固定 → 音声同期", "intent": {"schema": "rilarc_intent_v1", "actions": [{"action": "balloon.set_policy", "scene_idx": ${ctx?.scene_idx || 1}, "balloon_no": ${ctx?.balloon_no || 1}, "policy": "voice_window"}]}}

ユーザー: テロップ見にくい
→ {"assistant_message": "テロップを大きくしましょうか？位置も中央に移動できますよ！", "has_suggestion": true, "suggestion_summary": "テロップサイズ: 標準 → 大", "intent": {"schema": "rilarc_intent_v1", "actions": [{"action": "telop.set_size", "size_preset": "lg"}]}}

ユーザー: テロップと漫画の内容が重なってる
→ {"assistant_message": "シーン${ctx?.scene_idx || 1}のテロップを非表示にしましょうか？画像にすでにテキストがある場合は、Remotion側のテロップをOFFにすると見やすくなりますよ！", "has_suggestion": true, "suggestion_summary": "シーン${ctx?.scene_idx || 1}のテロップ: ON → OFF", "intent": {"schema": "rilarc_intent_v1", "actions": [{"action": "telop.set_enabled_scene", "scene_idx": ${ctx?.scene_idx || 1}, "enabled": false}]}}

ユーザー: シーン1のテロップを消して
→ {"assistant_message": "シーン1のテロップを非表示にしますね！", "has_suggestion": true, "suggestion_summary": "シーン1のテロップ: ON → OFF", "intent": {"schema": "rilarc_intent_v1", "actions": [{"action": "telop.set_enabled_scene", "scene_idx": 1, "enabled": false}]}}

ユーザー: このシーンだけテロップOFF
→ {"assistant_message": "シーン${ctx?.scene_idx || 1}のテロップを非表示にしましょうか？他のシーンはそのままです！", "has_suggestion": true, "suggestion_summary": "シーン${ctx?.scene_idx || 1}のテロップ: ON → OFF", "intent": {"schema": "rilarc_intent_v1", "actions": [{"action": "telop.set_enabled_scene", "scene_idx": ${ctx?.scene_idx || 1}, "enabled": false}]}}

【P7: シーン別BGM/SFX操作の会話例 - NEW!】
ユーザー: このシーンのBGMを小さくして
→ {"assistant_message": "シーン${ctx?.scene_idx || 1}のBGM音量を下げましょうか？15%くらいに調整するのはいかがでしょう？", "has_suggestion": true, "suggestion_summary": "シーン${ctx?.scene_idx || 1}のBGM音量: 現在 → 15%", "intent": {"schema": "rilarc_intent_v1", "actions": [{"action": "scene_bgm.set_volume", "scene_idx": ${ctx?.scene_idx || 1}, "volume": 0.15}]}}

ユーザー: このシーンのBGMを10秒で消して
→ {"assistant_message": "シーン${ctx?.scene_idx || 1}のBGMを10秒でフェードアウトさせましょうか？", "has_suggestion": true, "suggestion_summary": "シーン${ctx?.scene_idx || 1}のBGM終了: 10秒後", "intent": {"schema": "rilarc_intent_v1", "actions": [{"action": "scene_bgm.set_timing", "scene_idx": ${ctx?.scene_idx || 1}, "end_ms": 10000}]}}

ユーザー: 前のシーンのBGMをここで使って
→ {"assistant_message": "シーン${(ctx?.scene_idx || 1) - 1}のBGMをシーン${ctx?.scene_idx || 1}にコピーしましょうか？", "has_suggestion": true, "suggestion_summary": "シーン${ctx?.scene_idx || 1}にBGMをコピー", "intent": {"schema": "rilarc_intent_v1", "actions": [{"action": "scene_bgm.assign", "scene_idx": ${ctx?.scene_idx || 1}, "source_type": "copy_from_scene", "copy_from_scene_idx": ${(ctx?.scene_idx || 1) - 1}}]}}

ユーザー: このシーンのBGMを削除して
→ {"assistant_message": "シーン${ctx?.scene_idx || 1}のシーン別BGMを削除しますね！全体BGMに戻ります。", "has_suggestion": true, "suggestion_summary": "シーン${ctx?.scene_idx || 1}のシーンBGM: 削除", "intent": {"schema": "rilarc_intent_v1", "actions": [{"action": "scene_bgm.remove", "scene_idx": ${ctx?.scene_idx || 1}}]}}

ユーザー: 効果音の2番目を小さく
→ {"assistant_message": "シーン${ctx?.scene_idx || 1}の2番目の効果音の音量を下げましょうか？30%くらいに調整するのはいかがでしょう？", "has_suggestion": true, "suggestion_summary": "シーン${ctx?.scene_idx || 1}のSFX#2音量: 現在 → 30%", "intent": {"schema": "rilarc_intent_v1", "actions": [{"action": "scene_sfx.set_volume", "scene_idx": ${ctx?.scene_idx || 1}, "sfx_no": 2, "volume": 0.3}]}}

ユーザー: 効果音#1を3秒遅らせて
→ {"assistant_message": "シーン${ctx?.scene_idx || 1}の1番目の効果音を3秒遅らせましょうか？", "has_suggestion": true, "suggestion_summary": "シーン${ctx?.scene_idx || 1}のSFX#1: +3秒", "intent": {"schema": "rilarc_intent_v1", "actions": [{"action": "scene_sfx.set_timing", "scene_idx": ${ctx?.scene_idx || 1}, "sfx_no": 1, "delta_start_ms": 3000}]}}

【BGM音量変更の使い分け - 重要】
- bgm.set_volume: プロジェクト全体のBGM音量を変更（全シーンに影響）
- scene_bgm.set_volume: 特定シーンのみBGM音量を変更（そのシーンだけ）
ユーザーが「このシーンの」「ここの」などと言った場合は scene_bgm.set_volume を使う
ユーザーが「全体の」「BGM全部」などと言った場合は bgm.set_volume を使う

【文脈情報】
${ctxText}

【素材がない場合の対応 - 重要】
素材状態に「BGMなし」「SFXなし」がある場合、それらを追加・調整する提案は行わず、アップロード誘導をしてください。

例1: 素材状態に「BGMなし」があり、ユーザーが「BGMを追加して」と言った場合
→ {"assistant_message": "BGMを追加したいですね！まだBGMがアップロードされていないので、先にBGMをアップロードしましょう。\\n\\n📁 Video Build タブ → BGM設定 からアップロードできます。\\n\\n【おすすめフリーBGMサイト】\\n・DOVA-SYNDROME (dova-s.jp)\\n・甘茶の音楽工房\\n・魔王魂\\n\\nアップロードしたら教えてくださいね！", "has_suggestion": false, "intent": {"schema": "rilarc_intent_v1", "actions": []}}

例2: 素材状態に「BGMなし」があり、ユーザーが「BGMを大きくして」と言った場合
→ {"assistant_message": "BGMの音量を上げたいですね！ただ、まだBGMがアップロードされていないみたいです。先にBGMをアップロードしてから調整しましょう！\\n\\n📁 Video Build タブ → BGM設定 からアップロードできますよ。", "has_suggestion": false, "intent": {"schema": "rilarc_intent_v1", "actions": []}}

例3: 素材状態に「SFXなし」があり、ユーザーが「効果音を追加して」と言った場合
→ {"assistant_message": "効果音を追加したいですね！まだ効果音がないので、まずはSFXを設定しましょう。\\n\\nBuilder タブ → 各シーンの「🔊 SFX」から追加できます。\\n\\n【おすすめフリーSFXサイト】\\n・効果音ラボ\\n・OtoLogic\\n\\n設定したら教えてくださいね！", "has_suggestion": false, "intent": {"schema": "rilarc_intent_v1", "actions": []}}

【システムライブラリがある場合 - Phase 2】
素材状態に「システムBGMライブラリあり」または「システムSFXライブラリあり」がある場合、素材がなくてもシステムライブラリから選べることを提案できます。

例4: 素材状態に「BGMなし」と「システムBGMライブラリあり」があり、ユーザーが「BGMを追加して」と言った場合
→ {"assistant_message": "BGMを追加しましょう！\\n\\n🎵 システムライブラリにBGMが用意されています！\\n\\nVideo Build タブ → BGM設定 → 「ライブラリから選ぶ」で、いくつかのBGMから選べますよ。明るい曲、落ち着いた曲など、動画の雰囲気に合わせて選んでみてください！\\n\\nもちろん、自分でアップロードすることもできます。", "has_suggestion": false, "intent": {"schema": "rilarc_intent_v1", "actions": []}}

例5: 素材状態に「SFXなし」と「システムSFXライブラリあり」があり、ユーザーが「効果音を追加して」と言った場合
→ {"assistant_message": "効果音を追加しましょう！\\n\\n🔊 システムライブラリにSFXが用意されています！\\n\\nBuilder タブ → 各シーンの「🔊 SFX」→「ライブラリから選ぶ」で、驚き・笑い・環境音などから選べますよ！\\n\\n追加したいシーンを教えてもらえれば、具体的にご案内しますね！", "has_suggestion": false, "intent": {"schema": "rilarc_intent_v1", "actions": []}}

【SSOT: 代名詞の解決ルール - 超重要】
- 「このシーン」「ここ」「今の」→ 文脈情報の scene_idx を使う
- 「この画像」「今の画像」→ 現在シーンの画像
- 「このテロップ」→ 現在シーンのテロップ
- scene_idx が明示されていない場合、必ず文脈のシーン番号を使う

例: 文脈が「シーン3」の場合
ユーザー: ここのテロップを消して
→ {"assistant_message": "シーン3のテロップを非表示にしますね！", "has_suggestion": true, "suggestion_summary": "シーン3のテロップ: ON → OFF", "intent": {"schema": "rilarc_intent_v1", "actions": [{"action": "telop.set_enabled_scene", "scene_idx": 3, "enabled": false}]}}

例: 文脈が「シーン5」で、現在シーンにバブルが2個ある場合
ユーザー: このセリフを常時表示にして
→ {"assistant_message": "シーン5のバブルを常時表示にしますか？1番目と2番目、どちらのバブルですか？", "has_suggestion": false, "intent": {"schema": "rilarc_intent_v1", "actions": []}}

【注意事項】
- 必ずJSON形式のみで返す（マークダウンや説明文は不要）
- 挨拶や雑談には会話のみ返す（actions は空配列）、ただし**次のアクションに自然に誘導**
- 編集指示が曖昧な場合は質問で確認
- suggestion_summaryは「Before → After」形式で書く
- 音量は0-1の範囲（パーセントは変換）
- 時間はミリ秒（秒は変換: 3秒 → 3000ms）
- **素材がない場合**: システムライブラリがあれば案内、なければアップロード誘導
- **「このシーン」「ここ」は必ず文脈のscene_idxを使う**（勝手に番号を推測しない）
`;

  // Build conversation history for Gemini
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  
  // Add history (max 10 turns)
  const recentHistory = history.slice(-20); // 10 turns = 20 messages
  for (const msg of recentHistory) {
    contents.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    });
  }
  
  // Add current message
  contents.push({
    role: 'user',
    parts: [{ text: userMessage }]
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: system.trim() }] },
    contents,
    generationConfig: {
      temperature: 0.7, // Slightly higher for more natural conversation
      topP: 0.9,
      maxOutputTokens: 1024,
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, error: `Gemini API error: ${res.status} ${t.slice(0, 200)}` };
    }
    
    const data: any = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    // Parse JSON response
    const parsed = safeJsonParseMaybe(text);
    
    if (!parsed || typeof parsed.assistant_message !== 'string') {
      // Fallback: treat the raw text as a message
      return {
        ok: true,
        assistant_message: text || '申し訳ありません、応答を生成できませんでした。',
        suggestion: null,
      };
    }

    // Build response
    let suggestion = null;
    if (parsed.has_suggestion && parsed.intent?.actions?.length > 0) {
      // Safety filter
      const { filtered, rejected } = filterAllowedActions(parsed.intent.actions, ALLOWED_CHAT_ACTIONS);
      parsed.intent.actions = filtered;
      
      if (filtered.length > 0) {
        suggestion = {
          needs_confirmation: true,
          summary: parsed.suggestion_summary || '編集提案',
          intent: parsed.intent,
          rejected_actions: rejected,
        };
      }
    }

    return {
      ok: true,
      assistant_message: parsed.assistant_message,
      suggestion,
    };
    
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

patches.post('/projects/:projectId/chat-edits/chat', async (c) => {
  try {
    const projectId = parseInt(c.req.param('projectId'), 10);
    if (isNaN(projectId)) {
      return c.json({ ok: false, error: 'Invalid projectId' }, 400);
    }

    const body = await c.req.json().catch(() => null) as any;
    const userMessage = body?.user_message;
    if (!userMessage || typeof userMessage !== 'string') {
      return c.json({ ok: false, error: 'user_message is required' }, 400);
    }

    // Check API key
    if (!c.env.GEMINI_API_KEY) {
      return c.json({ ok: false, error: 'GEMINI_API_KEY is not configured' }, 500);
    }

    // Phase 1: プロジェクトの素材状態を確認
    const bgmTrack = await c.env.DB.prepare(`
      SELECT id FROM project_audio_tracks 
      WHERE project_id = ? AND track_type = 'bgm' AND is_active = 1
    `).bind(projectId).first();
    
    const sfxCount = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM scene_audio_cues 
      WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
    `).bind(projectId).first() as { count: number } | null;
    
    const hasBgm = !!bgmTrack;
    const hasSfx = (sfxCount?.count || 0) > 0;

    // Phase 2: システムライブラリの存在を確認
    const systemBgmCount = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM system_audio_library 
      WHERE audio_type = 'bgm' AND is_active = 1
    `).first() as { count: number } | null;
    
    const systemSfxCount = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM system_audio_library 
      WHERE audio_type = 'sfx' AND is_active = 1
    `).first() as { count: number } | null;
    
    const hasSystemBgm = (systemBgmCount?.count || 0) > 0;
    const hasSystemSfx = (systemSfxCount?.count || 0) > 0;

    // Parse context with asset status + SSOT current_scene
    const ctx: ChatContext = body?.context && typeof body.context === 'object'
      ? {
          scene_idx: typeof body.context.scene_idx === 'number' ? body.context.scene_idx : undefined,
          balloon_no: typeof body.context.balloon_no === 'number' ? body.context.balloon_no : undefined,
          video_build_id: typeof body.context.video_build_id === 'number' ? body.context.video_build_id : undefined,
          has_bgm: hasBgm,
          has_sfx: hasSfx,
          has_system_bgm: hasSystemBgm,
          has_system_sfx: hasSystemSfx,
          // SSOT: 現在シーンの詳細情報
          current_scene: body.context.current_scene && typeof body.context.current_scene === 'object'
            ? {
                has_image: typeof body.context.current_scene.has_image === 'boolean' ? body.context.current_scene.has_image : undefined,
                has_audio: typeof body.context.current_scene.has_audio === 'boolean' ? body.context.current_scene.has_audio : undefined,
                telop_enabled: typeof body.context.current_scene.telop_enabled === 'boolean' ? body.context.current_scene.telop_enabled : undefined,
                balloon_count: typeof body.context.current_scene.balloon_count === 'number' ? body.context.current_scene.balloon_count : undefined,
                sfx_count: typeof body.context.current_scene.sfx_count === 'number' ? body.context.current_scene.sfx_count : undefined,
              }
            : null,
          total_scenes: typeof body.context.total_scenes === 'number' ? body.context.total_scenes : null,
          playback_time_ms: typeof body.context.playback_time_ms === 'number' ? body.context.playback_time_ms : null,
        }
      : { has_bgm: hasBgm, has_sfx: hasSfx, has_system_bgm: hasSystemBgm, has_system_sfx: hasSystemSfx };

    // Parse history
    const history = Array.isArray(body?.history) 
      ? body.history.filter((h: any) => 
          h && typeof h.role === 'string' && typeof h.content === 'string' &&
          (h.role === 'user' || h.role === 'assistant')
        )
      : [];

    // Call Gemini with conversation context
    const result = await geminiChatWithSuggestion(c.env.GEMINI_API_KEY, userMessage, ctx, history);
    
    if (!result.ok) {
      return c.json({ 
        ok: false, 
        stage: 'chat_ai', 
        error: result.error 
      }, 400);
    }

    return c.json({
      ok: true,
      assistant_message: result.assistant_message,
      suggestion: result.suggestion,
    });
    
  } catch (e: any) {
    console.error('[chat-edits/chat] Error:', e);
    return c.json({ ok: false, error: e?.message || String(e) }, 500);
  }
});

// ====================================================================
// GET /api/system-audio - システムオーディオライブラリ（公開API）
// ====================================================================
// 認証不要でアクセス可能
// ユーザーがChat Edit機能でBGM/SFXを選択する際に使用

patches.get('/system-audio', async (c) => {
  const { DB } = c.env;
  const type = c.req.query('type'); // 'bgm' | 'sfx' | undefined (all)
  const mood = c.req.query('mood'); // 'bright', 'calm', 'dramatic', etc.
  
  try {
    let query = `
      SELECT 
        id, audio_type, name, description, category, mood, tags,
        file_url, duration_ms, thumbnail_url
      FROM system_audio_library
      WHERE is_active = 1
    `;
    
    const params: string[] = [];
    
    if (type && (type === 'bgm' || type === 'sfx')) {
      query += ' AND audio_type = ?';
      params.push(type);
    }
    
    if (mood) {
      query += ' AND mood = ?';
      params.push(mood);
    }
    
    query += ' ORDER BY sort_order ASC, name ASC';
    
    const result = await DB.prepare(query).bind(...params).all();
    
    return c.json({
      ok: true,
      audio: result.results || [],
    });
  } catch (error) {
    console.error('Get system audio error:', error);
    return c.json({ 
      ok: false, 
      error: error instanceof Error ? error.message : 'Failed to get system audio' 
    }, 500);
  }
});

// ====================================================================
// POST /api/projects/:projectId/system-audio/:audioId/apply - システムオーディオを適用
// ====================================================================
// 選択したシステムBGM/SFXをプロジェクトに追加

patches.post('/projects/:projectId/system-audio/:audioId/apply', async (c) => {
  const { DB } = c.env;
  const projectId = parseInt(c.req.param('projectId'), 10);
  const audioId = parseInt(c.req.param('audioId'), 10);
  
  if (isNaN(projectId) || isNaN(audioId)) {
    return c.json({ ok: false, error: 'Invalid projectId or audioId' }, 400);
  }
  
  try {
    // システムオーディオを取得
    const audio = await DB.prepare(`
      SELECT id, audio_type, name, file_url, duration_ms
      FROM system_audio_library
      WHERE id = ? AND is_active = 1
    `).bind(audioId).first<{
      id: number;
      audio_type: 'bgm' | 'sfx';
      name: string;
      file_url: string;
      duration_ms: number | null;
    }>();
    
    if (!audio) {
      return c.json({ ok: false, error: 'Audio not found in system library' }, 404);
    }
    
    if (audio.audio_type === 'bgm') {
      // BGMをプロジェクトに追加
      // 既存のBGMを非アクティブ化
      await DB.prepare(`
        UPDATE project_audio_tracks 
        SET is_active = 0, updated_at = datetime('now')
        WHERE project_id = ? AND track_type = 'bgm'
      `).bind(projectId).run();
      
      // 新しいBGMを追加
      const result = await DB.prepare(`
        INSERT INTO project_audio_tracks (
          project_id, track_type, track_url, original_filename, 
          volume, loop, is_active, source_type, system_audio_id,
          created_at, updated_at
        ) VALUES (?, 'bgm', ?, ?, 0.5, 1, 1, 'system', ?, datetime('now'), datetime('now'))
      `).bind(projectId, audio.file_url, audio.name, audio.id).run();
      
      return c.json({
        ok: true,
        track_id: result.meta.last_row_id,
        message: `BGM「${audio.name}」を追加しました`,
        audio_type: 'bgm',
        audio_name: audio.name,
      });
      
    } else {
      // SFXの場合は、body からシーン情報を取得
      const body = await c.req.json().catch(() => ({})) as { scene_id?: number };
      
      if (!body.scene_id) {
        return c.json({ ok: false, error: 'scene_id is required for SFX' }, 400);
      }
      
      // シーンが存在するか確認
      const scene = await DB.prepare(`
        SELECT id FROM scenes WHERE id = ? AND project_id = ?
      `).bind(body.scene_id, projectId).first();
      
      if (!scene) {
        return c.json({ ok: false, error: 'Scene not found' }, 404);
      }
      
      // SFXをシーンに追加
      const result = await DB.prepare(`
        INSERT INTO scene_audio_cues (
          scene_id, cue_type, audio_url, original_filename,
          volume, trigger_type, source_type, system_audio_id,
          created_at, updated_at
        ) VALUES (?, 'sfx', ?, ?, 0.7, 'scene_start', 'system', ?, datetime('now'), datetime('now'))
      `).bind(body.scene_id, audio.file_url, audio.name, audio.id).run();
      
      return c.json({
        ok: true,
        cue_id: result.meta.last_row_id,
        message: `SFX「${audio.name}」をシーンに追加しました`,
        audio_type: 'sfx',
        audio_name: audio.name,
      });
    }
    
  } catch (error) {
    console.error('Apply system audio error:', error);
    return c.json({ 
      ok: false, 
      error: error instanceof Error ? error.message : 'Failed to apply system audio' 
    }, 500);
  }
});

export default patches;
