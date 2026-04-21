export interface Embedding {
    vector: number[];
    dimensions: number;
}

export interface Embedder {
    embed(text: string): Promise<Embedding>;
    embedBatch(texts: string[]): Promise<Embedding[]>;
}

export class EmbeddingError extends Error {
    constructor(message: string, public override readonly cause?: unknown) {
        super(message);
        this.name = 'EmbeddingError';
    }
}