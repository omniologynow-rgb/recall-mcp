import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RememberTool } from '../../src/tools/remember.js';
import { DatabaseClient } from '../../src/db/client.js';
import { Embedder } from '../../src/embedder/index.js';
import { AuthService } from '../../src/auth/index.js';

// Mocks
const mockDbClient = {
    withUserContext: vi.fn(),
} as unknown as DatabaseClient;

const mockEmbedder = {
    embed: vi.fn(),
    embedBatch: vi.fn(),
} as unknown as Embedder;

const mockAuthService = {
    authenticate: vi.fn(),
} as unknown as AuthService;

describe('RememberTool', () => {
    let rememberTool: RememberTool;
    const apiKey = 'recall_live_abcdefghijklmnopqrstuvwxyz012345';
    const userId = '123e4567-e89b-12d3-a456-426614174000';
    const tier = 'free';
    const embedding = { vector: new Array(1536).fill(0.1), dimensions: 1536 };

    beforeEach(() => {
        vi.clearAllMocks();
        rememberTool = new RememberTool(mockDbClient, mockEmbedder, mockAuthService);
        // Default mock for auth
        (mockAuthService.authenticate as any).mockResolvedValue({ userId, tier });
        // Default mock for embedder
        (mockEmbedder.embed as any).mockResolvedValue(embedding);
        // Default mock for withUserContext
        (mockDbClient.withUserContext as any).mockImplementation((_, fn) => {
            const mockClient = {
                query: vi.fn().mockImplementation((query, params) => {
                    // Duplicate check
                    if (query.includes('SELECT id FROM memories')) {
                        return Promise.resolve({ rows: [] }); // no duplicate
                    }
                    // Lock user row
                    if (query.includes('SELECT 1 FROM users')) {
                        return Promise.resolve({ rows: [{ '?column?': 1 }] });
                    }
                    // Count memories
                    if (query.includes('COUNT(*)')) {
                        return Promise.resolve({ rows: [{ count: '0' }] });
                    }
                    // Insert memory
                    if (query.includes('INSERT INTO memories')) {
                        return Promise.resolve({ rows: [{ id: 'memory-id' }] });
                    }
                    // Usage event
                    if (query.includes('INSERT INTO usage_events')) {
                        return Promise.resolve({ rows: [] });
                    }
                    // Fallback
                    return Promise.resolve({ rows: [] });
                }),
            };
            return fn(mockClient);
        });
    });

    describe('remember', () => {
        it('should authenticate API key and store memory', async () => {
            const result = await rememberTool.remember(apiKey, 'test content');
            expect(result).toBe('memory-id');
            expect(mockAuthService.authenticate).toHaveBeenCalledWith(apiKey);
            expect(mockEmbedder.embed).toHaveBeenCalledWith('test content');
            // Should have called withUserContext once (atomic transaction)
            expect(mockDbClient.withUserContext).toHaveBeenCalledTimes(1);
        });

        it('should enforce free tier limit (100 memories)', async () => {
            // Mock count query to return 100
            (mockDbClient.withUserContext as any).mockImplementation((_, fn) => {
                const mockClient = {
                    query: vi.fn().mockImplementation((query) => {
                        if (query.includes('COUNT(*)')) {
                            return Promise.resolve({ rows: [{ count: '100' }] });
                        }
                        // duplicate check returns empty
                        if (query.includes('SELECT id FROM memories')) {
                            return Promise.resolve({ rows: [] });
                        }
                        if (query.includes('SELECT 1 FROM users')) {
                            return Promise.resolve({ rows: [{ '?column?': 1 }] });
                        }
                        // other queries
                        return Promise.resolve({ rows: [] });
                    }),
                };
                return fn(mockClient);
            });
            await expect(rememberTool.remember(apiKey, 'test')).rejects.toMatchObject({
                code: 'limit_exceeded',
                message: expect.stringContaining('Free tier allows 100 memories'),
                retryable: false,
            });
            expect(mockDbClient.withUserContext).toHaveBeenCalledTimes(1);
        });

        it('should allow free tier up to 99 memories', async () => {
            (mockDbClient.withUserContext as any).mockImplementation((_, fn) => {
                const mockClient = {
                    query: vi.fn().mockImplementation((query) => {
                        if (query.includes('COUNT(*)')) {
                            return Promise.resolve({ rows: [{ count: '99' }] });
                        }
                        if (query.includes('SELECT id FROM memories')) {
                            return Promise.resolve({ rows: [] });
                        }
                        if (query.includes('SELECT 1 FROM users')) {
                            return Promise.resolve({ rows: [{ '?column?': 1 }] });
                        }
                        if (query.includes('INSERT INTO memories')) {
                            return Promise.resolve({ rows: [{ id: 'memory-id' }] });
                        }
                        if (query.includes('INSERT INTO usage_events')) {
                            return Promise.resolve({ rows: [] });
                        }
                        return Promise.resolve({ rows: [] });
                    }),
                };
                return fn(mockClient);
            });
            await expect(rememberTool.remember(apiKey, 'test')).resolves.toBe('memory-id');
            expect(mockDbClient.withUserContext).toHaveBeenCalledTimes(1);
        });

        it('should not enforce limit for paid tiers', async () => {
            (mockAuthService.authenticate as any).mockResolvedValue({ userId, tier: 'starter' });
            // Paid tier should skip count check (no SELECT COUNT(*))
            let countQueryCalled = false;
            (mockDbClient.withUserContext as any).mockImplementation((_, fn) => {
                const mockClient = {
                    query: vi.fn().mockImplementation((query) => {
                        if (query.includes('COUNT(*)')) {
                            countQueryCalled = true;
                        }
                        if (query.includes('SELECT id FROM memories')) {
                            return Promise.resolve({ rows: [] });
                        }
                        if (query.includes('SELECT 1 FROM users')) {
                            return Promise.resolve({ rows: [{ '?column?': 1 }] });
                        }
                        if (query.includes('INSERT INTO memories')) {
                            return Promise.resolve({ rows: [{ id: 'memory-id' }] });
                        }
                        if (query.includes('INSERT INTO usage_events')) {
                            return Promise.resolve({ rows: [] });
                        }
                        return Promise.resolve({ rows: [] });
                    }),
                };
                return fn(mockClient);
            });
            await expect(rememberTool.remember(apiKey, 'test')).resolves.toBe('memory-id');
            expect(countQueryCalled).toBe(false);
        });

        it('should deduplicate identical content', async () => {
            // Track queries executed
            const queries: string[] = [];
            (mockDbClient.withUserContext as any).mockImplementation((_, fn) => {
                const mockClient = {
                    query: vi.fn().mockImplementation((query) => {
                        queries.push(query);
                        // Duplicate check returns a row
                        if (query.includes('SELECT id FROM memories') && !query.includes('COUNT')) {
                            return Promise.resolve({ rows: [{ id: 'dedupe-id' }] });
                        }
                        // Usage event for dedupe
                        if (query.includes('INSERT INTO usage_events')) {
                            expect(query).toContain('remember_dedupe');
                            return Promise.resolve({ rows: [] });
                        }
                        // No other queries should be called
                        return Promise.resolve({ rows: [] });
                    }),
                };
                return fn(mockClient);
            });
            const result = await rememberTool.remember(apiKey, 'same content');
            expect(result).toBe('dedupe-id');
            // Verify duplicate check query was called
            expect(queries).toEqual([
                expect.stringContaining('SELECT id FROM memories'),
                expect.stringContaining('INSERT INTO usage_events'),
            ]);
            // Embedder should NOT be called
            expect(mockEmbedder.embed).not.toHaveBeenCalled();
        });
    });
});