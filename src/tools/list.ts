import { DatabaseClient } from '../db/client.js';

const ORDER_COLUMNS = ['created_at', 'updated_at'] as const;
export type OrderColumn = (typeof ORDER_COLUMNS)[number];

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
    ) {}

    async list(
        userId: string,
        namespace: string = 'default',
        limit: number = 100,
        offset: number = 0,
        order: OrderColumn = 'created_at'
    ): Promise<MemoryListItem[]> {
        // Safe: only allows known column names
        const orderClause = ORDER_COLUMNS.includes(order) ? order : 'created_at';

        const results = await this.db.withUserContext(userId, async (client) => {
            const res = await client.query<MemoryListItem>(
                `SELECT id, content, namespace, created_at, updated_at
                 FROM memories
                 WHERE user_id = $1
                   AND namespace = $2
                 ORDER BY ${orderClause} ASC
                 LIMIT $3 OFFSET $4`,
                [userId, namespace, limit, offset]
            );
            return res.rows;
        });
        return results;
    }
}
