/**
 * Extract an API key from an incoming HTTP request.
 *
 * Two accepted forms, checked in order:
 *   1. `Authorization: Bearer recall_live_…` — the preferred form; every
 *      client that can send headers should use it.
 *   2. `?key=recall_live_…` query parameter — the connector-UI escape hatch.
 *      Several hosted MCP clients (claude.ai custom connectors, ChatGPT
 *      developer-mode connectors, Le Chat) only accept a server URL with no
 *      header fields, so the key must ride in the URL. Docs steer those users
 *      toward a dedicated, individually-revocable key.
 *
 * Never log the returned value.
 */

export function extractApiKey(request: {
  headers: Record<string, unknown>;
  query?: unknown;
}): string | null {
  const authHeader = request.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length);
  }
  const q = request.query as Record<string, unknown> | undefined;
  const key = q?.['key'];
  if (typeof key === 'string' && key.length > 0) {
    return key;
  }
  return null;
}
