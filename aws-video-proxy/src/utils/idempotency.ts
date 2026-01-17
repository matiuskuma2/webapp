/**
 * Idempotency utilities
 * 
 * Generates idempotency keys for video generation jobs
 * to prevent duplicate processing
 */

import { createHash } from 'crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function buildIdempotencyKey(args: {
  sceneId: number;
  model: string;
  durationSec: number;
  prompt: string;
  imageBase64: string; // hashed only (first 2048 chars to bound cost)
}): string {
  const promptHash = sha256Hex(args.prompt);
  const imageHash = sha256Hex(args.imageBase64.slice(0, 2048));
  return `scene:${args.sceneId}|model:${args.model}|dur:${args.durationSec}|p:${promptHash}|i:${imageHash}`;
}
