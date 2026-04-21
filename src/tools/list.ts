import { DatabaseClient } from '../db/client.js';
import { AuthService } from '../auth/index.js';
import { ToolError } from '../errors/tool-error.js';

export interface MemoryListItem {
    id: string;
    content: string;
    namespace: string;
    created_at: string;
    updated_at: string;
}

export class ListMemoriesTool {
    constructor(
        private db: DatabaseClient,
        private auth: AuthService
    ) {}

    async list(
        apiKey: string,
        namespace: string = 'default',
        limit: number = 100,
        offset: number = 0
    ): Promise<MemoryListItem[]> {
        // Authenticate API key
        const { userId } = await this.auth.authenticate(apiKey);

        const results = await this.db.withUserContext(userId, async (client) => {
            const res = await client.query<MemoryListItem>(
                `SELECT id, content, namespace, created_at, updated_at
                 FROM memories
                 WHERE user_id = $1
                   AND ($2 = 'default' OR namespace = $2)
                 ORDER BY created_at ASC
                 LIMIT $3 OFFSET $4`,
                [userId, namespace, limit, offset]
            );
            // Record usage event
            await client.query(
                `INSERT INTO usage_events (user_id, event_type, metadata) VALUES ($1, 'list', '{}')`,
                [userId]
            );
            return res.rows;
        });
        return results;
    }
}