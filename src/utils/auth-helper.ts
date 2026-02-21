/**
 * 共通認証ヘルパー関数
 * 
 * SSOT: Superadmin は全データにアクセス可能
 * 
 * 使用方法:
 * - getUserFromSession: セッションからユーザー情報（id, role）を取得
 * - validateSceneAccess: シーンへのアクセス権を検証（Superadmin対応）
 * - validateProjectAccess: プロジェクトへのアクセス権を検証（Superadmin対応）
 */

import { getCookie } from 'hono/cookie';

// ====================================================================
// Types
// ====================================================================

export interface AuthUser {
  id: number;
  role: string;
  email?: string;
}

export interface AccessResult {
  valid: boolean;
  projectId?: number;
  error?: string;
  errorCode?: 'NOT_FOUND' | 'FORBIDDEN' | 'INTERNAL_ERROR';  // HTTPステータスと対応するエラーコード
  httpStatus?: 404 | 403 | 500;  // 適切なHTTPステータスコード
  details?: any;
}

// ====================================================================
// getUserFromSession
// ====================================================================
/**
 * セッションからユーザー情報を取得（role含む）
 * 
 * @returns AuthUser | null
 */
export async function getUserFromSession(c: any): Promise<AuthUser | null> {
  try {
    const sessionId = getCookie(c, 'session');
    if (!sessionId) {
      console.log('[AuthHelper] No session cookie found');
      return null;
    }
    
    const session = await c.env.DB.prepare(`
      SELECT s.user_id, u.role, u.email
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.id = ? AND s.expires_at > datetime('now')
    `).bind(sessionId).first<{ user_id: number; role: string; email: string }>();
    
    if (!session) {
      console.log('[AuthHelper] Session not found or expired');
      return null;
    }
    
    console.log(`[AuthHelper] User ID: ${session.user_id}, Role: ${session.role}`);
    return { id: session.user_id, role: session.role, email: session.email };
  } catch (error) {
    console.error('[AuthHelper] Session lookup error:', error);
    return null;
  }
}

// ====================================================================
// validateSceneAccess
// ====================================================================
/**
 * シーンへのアクセス権を検証
 * 
 * SSOT: Superadminは全シーンにアクセス可能
 * 
 * @returns AccessResult
 */
export async function validateSceneAccess(
  c: any, 
  sceneId: number, 
  user: AuthUser
): Promise<AccessResult> {
  try {
    console.log(`[AuthHelper] Validating scene access: sceneId=${sceneId}, userId=${user.id}, role=${user.role}`);
    
    const scene = await c.env.DB.prepare(`
      SELECT s.id, s.project_id, p.user_id as project_user_id
      FROM scenes s
      JOIN projects p ON s.project_id = p.id
      WHERE s.id = ?
    `).bind(sceneId).first<{ id: number; project_id: number; project_user_id: number | null }>();
    
    if (!scene) {
      console.log(`[AuthHelper] Scene ${sceneId} not found`);
      return { 
        valid: false, 
        error: 'Scene not found',
        errorCode: 'NOT_FOUND',
        httpStatus: 404
      };
    }
    
    // SSOT: Superadmin のみ全データにアクセス可能
    // ⚠️ SECURITY FIX 2026-02-21: admin は owner と同等（自分のプロジェクトのみ）
    if (user.role === 'superadmin') {
      console.log(`[AuthHelper] superadmin access granted for scene ${sceneId}`);
      return { valid: true, projectId: scene.project_id };
    }
    
    // 通常ユーザー: プロジェクト所有者のみアクセス可能
    if (scene.project_user_id !== user.id) {
      console.log(`[AuthHelper] Access denied: project owner ${scene.project_user_id} !== request user ${user.id}`);
      return { 
        valid: false, 
        error: 'Access denied',
        errorCode: 'FORBIDDEN',
        httpStatus: 403,
        details: { projectOwnerId: scene.project_user_id, requestUserId: user.id, sceneId, projectId: scene.project_id }
      };
    }
    
    return { valid: true, projectId: scene.project_id };
  } catch (error) {
    console.error('[AuthHelper] Scene validation error:', error);
    return { 
      valid: false, 
      error: 'Validation failed',
      errorCode: 'INTERNAL_ERROR',
      httpStatus: 500
    };
  }
}

// ====================================================================
// validateProjectAccess
// ====================================================================
/**
 * プロジェクトへのアクセス権を検証
 * 
 * SSOT: Superadminは全プロジェクトにアクセス可能
 * 
 * @returns AccessResult
 */
export async function validateProjectAccess(
  c: any, 
  projectId: number, 
  user: AuthUser
): Promise<AccessResult> {
  try {
    console.log(`[AuthHelper] Validating project access: projectId=${projectId}, userId=${user.id}, role=${user.role}`);
    
    const project = await c.env.DB.prepare(`
      SELECT id, user_id FROM projects WHERE id = ? AND (is_deleted = 0 OR is_deleted IS NULL)
    `).bind(projectId).first<{ id: number; user_id: number | null }>();
    
    if (!project) {
      console.log(`[AuthHelper] Project ${projectId} not found`);
      return { valid: false, error: 'Project not found' };
    }
    
    // SSOT: Superadmin は全データにアクセス可能
    if (user.role === 'superadmin') {
      console.log(`[AuthHelper] Superadmin access granted for project ${projectId}`);
      return { valid: true, projectId: project.id };
    }
    
    // 通常ユーザー: プロジェクト所有者のみアクセス可能
    if (project.user_id !== user.id) {
      console.log(`[AuthHelper] Access denied: project owner ${project.user_id} !== request user ${user.id}`);
      return { 
        valid: false, 
        error: 'Access denied',
        details: { projectOwnerId: project.user_id, requestUserId: user.id, projectId }
      };
    }
    
    return { valid: true, projectId: project.id };
  } catch (error) {
    console.error('[AuthHelper] Project validation error:', error);
    return { valid: false, error: 'Validation failed' };
  }
}

// ====================================================================
// isSuperadmin
// ====================================================================
/**
 * ユーザーがSuperadminかどうかを判定
 */
export function isSuperadmin(user: AuthUser | null): boolean {
  return user?.role === 'superadmin';
}

// ====================================================================
// Legacy compatibility: getUserIdFromSession
// ====================================================================
/**
 * 後方互換性のため残す（既存コードの段階的移行用）
 * 新規コードは getUserFromSession を使用すること
 * 
 * @deprecated Use getUserFromSession instead
 */
export async function getUserIdFromSession(c: any): Promise<number | null> {
  const user = await getUserFromSession(c);
  return user?.id ?? null;
}
