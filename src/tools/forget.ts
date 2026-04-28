import { DatabaseClient } from '../db/client.js';
import type { Embedder } from '../embedder/index.js';
import { ToolError } from '../errors/tool-error.js';
import { toSql } from 'pgvector';
import crypto from 'crypto';

// ─── Confirmation token store ───────────────────────────────────────────────
// In-memory only. Process restart invalidates all pending confirmations (fail-safe).

interface PendingDeletion {
    userId: string;
    memoryIds: string[];
    expiresAt: number; // epoch ms
}

const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pendingDeletions = new Map<string, PendingDeletion>();

// Periodic cleanup of expired tokens (every 60s, unref'd so it doesn't block exit)
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [token, pending] of pendingDeletions.entries()) {
        if (pending.expiresAt <= now) {
            pendingDeletions.delete(token);
        }
    }
}, 60_000);
cleanupInterval.unref();

function generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
}

// ─── ForgetTool ─────────────────────────────────────────────────────────────

export interface ForgetQueryMatch {
    id: string;
    content: string;
    similarity: number;
}

export interface ForgetQueryPreviewResult {
    preview: true;
    matches: ForgetQueryMatch[];
    total_matches: number;
    confirmation_token: string;
    expires_at: string;
}

export interface ForgetQueryConfirmResult {
    success: true;
    deleted_count: number;
}

export class ForgetTool {
    constructor(
        private db: DatabaseClient,
        private embedder: Embedder,
    ) {}

    async forget(userId: string, memoryId: string): Promise<boolean> {
        const deleted = await this.db.withUserContext(userId, async (client) => {
            // Delete memory, ensuring ownership
            const deleteRes = await client.query<{ id: string }>(
                `DELETE FROM memories WHERE id = $1 AND user_id = $2 RETURNING id`,
                [memoryId, userId]
            );
            if (deleteRes.rows.length === 0) {
                throw ToolError.notFound('Memory not found');
            }
            return true;
        });
        return deleted;
    }

    async forgetByQueryPreview(
        userId: string,
        query: string,
        namespace?: string,
        threshold: number = 0.85,
        limit: number = 10,
    ): Promise<ForgetQueryPreviewResult> {
        const embedding = await this.embedder.embed(query);
        const embeddingSql = toSql(embedding.vector);

        const matches = await this.db.withUserContext(userId, async (client) => {
            const nsClause = namespace
                ? `AND namespace = '${namespace.replace(/'/g, "''")}'`
                : '';

            const res = await client.query<{
                id: string;
                content: string;
                similarity: number;
            }>(
                `SELECT id, content, 1 - (embedding <=> $1::vector) AS similarity
                 FROM memories
                 WHERE user_id = $2
                   ${nsClause}
                   AND 1 - (embedding <=> $1::vector) >= $3
                 ORDER BY similarity DESC
                 LIMIT $4`,
                [embeddingSql, userId, threshold, limit]
            );
            return res.rows;
        });

        if (matches.length === 0) {
            // No matches — return empty preview with no token
            return {
                preview: true,
                matches: [],
                total_matches: 0,
                confirmation_token: '',
                expires_at: '',
            };
        }

        // Generate confirmation token
        const token = generateToken();
        const expiresAt = Date.now() + TOKEN_TTL_MS;
        pendingDeletions.set(token, {
            userId,
            memoryIds: matches.map(m => m.id),
            expiresAt,
        });

        return {
            preview: true,
            matches,
            total_matches: matches.length,
            confirmation_token: token,
            expires_at: new Date(expiresAt).toISOString(),
        };
    }

    async forgetByQueryConfirm(
        userId: string,
        token: string,
    ): Promise<ForgetQueryConfirmResult> {
        const pending = pendingDeletions.get(token);
        if (!pending) {
            throw ToolError.validationError('Invalid or expired confirmation token');
        }

        if (pending.userId !== userId) {
            // Token exists but belongs to another user — don't leak that fact
            throw ToolError.validationError('Invalid or expired confirmation token');
        }

        if (pending.expiresAt <= Date.now()) {
            pendingDeletions.delete(token);
            throw ToolError.validationError('Confirmation token has expired');
        }

        // Delete all matched memories
        const deleted = await this.db.withUserContext(userId, async (client) => {
            const res = await client.query<{ id: string }>(
                `DELETE FROM memories WHERE id = ANY($1::uuid[]) AND user_id = $2 RETURNING id`,
                [pending.memoryIds, userId]
            );
            const deletedCount = res.rows.length;

            return deletedCount;
        });

        // Clean up token
        pendingDeletions.delete(token);

        return {
            success: true,
            deleted_count: deleted,
        };
    }
}
