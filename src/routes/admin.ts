/**
 * Admin Routes
 * 
 * Admin panel API endpoints (superadmin only)
 * - GET /api/admin/users - List all users
 * - PUT /api/admin/users/:id/approve - Approve pending user
 * - PUT /api/admin/users/:id/suspend - Suspend user
 * - PUT /api/admin/users/:id/reactivate - Reactivate user
 * - PUT /api/admin/users/:id/sponsor - Toggle sponsor status
 * - DELETE /api/admin/users/:id - Delete user
 * - GET /api/admin/usage - Get API usage summary
 * - GET /api/admin/usage/daily - Get daily usage stats
 * - GET /api/admin/usage/sponsor - Get sponsor usage
 * - GET /api/admin/video-builds/summary - Get video build summary
 * - GET /api/admin/sales/summary - Get sales summary
 * - GET /api/admin/sales/by-user - Get sales by user
 * - GET /api/admin/sales/records - Get sales records
 * - GET /api/admin/subscriptions - Get subscriptions
 * - PUT /api/admin/subscriptions/:id - Update subscription
 * - GET /api/admin/subscription-logs - Get subscription logs
 * - GET /api/admin/settings - Get system settings
 * - PUT /api/admin/settings/:key - Update system setting
 * - GET /api/admin/webhook-logs - Get webhook logs
 */

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Bindings } from '../types/bindings';

const admin = new Hono<{ Bindings: Bindings }>();

// ====================================================================
// Middleware: Check superadmin authentication
// ====================================================================

admin.use('/*', async (c, next) => {
  const { DB } = c.env;
  const sessionId = getCookie(c, 'session');
  
  if (!sessionId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required. Please login.' } }, 401);
  }
  
  try {
    const session = await DB.prepare(`
      SELECT u.id, u.email, u.role, u.status
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.id = ? AND s.expires_at > datetime('now')
    `).bind(sessionId).first<{ id: number; email: string; role: string; status: string }>();
    
    if (!session) {
      return c.json({ error: { code: 'SESSION_EXPIRED', message: 'Session expired. Please login again.' } }, 401);
    }
    
    if (session.role !== 'superadmin') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Superadmin access required.' } }, 403);
    }
    
    // Store user info for later use
    c.set('user' as never, session as never);
    await next();
  } catch (error) {
    console.error('Admin auth error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Authentication check failed' } }, 500);
  }
});

// ====================================================================
// GET /api/admin/users - List all users
// ====================================================================

admin.get('/users', async (c) => {
  const { DB } = c.env;
  
  try {
    const users = await DB.prepare(`
      SELECT id, email, name, company, phone, role, status, 
             api_sponsor_id, video_build_sponsor_id,
             subscription_status, subscription_plan,
             created_at, updated_at
      FROM users
      ORDER BY created_at DESC
    `).all();
    
    return c.json({ users: users.results || [] });
  } catch (error) {
    console.error('Get users error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get users' } }, 500);
  }
});

// ====================================================================
// PUT /api/admin/users/:id/approve - Approve pending user
// ====================================================================

admin.put('/users/:id/approve', async (c) => {
  const { DB } = c.env;
  const userId = c.req.param('id');
  
  try {
    await DB.prepare(`
      UPDATE users SET status = 'active', updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).bind(userId).run();
    
    return c.json({ success: true, message: 'User approved' });
  } catch (error) {
    console.error('Approve user error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to approve user' } }, 500);
  }
});

// ====================================================================
// PUT /api/admin/users/:id/suspend - Suspend user
// ====================================================================

admin.put('/users/:id/suspend', async (c) => {
  const { DB } = c.env;
  const userId = c.req.param('id');
  
  try {
    await DB.prepare(`
      UPDATE users SET status = 'suspended', updated_at = datetime('now')
      WHERE id = ? AND role != 'superadmin'
    `).bind(userId).run();
    
    return c.json({ success: true, message: 'User suspended' });
  } catch (error) {
    console.error('Suspend user error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to suspend user' } }, 500);
  }
});

// ====================================================================
// PUT /api/admin/users/:id/reactivate - Reactivate user
// ====================================================================

admin.put('/users/:id/reactivate', async (c) => {
  const { DB } = c.env;
  const userId = c.req.param('id');
  
  try {
    await DB.prepare(`
      UPDATE users SET status = 'active', updated_at = datetime('now')
      WHERE id = ? AND status = 'suspended'
    `).bind(userId).run();
    
    return c.json({ success: true, message: 'User reactivated' });
  } catch (error) {
    console.error('Reactivate user error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reactivate user' } }, 500);
  }
});

// ====================================================================
// PUT /api/admin/users/:id/sponsor - Toggle sponsor status
// ====================================================================

admin.put('/users/:id/sponsor', async (c) => {
  const { DB } = c.env;
  const userId = c.req.param('id');
  const user = c.get('user' as never) as { id: number };
  
  try {
    // Get current sponsor status
    const targetUser = await DB.prepare(`
      SELECT api_sponsor_id FROM users WHERE id = ?
    `).bind(userId).first<{ api_sponsor_id: number | null }>();
    
    if (!targetUser) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
    }
    
    // Toggle sponsor status
    const newSponsorId = targetUser.api_sponsor_id ? null : user.id;
    
    await DB.prepare(`
      UPDATE users SET api_sponsor_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(newSponsorId, userId).run();
    
    return c.json({ 
      success: true, 
      sponsored: newSponsorId !== null,
      message: newSponsorId ? 'Sponsor enabled' : 'Sponsor disabled'
    });
  } catch (error) {
    console.error('Toggle sponsor error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to toggle sponsor' } }, 500);
  }
});

// ====================================================================
// DELETE /api/admin/users/:id - Delete user
// ====================================================================

admin.delete('/users/:id', async (c) => {
  const { DB } = c.env;
  const userId = c.req.param('id');
  
  try {
    // Don't allow deleting superadmin
    const user = await DB.prepare(`
      SELECT role FROM users WHERE id = ?
    `).bind(userId).first<{ role: string }>();
    
    if (!user) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
    }
    
    if (user.role === 'superadmin') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Cannot delete superadmin' } }, 403);
    }
    
    // Delete user's sessions first
    await DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
    
    // Delete user
    await DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
    
    return c.json({ success: true, message: 'User deleted' });
  } catch (error) {
    console.error('Delete user error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete user' } }, 500);
  }
});

// ====================================================================
// GET /api/admin/usage - Get API usage summary
// ====================================================================

admin.get('/usage', async (c) => {
  const { DB } = c.env;
  
  try {
    // 1. Get usage from api_usage_logs (video_generation, video_build, image_generation, etc.)
    const apiResult = await DB.prepare(`
      SELECT 
        api_type,
        COUNT(*) as request_count,
        SUM(COALESCE(estimated_cost_usd, 0)) as total_cost
      FROM api_usage_logs
      WHERE created_at > datetime('now', '-30 days')
      GROUP BY api_type
    `).all();
    
    // 2. Get TTS usage from tts_usage_logs
    const ttsResult = await DB.prepare(`
      SELECT 
        provider,
        COUNT(*) as request_count,
        SUM(COALESCE(estimated_cost_usd, 0)) as total_cost
      FROM tts_usage_logs
      WHERE created_at > datetime('now', '-30 days')
      GROUP BY provider
    `).all();
    
    // 3. Get usage by user (combine api_usage_logs)
    const userResult = await DB.prepare(`
      SELECT 
        u.id as user_id,
        u.name,
        u.email,
        COUNT(*) as request_count,
        SUM(COALESCE(l.estimated_cost_usd, 0)) as total_cost
      FROM api_usage_logs l
      JOIN users u ON l.user_id = u.id
      WHERE l.created_at > datetime('now', '-30 days')
      GROUP BY u.id
      ORDER BY total_cost DESC
      LIMIT 20
    `).all();
    
    // Build byType object (camelCase for frontend)
    const byType: Record<string, { cost: number; count: number }> = {};
    let totalCost = 0;
    let totalRequests = 0;
    
    // Add API usage logs
    for (const row of (apiResult.results || []) as { api_type: string; request_count: number; total_cost: number }[]) {
      byType[row.api_type] = {
        cost: row.total_cost || 0,
        count: row.request_count || 0
      };
      totalCost += row.total_cost || 0;
      totalRequests += row.request_count || 0;
    }
    
    // Add TTS usage logs (convert provider to api_type format)
    for (const row of (ttsResult.results || []) as { provider: string; request_count: number; total_cost: number }[]) {
      const apiType = `tts_${row.provider}`;
      if (byType[apiType]) {
        byType[apiType].cost += row.total_cost || 0;
        byType[apiType].count += row.request_count || 0;
      } else {
        byType[apiType] = {
          cost: row.total_cost || 0,
          count: row.request_count || 0
        };
      }
      totalCost += row.total_cost || 0;
      totalRequests += row.request_count || 0;
    }
    
    // Build byUser array (camelCase for frontend)
    const byUser = (userResult.results || []).map((row: { user_id: number; name: string; email: string; request_count: number; total_cost: number }) => ({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      requestCount: row.request_count || 0,
      totalCost: row.total_cost || 0
    }));
    
    // Return camelCase format for frontend compatibility
    return c.json({
      totalCost,
      totalRequests,
      byType,
      byUser
    });
  } catch (error) {
    console.error('Get usage error:', error);
    // Return empty data if table doesn't exist
    return c.json({ totalCost: 0, totalRequests: 0, byType: {}, byUser: [] });
  }
});

// ====================================================================
// GET /api/admin/usage/daily - Get daily usage stats
// ====================================================================

admin.get('/usage/daily', async (c) => {
  const { DB } = c.env;
  const days = parseInt(c.req.query('days') || '30');
  
  try {
    // Get daily totals from api_usage_logs
    const apiResult = await DB.prepare(`
      SELECT 
        date(created_at) as date,
        SUM(COALESCE(estimated_cost_usd, 0)) as total_cost
      FROM api_usage_logs
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY date(created_at)
    `).bind(days).all();
    
    // Get daily totals from tts_usage_logs
    const ttsResult = await DB.prepare(`
      SELECT 
        date(created_at) as date,
        SUM(COALESCE(estimated_cost_usd, 0)) as total_cost
      FROM tts_usage_logs
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY date(created_at)
    `).bind(days).all();
    
    // Merge daily costs
    const dailyCosts: Record<string, number> = {};
    
    for (const row of (apiResult.results || []) as { date: string; total_cost: number }[]) {
      dailyCosts[row.date] = (dailyCosts[row.date] || 0) + (row.total_cost || 0);
    }
    
    for (const row of (ttsResult.results || []) as { date: string; total_cost: number }[]) {
      dailyCosts[row.date] = (dailyCosts[row.date] || 0) + (row.total_cost || 0);
    }
    
    // Convert to array sorted by date
    const data = Object.entries(dailyCosts)
      .map(([date, cost]) => ({ date, cost }))
      .sort((a, b) => a.date.localeCompare(b.date));
    
    return c.json({ data });
  } catch (error) {
    console.error('Get daily usage error:', error);
    return c.json({ data: [] });
  }
});

// ====================================================================
// GET /api/admin/usage/sponsor - Get sponsor usage
// ====================================================================

admin.get('/usage/sponsor', async (c) => {
  const { DB } = c.env;
  
  try {
    // 1. Get all superadmins (sponsors)
    const sponsorsResult = await DB.prepare(`
      SELECT id, name, email FROM users WHERE role = 'superadmin'
    `).all();
    
    const sponsors = (sponsorsResult.results || []) as { id: number; name: string; email: string }[];
    
    if (sponsors.length === 0) {
      return c.json({ sponsors: [], grandTotalCost: 0, grandTotalRequests: 0 });
    }
    
    // 2. For each sponsor, get usage data
    const sponsorDetails = [];
    let grandTotalCost = 0;
    let grandTotalRequests = 0;
    
    for (const sponsor of sponsors) {
      // Get all users sponsored by this admin and their usage
      const usageResult = await DB.prepare(`
        SELECT 
          u.id as user_id,
          u.name as user_name,
          u.email as user_email,
          l.api_type,
          COUNT(*) as request_count,
          SUM(COALESCE(l.estimated_cost_usd, 0)) as total_cost
        FROM api_usage_logs l
        JOIN users u ON l.user_id = u.id
        WHERE l.sponsored_by_user_id = ?
        GROUP BY u.id, l.api_type
      `).bind(sponsor.id).all();
      
      // Aggregate by user
      const userMap: Record<number, {
        user: { id: number; name: string; email: string };
        byType: Record<string, { cost: number; count: number }>;
        totalCost: number;
        totalRequests: number;
      }> = {};
      
      for (const row of (usageResult.results || []) as { user_id: number; user_name: string; user_email: string; api_type: string; request_count: number; total_cost: number }[]) {
        if (!userMap[row.user_id]) {
          userMap[row.user_id] = {
            user: { id: row.user_id, name: row.user_name, email: row.user_email },
            byType: {},
            totalCost: 0,
            totalRequests: 0
          };
        }
        
        userMap[row.user_id].byType[row.api_type] = {
          cost: row.total_cost || 0,
          count: row.request_count || 0
        };
        userMap[row.user_id].totalCost += row.total_cost || 0;
        userMap[row.user_id].totalRequests += row.request_count || 0;
      }
      
      const byUser = Object.values(userMap);
      const sponsorTotalCost = byUser.reduce((sum, u) => sum + u.totalCost, 0);
      const sponsorTotalRequests = byUser.reduce((sum, u) => sum + u.totalRequests, 0);
      
      grandTotalCost += sponsorTotalCost;
      grandTotalRequests += sponsorTotalRequests;
      
      if (byUser.length > 0) {
        sponsorDetails.push({
          sponsor: { id: sponsor.id, name: sponsor.name, email: sponsor.email },
          byUser,
          totalCost: sponsorTotalCost,
          totalRequests: sponsorTotalRequests
        });
      }
    }
    
    return c.json({
      sponsors: sponsorDetails,
      grandTotalCost,
      grandTotalRequests
    });
  } catch (error) {
    console.error('Get sponsor usage error:', error);
    return c.json({ sponsors: [], grandTotalCost: 0, grandTotalRequests: 0 });
  }
});

// ====================================================================
// GET /api/admin/usage/operations - Get operation-specific usage (Safe Chat v1)
// ====================================================================

admin.get('/usage/operations', async (c) => {
  const { DB } = c.env;
  const days = parseInt(c.req.query('days') || '30');
  
  try {
    // Safe Chat v1 operation types
    const operationTypes = [
      'bgm_upload',
      'sfx_upload',
      'patch_dry_run',
      'patch_apply',
      'chat_edit_dry_run',
      'chat_edit_apply',
      'video_build_render',
      'llm_intent'
    ];
    
    // Get operation counts and metadata
    const operationsResult = await DB.prepare(`
      SELECT 
        api_type,
        COUNT(*) as request_count,
        SUM(COALESCE(estimated_cost_usd, 0)) as total_cost,
        COUNT(DISTINCT project_id) as unique_projects,
        COUNT(DISTINCT user_id) as unique_users
      FROM api_usage_logs
      WHERE api_type IN (${operationTypes.map(() => '?').join(', ')})
        AND created_at > datetime('now', '-' || ? || ' days')
      GROUP BY api_type
    `).bind(...operationTypes, days).all();
    
    // Get recent operations with details
    const recentResult = await DB.prepare(`
      SELECT 
        l.id,
        l.api_type,
        l.user_id,
        l.project_id,
        l.estimated_cost_usd,
        l.metadata_json,
        l.created_at,
        u.name as user_name,
        u.email as user_email,
        p.title as project_title
      FROM api_usage_logs l
      LEFT JOIN users u ON l.user_id = u.id
      LEFT JOIN projects p ON l.project_id = p.id
      WHERE l.api_type IN (${operationTypes.map(() => '?').join(', ')})
      ORDER BY l.created_at DESC
      LIMIT 100
    `).bind(...operationTypes).all();
    
    // Parse metadata and format
    const recentOperations = (recentResult.results || []).map((row: Record<string, unknown>) => {
      let metadata = null;
      try {
        metadata = row.metadata_json ? JSON.parse(row.metadata_json as string) : null;
      } catch { /* ignore */ }
      
      return {
        id: row.id,
        type: row.api_type,
        user: row.user_name || row.user_email || `User #${row.user_id}`,
        project: row.project_title || `Project #${row.project_id}`,
        cost: row.estimated_cost_usd || 0,
        metadata,
        createdAt: row.created_at,
      };
    });
    
    // Build summary by type
    const byType: Record<string, { count: number; cost: number; projects: number; users: number }> = {};
    let totalOperations = 0;
    let totalCost = 0;
    
    for (const row of (operationsResult.results || []) as { 
      api_type: string; 
      request_count: number; 
      total_cost: number;
      unique_projects: number;
      unique_users: number;
    }[]) {
      byType[row.api_type] = {
        count: row.request_count || 0,
        cost: row.total_cost || 0,
        projects: row.unique_projects || 0,
        users: row.unique_users || 0,
      };
      totalOperations += row.request_count || 0;
      totalCost += row.total_cost || 0;
    }
    
    return c.json({
      summary: {
        totalOperations,
        totalCost,
        periodDays: days,
      },
      byType,
      recentOperations,
    });
  } catch (error) {
    console.error('Get operations usage error:', error);
    return c.json({
      summary: { totalOperations: 0, totalCost: 0, periodDays: days },
      byType: {},
      recentOperations: [],
    });
  }
});

// ====================================================================
// GET /api/admin/video-builds/summary - Get video build summary
// ====================================================================

admin.get('/video-builds/summary', async (c) => {
  const { DB } = c.env;
  const month = c.req.query('month') || new Date().toISOString().slice(0, 7);
  
  try {
    // Get summary stats
    const stats = await DB.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status IN ('pending', 'processing', 'retrying') THEN 1 ELSE 0 END) as in_progress,
        SUM(COALESCE(estimated_cost_usd, 0)) as total_cost
      FROM video_builds
      WHERE strftime('%Y-%m', created_at) = ?
    `).bind(month).first<{
      total: number;
      completed: number;
      failed: number;
      in_progress: number;
      total_cost: number;
    }>();
    
    // Get daily breakdown
    const daily = await DB.prepare(`
      SELECT 
        date(created_at) as date,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM video_builds
      WHERE strftime('%Y-%m', created_at) = ?
      GROUP BY date(created_at)
      ORDER BY date DESC
    `).bind(month).all();
    
    // Get by owner
    const byOwner = await DB.prepare(`
      SELECT 
        u.id as user_id,
        u.name,
        u.email,
        COUNT(*) as total,
        SUM(CASE WHEN vb.status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN vb.status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(COALESCE(vb.estimated_cost_usd, 0)) as total_cost
      FROM video_builds vb
      JOIN projects p ON vb.project_id = p.id
      JOIN users u ON p.user_id = u.id
      WHERE strftime('%Y-%m', vb.created_at) = ?
      GROUP BY u.id
      ORDER BY total DESC
      LIMIT 20
    `).bind(month).all();
    
    // Get recent failed
    const recentFailed = await DB.prepare(`
      SELECT 
        vb.id,
        u.name as owner_name,
        vb.error_message,
        vb.created_at
      FROM video_builds vb
      JOIN projects p ON vb.project_id = p.id
      JOIN users u ON p.user_id = u.id
      WHERE vb.status = 'failed'
      ORDER BY vb.created_at DESC
      LIMIT 10
    `).all();
    
    return c.json({
      summary: stats || { total: 0, completed: 0, failed: 0, in_progress: 0, total_cost: 0 },
      daily: daily.results || [],
      by_owner: byOwner.results || [],
      recent_failed: recentFailed.results || []
    });
  } catch (error) {
    console.error('Get video builds summary error:', error);
    return c.json({
      summary: { total: 0, completed: 0, failed: 0, in_progress: 0, total_cost: 0 },
      daily: [],
      by_owner: [],
      recent_failed: []
    });
  }
});

// ====================================================================
// GET /api/admin/sales/summary - Get sales summary
// ====================================================================

admin.get('/sales/summary', async (c) => {
  const { DB } = c.env;
  
  try {
    const result = await DB.prepare(`
      SELECT 
        strftime('%Y-%m', created_at) as month,
        COUNT(*) as count,
        SUM(amount) as total
      FROM payment_records
      WHERE status = 'completed'
      GROUP BY strftime('%Y-%m', created_at)
      ORDER BY month DESC
      LIMIT 12
    `).all();
    
    // Get total active subscriptions
    const activeCount = await DB.prepare(`
      SELECT COUNT(*) as count FROM users WHERE subscription_status = 1
    `).first<{ count: number }>();
    
    return c.json({
      monthly: result.results || [],
      active_subscribers: activeCount?.count || 0
    });
  } catch (error) {
    console.error('Get sales summary error:', error);
    return c.json({ monthly: [], active_subscribers: 0 });
  }
});

// ====================================================================
// GET /api/admin/sales/by-user - Get sales by user
// ====================================================================

admin.get('/sales/by-user', async (c) => {
  const { DB } = c.env;
  
  try {
    const result = await DB.prepare(`
      SELECT 
        u.id as user_id,
        u.name,
        u.email,
        COUNT(pr.id) as payment_count,
        SUM(pr.amount) as total_amount
      FROM users u
      LEFT JOIN payment_records pr ON pr.user_id = u.id AND pr.status = 'completed'
      GROUP BY u.id
      HAVING payment_count > 0
      ORDER BY total_amount DESC
      LIMIT 10
    `).all();
    
    return c.json({ users: result.results || [] });
  } catch (error) {
    console.error('Get sales by user error:', error);
    return c.json({ users: [] });
  }
});

// ====================================================================
// GET /api/admin/sales/records - Get sales records
// ====================================================================

admin.get('/sales/records', async (c) => {
  const { DB } = c.env;
  const limit = parseInt(c.req.query('limit') || '50');
  
  try {
    const result = await DB.prepare(`
      SELECT 
        pr.id,
        pr.user_id,
        u.name as user_name,
        u.email as user_email,
        pr.amount,
        pr.payment_type,
        pr.status,
        pr.created_at
      FROM payment_records pr
      JOIN users u ON pr.user_id = u.id
      ORDER BY pr.created_at DESC
      LIMIT ?
    `).bind(limit).all();
    
    return c.json({ records: result.results || [] });
  } catch (error) {
    console.error('Get sales records error:', error);
    return c.json({ records: [] });
  }
});

// ====================================================================
// GET /api/admin/sales/export - Export sales as CSV
// ====================================================================

admin.get('/sales/export', async (c) => {
  const { DB } = c.env;
  const month = c.req.query('month');
  
  try {
    let query = `
      SELECT 
        pr.id,
        u.name as user_name,
        u.email as user_email,
        pr.amount,
        pr.payment_type,
        pr.status,
        pr.created_at
      FROM payment_records pr
      JOIN users u ON pr.user_id = u.id
    `;
    
    if (month) {
      query += ` WHERE strftime('%Y-%m', pr.created_at) = '${month}'`;
    }
    
    query += ' ORDER BY pr.created_at DESC';
    
    const result = await DB.prepare(query).all();
    
    // Generate CSV
    const headers = ['ID', 'ユーザー名', 'メール', '金額', '種別', 'ステータス', '日時'];
    const rows = (result.results || []).map((r: Record<string, unknown>) => [
      r.id, r.user_name, r.user_email, r.amount, r.payment_type, r.status, r.created_at
    ]);
    
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="sales_${month || 'all'}.csv"`
      }
    });
  } catch (error) {
    console.error('Export sales error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Export failed' } }, 500);
  }
});

// ====================================================================
// GET /api/admin/subscriptions - Get subscriptions
// ====================================================================

admin.get('/subscriptions', async (c) => {
  const { DB } = c.env;
  
  try {
    const result = await DB.prepare(`
      SELECT 
        id, email, name,
        subscription_status, subscription_plan,
        myasp_user_id,
        subscription_started_at, subscription_ended_at
      FROM users
      ORDER BY subscription_started_at DESC NULLS LAST
    `).all();
    
    return c.json({ subscriptions: result.results || [] });
  } catch (error) {
    console.error('Get subscriptions error:', error);
    return c.json({ subscriptions: [] });
  }
});

// ====================================================================
// PUT /api/admin/subscriptions/:id - Update subscription
// ====================================================================

admin.put('/subscriptions/:id', async (c) => {
  const { DB } = c.env;
  const userId = c.req.param('id');
  
  try {
    const body = await c.req.json<{ status?: number; plan?: string }>();
    
    const updates: string[] = [];
    const values: (string | number)[] = [];
    
    if (body.status !== undefined) {
      updates.push('subscription_status = ?');
      values.push(body.status);
    }
    
    if (body.plan) {
      updates.push('subscription_plan = ?');
      values.push(body.plan);
    }
    
    if (updates.length === 0) {
      return c.json({ error: { code: 'NO_UPDATES', message: 'No fields to update' } }, 400);
    }
    
    updates.push("updated_at = datetime('now')");
    values.push(userId);
    
    await DB.prepare(`
      UPDATE users SET ${updates.join(', ')} WHERE id = ?
    `).bind(...values).run();
    
    return c.json({ success: true, message: 'Subscription updated' });
  } catch (error) {
    console.error('Update subscription error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update subscription' } }, 500);
  }
});

// ====================================================================
// GET /api/admin/subscription-logs - Get subscription logs
// ====================================================================

admin.get('/subscription-logs', async (c) => {
  const { DB } = c.env;
  const limit = parseInt(c.req.query('limit') || '20');
  
  try {
    // This assumes a subscription_logs table exists
    const result = await DB.prepare(`
      SELECT * FROM subscription_logs
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(limit).all();
    
    return c.json({ logs: result.results || [] });
  } catch (error) {
    // Table might not exist
    return c.json({ logs: [] });
  }
});

// ====================================================================
// GET /api/admin/settings - Get system settings
// ====================================================================

admin.get('/settings', async (c) => {
  const { DB } = c.env;
  
  try {
    const result = await DB.prepare(`
      SELECT key, value FROM system_settings
    `).all();
    
    const settings: Record<string, string> = {};
    for (const row of (result.results || []) as { key: string; value: string }[]) {
      settings[row.key] = row.value;
    }
    
    return c.json({ settings });
  } catch (error) {
    console.error('Get settings error:', error);
    return c.json({ settings: {} });
  }
});

// ====================================================================
// PUT /api/admin/settings/:key - Update system setting
// ====================================================================

admin.put('/settings/:key', async (c) => {
  const { DB } = c.env;
  const key = c.req.param('key');
  
  try {
    const body = await c.req.json<{ value: string }>();
    
    await DB.prepare(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).bind(key, body.value).run();
    
    return c.json({ success: true, message: 'Setting updated' });
  } catch (error) {
    console.error('Update setting error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update setting' } }, 500);
  }
});

// ====================================================================
// GET /api/admin/webhook-logs - Get webhook logs
// ====================================================================

admin.get('/webhook-logs', async (c) => {
  const { DB } = c.env;
  const limit = parseInt(c.req.query('limit') || '10');
  
  try {
    // This assumes a webhook_logs table exists
    const result = await DB.prepare(`
      SELECT * FROM webhook_logs
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(limit).all();
    
    return c.json({ logs: result.results || [] });
  } catch (error) {
    // Table might not exist
    return c.json({ logs: [] });
  }
});

// ====================================================================
// POST /api/admin/backfill-render-logs - Backfill render usage logs for completed builds
// ====================================================================
// userId 正規化: owner_user_id → project.user_id → スキップ（異常データ）

admin.post('/backfill-render-logs', async (c) => {
  const { DB } = c.env;
  const { logVideoBuildRender } = await import('../utils/usage-logger');
  
  try {
    const limit = parseInt(c.req.query('limit') || '100');
    
    // 完了済み＆ログ未記録のビルドを取得（project.user_id も JOIN で取得）
    const unloggedBuilds = await DB.prepare(`
      SELECT 
        vb.id, vb.project_id, vb.owner_user_id, 
        vb.total_scenes, vb.total_duration_ms,
        vb.settings_json, vb.remotion_render_id,
        p.user_id AS project_owner_user_id
      FROM video_builds vb
      LEFT JOIN projects p ON vb.project_id = p.id
      WHERE vb.status = 'completed' 
        AND vb.render_usage_logged = 0
      ORDER BY vb.id DESC
      LIMIT ?
    `).bind(limit).all<{
      id: number;
      project_id: number;
      owner_user_id: number | null;
      total_scenes: number | null;
      total_duration_ms: number | null;
      settings_json: string | null;
      remotion_render_id: string | null;
      project_owner_user_id: number | null;
    }>();
    
    const builds = unloggedBuilds.results || [];
    let processedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];
    const skipped: string[] = [];
    
    for (const build of builds) {
      try {
        // userId 正規化: owner_user_id → project.user_id → スキップ
        const userId = build.owner_user_id || build.project_owner_user_id;
        
        if (!userId) {
          // 異常データ: user_id が特定できない → スキップ
          skippedCount++;
          skipped.push(`Build ${build.id}: No owner_user_id or project.user_id found`);
          console.warn(`[backfill] Skipping build ${build.id}: No user_id available`);
          continue;
        }
        
        // フラグを先に立てる（二重計上防止）
        const lockResult = await DB.prepare(`
          UPDATE video_builds 
          SET render_usage_logged = 1 
          WHERE id = ? AND render_usage_logged = 0
        `).bind(build.id).run();
        
        if (lockResult.meta.changes === 1) {
          // settings_json から fps を取得
          let fps = 30;
          try {
            if (build.settings_json) {
              const settings = JSON.parse(build.settings_json);
              fps = settings.fps ?? 30;
            }
          } catch { /* ignore */ }
          
          await logVideoBuildRender(DB, {
            userId,
            projectId: build.project_id,
            videoBuildId: build.id,
            totalScenes: build.total_scenes || 0,
            totalDurationMs: build.total_duration_ms || 0,
            fps,
            status: 'success',
          });
          
          processedCount++;
        }
      } catch (err) {
        errorCount++;
        errors.push(`Build ${build.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    return c.json({
      success: true,
      found: builds.length,
      processed: processedCount,
      skipped: skippedCount,
      errors: errorCount,
      skipped_details: skipped.slice(0, 10), // 最大10件のスキップ詳細
      error_details: errors.slice(0, 10), // 最大10件のエラー詳細
    });
    
  } catch (error) {
    console.error('Backfill render logs error:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to backfill' 
    }, 500);
  }
});

// ====================================================================
// POST /api/admin/cron/collect-render-logs - Cron 回収用エンドポイント
// ====================================================================
// Workers Cron または外部からの定期呼び出しで使用
// completed/failed かつ render_usage_logged=0 のビルドを回収
// 認証: Cron-Secret ヘッダーまたは SuperAdmin セッション

admin.post('/cron/collect-render-logs', async (c) => {
  const { DB } = c.env;
  const { logVideoBuildRender } = await import('../utils/usage-logger');
  
  // 認証: Cron-Secret または SuperAdmin セッション
  const cronSecret = c.req.header('X-Cron-Secret');
  const expectedSecret = c.env.CRON_SECRET || 'default-cron-secret-change-me';
  
  // Cron-Secret が一致しない場合はセッション認証を試行
  if (cronSecret !== expectedSecret) {
    const sessionCookie = getCookie(c, 'session');
    if (!sessionCookie) {
      return c.json({ error: 'UNAUTHORIZED', message: 'Cron secret or session required' }, 401);
    }
    
    const sessionResult = await DB.prepare(`
      SELECT u.id, u.role FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND s.expires_at > datetime('now')
    `).bind(sessionCookie).first<{ id: number; role: string }>();
    
    if (!sessionResult || sessionResult.role !== 'superadmin') {
      return c.json({ error: 'FORBIDDEN', message: 'SuperAdmin required' }, 403);
    }
  }
  
  try {
    // completed または failed かつ render_usage_logged=0 のビルドを取得
    const unloggedBuilds = await DB.prepare(`
      SELECT 
        vb.id, vb.project_id, vb.owner_user_id, vb.status,
        vb.total_scenes, vb.total_duration_ms,
        vb.settings_json, vb.remotion_render_id,
        vb.error_code, vb.error_message,
        p.user_id AS project_owner_user_id
      FROM video_builds vb
      LEFT JOIN projects p ON vb.project_id = p.id
      WHERE vb.status IN ('completed', 'failed')
        AND vb.render_usage_logged = 0
      ORDER BY vb.id DESC
      LIMIT 50
    `).all<{
      id: number;
      project_id: number;
      owner_user_id: number | null;
      status: string;
      total_scenes: number | null;
      total_duration_ms: number | null;
      settings_json: string | null;
      remotion_render_id: string | null;
      error_code: string | null;
      error_message: string | null;
      project_owner_user_id: number | null;
    }>();
    
    const builds = unloggedBuilds.results || [];
    let processedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    const processed: number[] = [];
    const errors: string[] = [];
    const skipped: string[] = [];
    
    for (const build of builds) {
      try {
        // userId 正規化: owner_user_id → project.user_id → スキップ
        const userId = build.owner_user_id || build.project_owner_user_id;
        
        if (!userId) {
          skippedCount++;
          skipped.push(`Build ${build.id}: No user_id available`);
          console.warn(`[cron] Skipping build ${build.id}: No user_id available`);
          continue;
        }
        
        // フラグを先に立てる（二重計上防止）
        const lockResult = await DB.prepare(`
          UPDATE video_builds 
          SET render_usage_logged = 1 
          WHERE id = ? AND render_usage_logged = 0
        `).bind(build.id).run();
        
        if (lockResult.meta.changes === 1) {
          // settings_json から fps, aspect_ratio, resolution を取得
          let fps = 30;
          let aspectRatio = '9:16';
          let resolution = '1080p';
          try {
            if (build.settings_json) {
              const settings = JSON.parse(build.settings_json);
              fps = settings.fps ?? 30;
              aspectRatio = settings.aspect_ratio ?? '9:16';
              resolution = settings.resolution ?? '1080p';
            }
          } catch { /* ignore */ }
          
          await logVideoBuildRender(DB, {
            userId,
            projectId: build.project_id,
            videoBuildId: build.id,
            totalScenes: build.total_scenes || 0,
            totalDurationMs: build.total_duration_ms || 0,
            fps,
            status: build.status === 'completed' ? 'success' : 'failed',
            errorCode: build.error_code || undefined,
            errorMessage: build.error_message || undefined,
            remotionRenderId: build.remotion_render_id || undefined,
            aspectRatio,
            resolution,
          });
          
          processed.push(build.id);
          processedCount++;
          console.log(`[cron] Logged render for build ${build.id} (${build.status})`);
        }
      } catch (err) {
        errorCount++;
        const errMsg = err instanceof Error ? err.message : String(err);
        errors.push(`Build ${build.id}: ${errMsg}`);
        console.error(`[cron] Error processing build ${build.id}:`, err);
      }
    }
    
    const result = {
      success: true,
      timestamp: new Date().toISOString(),
      found: builds.length,
      processed: processedCount,
      skipped: skippedCount,
      errors: errorCount,
      processed_ids: processed,
      skipped_details: skipped.slice(0, 10),
      error_details: errors.slice(0, 10),
    };
    
    console.log('[cron] Collect render logs completed:', result);
    return c.json(result);
    
  } catch (error) {
    console.error('Cron collect render logs error:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to collect' 
    }, 500);
  }
});

// ====================================================================
// GET /api/admin/orphan-builds - 異常データ（user_id 不明）の一覧
// ====================================================================
// SuperAdmin でのモニタリング用

admin.get('/orphan-builds', async (c) => {
  const { DB } = c.env;
  
  try {
    // user_id が特定できないビルドを取得
    const orphanBuilds = await DB.prepare(`
      SELECT 
        vb.id, vb.project_id, vb.owner_user_id, vb.status,
        vb.total_scenes, vb.total_duration_ms,
        vb.render_usage_logged, vb.created_at,
        p.user_id AS project_owner_user_id,
        p.title AS project_title
      FROM video_builds vb
      LEFT JOIN projects p ON vb.project_id = p.id
      WHERE vb.owner_user_id IS NULL AND p.user_id IS NULL
      ORDER BY vb.id DESC
      LIMIT 100
    `).all<{
      id: number;
      project_id: number;
      owner_user_id: number | null;
      status: string;
      total_scenes: number | null;
      total_duration_ms: number | null;
      render_usage_logged: number;
      created_at: string;
      project_owner_user_id: number | null;
      project_title: string | null;
    }>();
    
    const builds = orphanBuilds.results || [];
    
    return c.json({
      success: true,
      count: builds.length,
      builds: builds.map(b => ({
        id: b.id,
        project_id: b.project_id,
        project_title: b.project_title,
        status: b.status,
        owner_user_id: b.owner_user_id,
        project_owner_user_id: b.project_owner_user_id,
        render_usage_logged: b.render_usage_logged === 1,
        total_scenes: b.total_scenes,
        total_duration_ms: b.total_duration_ms,
        created_at: b.created_at,
      })),
    });
    
  } catch (error) {
    console.error('Get orphan builds error:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to get orphan builds' 
    }, 500);
  }
});

export default admin;
