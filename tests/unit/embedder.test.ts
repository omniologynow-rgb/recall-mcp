import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockEmbedder } from '../../src/embedder/mock.js';
import { OpenAIEmbedder } from '../../src/embedder/openai.js';
import type { Embedding } from '../../src/embedder/index.js';

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

describe('OpenAIEmbedder', () => {
    let mockOpenAI: any;

    beforeEach(() => {
        mockOpenAI = {
            embeddings: {
                create: vi.fn(),
            },
        };
        vi.doMock('openai', () => ({
            default: vi.fn(() => mockOpenAI),
        }));
    });

    it('should embed text', async () => {
        const mockEmbedding: Embedding = {
            vector: Array.from({ length: 1536 }, (_, i) => i / 1536),
            dimensions: 1536,
        };
        mockOpenAI.embeddings.create.mockResolvedValue({
            data: [{ embedding: mockEmbedding.vector }],
        });

        // Need to import after mock
        const { OpenAIEmbedder } = await import('../../src/embedder/openai.js');
        const embedder = new OpenAIEmbedder({ apiKey: 'test-key' });
        const result = await embedder.embed('test');
        expect(result).toEqual(mockEmbedding);
        expect(mockOpenAI.embeddings.create).toHaveBeenCalledWith({
            model: 'text-embedding-3-small',
            input: 'test',
            dimensions: 1536,
        });
    });

    it('should embed batch', async () => {
        const vectors = [
            Array.from({ length: 1536 }, (_, i) => i / 1536),
            Array.from({ length: 1536 }, (_, i) => (i + 1) / 1537),
        ];
        mockOpenAI.embeddings.create.mockResolvedValue({
            data: vectors.map(vector => ({ embedding: vector })),
        });

        const { OpenAIEmbedder } = await import('../../src/embedder/openai.js');
        const embedder = new OpenAIEmbedder({ apiKey: 'test-key' });
        const results = await embedder.embedBatch(['a', 'b']);
        expect(results).toHaveLength(2);
        expect(results[0].vector).toEqual(vectors[0]);
        expect(results[1].vector).toEqual(vectors[1]);
        expect(mockOpenAI.embeddings.create).toHaveBeenCalledWith({
            model: 'text-embedding-3-small',
            input: ['a', 'b'],
            dimensions: 1536,
        });
    });
});