import pino from 'pino';
import crypto from 'crypto';

/**
 * Determine if we're in dev mode from NODE_ENV, without importing config
 * (which may call process.exit during env validation at module load time).
 */
function isDev(): boolean {
    return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
}

/**
 * Get log level from environment, defaulting to 'info'.
 */
function logLevel(): pino.LevelWithSilent {
    const level = process.env.LOG_LEVEL;
    if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
        return level;
    }
    return 'info';
}

const loggerOptions: pino.LoggerOptions = {
    level: logLevel(),
    redact: {
        paths: [
            'req.body',
            'res.body',
        ],
        censor: '[REDACTED]',
    },
};

if (isDev()) {
    loggerOptions.transport = {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
        },
    };
}

/**
 * Root pino logger for the application.
 * JSON in production, pretty-printed in dev.
 */
export const rootLogger = pino(loggerOptions);

/**
 * Create a child logger for a specific tool call with request context.
 * Every log line from this child will include:
 *   request_id, tool_name, user_id, elapsed_ms (if available)
 */
export function createToolLogger(
    requestId: string,
    toolName: string,
    userId: string,
): pino.Logger {
    return rootLogger.child({ request_id: requestId, tool_name: toolName, user_id: userId });
}

/**
 * Redact sensitive fields from log-safe objects.
 * Sensitive = memory content, query text, embeddings.
 * Replaces with a SHA-256 hash truncated to 8 hex chars for traceability.
 */
export function redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
    const SENSITIVE_KEYS = new Set(['content', 'query', 'query_text', 'memory_content']);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (SENSITIVE_KEYS.has(key) && typeof value === 'string') {
            const hash = crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
            result[key] = `[redacted:${hash}]`;
        } else if (key === 'embedding' || key === 'embeddings') {
            result[key] = '[redacted]';
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            result[key] = redactSensitive(value as Record<string, unknown>);
        } else {
            result[key] = value;
        }
    }
    return result;
}
