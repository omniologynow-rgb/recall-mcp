import crypto from 'crypto';

/**
 * Normalize content string for consistent dedup hashing:
 * 1. Trim leading/trailing whitespace
 * 2. Collapse internal whitespace runs (including tabs, newlines) to single space
 * 3. NFC Unicode normalization (composed form)
 *
 * Pure function — no side effects, no storage knowledge.
 */
export function normalizeContent(content: string): string {
    return content
        .trim()
        .replace(/\s+/g, ' ')
        .normalize('NFC');
}

/**
 * Compute a deterministic content hash for dedup detection.
 * Always normalizes content first, so every call site produces
 * the same hash regardless of input formatting differences.
 */
export function computeContentHash(content: string): string {
    const normalized = normalizeContent(content);
    return crypto.createHash('sha256').update(normalized).digest('hex');
}
