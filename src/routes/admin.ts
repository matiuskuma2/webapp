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
    // Get usage from api_usage_logs if it exists
    const result = await DB.prepare(`
      SELECT 
        api_type,
        COUNT(*) as request_count,
        SUM(COALESCE(estimated_cost_usd, 0)) as total_cost
      FROM api_usage_logs
      WHERE created_at > datetime('now', '-30 days')
      GROUP BY api_type
      ORDER BY total_cost DESC
    `).all();
    
    const summary = {
      total_cost: 0,
      total_requests: 0,
      by_type: result.results || []
    };
    
    for (const row of (result.results || []) as { total_cost: number; request_count: number }[]) {
      summary.total_cost += row.total_cost || 0;
      summary.total_requests += row.request_count || 0;
    }
    
    return c.json(summary);
  } catch (error) {
    console.error('Get usage error:', error);
    // Return empty data if table doesn't exist
    return c.json({ total_cost: 0, total_requests: 0, by_type: [] });
  }
});

// ====================================================================
// GET /api/admin/usage/daily - Get daily usage stats
// ====================================================================

admin.get('/usage/daily', async (c) => {
  const { DB } = c.env;
  const days = parseInt(c.req.query('days') || '30');
  
  try {
    const result = await DB.prepare(`
      SELECT 
        date(created_at) as date,
        api_type,
        COUNT(*) as request_count,
        SUM(COALESCE(estimated_cost_usd, 0)) as total_cost
      FROM api_usage_logs
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY date(created_at), api_type
      ORDER BY date DESC
    `).bind(days).all();
    
    return c.json({ daily: result.results || [] });
  } catch (error) {
    console.error('Get daily usage error:', error);
    return c.json({ daily: [] });
  }
});

// ====================================================================
// GET /api/admin/usage/sponsor - Get sponsor usage
// ====================================================================

admin.get('/usage/sponsor', async (c) => {
  const { DB } = c.env;
  
  try {
    const result = await DB.prepare(`
      SELECT 
        u.id as sponsor_id,
        u.name as sponsor_name,
        u.email as sponsor_email,
        COUNT(DISTINCT l.user_id) as sponsored_users,
        SUM(COALESCE(l.estimated_cost_usd, 0)) as total_cost
      FROM users u
      LEFT JOIN api_usage_logs l ON l.sponsored_by_user_id = u.id
      WHERE u.role = 'superadmin'
      GROUP BY u.id
    `).all();
    
    return c.json({ sponsors: result.results || [] });
  } catch (error) {
    console.error('Get sponsor usage error:', error);
    return c.json({ sponsors: [] });
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

export default admin;
