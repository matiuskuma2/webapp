/**
 * Video Build Orchestrator Lambda - Phase B-2
 * 
 * Integrates with Remotion Lambda for actual video rendering.
 * - POST /start: Start rendering with Remotion Lambda
 * - GET /status/{video_build_id}: Get render progress and generate presigned URL on completion
 */

import { z } from "zod";
import {
  renderMediaOnLambda,
  getRenderProgress,
  getSites,
} from "@remotion/lambda/client";
import { S3Client, CopyObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Environment variables
// Note: AWS_REGION is reserved, so we use REMOTION_REGION
const region = process.env.REMOTION_REGION || process.env.AWS_REGION || "ap-northeast-1";
const siteName = process.env.REMOTION_SITE_NAME || "rilarc-video-build";
const functionName = process.env.REMOTION_FUNCTION_NAME || "remotion-render-4-0-404-mem2048mb-disk2048mb-240sec";
const remotionBucket = process.env.REMOTION_RENDER_BUCKET || "remotionlambda-apnortheast1-ucgr0eo7k7";
const outputBucket = process.env.OUTPUT_BUCKET || "rilarc-remotion-renders-prod-202601";
const presignExpires = Number(process.env.PRESIGN_EXPIRES_SECONDS || "86400");

const s3 = new S3Client({ region });

// Validation schemas
const StartSchema = z.object({
  video_build_id: z.number().int().positive(),
  project_id: z.number().int().positive(),
  owner_user_id: z.number().int().positive(),
  executor_user_id: z.number().int().positive(),
  is_delegation: z.boolean(),
  project_json: z.any(), // The actual project data to render
  build_settings: z.any().optional(),
});

// Helper: JSON response
function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Helper: Get serve URL for Remotion site
async function getServeUrl() {
  try {
    console.log(`[getServeUrl] region=${region}, bucketName=${remotionBucket}`);
    const sites = await getSites({ region, bucketName: remotionBucket });
    console.log(`[getServeUrl] sites found:`, sites.sites.map(s => s.id));
    const site = sites.sites.find(s => s.id === siteName);
    if (!site) {
      throw new Error(`Site '${siteName}' not found in bucket '${remotionBucket}'`);
    }
    return site.serveUrl;
  } catch (error) {
    console.error("[getServeUrl] Failed:", error);
    // Fallback: construct URL directly (may not work in all cases)
    return `https://${remotionBucket}.s3.${region}.amazonaws.com/sites/${siteName}/index.html`;
  }
}

// Helper: Promise with timeout
function withTimeout(promise, timeoutMs, errorMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    )
  ]);
}

export const handler = async (event) => {
  console.log("Event:", JSON.stringify(event, null, 2));

  const rawPath = event.rawPath || event.requestContext?.http?.path || "";
  const method = event.requestContext?.http?.method || event.httpMethod || "";
  const path = rawPath.replace(/^\/prod/, "") || "/";

  console.log(`Processing: ${method} ${path}`);

  try {
    // POST /start - Start rendering
    if (method === "POST" && path === "/start") {
      return await handleStart(event);
    }

    // GET /status/{video_build_id} - Get progress
    if (method === "GET" && path.startsWith("/status/")) {
      return await handleStatus(event, path);
    }

    return json(404, { error: "Not found", path });
  } catch (error) {
    console.error("Handler error:", error);
    return json(500, {
      success: false,
      error: { code: "INTERNAL_ERROR", message: error.message || String(error) },
    });
  }
};

/**
 * POST /start - Start Remotion Lambda render
 */
async function handleStart(event) {
  // Parse and validate body
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (e) {
    return json(400, { success: false, error: { code: "INVALID_JSON", message: "Invalid JSON body" } });
  }

  const parseResult = StartSchema.safeParse(body);
  if (!parseResult.success) {
    return json(400, {
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request body",
        details: parseResult.error.issues,
      },
    });
  }

  const input = parseResult.data;
  console.log(`[handleStart] video_build_id: ${input.video_build_id}`);

  // Get serve URL
  console.log("[handleStart] Getting serve URL...");
  const serveUrl = await getServeUrl();
  console.log(`[handleStart] Serve URL: ${serveUrl}`);

  // Output key in OUTPUT_BUCKET
  const outputKey = `video-builds/owner-${input.owner_user_id}/video-build-${input.video_build_id}.mp4`;

  try {
    console.log("[handleStart] Calling renderMediaOnLambda...");
    console.log(`[handleStart] region=${region}, functionName=${functionName}`);
    console.log(`[handleStart] composition=RilarcVideo`);
    console.log(`[handleStart] inputProps keys:`, Object.keys({
      projectJson: input.project_json,
      buildSettings: input.build_settings || {},
      meta: {
        videoBuildId: input.video_build_id,
        projectId: input.project_id,
        ownerUserId: input.owner_user_id,
      },
    }));

    // Start Remotion Lambda render with 90 second timeout
    // renderMediaOnLambda should return quickly (just starts the render process)
    const renderResult = await withTimeout(
      renderMediaOnLambda({
        region,
        functionName,
        serveUrl,
        composition: "RilarcVideo",
        inputProps: {
          projectJson: input.project_json,
          buildSettings: input.build_settings || {},
          meta: {
            videoBuildId: input.video_build_id,
            projectId: input.project_id,
            ownerUserId: input.owner_user_id,
          },
        },
        codec: "h264",
        // Remotion will output to its own bucket, we'll copy to OUTPUT_BUCKET on completion
      }),
      90000, // 90 second timeout
      "renderMediaOnLambda timed out after 90 seconds"
    );

    console.log("[handleStart] Render started:", JSON.stringify(renderResult, null, 2));

    return json(200, {
      success: true,
      status: "accepted",
      video_build_id: input.video_build_id,
      aws_job_id: renderResult.renderId,
      remotion: {
        render_id: renderResult.renderId,
        bucket: renderResult.bucketName,
      },
      output: {
        bucket: outputBucket,
        key: outputKey,
      },
    });
  } catch (renderError) {
    console.error("[handleStart] Remotion render failed:", renderError);
    console.error("[handleStart] Error stack:", renderError.stack);
    return json(500, {
      success: false,
      error: {
        code: "RENDER_START_FAILED",
        message: renderError.message || "Failed to start render",
        stack: renderError.stack,
      },
    });
  }
}

/**
 * GET /status/{video_build_id} - Get render progress
 */
async function handleStatus(event, path) {
  const videoBuildId = Number(path.split("/").pop());
  const qs = event.queryStringParameters || {};
  const renderId = qs.render_id;
  const outputKey = qs.output_key;

  if (!renderId) {
    return json(400, {
      success: false,
      error: { code: "INVALID_REQUEST", message: "render_id query parameter is required" },
    });
  }

  console.log(`[handleStatus] video_build_id: ${videoBuildId}, render_id: ${renderId}`);

  try {
    // Get Remotion render progress
    const progress = await getRenderProgress({
      region,
      functionName,
      bucketName: remotionBucket,
      renderId,
    });

    console.log("[handleStatus] Progress:", JSON.stringify(progress, null, 2));

    // Handle error state
    if (progress.fatalErrorEncountered) {
      return json(200, {
        success: false,
        video_build_id: videoBuildId,
        status: "failed",
        error: {
          code: "RENDER_FAILED",
          message: progress.errors?.[0]?.message || "Render failed",
        },
      });
    }

    // Handle in-progress state
    if (!progress.done) {
      return json(200, {
        success: true,
        video_build_id: videoBuildId,
        status: "rendering",
        progress: {
          percent: Math.round((progress.overallProgress || 0) * 100),
          stage: progress.renderMetadata?.type || "rendering",
          frames_rendered: progress.framesRendered || 0,
          chunks_done: progress.chunks || 0,
        },
      });
    }

    // Render complete - copy to OUTPUT_BUCKET and generate presigned URL
    const remotionOutputKey = progress.outKey;
    console.log(`[handleStatus] Render complete. Remotion output: ${remotionOutputKey}`);

    if (!outputKey) {
      return json(400, {
        success: false,
        error: { code: "INVALID_REQUEST", message: "output_key query parameter is required for completed renders" },
      });
    }

    // Check if already copied to output bucket
    let needsCopy = true;
    try {
      await s3.send(new HeadObjectCommand({
        Bucket: outputBucket,
        Key: outputKey,
      }));
      needsCopy = false;
      console.log("[handleStatus] File already exists in output bucket");
    } catch (e) {
      // File doesn't exist, need to copy
    }

    if (needsCopy && remotionOutputKey) {
      console.log(`[handleStatus] Copying from ${remotionBucket}/${remotionOutputKey} to ${outputBucket}/${outputKey}`);
      try {
        await s3.send(new CopyObjectCommand({
          Bucket: outputBucket,
          Key: outputKey,
          CopySource: encodeURIComponent(`${remotionBucket}/${remotionOutputKey}`),
          ContentType: "video/mp4",
        }));
        console.log("[handleStatus] Copy successful");
      } catch (copyError) {
        console.error("[handleStatus] Copy failed:", copyError);
        // Don't fail - the file might still be accessible from remotion bucket
      }
    }

    // Generate presigned URL
    const presignedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: outputBucket,
        Key: outputKey,
      }),
      { expiresIn: presignExpires }
    );

    // Get file size
    let sizeBytes = null;
    try {
      const headResult = await s3.send(new HeadObjectCommand({
        Bucket: outputBucket,
        Key: outputKey,
      }));
      sizeBytes = headResult.ContentLength;
    } catch (e) {
      console.warn("[handleStatus] Could not get file size:", e);
    }

    return json(200, {
      success: true,
      video_build_id: videoBuildId,
      status: "completed",
      output: {
        bucket: outputBucket,
        key: outputKey,
        size_bytes: sizeBytes,
        presigned_url: presignedUrl,
        expires_seconds: presignExpires,
      },
      render_duration_ms: progress.timeToFinish || null,
    });
  } catch (error) {
    console.error("[handleStatus] Status check failed:", error);
    return json(500, {
      success: false,
      error: { code: "STATUS_CHECK_FAILED", message: error.message || String(error) },
    });
  }
}
