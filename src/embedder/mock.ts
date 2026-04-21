import type { Embedding, Embedder } from './index.js';

export class MockEmbedder implements Embedder {
    private dimension: number;

    constructor(dimension: number = 1536) {
        this.dimension = dimension;
    }

    async embed(text: string): Promise<Embedding> {
        // Deterministic fake embedding based on text hash
        const hash = this.hashString(text);
        const vector = Array.from({ length: this.dimension }, (_, i) => {
            const val = Math.sin(hash + i) * 0.5 + 0.5; // 0-1 range
            return val;
        });
        return { vector, dimensions: this.dimension };
    }

    async embedBatch(texts: string[]): Promise<Embedding[]> {
        return Promise.all(texts.map(text => this.embed(text)));
    }

    private hashString(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash);
    }
}