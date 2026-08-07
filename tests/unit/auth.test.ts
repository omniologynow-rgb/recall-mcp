import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from '../../src/auth/index.js';
import { DatabaseClient } from '../../src/db/client.js';
import bcrypt from 'bcrypt';

// Mock bcrypt
vi.mock('bcrypt', () => ({
  default: {
    compare: vi.fn(),
    hash: vi.fn(),
    genSalt: vi.fn(),
  },
}));

// Mock DatabaseClient
const mockDbClient = {
  query: vi.fn(),
} as unknown as DatabaseClient;

describe('AuthService', () => {
  let authService: AuthService;
  const validKey = 'recall_live_abcdefghijklmnopqrstuvwxyz012345';
  const keyPrefix = 'recall_live_abcd';
  const userId = '123e4567-e89b-12d3-a456-426614174000';
  const tier = 'free';
  const keyHash = '$2b$12$hashedvalue';
  const now = new Date();

  beforeEach(() => {
    vi.clearAllMocks();
    authService = new AuthService(mockDbClient);
  });

  describe('validateApiKeyFormat', () => {
    it('accepts valid API key format', () => {
      const key = 'recall_live_abcdefghijklmnopqrstuvwxyz012345';
      expect(() => authService.validateApiKeyFormat(key)).not.toThrow();
    });

    it('rejects key missing prefix', () => {
      const key = 'invalid_abcdefghijklmnopqrstuvwxyz012345';
      expect(() => authService.validateApiKeyFormat(key)).toThrow(/invalid format/);
    });

    it('rejects key with wrong prefix', () => {
      const key = 'recall_test_abcdefghijklmnopqrstuvwxyz012345';
      expect(() => authService.validateApiKeyFormat(key)).toThrow(/invalid format/);
    });

    it('rejects key with incorrect length', () => {
      const key = 'recall_live_short';
      expect(() => authService.validateApiKeyFormat(key)).toThrow(/invalid format/);
    });

    it('rejects key with non-url-safe characters', () => {
      const key = 'recall_live_abc+defghijklmnopqrstuvwxyz012345';
      expect(() => authService.validateApiKeyFormat(key)).toThrow(/invalid format/);
    });
  });

  describe('authenticate', () => {

    beforeEach(() => {
      // Default mock for key lookup
      (mockDbClient.query as any).mockResolvedValue({
        rows: [{
          id: 'key-id',
          user_id: userId,
          key_hash: keyHash,
          key_prefix: keyPrefix,
          label: null,
          last_used_at: now,
          revoked_at: null,
        }],
      });
      (bcrypt.compare as any).mockResolvedValue(true);
    });

    it('returns user id and tier for valid key', async () => {
      // Mock sequence: first call (key lookup) returns key row, second call (user lookup) returns user row
      (mockDbClient.query as any)
        .mockResolvedValueOnce({ rows: [{ id: 'key-id', user_id: userId, key_hash: keyHash, key_prefix: keyPrefix, revoked_at: null }] }) // key lookup
        .mockResolvedValueOnce({ rows: [{ id: userId, tier }] }); // user lookup
      const result = await authService.authenticate(validKey);
      expect(result).toMatchObject({ userId, tier });
      expect(result.keyId).toBe('key-id');
      // Should call bcrypt.compare with correct arguments
      expect(bcrypt.compare).toHaveBeenCalledWith(validKey, keyHash);
      // Should have called: 1) key lookup, 2) user lookup, 3) update last_used_at
      expect(mockDbClient.query).toHaveBeenCalledTimes(3);
      // Verify update query was called
      expect(mockDbClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE api_keys'),
        expect.any(Array)
      );
    });

    it('caches successful authentication', async () => {
      // Mock sequence for first call
      (mockDbClient.query as any)
        .mockResolvedValueOnce({ rows: [{ id: 'key-id', user_id: userId, key_hash: keyHash, key_prefix: keyPrefix, revoked_at: null }] }) // key lookup
        .mockResolvedValueOnce({ rows: [{ id: userId, tier }] }); // user lookup
      // First call
      await authService.authenticate(validKey);
      expect(mockDbClient.query).toHaveBeenCalledTimes(3); // key lookup + user lookup + key update
      (mockDbClient.query as any).mockClear();
      // Second call within cache window: only revocation check query
      (mockDbClient.query as any).mockResolvedValue({ rows: [{ revoked_at: null }] });
      (bcrypt.compare as any).mockClear();
      await authService.authenticate(validKey);
      expect(bcrypt.compare).not.toHaveBeenCalled();
      expect(mockDbClient.query).toHaveBeenCalledTimes(1); // revocation check
      expect(mockDbClient.query).toHaveBeenCalledWith(
        `SELECT revoked_at FROM api_keys WHERE id = $1`,
        ['key-id']
      );
    });

    it('throws generic error for invalid key format', async () => {
      await expect(authService.authenticate('invalid')).rejects.toThrow(/unauthorized/);
    });

    it('throws generic error when key not found', async () => {
      (mockDbClient.query as any).mockResolvedValue({ rows: [] });
      await expect(authService.authenticate(validKey)).rejects.toThrow(/unauthorized/);
      // Should not call bcrypt.compare
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('throws generic error when key is revoked', async () => {
      (mockDbClient.query as any).mockResolvedValue({
        rows: [{
          id: 'key-id',
          user_id: userId,
          key_hash: keyHash,
          key_prefix: keyPrefix,
          revoked_at: new Date(),
        }],
      });
      await expect(authService.authenticate(validKey)).rejects.toThrow(/unauthorized/);
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('throws generic error when bcrypt.compare returns false', async () => {
      (mockDbClient.query as any)
        .mockResolvedValueOnce({ rows: [{ id: userId, tier }] });
      (bcrypt.compare as any).mockResolvedValue(false);
      await expect(authService.authenticate(validKey)).rejects.toThrow(/unauthorized/);
    });

    it('invalidates cache entry on authentication failure', async () => {
      // First, cache a successful authentication
      (mockDbClient.query as any)
        .mockResolvedValueOnce({ rows: [{ id: 'key-id', user_id: userId, key_hash: keyHash, key_prefix: keyPrefix, revoked_at: null }] }) // key lookup
        .mockResolvedValueOnce({ rows: [{ id: userId, tier }] }); // user lookup
      await authService.authenticate(validKey);
      // Clear bcrypt mock to isolate second call
      (bcrypt.compare as any).mockClear();
      // Now simulate a revoked key on next call: revocation check returns revoked
      (mockDbClient.query as any).mockReset();
      // Revocation check query
      (mockDbClient.query as any)
        .mockResolvedValueOnce({ rows: [{ revoked_at: new Date() }] }) // revoked
        .mockResolvedValueOnce({ rows: [{
          id: 'key-id',
          user_id: userId,
          key_hash: keyHash,
          key_prefix: keyPrefix,
          revoked_at: new Date(),
        }] }); // key lookup after cache deletion
      await expect(authService.authenticate(validKey)).rejects.toThrow(/unauthorized/);
      // Ensure the cache entry was removed
      // (We'll need to expose cache for testing, but we can infer via bcrypt calls)
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });
  });

  describe('generateApiKey', () => {
    it('generates a key with correct format', async () => {
      (mockDbClient.query as any).mockResolvedValue({ rows: [{ id: 'test-key-id' }] }); // no duplicate
      const result = await authService.generateApiKey(userId, 'test label');
      expect(result.key).toMatch(/^recall_live_[a-zA-Z0-9_-]{32}$/);
      expect(result.keyPrefix).toBe(result.key.slice(0, 16));
      // Should store hash and prefix in database
      expect(mockDbClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO api_keys'),
        expect.any(Array)
      );
    });

    it('retries on duplicate key prefix', async () => {
      // Simulate a collision: first insert fails with unique violation, second succeeds
      let callCount = 0;
      (mockDbClient.query as any).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw { code: '23505' }; // unique_violation
        }
        return { rows: [{ id: "test-key-id" }] };
      });
      const result = await authService.generateApiKey(userId);
      expect(result.key).toMatch(/^recall_live_[a-zA-Z0-9_-]{32}$/);
      // Should have attempted twice
      expect(callCount).toBe(2);
    });
  });
});