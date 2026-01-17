/**
 * Simple logger utility for Lambda
 * 
 * Design: 
 * - Structured JSON logging for CloudWatch
 * - API keys are NEVER logged
 * - Log levels: debug, info, warn, error
 */

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  const currentPriority = LEVEL_PRIORITY[LOG_LEVEL as LogLevel] ?? LEVEL_PRIORITY.info;
  return LEVEL_PRIORITY[level] >= currentPriority;
}

function formatLog(level: LogLevel, message: string, data?: Record<string, unknown>): string {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(data && { data }),
  };
  return JSON.stringify(logEntry);
}

/**
 * Mask sensitive data in objects
 */
function maskSensitive(data: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...data };
  const sensitiveKeys = ['api_key', 'apiKey', 'secret', 'password', 'token', 'authorization'];
  
  for (const key of Object.keys(masked)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      masked[key] = '[REDACTED]';
    }
  }
  
  return masked;
}

export const logger = {
  debug(message: string, data?: Record<string, unknown>) {
    if (shouldLog('debug')) {
      console.debug(formatLog('debug', message, data ? maskSensitive(data) : undefined));
    }
  },
  
  info(message: string, data?: Record<string, unknown>) {
    if (shouldLog('info')) {
      console.info(formatLog('info', message, data ? maskSensitive(data) : undefined));
    }
  },
  
  warn(message: string, data?: Record<string, unknown>) {
    if (shouldLog('warn')) {
      console.warn(formatLog('warn', message, data ? maskSensitive(data) : undefined));
    }
  },
  
  error(message: string, data?: Record<string, unknown>) {
    if (shouldLog('error')) {
      console.error(formatLog('error', message, data ? maskSensitive(data) : undefined));
    }
  },
};
