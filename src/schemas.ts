import { z } from 'zod';
import { ToolError } from './errors/tool-error.js';

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const RememberInputSchema = z.object({
    content: z
        .string()
        .min(1, 'Content must not be empty')
        .max(50000, 'Content must not exceed 50000 characters'),
    namespace: z
        .string()
        .default('default')
        .describe('Namespace (default: "default")'),
    metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Optional metadata'),
});

export const RecallInputSchema = z.object({
    query: z
        .string()
        .min(1, 'Query must not be empty')
        .max(10000, 'Query must not exceed 10000 characters'),
    namespace: z
        .string()
        .optional()
        .describe('Filter by namespace (default: "default")'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Maximum number of results (default: 10)'),
    threshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.7)
        .describe('Minimum similarity threshold 0.0-1.0 (default: 0.7)'),
});

export const ListMemoriesInputSchema = z.object({
    namespace: z
        .string()
        .optional()
        .describe('Filter by namespace (default: "default")'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe('Maximum number of results (default: 20)'),
    offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Pagination offset (default: 0)'),
    order: z
        .enum(['created_at', 'updated_at'])
        .default('created_at')
        .describe('Sort order (default: created_at)'),
});

export const UpdateMemoryInputSchema = z
    .object({
        id: z.string().uuid('Memory ID must be a valid UUID'),
        content: z.string().optional().describe('New content'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('New metadata'),
    })
    .refine(
        (data) => data.content !== undefined || data.metadata !== undefined,
        { message: 'At least one of content or metadata must be provided' }
    );

export const ForgetInputSchema = z.discriminatedUnion('mode', [
    z.object({
        mode: z.literal('by_id'),
        id: z.string().uuid('Memory ID must be a valid UUID'),
    }),
    z.object({
        mode: z.literal('by_query'),
        namespace: z.string().optional().describe('Namespace to search'),
        query: z.string().optional().describe('Search query'),
        confirm: z.literal(true).describe('Must be true'),
        max_delete: z
            .number()
            .int()
            .min(1)
            .max(100)
            .describe('Maximum memories to delete (1-100)'),
    }),
]).refine(
    (data) => {
        if (data.mode === 'by_id') return true;
        // by_query: require at least one of namespace or query
        return data.namespace !== undefined || data.query !== undefined;
    },
    { message: 'by_query mode requires at least one of namespace or query' }
);

// ─── Output Schemas ──────────────────────────────────────────────────────────

export const RememberOutputSchema = z.object({
    id: z.string().uuid(),
});

export interface RecallMemory {
    id: string;
    content: string;
    similarity: number;
    metadata: Record<string, unknown>;
    namespace: string;
    created_at: string;
}

export const RecallOutputSchema = z.array(
    z.object({
        id: z.string(),
        content: z.string(),
        similarity: z.number().min(0).max(1),
        metadata: z.record(z.string(), z.unknown()),
        namespace: z.string(),
        created_at: z.string(),
    })
);

export interface MemoryListItem {
    id: string;
    content: string;
    namespace: string;
    created_at: string;
    updated_at: string;
}

export const ListMemoriesOutputSchema = z.array(
    z.object({
        id: z.string(),
        content: z.string(),
        namespace: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
    })
);

export const UpdateMemoryOutputSchema = z.object({
    success: z.boolean(),
});

export const ForgetOutputSchema = z.object({
    success: z.boolean(),
});

// ─── Validation helpers ──────────────────────────────────────────────────────

/**
 * Validates function arguments against a Zod schema and throws ToolError on failure.
 */
export function validateArgs<T>(schema: z.ZodType<T>, args: unknown): T {
    const result = schema.safeParse(args);
    if (!result.success) {
        const firstIssue = result.error.issues[0];
        const message = firstIssue?.message ?? 'Invalid arguments';
        throw ToolError.validationError(message, {
            issues: result.error.issues.map((i: any) => ({
                path: i.path.join('.'),
                message: i.message,
            })),
        });
    }
    return result.data;
}

/**
 * Validates a return value against a Zod schema and throws ToolError if it
 * doesn't match (catches unexpected DB/embdedder output).
 */
export function validateOutput<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) {
        const firstIssue = result.error.issues[0];
        const message = firstIssue?.message ?? 'Unexpected internal result shape';
        throw ToolError.internalError(`Output shape validation failed: ${message}`);
    }
    return result.data;
}
