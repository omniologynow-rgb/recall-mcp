import { describe, it, expect } from 'vitest';
import { normalizeContent, computeContentHash } from '../../src/normalize.js';

describe('normalizeContent', () => {
    it('should trim leading and trailing whitespace', () => {
        expect(normalizeContent('  hello world  ')).toBe('hello world');
    });

    it('should collapse internal whitespace runs to single space', () => {
        expect(normalizeContent('hello   world    here')).toBe('hello world here');
    });

    it('should collapse tabs and newlines to single space', () => {
        expect(normalizeContent('hello\t\tworld\n\nhere')).toBe('hello world here');
    });

    it('should apply NFC normalization', () => {
        // U+00E9 (é, precomposed) vs U+0065 + U+0301 (e + combining acute)
        const precomposed = '\u00E9'; // é (NFC)
        const decomposed = '\u0065\u0301'; // é (NFD)
        expect(normalizeContent(decomposed)).toBe(precomposed);
        expect(normalizeContent(decomposed).length).toBe(1);
    });

    it('should handle empty string', () => {
        expect(normalizeContent('')).toBe('');
        expect(normalizeContent('   ')).toBe('');
    });
});

describe('computeContentHash', () => {
    it('should produce same hash for semantically identical content', () => {
        const a = '  Hello   World  ';
        const b = 'Hello World';
        const c = 'Hello\tWorld';
        expect(computeContentHash(a)).toBe(computeContentHash(b));
        expect(computeContentHash(b)).toBe(computeContentHash(c));
    });

    it('should produce different hashes for different content', () => {
        expect(computeContentHash('hello')).not.toBe(computeContentHash('world'));
    });

    it('should handle NFC-equivalent strings identically', () => {
        const precomposed = '\u00E9'; // é (NFC)
        const decomposed = '\u0065\u0301'; // é (NFD)
        expect(computeContentHash(precomposed)).toBe(computeContentHash(decomposed));
    });

    it('should be deterministic for the same input', () => {
        const hash1 = computeContentHash('  The quick brown fox  ');
        const hash2 = computeContentHash('  The quick brown fox  ');
        expect(hash1).toBe(hash2);
    });
});
