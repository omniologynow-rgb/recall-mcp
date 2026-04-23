import { DatabaseClient } from './db/client.js';
import type { Embedder } from './embedder/index.js';

export interface HealthStatus {
  ok: boolean;
  version: string;
  db: 'up' | 'down';
  embedder: 'up' | 'down';
  timestamp: string;
}

export interface ReadyStatus {
  ok: boolean;
  db: 'up' | 'down';
  embedder: 'up' | 'down';
  migrations: 'current' | 'outdated' | 'unknown';
}

export class HealthService {
  private lastDbCheck: { timestamp: number; result: 'up' | 'down' } | null = null;
  private lastEmbedderCheck: { timestamp: number; result: 'up' | 'down' } | null = null;
  private readonly cacheMs = 30_000; // 30 seconds

  constructor(
    private db: DatabaseClient,
    private embedder: Embedder,
    private version: string
  ) {}

  async getHealth(): Promise<HealthStatus> {
    const [db, embedder] = await Promise.all([
      this.checkDb(),
      this.checkEmbedder(),
    ]);
    return {
      ok: db === 'up' && embedder === 'up',
      version: this.version,
      db,
      embedder,
      timestamp: new Date().toISOString(),
    };
  }

  async getReady(): Promise<ReadyStatus> {
    const [db, embedder, migrations] = await Promise.all([
      this.checkDb(),
      this.checkEmbedder(),
      this.checkMigrations(),
    ]);
    return {
      ok: db === 'up' && embedder === 'up' && migrations === 'current',
      db,
      embedder,
      migrations,
    };
  }

  private async checkDb(): Promise<'up' | 'down'> {
    const now = Date.now();
    if (this.lastDbCheck && now - this.lastDbCheck.timestamp < this.cacheMs) {
      return this.lastDbCheck.result;
    }
    try {
      await this.db.query('SELECT 1');
      this.lastDbCheck = { timestamp: now, result: 'up' };
      return 'up';
    } catch {
      this.lastDbCheck = { timestamp: now, result: 'down' };
      return 'down';
    }
  }

  private async checkEmbedder(): Promise<'up' | 'down'> {
    const now = Date.now();
    if (this.lastEmbedderCheck && now - this.lastEmbedderCheck.timestamp < this.cacheMs) {
      return this.lastEmbedderCheck.result;
    }
    try {
      // Minimal embedding call to verify credentials
      await this.embedder.embed('test');
      this.lastEmbedderCheck = { timestamp: now, result: 'up' };
      return 'up';
    } catch {
      this.lastEmbedderCheck = { timestamp: now, result: 'down' };
      return 'down';
    }
  }

  private async checkMigrations(): Promise<'current' | 'outdated' | 'unknown'> {
    // For now, we assume if the database is up and tables exist, migrations are current.
    // In a real implementation, we'd compare a stored migration version against expected.
    // We'll implement a simple check: see if the 'memories' table exists.
    try {
      const res = await this.db.query(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'memories')`
      );
      const exists = res.rows[0]?.exists ?? false;
      return exists ? 'current' : 'unknown';
    } catch {
      return 'unknown';
    }
  }
}