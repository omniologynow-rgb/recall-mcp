import { describe, it, expect } from 'vitest';
import { MockEmbedder } from '../../src/embedder/mock.js';

describe('MockEmbedder', () => {
    it('should create embeddings with correct dimensions', async () => {
        const embedder = new MockEmbedder(1536);
        const embedding = await embedder.embed('hello world');
        expect(embedding.dimensions).toBe(1536);
        expect(embedding.vector).toHaveLength(1536);
        expect(embedding.vector.every(v => v >= 0 && v <= 1)).toBe(true);
    });

    it('should produce deterministic embeddings', async () => {
        const embedder = new MockEmbedder(10);
        const emb1 = await embedder.embed('same text');
        const emb2 = await embedder.embed('same text');
        expect(emb1.vector).toEqual(emb2.vector);
    });

    it('should batch embed', async () => {
        const embedder = new MockEmbedder(5);
        const embeddings = await embedder.embedBatch(['a', 'b', 'c']);
        expect(embeddings).toHaveLength(3);
        embeddings.forEach(emb => {
            expect(emb.dimensions).toBe(5);
            expect(emb.vector).toHaveLength(5);
        });
    });
});

// OpenAIEmbedder unit tests skipped; integration tests will verify with mocks