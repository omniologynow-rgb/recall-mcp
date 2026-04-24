import { DatabaseClient } from '../db/client.js';
import { ToolError } from '../errors/tool-error.js';

export class ForgetTool {
    constructor(
        private db: DatabaseClient,
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
            // Record usage event
            await client.query(
                `INSERT INTO usage_events (user_id, event_type, metadata) VALUES ($1, 'forget', '{}')`,
                [userId]
            );
            return true;
        });
        return deleted;
    }
}
