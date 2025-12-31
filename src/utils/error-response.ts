// src/utils/error-response.ts
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function createErrorResponse(
  code: string,
  message: string,
  details?: unknown
): ErrorResponse {
  return {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
}
