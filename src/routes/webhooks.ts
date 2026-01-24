/**
 * Webhooks Routes
 * 
 * External webhook endpoints for AWS Orchestrator callbacks
 * 
 * POST /api/webhooks/video-build - Video build status callback
 */

import { Hono } from 'hono';
import type { Bindings } from '../types/bindings';
import { logVideoBuildRender } from '../utils/usage-logger';

const webhooks = new Hono<{ Bindings: Bindings }>();

/**
 * POST /api/webhooks/video-build
 * 
 * AWS Orchestrator からのステータス更新コールバック
 * ポーリング依存を脱却し、リアルタイムでステータスを更新
 * 
 * 認証: HMAC-SHA256 署名検証
 * Header: X-Rilarc-Signature: sha256=<hex>
 * Header: X-Rilarc-Timestamp: <unix_sec>
 * Header: X-Rilarc-Event-Id: <uuid>
 */
webhooks.post('/video-build', async (c) => {
  const { DB } = c.env;
  
  try {
    // 1. 署名検証（HMAC-SHA256 with timestamp for replay protection）
    const signature = c.req.header('X-Rilarc-Signature') || c.req.header('X-Webhook-Signature');
    const timestamp = c.req.header('X-Rilarc-Timestamp');
    const eventId = c.req.header('X-Rilarc-Event-Id');
    const webhookSecret = c.env.WEBHOOK_SECRET || c.env.CRON_SECRET;
    
    // Log event for debugging
    if (eventId) {
      console.log(`[Webhook] Received event: ${eventId}`);
    }
    
    const body = await c.req.text();
    
    if (!webhookSecret) {
      console.warn('[Webhook] WEBHOOK_SECRET not configured, accepting without verification');
    } else if (!signature) {
      return c.json({ error: 'UNAUTHORIZED', message: 'Missing signature header' }, 401);
    } else {
      // Extract signature value (remove "sha256=" prefix if present)
      const signatureValue = signature.startsWith('sha256=') 
        ? signature.slice(7) 
        : signature;
      
      // Build signed message: timestamp + "." + body (if timestamp present)
      const signedMessage = timestamp ? `${timestamp}.${body}` : body;
      
      // HMAC-SHA256 検証
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(webhookSecret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(signedMessage));
      const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      
      if (signatureValue !== expectedSignature) {
        console.warn('[Webhook] Signature mismatch', { eventId, timestamp });
        return c.json({ error: 'UNAUTHORIZED', message: 'Invalid signature' }, 401);
      }
      
      // Replay protection: reject if timestamp is older than 5 minutes
      if (timestamp) {
        const timestampSec = parseInt(timestamp, 10);
        const nowSec = Math.floor(Date.now() / 1000);
        if (Math.abs(nowSec - timestampSec) > 300) {
          console.warn('[Webhook] Timestamp too old', { eventId, timestamp, nowSec });
          return c.json({ error: 'UNAUTHORIZED', message: 'Timestamp expired' }, 401);
        }
      }
    }
    
    // Parse body as JSON
    const payload = JSON.parse(body);
    return await processWebhook(c, DB, payload, eventId);
    
  } catch (error) {
    console.error('[Webhook] Error:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Webhook processing failed' 
    }, 500);
  }
});

/**
 * Process webhook payload
 */
async function processWebhook(c: any, DB: D1Database, payload: any, eventId?: string | null) {
  const {
    video_build_id,
    status,
    progress_percent,
    progress_stage,
    progress_message,
    download_url,
    download_expires_at,
    error_code,
    error_message,
    render_metadata,
  } = payload;
  
  if (!video_build_id || !status) {
    return c.json({ error: 'INVALID_PAYLOAD', message: 'video_build_id and status required' }, 400);
  }
  
  // 2. ビルドの存在確認
  const build = await DB.prepare(`
    SELECT id, status, render_usage_logged, project_id, owner_user_id
    FROM video_builds WHERE id = ?
  `).bind(video_build_id).first<{
    id: number;
    status: string;
    render_usage_logged: number;
    project_id: number;
    owner_user_id: number | null;
  }>();
  
  if (!build) {
    return c.json({ error: 'NOT_FOUND', message: 'Video build not found' }, 404);
  }
  
  // 3. すでに完了/失敗していたらスキップ（冪等性）
  if (['completed', 'failed'].includes(build.status) && build.status === status) {
    console.log(`[Webhook] Build ${video_build_id} already ${status}, skipping`);
    return c.json({ success: true, message: 'Already processed', status: build.status });
  }
  
  // 4. ステータス更新
  const updateFields: string[] = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const updateValues: any[] = [status];
  
  if (progress_percent !== undefined) {
    updateFields.push('progress_percent = ?');
    updateValues.push(progress_percent);
  }
  if (progress_stage) {
    updateFields.push('progress_stage = ?');
    updateValues.push(progress_stage);
  }
  if (progress_message) {
    updateFields.push('progress_message = ?');
    updateValues.push(progress_message);
  }
  if (download_url) {
    updateFields.push('download_url = ?');
    updateValues.push(download_url);
  }
  if (download_expires_at) {
    updateFields.push('download_expires_at = ?');
    updateValues.push(download_expires_at);
  }
  if (error_code) {
    updateFields.push('error_code = ?');
    updateValues.push(error_code);
  }
  if (error_message) {
    updateFields.push('error_message = ?');
    updateValues.push(error_message);
  }
  
  // Render metadata
  if (render_metadata) {
    if (render_metadata.render_id) {
      updateFields.push('remotion_render_id = ?');
      updateValues.push(render_metadata.render_id);
    }
    if (render_metadata.started_at) {
      updateFields.push('render_started_at = ?');
      updateValues.push(render_metadata.started_at);
    }
    if (render_metadata.completed_at) {
      updateFields.push('render_completed_at = ?');
      updateValues.push(render_metadata.completed_at);
    }
    if (render_metadata.duration_sec !== undefined) {
      updateFields.push('render_duration_sec = ?');
      updateValues.push(render_metadata.duration_sec);
    }
    if (render_metadata.estimated_cost_usd !== undefined) {
      updateFields.push('estimated_cost_usd = ?');
      updateValues.push(render_metadata.estimated_cost_usd);
    }
  }
  
  updateValues.push(video_build_id);
  
  await DB.prepare(`
    UPDATE video_builds SET ${updateFields.join(', ')} WHERE id = ?
  `).bind(...updateValues).run();
  
  console.log(`[Webhook] Build ${video_build_id} updated: ${build.status} → ${status}${eventId ? ` (event: ${eventId})` : ''}`);
  
  // 5. 完了時のログ記録（二重計上防止）
  if (status === 'completed' && build.render_usage_logged === 0) {
    try {
      // Lock first: render_usage_logged を 1 に更新
      const lockResult = await DB.prepare(`
        UPDATE video_builds SET render_usage_logged = 1 WHERE id = ? AND render_usage_logged = 0
      `).bind(video_build_id).run();
      
      if (lockResult.meta.changes === 1) {
        // Get full build data for logging
        const fullBuild = await DB.prepare(`
          SELECT vb.*, p.user_id as project_owner_user_id
          FROM video_builds vb
          LEFT JOIN projects p ON vb.project_id = p.id
          WHERE vb.id = ?
        `).bind(video_build_id).first<any>();
        
        if (fullBuild) {
          const userId = fullBuild.owner_user_id || fullBuild.project_owner_user_id;
          if (userId) {
            let fps = 30, aspectRatio = '9:16', resolution = '1080p';
            try {
              const settings = JSON.parse(fullBuild.settings_json || '{}');
              fps = settings.fps || 30;
              aspectRatio = settings.aspect_ratio || '9:16';
              resolution = settings.resolution || '1080p';
            } catch {}
            
            await logVideoBuildRender(DB, {
              userId,
              projectId: fullBuild.project_id,
              videoBuildId: video_build_id,
              totalScenes: fullBuild.total_scenes || 0,
              totalDurationMs: fullBuild.total_duration_ms || 0,
              fps,
              status: 'completed',
              errorCode: null,
              errorMessage: null,
              remotionRenderId: render_metadata?.render_id || fullBuild.remotion_render_id,
              aspectRatio,
              resolution,
            });
            console.log(`[Webhook] Logged render usage for build ${video_build_id}`);
          }
        }
      }
    } catch (logErr) {
      console.warn('[Webhook] Failed to log render usage:', logErr);
    }
  }
  
  // 6. 失敗時もログ記録
  if (status === 'failed' && build.render_usage_logged === 0) {
    try {
      await DB.prepare(`
        UPDATE video_builds SET render_usage_logged = 1 WHERE id = ? AND render_usage_logged = 0
      `).bind(video_build_id).run();
      
      const fullBuild = await DB.prepare(`
        SELECT vb.*, p.user_id as project_owner_user_id
        FROM video_builds vb
        LEFT JOIN projects p ON vb.project_id = p.id
        WHERE vb.id = ?
      `).bind(video_build_id).first<any>();
      
      if (fullBuild) {
        const userId = fullBuild.owner_user_id || fullBuild.project_owner_user_id;
        if (userId) {
          let fps = 30, aspectRatio = '9:16', resolution = '1080p';
          try {
            const settings = JSON.parse(fullBuild.settings_json || '{}');
            fps = settings.fps || 30;
            aspectRatio = settings.aspect_ratio || '9:16';
            resolution = settings.resolution || '1080p';
          } catch {}
          
          await logVideoBuildRender(DB, {
            userId,
            projectId: fullBuild.project_id,
            videoBuildId: video_build_id,
            totalScenes: fullBuild.total_scenes || 0,
            totalDurationMs: fullBuild.total_duration_ms || 0,
            fps,
            status: 'failed',
            errorCode: error_code || 'UNKNOWN',
            errorMessage: error_message || 'Unknown error',
            remotionRenderId: render_metadata?.render_id || fullBuild.remotion_render_id,
            aspectRatio,
            resolution,
          });
          console.log(`[Webhook] Logged failed render for build ${video_build_id}`);
        }
      }
    } catch (logErr) {
      console.warn('[Webhook] Failed to log render failure:', logErr);
    }
  }
  
  // 7. Webhook受信の監査ログ（api_usage_logs）
  try {
    await DB.prepare(`
      INSERT INTO api_usage_logs (user_id, provider, model, operation, input_tokens, output_tokens, estimated_cost_usd, metadata_json, created_at)
      VALUES (?, 'internal', 'webhook', 'video_build_callback', 0, 0, 0, ?, CURRENT_TIMESTAMP)
    `).bind(
      build.owner_user_id || null,
      JSON.stringify({
        video_build_id,
        event_id: eventId || null,
        previous_status: build.status,
        new_status: status,
        has_download_url: !!download_url,
      })
    ).run();
  } catch (logErr) {
    console.warn('[Webhook] Failed to log to api_usage_logs:', logErr);
  }
  
  return c.json({ 
    success: true, 
    video_build_id,
    previous_status: build.status,
    new_status: status,
    event_id: eventId || null,
  });
}

export default webhooks;
