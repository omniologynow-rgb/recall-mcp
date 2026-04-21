import OpenAI from 'openai';
import type { Embedding, Embedder } from './index.js';
import { EmbeddingError } from './index.js';

export interface OpenAIEmbedderOptions {
    apiKey: string;
    model?: string;
    dimensions?: number;
    organization?: string;
    baseURL?: string;
}

export class OpenAIEmbedder implements Embedder {
    private client: OpenAI;
    private model: string;
    private dimensions: number;

    constructor(options: OpenAIEmbedderOptions) {
        if (!options.apiKey) {
            throw new EmbeddingError('OpenAI API key is required');
        }
        this.client = new OpenAI({
            apiKey: options.apiKey,
            organization: options.organization,
            baseURL: options.baseURL,
        });
        this.model = options.model ?? 'text-embedding-3-small';
        this.dimensions = options.dimensions ?? 1536;
    }

    async embed(text: string): Promise<Embedding> {
        try {
            const response = await this.client.embeddings.create({
                model: this.model,
                input: text,
                dimensions: this.dimensions,
            });
            const vector = response.data[0]?.embedding;
            if (!vector) {
                throw new EmbeddingError('No embedding returned from OpenAI');
            }
            return {
                vector,
                dimensions: this.dimensions,
            };
        } catch (error) {
            throw new EmbeddingError('Failed to create embedding', error);
        }
    }

    async embedBatch(texts: string[]): Promise<Embedding[]> {
        try {
            const response = await this.client.embeddings.create({
                model: this.model,
                input: texts,
                dimensions: this.dimensions,
            });
            return response.data.map((item) => ({
                vector: item.embedding,
                dimensions: this.dimensions,
            }));
        } catch (error) {
            throw new EmbeddingError('Failed to create batch embeddings', error);
        }
    }
}