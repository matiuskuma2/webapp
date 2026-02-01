// src/constants.ts
export const GENERATION_STATUS = {
  PENDING: 'pending',
  GENERATING: 'generating',
  COMPLETED: 'completed',
  FAILED: 'failed',
  POLICY_VIOLATION: 'policy_violation',
} as const;

export type GenerationStatus =
  (typeof GENERATION_STATUS)[keyof typeof GENERATION_STATUS];

export const ERROR_CODES = {
  NOT_FOUND: 'NOT_FOUND',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  
  // Auth
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',

  // Audio generation
  AUDIO_GENERATING: 'AUDIO_GENERATING',
  NO_DIALOGUE: 'NO_DIALOGUE',
  AUDIO_GENERATION_FAILED: 'AUDIO_GENERATION_FAILED',
  ACTIVE_AUDIO_DELETE: 'ACTIVE_AUDIO_DELETE',
} as const;
