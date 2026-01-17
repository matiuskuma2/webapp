/**
 * Authentication Routes
 * 
 * User authentication and session management
 * - POST /api/auth/login - Login with email/password
 * - POST /api/auth/logout - Logout (invalidate session)
 * - POST /api/auth/register - Register new user (pending approval)
 * - POST /api/auth/forgot-password - Request password reset
 * - POST /api/auth/reset-password - Reset password with token
 * - GET /api/auth/me - Get current user info
 */

import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import type { Bindings } from '../types/bindings';

const auth = new Hono<{ Bindings: Bindings }>();

// ====================================================================
// Types
// ====================================================================

interface LoginRequest {
  email: string;
  password: string;
}

interface RegisterRequest {
  email: string;
  password: string;
  name: string;
  company?: string;
  phone?: string;
}

interface ForgotPasswordRequest {
  email: string;
}

interface ResetPasswordRequest {
  token: string;
  password: string;
}

// ====================================================================
// Crypto Helpers (PBKDF2-based password hashing for Cloudflare Workers)
// ====================================================================

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    passwordKey,
    256
  );
  
  const hashHex = Array.from(new Uint8Array(derivedBits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  return `${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [saltHex, expectedHashHex] = storedHash.split(':');
  if (!saltHex || !expectedHashHex) return false;
  
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));
  
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    passwordKey,
    256
  );
  
  const computedHashHex = Array.from(new Uint8Array(derivedBits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  return computedHashHex === expectedHashHex;
}

function generateSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateResetToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ====================================================================
// POST /api/auth/login
// ====================================================================

auth.post('/auth/login', async (c) => {
  const { DB } = c.env;
  
  let body: LoginRequest;
  try {
    body = await c.req.json<LoginRequest>();
  } catch {
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body' } }, 400);
  }
  
  const { email, password } = body;
  if (!email || !password) {
    return c.json({ error: { code: 'MISSING_FIELDS', message: 'Email and password are required' } }, 400);
  }
  
  try {
    // Find user
    const user = await DB.prepare(`
      SELECT id, email, password_hash, name, role, status
      FROM users WHERE email = ?
    `).bind(email.toLowerCase().trim()).first<{
      id: number;
      email: string;
      password_hash: string;
      name: string;
      role: string;
      status: string;
    }>();
    
    if (!user) {
      return c.json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }, 401);
    }
    
    // Check status
    if (user.status === 'pending') {
      return c.json({ error: { code: 'ACCOUNT_PENDING', message: 'Your account is pending approval' } }, 403);
    }
    if (user.status === 'suspended') {
      return c.json({ error: { code: 'ACCOUNT_SUSPENDED', message: 'Your account has been suspended' } }, 403);
    }
    
    // Verify password
    const validPassword = await verifyPassword(password, user.password_hash);
    if (!validPassword) {
      return c.json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }, 401);
    }
    
    // Create session
    const sessionId = generateSessionId();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    
    await DB.prepare(`
      INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)
    `).bind(sessionId, user.id, expiresAt.toISOString()).run();
    
    // Set cookie
    setCookie(c, 'session', sessionId, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      expires: expiresAt,
    });
    
    return c.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Login failed' } }, 500);
  }
});

// ====================================================================
// POST /api/auth/logout
// ====================================================================

auth.post('/auth/logout', async (c) => {
  const { DB } = c.env;
  const sessionId = getCookie(c, 'session');
  
  if (sessionId) {
    try {
      await DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
    } catch (error) {
      console.error('Logout error:', error);
    }
  }
  
  deleteCookie(c, 'session', { path: '/' });
  
  return c.json({ success: true, message: 'Logged out successfully' });
});

// ====================================================================
// POST /api/auth/register
// ====================================================================

auth.post('/auth/register', async (c) => {
  const { DB } = c.env;
  
  let body: RegisterRequest;
  try {
    body = await c.req.json<RegisterRequest>();
  } catch {
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body' } }, 400);
  }
  
  const { email, password, name, company, phone } = body;
  
  if (!email || !password || !name) {
    return c.json({ error: { code: 'MISSING_FIELDS', message: 'Email, password, and name are required' } }, 400);
  }
  
  if (password.length < 8) {
    return c.json({ error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters' } }, 400);
  }
  
  try {
    // Check if email exists
    const existing = await DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind(email.toLowerCase().trim()).first();
    
    if (existing) {
      return c.json({ error: { code: 'EMAIL_EXISTS', message: 'Email is already registered' } }, 409);
    }
    
    // Hash password
    const passwordHash = await hashPassword(password);
    
    // Create user (status: pending for approval)
    const result = await DB.prepare(`
      INSERT INTO users (email, password_hash, name, company, phone, role, status)
      VALUES (?, ?, ?, ?, ?, 'user', 'pending')
    `).bind(
      email.toLowerCase().trim(),
      passwordHash,
      name.trim(),
      company?.trim() || null,
      phone?.trim() || null
    ).run();
    
    return c.json({
      success: true,
      message: 'Registration successful. Your account is pending approval.',
      user_id: result.meta.last_row_id,
    }, 201);
  } catch (error) {
    console.error('Registration error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Registration failed' } }, 500);
  }
});

// ====================================================================
// POST /api/auth/forgot-password
// ====================================================================

auth.post('/auth/forgot-password', async (c) => {
  const { DB, SENDGRID_API_KEY, SENDGRID_FROM_EMAIL, SITE_URL } = c.env;
  
  let body: ForgotPasswordRequest;
  try {
    body = await c.req.json<ForgotPasswordRequest>();
  } catch {
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body' } }, 400);
  }
  
  const { email } = body;
  if (!email) {
    return c.json({ error: { code: 'MISSING_EMAIL', message: 'Email is required' } }, 400);
  }
  
  try {
    // Find user
    const user = await DB.prepare('SELECT id, email, name FROM users WHERE email = ?')
      .bind(email.toLowerCase().trim()).first<{ id: number; email: string; name: string }>();
    
    // Always return success to prevent email enumeration
    if (!user) {
      return c.json({ success: true, message: 'If the email exists, a reset link will be sent' });
    }
    
    // Generate reset token
    const resetToken = generateResetToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    
    await DB.prepare(`
      UPDATE users SET reset_token = ?, reset_token_expires = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(resetToken, expiresAt.toISOString(), user.id).run();
    
    // Send email via SendGrid
    if (SENDGRID_API_KEY && SENDGRID_FROM_EMAIL) {
      const resetUrl = `${SITE_URL || 'https://webapp-c7n.pages.dev'}/reset-password?token=${resetToken}`;
      
      await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SENDGRID_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: user.email, name: user.name }] }],
          from: { email: SENDGRID_FROM_EMAIL, name: 'RILARC' },
          subject: 'パスワードリセットのご案内',
          content: [
            {
              type: 'text/html',
              value: `
                <p>${user.name} 様</p>
                <p>パスワードリセットのリクエストを受け付けました。</p>
                <p>以下のリンクをクリックして、新しいパスワードを設定してください：</p>
                <p><a href="${resetUrl}">${resetUrl}</a></p>
                <p>このリンクは1時間後に無効になります。</p>
                <p>心当たりがない場合は、このメールを無視してください。</p>
              `,
            },
          ],
        }),
      });
    }
    
    return c.json({ success: true, message: 'If the email exists, a reset link will be sent' });
  } catch (error) {
    console.error('Forgot password error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Request failed' } }, 500);
  }
});

// ====================================================================
// POST /api/auth/reset-password
// ====================================================================

auth.post('/auth/reset-password', async (c) => {
  const { DB } = c.env;
  
  let body: ResetPasswordRequest;
  try {
    body = await c.req.json<ResetPasswordRequest>();
  } catch {
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body' } }, 400);
  }
  
  const { token, password } = body;
  if (!token || !password) {
    return c.json({ error: { code: 'MISSING_FIELDS', message: 'Token and password are required' } }, 400);
  }
  
  if (password.length < 8) {
    return c.json({ error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters' } }, 400);
  }
  
  try {
    // Find user with valid token
    const user = await DB.prepare(`
      SELECT id FROM users 
      WHERE reset_token = ? AND reset_token_expires > datetime('now')
    `).bind(token).first<{ id: number }>();
    
    if (!user) {
      return c.json({ error: { code: 'INVALID_TOKEN', message: 'Invalid or expired reset token' } }, 400);
    }
    
    // Hash new password
    const passwordHash = await hashPassword(password);
    
    // Update password and clear token
    await DB.prepare(`
      UPDATE users 
      SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).bind(passwordHash, user.id).run();
    
    // Invalidate all sessions for this user
    await DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
    
    return c.json({ success: true, message: 'Password reset successfully. Please login with your new password.' });
  } catch (error) {
    console.error('Reset password error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Password reset failed' } }, 500);
  }
});

// ====================================================================
// GET /api/auth/me
// ====================================================================

auth.get('/auth/me', async (c) => {
  const { DB } = c.env;
  const sessionId = getCookie(c, 'session');
  
  if (!sessionId) {
    return c.json({ authenticated: false, error: { code: 'NOT_AUTHENTICATED', message: 'Not logged in' } }, 401);
  }
  
  try {
    // Find valid session
    const session = await DB.prepare(`
      SELECT s.user_id, s.expires_at, u.id, u.email, u.name, u.role, u.status,
             u.subscription_plan, u.api_sponsor_id, u.video_build_sponsor_id
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.id = ? AND s.expires_at > datetime('now')
    `).bind(sessionId).first<{
      user_id: number;
      expires_at: string;
      id: number;
      email: string;
      name: string;
      role: string;
      status: string;
      subscription_plan: string;
      api_sponsor_id: number | null;
      video_build_sponsor_id: number | null;
    }>();
    
    if (!session) {
      deleteCookie(c, 'session', { path: '/' });
      return c.json({ authenticated: false, error: { code: 'SESSION_EXPIRED', message: 'Session expired' } }, 401);
    }
    
    return c.json({
      authenticated: true,
      user: {
        id: session.id,
        email: session.email,
        name: session.name,
        role: session.role,
        status: session.status,
        subscription_plan: session.subscription_plan,
        api_sponsor_id: session.api_sponsor_id,
        video_build_sponsor_id: session.video_build_sponsor_id,
      },
    });
  } catch (error) {
    console.error('Get user error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get user info' } }, 500);
  }
});

export default auth;
