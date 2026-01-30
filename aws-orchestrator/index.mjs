/**
 * Video Build Orchestrator Lambda - Phase B-2b (Remotion Integration)
 * 
 * Uses direct Lambda invocation with payload format matching Remotion CLI.
 * 
 * CRITICAL CHANGE (2026-01-19):
 * - Orchestrator invokes Remotion Lambda using :live alias (Provisioned Concurrency)
 * - Payload's functionName uses BASE name (no alias) so renderer/stitcher call $LATEST
 * 
 * Endpoints:
 * - POST /video/build/start  → Start Remotion render via direct Lambda invoke
 * - GET  /video/build/status/{buildId} → Get render progress from S3
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Configuration
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-1';

// Function name WITH :live alias - used by Orchestrator to invoke (Provisioned Concurrency)
const REMOTION_FUNCTION_WITH_ALIAS = process.env.REMOTION_FUNCTION_NAME || 'remotion-render-4-0-404-mem2048mb-disk2048mb-240sec:live';

// Function name WITHOUT alias - used in payload for internal Remotion calls (renderer/stitcher)
// This ensures renderer/stitcher call $LATEST, which is essential for Remotion's internal Lambda chaining
const REMOTION_FUNCTION_BASE = REMOTION_FUNCTION_WITH_ALIAS.replace(/:live$/, '');

const REMOTION_SERVE_URL = process.env.REMOTION_SERVE_URL || 'https://remotionlambda-apnortheast1-ucgr0eo7k7.s3.ap-northeast-1.amazonaws.com/sites/rilarc-video-build/index.html';
const REMOTION_BUCKET = 'remotionlambda-apnortheast1-ucgr0eo7k7';
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET || 'rilarc-remotion-renders-prod-202601';

// AWS Clients
const lambda = new LambdaClient({ region: AWS_REGION });
const s3 = new S3Client({ region: AWS_REGION });

export const handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const rawPath = event.path || event.rawPath || event.requestContext?.http?.path || '';
  const method = event.httpMethod || event.requestContext?.http?.method || '';
  const path = rawPath.replace(/^\/prod/, '') || '/';
  
  console.log(`Processing: ${method} ${path}`);
  
  let body = {};
  try {
    if (event.body) {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    }
  } catch (e) {
    console.error('Failed to parse body:', e);
  }
  
  // POST /video/build/start
  if (method === 'POST' && (path === '/start' || path === '/video/build/start')) {
    return handleStart(body);
  }
  
  // GET /video/build/status/{buildId}
  const statusMatch = path.match(/^\/(?:video\/build\/)?status\/(.+)$/);
  if (method === 'GET' && statusMatch) {
    const buildId = statusMatch[1];
    const queryParams = event.queryStringParameters || {};
    return handleStatus(buildId, queryParams);
  }
  
  return {
    statusCode: 404,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      error: 'Not found',
      message: `No method found matching route ${path.replace(/^\//, '')} for http method ${method}.`,
      supportedRoutes: ['POST /video/build/start', 'GET /video/build/status/{buildId}']
    })
  };
};

// ============================================================================
// Generate random render ID (matches Remotion's format)
// ============================================================================
function generateRenderId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 10; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ============================================================================
// POST /video/build/start - Start Remotion render via direct Lambda invoke
// ============================================================================

async function handleStart(body) {
  const { video_build_id, project_id, owner_user_id, executor_user_id, project_json, build_settings } = body;
  
  // Validate required fields
  const requiredFields = ['video_build_id', 'project_id', 'owner_user_id', 'executor_user_id', 'project_json'];
  const missingFields = requiredFields.filter(f => body[f] === undefined);
  
  if (missingFields.length > 0) {
    return jsonResponse(400, { 
      success: false, 
      error: { code: 'MISSING_FIELDS', message: `Missing required fields: ${missingFields.join(', ')}` }
    });
  }
  
  try {
    // Parse project_json (keep webapp format - Remotion now handles both)
    const webappJson = typeof project_json === 'string' ? JSON.parse(project_json) : project_json;
    
    // Generate render ID
    const renderId = generateRenderId();
    
    // Build inputProps - this is what gets passed to the composition
    const inputProps = {
      projectJson: webappJson
    };
    
    // Calculate frame range from duration
    const fps = webappJson.output?.fps || 30;
    const totalDurationMs = webappJson.total_duration_ms || 
      webappJson.scenes?.reduce((sum, s) => sum + (s.duration_ms || 3000), 0) || 3000;
    const totalFrames = Math.ceil((totalDurationMs / 1000) * fps);
    
    // Remotion Lambda has a limit of 200 concurrent functions
    // Calculate optimal framesPerLambda to stay under 200 functions
    // Max supported: 200 scenes × 30sec avg = 6000sec = 180,000 frames @ 30fps
    // With framesPerLambda = 900, that's 200 functions exactly
    const MAX_LAMBDA_FUNCTIONS = 200;
    const MIN_FRAMES_PER_LAMBDA = 60;   // Minimum for quality
    const MAX_FRAMES_PER_LAMBDA = 1200; // Maximum practical value
    
    // Auto-calculate: ensure we stay under 200 functions
    let framesPerLambda = Math.ceil(totalFrames / MAX_LAMBDA_FUNCTIONS);
    framesPerLambda = Math.max(MIN_FRAMES_PER_LAMBDA, framesPerLambda);  // At least 60
    framesPerLambda = Math.min(MAX_FRAMES_PER_LAMBDA, framesPerLambda);  // At most 1200
    
    const estimatedFunctions = Math.ceil(totalFrames / framesPerLambda);
    const durationSec = Math.round(totalDurationMs / 1000);
    
    console.log('Starting Remotion render:', {
      video_build_id,
      renderId,
      invokeFunction: REMOTION_FUNCTION_WITH_ALIAS, // What we invoke
      payloadFunction: REMOTION_FUNCTION_BASE,       // What goes in payload
      composition: 'RilarcVideo',
      totalFrames,
      totalDurationMs,
      durationSec,
      durationMin: (durationSec / 60).toFixed(1),
      framesPerLambda,
      estimatedFunctions,
      inputPropsSize: JSON.stringify(inputProps).length
    });
    
    // Build Remotion Lambda payload - matching official @remotion/lambda format
    // CRITICAL: DO NOT include 'functionName' in payload - it's only used in InvokeCommand
    // For internal renderer/stitcher calls, use 'rendererFunctionName' (optional)
    const remotionPayload = {
      type: 'start',
      version: '4.0.404',
      serveUrl: REMOTION_SERVE_URL,
      composition: 'RilarcVideo',
      codec: 'h264',
      inputProps: {
        type: 'payload',
        payload: JSON.stringify(inputProps)
      },
      // Frame range - null to let Remotion auto-calculate, or specify [start, end]
      frameRange: null,
      framesPerLambda: framesPerLambda,
      concurrency: null,  // Let Remotion decide based on framesPerLambda
      logLevel: 'info',
      downloadBehavior: {
        type: 'play-in-browser'
      },
      // rendererFunctionName: Optional - if not set, uses the same function
      rendererFunctionName: null,
      bucketName: REMOTION_BUCKET,
      jpegQuality: 80,
      imageFormat: 'jpeg',
      crf: null,
      envVariables: {},
      pixelFormat: null,
      proResProfile: null,
      x264Preset: null,
      privacy: 'public',
      maxRetries: 1,
      outName: null,
      timeoutInMilliseconds: 120000, // 120 seconds - longer for cold start
      chromiumOptions: {},
      scale: 1,
      everyNthFrame: 1,
      numberOfGifLoops: null,
      concurrencyPerLambda: null,
      muted: false,
      overwrite: true,
      audioBitrate: null,
      videoBitrate: null,
      encodingBufferSize: null,
      encodingMaxRate: null,
      webhook: null,
      forceHeight: null,
      forceWidth: null,
      audioCodec: null,
      offthreadVideoCacheSizeInBytes: null,
      deleteAfter: null,
      colorSpace: null,
      preferLossless: false,
      forcePathStyle: false,
      metadata: null,
      apiKey: null,
      licenseKey: null,
      offthreadVideoThreads: null,
      mediaCacheSizeInBytes: null,
      storageClass: null
    };
    
    // Invoke Remotion Lambda using :live alias (Provisioned Concurrency)
    const invokeCommand = new InvokeCommand({
      FunctionName: REMOTION_FUNCTION_WITH_ALIAS,  // <-- With :live alias
      Payload: JSON.stringify(remotionPayload),
      InvocationType: 'RequestResponse'
    });
    
    const response = await lambda.send(invokeCommand);
    const responsePayload = JSON.parse(new TextDecoder().decode(response.Payload));
    
    console.log('Remotion response:', JSON.stringify(responsePayload, null, 2));
    
    // Handle Remotion errors
    if (responsePayload.type === 'error') {
      return jsonResponse(500, {
        success: false,
        error: { 
          code: 'REMOTION_ERROR', 
          message: responsePayload.message || 'Failed to start Remotion render'
        }
      });
    }
    
    // Success - return render info
    const actualRenderId = responsePayload.renderId || renderId;
    const bucketName = responsePayload.bucketName || REMOTION_BUCKET;
    
    return jsonResponse(200, {
      success: true,
      video_build_id,
      aws_job_id: actualRenderId,
      remotion: {
        render_id: actualRenderId,
        bucket_name: bucketName
      },
      output: {
        bucket: bucketName,
        key: `renders/${actualRenderId}/out.mp4`
      },
      status: 'accepted',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Failed to start Remotion render:', error);
    
    return jsonResponse(500, {
      success: false,
      error: {
        code: 'START_FAILED',
        message: error.message || 'Failed to start video build'
      }
    });
  }
}

// ============================================================================
// GET /video/build/status/{buildId} - Get render progress from S3
// ============================================================================

async function handleStatus(buildId, queryParams = {}) {
  const { render_id } = queryParams;
  const remotionRenderId = render_id || buildId;
  
  try {
    // Read progress.json directly from S3
    const progressResponse = await s3.send(new GetObjectCommand({
      Bucket: REMOTION_BUCKET,
      Key: `renders/${remotionRenderId}/progress.json`
    }));
    
    const progressJson = JSON.parse(await progressResponse.Body.transformToString());
    console.log('Progress from S3:', JSON.stringify({
      done: progressJson.done,
      fatalErrorEncountered: progressJson.fatalErrorEncountered,
      framesRendered: progressJson.framesRendered,
      errors: progressJson.errors?.length || 0,
      hasPostRenderData: !!progressJson.postRenderData
    }, null, 2));
    
    // Check for fatal errors
    if (progressJson.fatalErrorEncountered || (progressJson.errors && progressJson.errors.length > 0)) {
      const errorMsg = progressJson.errors?.[0]?.message || 'Render failed';
      return jsonResponse(200, {
        success: true,
        build_id: buildId,
        status: 'failed',
        progress: { percent: 0, stage: 'Failed', message: errorMsg.substring(0, 200) },
        error: { code: 'RENDER_FAILED', message: errorMsg.substring(0, 500) }
      });
    }
    
    // Check if done via postRenderData
    if (progressJson.postRenderData) {
      let presignedUrl = null;
      let sizeBytes = progressJson.postRenderData.outputSize;
      const outputKey = `renders/${remotionRenderId}/out.mp4`;
      
      try {
        // Verify file exists and get presigned URL
        await s3.send(new HeadObjectCommand({
          Bucket: REMOTION_BUCKET,
          Key: outputKey
        }));
        
        const getCommand = new GetObjectCommand({
          Bucket: REMOTION_BUCKET,
          Key: outputKey
        });
        presignedUrl = await getSignedUrl(s3, getCommand, { expiresIn: 86400 });
      } catch (s3Error) {
        console.log('Could not generate presigned URL:', s3Error.message);
        // Use the outputFile URL from postRenderData as fallback
        presignedUrl = progressJson.postRenderData.outputFile;
      }
      
      return jsonResponse(200, {
        success: true,
        build_id: buildId,
        status: 'completed',
        progress: { percent: 100, stage: 'Completed', message: '動画生成が完了しました' },
        output: {
          bucket: REMOTION_BUCKET,
          key: outputKey,
          presigned_url: presignedUrl,
          size_bytes: sizeBytes,
          duration_ms: progressJson.postRenderData.timeToFinish
        },
        render_metadata: {
          render_id: remotionRenderId,
          started_at: progressJson.renderMetadata?.startedDate ?
            new Date(progressJson.renderMetadata.startedDate).toISOString() : null,
          completed_at: new Date(progressJson.postRenderData.endTime).toISOString(),
          cost: progressJson.postRenderData.cost?.estimatedDisplayCost
        }
      });
    }
    
    // Still rendering - calculate progress
    const framesRendered = progressJson.framesRendered || 0;
    const framesEncoded = progressJson.framesEncoded || 0;
    const totalChunks = progressJson.renderMetadata?.estimatedTotalLambdaInvocations || 
                        progressJson.renderMetadata?.totalChunks || 24;
    const totalFrames = totalChunks * 20; // framesPerLambda = 20
    
    // Calculate overall progress based on frames rendered + encoded
    const renderProgress = totalFrames > 0 ? framesRendered / totalFrames : 0;
    const encodeProgress = totalFrames > 0 ? framesEncoded / totalFrames : 0;
    const overallProgress = (renderProgress * 0.6) + (encodeProgress * 0.3);
    
    // Add extra progress for chunks combined
    const chunksComplete = progressJson.chunks?.length || 0;
    const combineProgress = totalChunks > 0 ? (chunksComplete / totalChunks) * 0.1 : 0;
    
    const percent = Math.min(99, Math.round((overallProgress + combineProgress) * 100));
    
    let stage = 'Rendering';
    let message = `レンダリング中... ${percent}%`;
    
    if (percent < 5) {
      stage = 'Initializing';
      message = '初期化中...';
    } else if (percent < 30) {
      stage = 'Rendering';
      message = `フレームレンダリング中... ${framesRendered}/${totalFrames}`;
    } else if (percent < 80) {
      stage = 'Encoding';
      message = `エンコード中... ${framesEncoded}/${totalFrames}`;
    } else {
      stage = 'Combining';
      message = `チャンク結合中... ${chunksComplete}/${totalChunks}`;
    }
    
    return jsonResponse(200, {
      success: true,
      build_id: buildId,
      status: 'rendering',
      progress: {
        percent,
        stage,
        message,
        framesRendered,
        framesEncoded,
        totalFrames,
        chunks: chunksComplete,
        totalChunks
      },
      output: null
    });
    
  } catch (error) {
    // progress.json might not exist yet
    console.log('Could not read progress.json:', error.message);
    
    // Return queued status
    return jsonResponse(200, {
      success: true,
      build_id: buildId,
      status: 'rendering',
      progress: { percent: 0, stage: 'Queued', message: '処理を開始しています...' },
      output: null
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
