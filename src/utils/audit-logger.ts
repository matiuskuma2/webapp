// src/utils/audit-logger.ts
// 監査ログ記録用ヘルパー

interface AuditLogParams {
  db: D1Database;
  userId?: number | null;
  userRole?: string | null;
  entityType: 'scene' | 'audio' | 'project' | 'video';
  entityId: number;
  projectId?: number | null;
  action: string;
  details?: Record<string, unknown>;
}

/**
 * 監査ログを記録
 * - 失敗してもエラーを投げない（ログ記録失敗で本処理を止めない）
 */
export async function logAudit(params: AuditLogParams): Promise<void> {
  const { db, userId, userRole, entityType, entityId, projectId, action, details } = params;
  
  try {
    await db.prepare(`
      INSERT INTO audit_logs (user_id, user_role, entity_type, entity_id, project_id, action, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId ?? null,
      userRole ?? null,
      entityType,
      entityId,
      projectId ?? null,
      action,
      details ? JSON.stringify(details) : null
    ).run();
  } catch (error) {
    // ログ記録失敗は警告のみ（本処理を止めない）
    console.warn('[AuditLog] Failed to record audit log:', error, params);
  }
}
