import { DatabaseClient } from '../db/client.js';
import bcrypt from 'bcrypt';
import { LRUCache } from 'lru-cache';

export interface AuthResult {
  userId: string;
  tier: string;
  keyId: string;
}

export class AuthService {
  private cache: LRUCache<string, AuthResult>;
  private readonly KEY_PREFIX = 'recall_live_';
  private readonly KEY_SUFFIX_LENGTH = 32;
  private readonly KEY_TOTAL_LENGTH = this.KEY_PREFIX.length + this.KEY_SUFFIX_LENGTH;
  private readonly KEY_PREFIX_LENGTH = 16;

  constructor(private db: DatabaseClient) {
    this.cache = new LRUCache<string, AuthResult>({
      max: 1000,
      ttl: 60_000, // 60 seconds
    });
  }

  validateApiKeyFormat(apiKey: string): void {
    if (typeof apiKey !== 'string') {
      throw new Error('invalid format');
    }
    // Exact length
    if (apiKey.length !== this.KEY_TOTAL_LENGTH) {
      throw new Error('invalid format');
    }
    // Prefix
    if (!apiKey.startsWith(this.KEY_PREFIX)) {
      throw new Error('invalid format');
    }
    // Suffix must be URL‑safe characters: A‑Z a‑z 0‑9 _ -
    const suffix = apiKey.slice(this.KEY_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(suffix)) {
      throw new Error('invalid format');
    }
  }

  async authenticate(apiKey: string): Promise<AuthResult> {
    try {
      this.validateApiKeyFormat(apiKey);
    } catch {
      throw new Error('unauthorized');
    }
    const keyPrefix = this.extractKeyPrefix(apiKey);
    // Cache lookup
    const cached = this.cache.get(keyPrefix);
    if (cached) {
      // Verify key not revoked
      const revokedRes = await this.db.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM api_keys WHERE id = $1`,
        [cached.keyId]
      );
      if (revokedRes.rows.length === 0 || revokedRes.rows[0].revoked_at) {
        // Key missing or revoked, delete cache and proceed to full authentication
        this.cache.delete(keyPrefix);
      } else {
        return cached;
      }
    }
    // Database lookup
    const keyRes = await this.db.query<{
      id: string;
      user_id: string;
      key_hash: string;
      key_prefix: string;
      tier: string;
      revoked_at: Date | null;
    }>(
      `SELECT id, user_id, key_hash, key_prefix, tier, revoked_at
       FROM api_keys
       WHERE key_prefix = $1`,
      [keyPrefix]
    );
    if (keyRes.rows.length === 0) {
      this.cache.delete(keyPrefix);
      throw new Error('unauthorized');
    }
    const keyRow = keyRes.rows[0];
    if (keyRow.revoked_at) {
      this.cache.delete(keyPrefix);
      throw new Error('unauthorized');
    }
    // Verify hash
    const match = await bcrypt.compare(apiKey, keyRow.key_hash);
    if (!match) {
      this.cache.delete(keyPrefix);
      throw new Error('unauthorized');
    }
    // Get user tier
    const userRes = await this.db.query<{ id: string; tier: string }>(
      `SELECT id, tier FROM users WHERE id = $1`,
      [keyRow.user_id]
    );
    if (userRes.rows.length === 0) {
      // Should not happen (foreign key constraint), but handle
      this.cache.delete(keyPrefix);
      throw new Error('unauthorized');
    }
    const user = userRes.rows[0];
    // Tier comes from the API key's tier column (migration 0004),
    // falling back to the user's tier if not set (legacy keys)
    const effectiveTier = keyRow.tier || user.tier || 'free';
    const result: AuthResult = { userId: user.id, tier: effectiveTier, keyId: keyRow.id };
    // Cache the result
    this.cache.set(keyPrefix, result);
    // Fire‑and‑forget update of last_used_at
    this.updateLastUsed(keyRow.id).catch(() => {
      // Ignore errors
    });
    return result;
  }

  async generateApiKey(userId: string, fields?: string | { label?: string; tier?: string }): Promise<{ key: string; keyPrefix: string; id: string }> {
    const suffixChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    const maxAttempts = 5;
    // Accept both old-style string label and new-style { label, tier } object
    const label = typeof fields === 'string' ? fields : (fields?.label ?? null);
    const tier = typeof fields === 'string' ? 'free' : (fields?.tier || 'free');
    const validTiers = ['free', 'starter', 'pro', 'team'];
    if (!validTiers.includes(tier)) {
      throw new Error(`invalid tier "${tier}"; must be one of: ${validTiers.join(', ')}`);
    }
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Generate random suffix
      let suffix = '';
      for (let i = 0; i < this.KEY_SUFFIX_LENGTH; i++) {
        suffix += suffixChars[Math.floor(Math.random() * suffixChars.length)];
      }
      const key = this.KEY_PREFIX + suffix;
      const keyPrefix = this.extractKeyPrefix(key);
      const hash = await bcrypt.hash(key, 12);
      try {
        const result = await this.db.query<{ id: string }>(
          `INSERT INTO api_keys (user_id, key_hash, key_prefix, label, tier)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [userId, hash, keyPrefix, label, tier]
        );
        return { key, keyPrefix, id: result.rows[0].id };
      } catch (err: any) {
        if (err.code === '23505') { // unique_violation
          // Duplicate prefix, retry with new suffix
          continue;
        }
        throw err;
      }
    }
    throw new Error('failed to generate unique API key after ' + maxAttempts + ' attempts');
  }

  private extractKeyPrefix(apiKey: string): string {
    return apiKey.slice(0, this.KEY_PREFIX_LENGTH);
  }

  private async updateLastUsed(keyId: string): Promise<void> {
    await this.db.query(
      `UPDATE api_keys SET last_used_at = now() WHERE id = $1`,
      [keyId]
    );
  }
}