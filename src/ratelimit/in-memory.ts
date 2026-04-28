import { type RateLimiter, type RateLimiterResult } from './index.js';

/**
 * Per-tier token-bucket configuration.
 */
export interface TierBucketConfig {
    capacity: number;
    refillRate: number; // tokens per second
}

const TIER_CONFIGS: Record<string, TierBucketConfig> = {
    free:    { capacity: 10,  refillRate: 10 / 60 }, // 10 tokens / min
    starter: { capacity: 60,  refillRate: 60 / 60 }, // 60 tokens / min
    pro:     { capacity: 60,  refillRate: 60 / 60 },
    team:    { capacity: 60,  refillRate: 60 / 60 },
};

export function getTierBucketConfig(tier: string): TierBucketConfig {
    const cfg = TIER_CONFIGS[tier];
    if (!cfg) {
        // Unknown tier defaults to free
        return TIER_CONFIGS.free;
    }
    return cfg;
}

interface BucketState {
    tokens: number;
    lastRefillAt: number; // epoch ms
}

/**
 * In-memory token-bucket rate limiter keyed by API key UUID.
 *
 * Thread-safe within a single process. State is lost on process restart,
 * which is acceptable for rate limiting (a restart resets all buckets).
 *
 * Lazy refill: tokens are computed on each check() call rather than
 * running a background timer. This avoids unnecessary work for idle keys.
 */
export class InMemoryRateLimiter implements RateLimiter {
    private buckets: Map<string, BucketState> = new Map();
    private intervalCleanup: ReturnType<typeof setInterval> | null = null;

    // Per-check metadata for logging
    private lastMeta: Record<string, unknown> = {};

    constructor() {
        // Periodic cleanup: evict idle buckets every 60 seconds
        // using unref'd timer so it doesn't keep the process alive
        this.intervalCleanup = setInterval(() => this.evictIdle(), 60_000);
        if (this.intervalCleanup && typeof this.intervalCleanup === 'object') {
            this.intervalCleanup.unref();
        }
    }

    /** Evict buckets that haven't been touched in 10 minutes. */
    private evictIdle(): void {
        const cutoff = Date.now() - 600_000;
        for (const [key, state] of this.buckets.entries()) {
            if (state.lastRefillAt < cutoff) {
                this.buckets.delete(key);
            }
        }
    }

    /** Dispose the cleanup interval (for testing). */
    dispose(): void {
        if (this.intervalCleanup) {
            clearInterval(this.intervalCleanup);
            this.intervalCleanup = null;
        }
    }

    /** Reset all buckets (for testing). */
    reset(): void {
        this.buckets.clear();
    }

    lastDecisionMeta(): Record<string, unknown> {
        return this.lastMeta;
    }

    async check(key: string, tier: string): Promise<RateLimiterResult> {
        const cfg = getTierBucketConfig(tier);
        const now = Date.now();

        let state = this.buckets.get(key);
        if (!state) {
            // First request: start with a full bucket
            state = { tokens: cfg.capacity, lastRefillAt: now };
            this.buckets.set(key, state);
        } else {
            // Lazy refill: add tokens earned since last check
            const elapsedSec = (now - state.lastRefillAt) / 1000;
            const earned = elapsedSec * cfg.refillRate;
            state.tokens = Math.min(cfg.capacity, state.tokens + earned);
            state.lastRefillAt = now;
        }

        if (state.tokens >= 1) {
            state.tokens -= 1;
            this.lastMeta = {
                allowed: true,
                bucket_key: key,
                tier,
                remaining_tokens: Math.floor(state.tokens),
                refill_per_sec: cfg.refillRate,
            };
            return { allowed: true };
        }

        // Denied: calculate retry-after (seconds until 1 token refills)
        const retryAfter = Math.ceil(1 / cfg.refillRate);
        this.lastMeta = {
            allowed: false,
            bucket_key: key,
            tier,
            remaining_tokens: 0,
            retry_after: retryAfter,
            refill_per_sec: cfg.refillRate,
        };
        return { allowed: false, retryAfter };
    }
}
