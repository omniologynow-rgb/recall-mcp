/**
 * API key generation — single source of truth for key format + CSPRNG generation.
 *
 * Keys look like: recall_live_<32 URL-safe chars>. The first 16 characters
 * (prefix) are stored in plaintext for lookup; the full key is bcrypt-hashed.
 * Generation uses crypto randomness (never Math.random — keys are credentials).
 */

import { randomFillSync } from 'node:crypto';

export const KEY_PREFIX = 'recall_live_';
export const KEY_SUFFIX_LENGTH = 32;
export const KEY_PREFIX_LENGTH = 16;
export const KEY_TOTAL_LENGTH = KEY_PREFIX.length + KEY_SUFFIX_LENGTH;

const SUFFIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export function generateKeyString(): { key: string; prefix: string } {
  const bytes = new Uint8Array(KEY_SUFFIX_LENGTH);
  randomFillSync(bytes);
  let suffix = '';
  for (let i = 0; i < KEY_SUFFIX_LENGTH; i++) {
    suffix += SUFFIX_CHARS[bytes[i] % SUFFIX_CHARS.length];
  }
  const key = KEY_PREFIX + suffix;
  return { key, prefix: key.slice(0, KEY_PREFIX_LENGTH) };
}
