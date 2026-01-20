/**
 * Convert milliseconds to frames
 */
export function msToFrames(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

/**
 * Convert frames to milliseconds
 */
export function framesToMs(frames: number, fps: number): number {
  return Math.round((frames / fps) * 1000);
}

/**
 * Calculate total frames from total duration
 */
export function calculateTotalFrames(totalDurationMs: number, fps: number): number {
  return msToFrames(totalDurationMs, fps);
}
