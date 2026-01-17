/**
 * Google Veo Video Generator Service
 * 
 * Uses @google/genai SDK to generate videos via Google Veo API.
 * This is the core service that handles the actual video generation.
 * 
 * Supported Models:
 * - veo-2.0-generate-001: Stable, 5-8 seconds, no audio, 16:9 or 9:16
 * - veo-3.0-generate-preview: Preview, 8 seconds fixed, WITH audio, 16:9 only
 * - veo-3.0-fast-generate-preview: Preview, faster generation, WITH audio, 16:9 only
 * 
 * Design notes:
 * - Uses new Google GenAI SDK (not REST) - this is the key reason for using Lambda
 * - Cloudflare Workers cannot use SDK due to CSP/dynamic code restrictions
 * - API key is passed per-request from Cloudflare (user's key)
 * - API key is NEVER stored, only used for the generation and then discarded
 * - Veo3 models generate audio natively - no separate config needed
 * 
 * Reference: https://ai.google.dev/gemini-api/docs/video
 */

import { GoogleGenAI } from '@google/genai';
import type { VeoGenerationResult } from '../types';
import { logger } from '../utils/logger';

// =============================================================================
// Constants
// =============================================================================

// Default to Veo 2 for backward compatibility
const DEFAULT_MODEL = 'veo-2.0-generate-001';

// Veo 3 models (Preview) - these generate audio natively
const VEO3_MODELS = [
  'veo-3.0-generate-preview',
  'veo-3.0-fast-generate-preview',
  'veo-3.0-generate-001',
  'veo-3.0-fast-generate-001',
];

/**
 * Check if a model is a Veo3 model (supports audio generation)
 */
function isVeo3Model(model: string): boolean {
  return VEO3_MODELS.some(v3 => model.startsWith(v3.replace('-preview', '').replace('-001', '')));
}
const MAX_POLL_TIME_MS = 6 * 60 * 1000;  // 6 minutes
const POLL_INTERVAL_MS = 10 * 1000;       // 10 seconds

// =============================================================================
// Main Generator Function
// =============================================================================

export interface VeoGenerateInput {
  imageBase64: string;
  imageMimeType: string;
  prompt: string;
  durationSec: number;
  apiKey: string;
  model?: string;  // Optional: defaults to MODEL_NAME
}

/**
 * Generate video using Google Veo (GenAI SDK)
 */
export async function generateVeoVideo(input: VeoGenerateInput): Promise<VeoGenerationResult> {
  const { imageBase64, imageMimeType, prompt, durationSec, apiKey, model } = input;
  const modelName = model || DEFAULT_MODEL;
  const isVeo3 = isVeo3Model(modelName);
  
  logger.info('Starting Veo video generation', {
    imageMimeType,
    promptLength: prompt.length,
    durationSec,
    model: modelName,
    isVeo3,
    audioEnabled: isVeo3, // Veo3 generates audio natively
  });

  try {
    // Initialize SDK with user's API key
    const client = new GoogleGenAI({ apiKey });

    // Build prompt - combine user prompt with cinematographic defaults
    const finalPrompt = prompt || 'A beautiful cinematic scene with gentle camera movement';

    logger.info('Calling Veo generateVideos', { 
      prompt: finalPrompt.substring(0, 100),
      model: modelName,
    });

    // Generate video using SDK
    // Reference: https://ai.google.dev/gemini-api/docs/video
    let operation;
    try {
      // Build config based on model version
      // Veo3: 8 seconds fixed, audio enabled, 16:9 only
      // Veo2: 5-8 seconds, no audio, 16:9 or 9:16
      const config: Record<string, any> = {
        aspectRatio: '16:9',
        numberOfVideos: 1,
      };
      
      // Veo3 specific: audio is always generated (no config needed per docs)
      // personGeneration for Veo3 image-to-video: allow_adult only
      if (isVeo3) {
        config.personGeneration = 'allow_adult';
        logger.info('Veo3 mode: audio will be generated natively', { model: modelName });
      }
      
      // Use the new API structure with image input
      operation = await client.models.generateVideos({
        model: modelName,
        prompt: finalPrompt,
        image: {
          imageBytes: imageBase64,
          mimeType: imageMimeType,
        },
        config,
      });
    } catch (apiError: any) {
      logger.error('Veo API call failed', {
        error: apiError.message,
        status: apiError.status,
      });

      // Handle specific error codes
      if (apiError.status === 403 || apiError.message?.includes('API key')) {
        return {
          success: false,
          error: {
            code: 'INVALID_API_KEY',
            message: 'The provided API key is invalid or does not have access to Veo',
          },
        };
      }

      if (apiError.status === 429) {
        return {
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'API rate limit exceeded. Please try again later.',
          },
        };
      }

      throw apiError;
    }

    // Poll for completion
    logger.info('Video generation started, polling for completion', {
      operationName: operation.name,
    });

    const startTime = Date.now();
    let currentOperation = operation;

    while (!currentOperation.done && Date.now() - startTime < MAX_POLL_TIME_MS) {
      await sleep(POLL_INTERVAL_MS);
      
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      logger.debug('Polling operation status', { 
        operationName: currentOperation.name,
        elapsedSec,
      });

      try {
        // Use the correct API to get operation status
        currentOperation = await client.operations.getVideosOperation({
          operation: currentOperation,
        });
      } catch (pollError: any) {
        logger.warn('Poll error, continuing', { error: pollError.message });
        // Continue polling on transient errors
      }
    }

    // Check timeout
    if (!currentOperation.done) {
      logger.error('Video generation timed out', {
        operationName: currentOperation.name,
        elapsedMs: Date.now() - startTime,
      });
      return {
        success: false,
        error: {
          code: 'TIMEOUT',
          message: 'Video generation timed out after 6 minutes',
        },
      };
    }

    // Check for errors in result
    if (currentOperation.error) {
      logger.error('Video generation failed', {
        error: currentOperation.error,
      });
      const errorMessage = typeof currentOperation.error === 'object' && currentOperation.error !== null
        ? (currentOperation.error as any).message || JSON.stringify(currentOperation.error)
        : String(currentOperation.error);
      return {
        success: false,
        error: {
          code: 'GENERATION_FAILED',
          message: errorMessage || 'Video generation failed',
        },
      };
    }

    // Extract video from response
    const generatedVideos = currentOperation.response?.generatedVideos;
    if (!generatedVideos || generatedVideos.length === 0) {
      logger.error('No video in response', { response: currentOperation.response });
      return {
        success: false,
        error: {
          code: 'NO_VIDEO',
          message: 'No video was generated',
        },
      };
    }

    const video = generatedVideos[0].video;
    if (!video) {
      logger.error('Video object is empty', { generatedVideos });
      return {
        success: false,
        error: {
          code: 'EMPTY_VIDEO',
          message: 'Video object is empty',
        },
      };
    }

    // Check if video bytes are already in the response
    if (video.videoBytes) {
      logger.info('Video bytes received in response', {
        videoSize: video.videoBytes.length,
        mimeType: video.mimeType || 'video/mp4',
      });

      // videoBytes is base64 encoded
      const videoBytes = Buffer.from(video.videoBytes, 'base64');
      return {
        success: true,
        videoBytes: new Uint8Array(videoBytes),
        mimeType: video.mimeType || 'video/mp4',
      };
    }

    // Download video from URI
    if (video.uri) {
      logger.info('Downloading video from URI', {
        videoUri: video.uri.substring(0, 50),
      });

      try {
        // Add API key to download URL if needed
        const downloadUrl = video.uri.includes('?') 
          ? `${video.uri}&key=${apiKey}`
          : `${video.uri}?key=${apiKey}`;

        const response = await fetch(downloadUrl);
        if (!response.ok) {
          throw new Error(`Download failed: ${response.status}`);
        }

        const videoBytes = new Uint8Array(await response.arrayBuffer());
        
        logger.info('Video generation completed successfully', {
          videoSize: videoBytes.length,
          mimeType: video.mimeType || 'video/mp4',
        });

        return {
          success: true,
          videoBytes,
          mimeType: video.mimeType || 'video/mp4',
        };
      } catch (downloadError: any) {
        logger.error('Video download failed', { error: downloadError.message });
        return {
          success: false,
          error: {
            code: 'DOWNLOAD_FAILED',
            message: `Failed to download video: ${downloadError.message}`,
          },
        };
      }
    }

    // No video data available
    logger.error('No video data available', { video });
    return {
      success: false,
      error: {
        code: 'NO_VIDEO_DATA',
        message: 'Video was generated but no data is available',
      },
    };

  } catch (err: any) {
    logger.error('Unexpected error in video generation', {
      error: err.message,
      stack: err.stack?.substring(0, 500),
    });

    return {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: err.message || 'An unexpected error occurred',
      },
    };
  }
}

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
