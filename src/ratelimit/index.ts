/**
 * Rate limiter interface with token-bucket semantics.
 *
 * Designed for pivot resistance: the in-memory Map implementation can be
 * transparently replaced with a Redis-backed DistributedRateLimiter by
 * implementing the same interface.
 */
export interface RateLimiterResult {
    allowed: boolean;
    retryAfter?: number;
}

export interface RateLimiter {
    /**
     * Check if a request from the given key is allowed.
     * @param key - Unique identifier (e.g. apiKey UUID)
     * @param tier - Tier name (e.g. 'free', 'paid')
     * @returns Object indicating whether the request is allowed and, if denied,
     *          the number of seconds the caller should wait before retrying.
     */
    check(key: string, tier: string): Promise<RateLimiterResult>;

    /**
     * Optional hook for logging. If the implementation collects per-decision
     * metadata, it can be returned. Defaults to an empty object.
     */
    lastDecisionMeta(): Record<string, unknown>;
}
