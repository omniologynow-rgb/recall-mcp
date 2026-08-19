/**
 * Static product site — landing, signup UI, and connect guides.
 *
 * Deliberately dependency-free: a whitelist map of clean URLs → files under
 * public/, read once and cached in memory. No directory traversal surface
 * (only whitelisted paths resolve), no build step, served by the same Fastify
 * app as /mcp so guides always live at the same origin as the endpoint they
 * describe.
 */

import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// dist/routes/site.js → ../../public ; src/routes/site.ts (tsx dev) → same
const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'public',
);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** Clean URL → file under public/. The whitelist IS the routing table. */
export const SITE_PAGES: Record<string, string> = {
  '/': 'index.html',
  '/signup': 'signup.html',
  '/connect': 'connect/index.html',
  '/connect/claude': 'connect/claude.html',
  '/connect/claude-code': 'connect/claude-code.html',
  '/connect/chatgpt': 'connect/chatgpt.html',
  '/connect/cursor': 'connect/cursor.html',
  '/connect/windsurf': 'connect/windsurf.html',
  '/connect/other-clients': 'connect/other-clients.html',
  '/connect/any': 'connect/any.html',
  '/export': 'export.html',
  '/assets/site.css': 'assets/site.css',
  '/assets/site.js': 'assets/site.js',
};

const cache = new Map<string, Buffer>();

async function loadFile(relPath: string): Promise<Buffer> {
  const cached = cache.get(relPath);
  if (cached) return cached;
  const buf = await readFile(path.join(PUBLIC_DIR, relPath));
  cache.set(relPath, buf);
  return buf;
}

export function registerSiteRoutes(fastify: FastifyInstance): void {
  for (const [route, relPath] of Object.entries(SITE_PAGES)) {
    const ext = path.extname(relPath);
    const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
    fastify.get(route, async (_request, reply) => {
      try {
        const body = await loadFile(relPath);
        reply
          .header('Content-Type', contentType)
          .header('Cache-Control', 'public, max-age=300')
          .code(200)
          .send(body);
      } catch {
        reply.code(404).send({ error: 'Not found' });
      }
    });
  }
}
