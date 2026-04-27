import { z } from 'zod';
import { ToolError } from './errors/tool-error.js';

// ─── Input Schemas ───────────────────────────────────────────────────────────

/**
 * Metadata schema with a ~4KB serialized JSON size cap.
 * Any Record<string, unknown> is accepted as long as its
 * JSON-stringified form fits in 4096 bytes.
 */
export const MetadataSchema = z
    .record(z.string(), z.unknown())
    .superRefine((val, ctx) => {
        const json = JSON.stringify(val);
        const bytes = Buffer.byteLength(json, 'utf8');
        if (bytes > 4096) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Metadata must not exceed 4096 bytes serialized (got ${bytes} bytes)`,
            });
        }
    });

export const RememberInputSchema = z.object({
    content: z
        .string()
        .min(1, 'Content must not be empty')
        .max(50000, 'Content must not exceed 50000 characters'),
    namespace: z
        .string()
        .default('default')
        .describe('Namespace (default: "default")'),
    metadata: MetadataSchema.optional().describe('Optional metadata'),
});

/**
 * Metadata filter for recall: equality match against top-level metadata keys,
 * AND across keys. Values must be primitives (string | number | boolean).
 * Max 8 keys (DoS guard). Empty filter is valid and equivalent to omitting.
 * Applied at the SQL level via metadata @> $filter::jsonb containment.
 */
export const MetadataFilterSchema = z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .superRefine((val, ctx) => {
        const keys = Object.keys(val);
        if (keys.length > 8) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Metadata filter must not exceed 8 keys (got ${keys.length})`,
            });
        }
        // Check for nested objects or arrays (should be caught by z.union type, but
        // z.record with union accepts them at runtime — so we validate explicitly)
        for (const [key, value] of Object.entries(val)) {
            if (value !== null && typeof value === 'object') {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `Metadata filter value for '${key}' must be a primitive (string, number, boolean), got ${typeof value}`,
                    path: [key],
                });
            }
        }
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
    metadata_filter: MetadataFilterSchema
        .optional()
        .describe('Filter by metadata key=value pairs (AND semantics, max 8 keys)'),
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
        metadata: MetadataSchema.optional().describe('New metadata'),
    })
    .refine(
        (data) => data.content !== undefined || data.metadata !== undefined,
        { message: 'At least one of content or metadata must be provided' }
    );

// ─── Forget schema (by_id + two-step by_query) ────────────────────────────────

const ForgetByIdSchema = z.object({
    mode: z.literal('by_id'),
    id: z.string().uuid('Memory ID must be a valid UUID'),
});

const ForgetQueryPreviewSchema = z.object({
    mode: z.literal('by_query'),
    query: z
        .string()
        .min(1, 'Query must not be empty')
        .describe('Semantic search query'),
    namespace: z
        .string()
        .optional()
        .describe('Namespace to search (omit for all namespaces)'),
    threshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.85)
        .describe('Minimum similarity threshold 0.0-1.0 (default: 0.85)'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Maximum matches to preview (1-50, default: 10)'),
});

const ForgetQueryConfirmSchema = z.object({
    mode: z.literal('by_query'),
    confirmation_token: z
        .string()
        .min(1, 'Confirmation token must not be empty')
        .describe('Confirmation token from a previous forget_by_query call'),
});

export const ForgetInputSchema = z
    .union([ForgetByIdSchema, ForgetQueryPreviewSchema, ForgetQueryConfirmSchema])
    .refine(
        (data) => {
            if (data.mode === 'by_id') return true;
            if ('confirmation_token' in data) return true; // confirm step
            // by_query preview: require at least one of query or namespace
            // (query is already required by schema, but namespace is optional)
            return true; // query is already required by ForgetQueryPreviewSchema
        },
        { message: 'by_query mode requires a search query' }
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

export const ForgetOutputSchema = z.union([
    z.object({ success: z.literal(true) }),
    z.object({
        preview: z.literal(true),
        matches: z.array(
            z.object({
                id: z.string(),
                content: z.string(),
                similarity: z.number().min(0).max(1),
            })
        ),
        total_matches: z.number().int().min(0),
        confirmation_token: z.string(),
        expires_at: z.string(),
    }),
    z.object({
        success: z.literal(true),
        deleted_count: z.number().int().min(0),
    }),
]);

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
