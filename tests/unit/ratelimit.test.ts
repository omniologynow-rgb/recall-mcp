import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { InMemoryRateLimiter, getTierBucketConfig } from '../../src/ratelimit/in-memory.js';

describe('getTierBucketConfig', () => {
    it('returns free config for unknown tier', () => {
        const cfg = getTierBucketConfig('unknown');
        expect(cfg.capacity).toBe(10);
        expect(cfg.refillRate).toBe(10 / 60);
    });

    it('returns free config for free tier', () => {
        const cfg = getTierBucketConfig('free');
        expect(cfg.capacity).toBe(10);
        expect(cfg.refillRate).toBe(10 / 60);
    });

    it('returns starter config for starter tier', () => {
        const cfg = getTierBucketConfig('starter');
        expect(cfg.capacity).toBe(60);
        expect(cfg.refillRate).toBe(60 / 60);
    });
});

describe('InMemoryRateLimiter', () => {
    let limiter: InMemoryRateLimiter;

    beforeEach(() => {
        limiter = new InMemoryRateLimiter();
        vi.useFakeTimers();
    });

    afterEach(() => {
        limiter.dispose();
        vi.useRealTimers();
    });

    describe('under-limit (9 calls on free tier)', () => {
        it('all 9 calls pass', async () => {
            const keyId = 'test-key-001';
            for (let i = 0; i < 9; i++) {
                const result = await limiter.check(keyId, 'free');
                expect(result.allowed).toBe(true);
            }
        });
    });

    describe('at-limit (11 calls within same minute on free tier)', () => {
        it('first 10 pass, 11th gets 429 with retryAfter', async () => {
            const keyId = 'test-key-002';

            // First 10: all pass
            for (let i = 0; i < 10; i++) {
                const result = await limiter.check(keyId, 'free');
                expect(result.allowed).toBe(true);
            }

            // 11th: denied
            const result = await limiter.check(keyId, 'free');
            expect(result.allowed).toBe(false);
            // retryAfter should be > 0 and roughly 6 seconds (1 / (10/60) = 6)
            expect(result.retryAfter).toBeGreaterThan(0);
            expect(result.retryAfter).toBe(6);
        });
    });

    describe('refill (wait 6 seconds, 1 token available)', () => {
        it('after 6 seconds a denied key passes', async () => {
            const keyId = 'test-key-003';

            // Exhaust bucket
            for (let i = 0; i < 10; i++) {
                await limiter.check(keyId, 'free');
            }
            // Confirm exhausted
            const denied = await limiter.check(keyId, 'free');
            expect(denied.allowed).toBe(false);

            // Advance fake clock by 6 seconds (1 token refilled)
            vi.advanceTimersByTime(6000);

            // Next call passes
            const allowed = await limiter.check(keyId, 'free');
            expect(allowed.allowed).toBe(true);
        });
    });

    describe('bucket isolation (two keys independent)', () => {
        it('exhausting key A does not affect key B', async () => {
            const keyA = 'key-a';
            const keyB = 'key-b';

            // Exhaust key A
            for (let i = 0; i < 10; i++) {
                await limiter.check(keyA, 'free');
            }
            const deniedA = await limiter.check(keyA, 'free');
            expect(deniedA.allowed).toBe(false);

            // Key B still has full capacity
            for (let i = 0; i < 10; i++) {
                const result = await limiter.check(keyB, 'free');
                expect(result.allowed).toBe(true);
            }
        });
    });

    describe('tier difference', () => {
        it('free tier blocks at 10, paid tier allows 60', async () => {
            const freeKey = 'free-key';
            const paidKey = 'paid-key';

            // Free: 10 pass, 11th denied
            for (let i = 0; i < 10; i++) {
                await limiter.check(freeKey, 'free');
            }
            const freeDenied = await limiter.check(freeKey, 'free');
            expect(freeDenied.allowed).toBe(false);

            // Paid: 60 pass, 61st denied
            for (let i = 0; i < 60; i++) {
                const result = await limiter.check(paidKey, 'starter');
                expect(result.allowed).toBe(true);
            }
            const paidDenied = await limiter.check(paidKey, 'starter');
            expect(paidDenied.allowed).toBe(false);
        });
    });

    describe('refill cap', () => {
        it('idle for an hour does not accumulate beyond capacity', async () => {
            const keyId = 'key-cap';

            // Make initial request to create bucket
            let result = await limiter.check(keyId, 'free');
            expect(result.allowed).toBe(true);

            // Leave idle for 1 hour
            vi.advanceTimersByTime(3_600_000);

            // Bucket should be full (capacity = 10), not accumulated beyond
            for (let i = 0; i < 10; i++) {
                result = await limiter.check(keyId, 'free');
                expect(result.allowed).toBe(true);
            }
            // 11th call should be denied — confirms cap enforcement
            result = await limiter.check(keyId, 'free');
            expect(result.allowed).toBe(false);
        });
    });

    describe('lastDecisionMeta', () => {
        it('denied request includes retry_after', async () => {
            const keyId = 'key-meta';

            // Exhaust
            for (let i = 0; i < 10; i++) {
                await limiter.check(keyId, 'free');
            }
            await limiter.check(keyId, 'free');

            const meta = limiter.lastDecisionMeta();
            expect(meta.allowed).toBe(false);
            expect(meta.remaining_tokens).toBe(0);
            expect(meta.retry_after).toBe(6);
        });

        it('allowed request includes remaining tokens', async () => {
            const keyId = 'key-meta-2';
            await limiter.check(keyId, 'free');
            const meta = limiter.lastDecisionMeta();
            expect(meta.allowed).toBe(true);
            expect(meta.remaining_tokens).toBe(9);
        });
    });
});
