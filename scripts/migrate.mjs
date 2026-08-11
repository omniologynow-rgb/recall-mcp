#!/usr/bin/env node
/**
 * migrate.mjs — apply supabase/migrations/*.sql in order against DATABASE_URL.
 *
 * The one-command migrate: `npm run migrate`. Migrations are plain SQL files
 * (there is NO dist/migrate.js — this script is the supported method, matching
 * the psql loop documented in the README).
 *
 * Files are applied in lexicographic order (0001_…, 0002_…). Each file runs in
 * its own transaction; the script stops at the first failure so a partial
 * sequence is never silently skipped. Re-running is safe as long as the SQL is
 * idempotent (the shipped migrations use IF NOT EXISTS where possible) — for
 * anything else, apply only the new files.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — refusing to run migrations.");
  process.exit(1);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
if (files.length === 0) {
  console.error(`No .sql files found in ${dir}`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    process.stdout.write(`applying ${f} … `);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
      console.log("ok");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.log("FAILED");
      console.error(`  ${e.message}`);
      process.exit(1);
    }
  }
  console.log(`done — ${files.length} migration file(s) applied.`);
} finally {
  await client.end();
}
