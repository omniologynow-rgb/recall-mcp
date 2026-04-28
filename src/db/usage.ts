import { DatabaseClient } from './client.js';

export interface UsageEvent {
    userId: string;
    apiKeyId: string;
    requestId: string;
    toolName: string;
    tokensConsumed: number;
    latencyMs: number;
    success: boolean;
    errorCode?: string | null;
}

/**
 * Record a usage event asynchronously.
 * Fire-and-forget: does NOT block the caller. Failures are logged but
 * never surfaced to the client.
 *
 * @param db - Database client (pool) for insert
 * @param event - Usage event data
 * @param onError - Optional error handler (for logging); defaults to silent
 */
export async function recordUsageEvent(
    db: DatabaseClient,
    event: UsageEvent,
    onError?: (err: Error) => void,
): Promise<void> {
    try {
        await db.query(
            `INSERT INTO usage_events (user_id, api_key_id, request_id, tool_name, tokens_consumed, latency_ms, success, error_code)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                event.userId,
                event.apiKeyId,
                event.requestId,
                event.toolName,
                event.tokensConsumed,
                event.latencyMs,
                event.success,
                event.errorCode ?? null,
            ],
        );
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (onError) {
            onError(error);
        }
    }
}
