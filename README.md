# Recall

**Portable AI memory — your AI's memory, everywhere you go.**

One living memory every MCP client reads and writes: Claude today, ChatGPT tomorrow, whatever comes next — same memories, same personality, same story. Yours: exportable anytime, deletable for real, never trained on.

**Hosted service:** [recall-mcp.fly.dev](https://recall-mcp.fly.dev) — [get a free key](https://recall-mcp.fly.dev/signup) (100 memories, every client), then follow a [2-minute connect guide](https://recall-mcp.fly.dev/connect) for Claude, ChatGPT, Claude Code, Cursor, Windsurf, or [any MCP client](https://recall-mcp.fly.dev/connect/any). Prefer to run it yourself? See the self-hosting guide below — it's the same open code.

[![License](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.0.0-339933.svg)](.nvmrc)
[![TypeScript](https://img.shields.io/badge/types-TypeScript-3178C6.svg)](tsconfig.json)
[![CI](https://img.shields.io/badge/CI-GitHub%20Actions-2088FF.svg)](.github/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-205%20passing-brightgreen.svg)](#)
[![MCP](https://img.shields.io/badge/MCP-StreamableHTTP-blueviolet.svg)](#)

> **CI badge:** Once pushed to GitHub, replace the `CI` badge above with:
> `https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg`

---

RecallMCP gives AI agents a persistent, searchable memory they can write to and query at any time — across sessions, across conversations, across namespaces. It is an MCP server that exposes five tools (`remember`, `recall`, `list_memories`, `update_memory`, `forget`) backed by Postgres + pgvector for semantic similarity search.

Memories are partitioned per user, isolated by row-level security, and stored as content + embedding + optional structured metadata. Deduplication happens automatically on identical content within the same namespace.

## Tools

### `remember`

Store a memory with semantic embedding.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | Yes | Content to remember (1–50,000 characters) |
| `namespace` | string | No | Namespace grouping (default: `"default"`) |
| `metadata` | object | No | Arbitrary key/value metadata |

**Output:**

```json
{ "id": "550e8400-e29b-41d4-a716-446655440000" }
```

Returns an error with `deduped: true` if identical content already exists in the same namespace (or you can check the returned id — it matches the existing memory's id).

**Example:**

```json
{
  "content": "The user prefers Python for data analysis and prefers FastAPI over Flask for web services.",
  "namespace": "preferences",
  "metadata": { "source": "conversation", "confidence": 0.95 }
}
```

Response:
```json
{ "id": "550e8400-e29b-41d4-a716-446655440000" }
```

Calling `remember` again with identical `content` in the same `namespace` returns the existing memory's id without creating a duplicate.

### `recall`

Retrieve memories semantically similar to a query, ranked by cosine similarity.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | Yes | Search query (1–10,000 characters) |
| `namespace` | string | No | Filter by namespace (default: `"default"`) |
| `limit` | number | No | Max results (1–50, default: 10) |
| `threshold` | number | No | Minimum similarity 0.0–1.0 (default: 0.7) |
| `metadata_filter` | object | No | Key/value filter on metadata (AND semantics, max 8 keys, primitive values only) |

**Output:**

Array of matching memories, ordered by decreasing similarity. Each result includes `<memory>` tag wrapping with HTML-escaped content for prompt-injection defense.

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "content": "The user prefers Python for data analysis and prefers FastAPI over Flask for web services.",
    "similarity": 0.92,
    "metadata": { "source": "conversation", "confidence": 0.95 },
    "namespace": "preferences",
    "created_at": "2026-04-29T12:00:00.000Z"
  }
]
```

**Example — recall with namespace and metadata filter:**

```json
{
  "query": "What are the user's web framework preferences?",
  "namespace": "preferences",
  "threshold": 0.8,
  "metadata_filter": { "source": "conversation" }
}
```

Results are formatted as `<memory>` tags internally so the calling agent receives escaped, structured output that can't be broken by injected content (e.g., a memory containing `</memory>` is safely escaped).

### `list_memories`

List stored memories for a user, with pagination and namespace filtering.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `namespace` | string | No | Filter by namespace (default: `"default"`) |
| `limit` | number | No | Max results (1–100, default: 20) |
| `offset` | number | No | Pagination offset (default: 0) |
| `order` | string | No | Sort column — `"created_at"` or `"updated_at"` (default: `"created_at"`) |

**Output:**

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "content": "The user prefers Python for data analysis.",
    "namespace": "preferences",
    "created_at": "2026-04-29T12:00:00.000Z",
    "updated_at": "2026-04-29T12:00:00.000Z"
  }
]
```

### `update_memory`

Update a memory's content and/or metadata. Changes trigger re-embedding of new content.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string (UUID) | Yes | Memory ID to update |
| `content` | string | No | New content (re-embedded) |
| `metadata` | object | No | New metadata (replaces existing) |

At least one of `content` or `metadata` must be provided.

**Output:**

```json
{ "success": true }
```

### `forget`

Delete memories. Supports two modes:

#### Mode `by_id` — delete a single memory by ID

```json
{ "mode": "by_id", "id": "550e8400-e29b-41d4-a716-446655440000" }
```

Output:
```json
{ "success": true }
```

#### Mode `by_query` — two-step semantic deletion

This mode requires two calls to prevent accidental bulk deletion:

**Step 1 — Preview:** Call `forget` with `mode: "by_query"` and a search query. Returns matching memories and a `confirmation_token`.

```json
{
  "mode": "by_query",
  "query": "web framework preferences",
  "namespace": "preferences",
  "threshold": 0.85,
  "limit": 10
}
```

Response:
```json
{
  "preview": true,
  "matches": [
    { "id": "550e8400-e29b-41d4-a716-446655440000", "content": "The user prefers...", "similarity": 0.91 }
  ],
  "total_matches": 1,
  "confirmation_token": "a1b2c3d4e5f6...",
  "expires_at": "2026-04-29T12:05:00.000Z"
}
```

**Step 2 — Confirm:** Call `forget` again with the same `mode: "by_query"` and the `confirmation_token`.

```json
{
  "mode": "by_query",
  "confirmation_token": "a1b2c3d4e5f6..."
}
```

Response:
```json
{ "success": true, "deleted_count": 1 }
```

Confirmation tokens expire after 5 minutes and are scoped to the requesting user (cross-user token reuse is rejected).

## Authentication & API Keys

RecallMCP uses bearer-token authentication. API keys follow a `recall_live_` prefix followed by a 32-character random suffix (URL-safe base64).

```http
Authorization: Bearer recall_live_<32-char-suffix>
```

Keys map to a user account and a **tier** that governs rate limits:

| Tier    | Rate Limit       | Max Memories |
|---------|------------------|--------------|
| Free    | 10 requests/min  | 100          |
| Starter | 60 requests/min  | Unlimited    |
| Pro     | 60 requests/min  | Unlimited    |
| Team    | 60 requests/min  | Unlimited    |

Rate limits are enforced per API key using a token-bucket algorithm. Paid tier quotas are currently uniform pending billing-granularity tuning.

For clients whose connector UI only accepts a URL (claude.ai custom connectors, ChatGPT developer mode, Le Chat), the key may instead ride in the URL as `?key=recall_live_…`. Issue a dedicated key per URL-based client so each can be revoked independently.

### Self-serve signup

`POST /api/signup` with `{ "email": "you@example.com" }` creates a free-tier account and returns the first API key **exactly once** (only a bcrypt hash is stored). A minimal web flow lives at [`/signup`](https://recall-mcp.fly.dev/signup). Guards: per-IP rate limit (`SIGNUP_MAX_PER_IP_HOUR`, default 5), one account per email (409 on duplicate), and a live kill switch (`SIGNUP_ENABLED=false`).

### Key management (self-serve)

All authenticated with any active key:

- `POST /api/keys` — issue an additional key (`{ label?, tier? }`; tier escalation is blocked)
- `GET /api/keys` — list keys (`?include_revoked=true` for history)
- `POST /api/keys/:id/rotate` — atomically issue a replacement and revoke the old key
- `DELETE /api/keys/:id` — revoke (the key in use cannot revoke itself)

### Export — your data leaves with you, anytime

`GET /api/export` returns **everything the account owns** — every memory in every namespace (personas included), with metadata and timestamps — as one JSON document (`format: "recall.export"`). Embedding vectors are excluded: they're derivable and provider-specific. Docs: [`/export`](https://recall-mcp.fly.dev/export).

## Rate Limiting

Every API call is rate-limited by token-bucket per API key. The bucket is lazily refilled — idle keys don't accumulate beyond capacity. When a key exceeds its rate:

- HTTP 429 with a `Retry-After` header (seconds until the bucket refills enough for another request)
- A `rate_limited` usage event is recorded with `tokens_consumed: 0`
- Denied requests never reach the tool handler

The rate limiter uses an `InMemoryRateLimiter` by default. The `RateLimiter` interface supports swapping to a distributed implementation (e.g., Redis) for multi-instance deployments.

## Usage Tracking

Every tool invocation that passes authentication produces exactly one row in `usage_events`:

| Column | Description |
|--------|-------------|
| `user_id` | Owner of the API key that made the call |
| `api_key_id` | Specific API key used |
| `request_id` | Correlates with structured logs |
| `tool_name` | Which tool was called |
| `tokens_consumed` | 1 for normal calls, 0 for rate-limited |
| `latency_ms` | Wall-clock time of the handler |
| `success` | Whether the tool call completed without error |
| `error_code` | String identifier on failure (`validation_failed`, `rate_limited`, `internal_error`, etc.) |

The insert is fire-and-forget — failures are logged as warnings but never surfaced to the client. Usage events are RLS-protected: users can only see their own events.

## Self-Hosting Guide

> **A more complete deployment guide ships in a later release — this section covers the basics for local and small-scale self-hosting.**

### Prerequisites

- Node.js 20.x (exact version required — see `.nvmrc`)
- PostgreSQL 15+ with [pgvector](https://github.com/pgvector/pgvector) extension
- An OpenAI API key (for embeddings; the server refuses to start without one in production)

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Postgres connection string with pgvector support |
| `OPENAI_API_KEY` | Yes | OpenAI API key for text embeddings |
| `PORT` | No | HTTP port (default: 8080) |
| `TRANSPORT` | No | `"http"` (default) or `"stdio"` |
| `LOG_LEVEL` | No | Log level: `debug`, `info`, `warn`, `error` (default: `info`) |
| `MCPIZE_BILLING_WEBHOOK_SECRET` | No | HMAC secret for MCPize billing webhook |
| `STRIPE_SECRET_KEY` | No | Stripe secret key (webhooks disabled if absent) |
| `STRIPE_WEBHOOK_SECRET` | No | Stripe webhook signing secret |
| `STRIPE_PRICE_TO_TIER` | No | JSON mapping: price IDs → tiers, e.g. `{"price_abc":"starter"}` |

### Run Migrations

Apply migrations in order — each is a standalone SQL file under `supabase/migrations/`:

```bash
# Using Supabase CLI (recommended for managed Postgres):
supabase db push --db-url "$DATABASE_URL"

# Or apply manually with psql:
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -f "$f"
done
```

Migration history:

| File | Description |
|------|-------------|
| `0001_init.sql` | Base schema: users, api_keys, memories (with pgvector), usage_events, RLS policies, update trigger |
| `0002_force_rls_and_app_role.sql` | Forces RLS on all tables, creates the `recall_app` role for non-bypass connections |
| `0003_metadata_gin_index.sql` | Adds GIN index on `memories.metadata` for efficient containment queries |
| `0004_api_key_tier.sql` | Adds `tier` column to `api_keys` for per-key rate limit configuration |
| `0005_usage_events.sql` | Replaces the initial usage_events table with a richer schema (request_id, tool_name, latency, tokens_consumed, error_code) |

### Start the Server

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start (HTTP mode on port 8080)
npm start
```

For development with hot reload:

```bash
npm run dev
```

The server exposes:
- `GET /health` — health check
- `GET /ready` — readiness check (DB connected)
- `POST /mcp` — MCP endpoint (Streamable HTTP transport; auth via `Authorization: Bearer` or `?key=`)
- `POST /api/signup` — self-serve account + first key
- `GET|POST|DELETE /api/keys…` — key management
- `GET /api/export` — full-account JSON export
- `/`, `/signup`, `/export`, `/connect/*` — the product site and connect guides (static, served from `public/`)

## Local Development

```bash
git clone https://github.com/<your-org>/recall-mcp
cd recall-mcp
npm install

# Set up local Postgres with pgvector, then:
cp .env.example .env
# Edit .env with your DATABASE_URL and OPENAI_API_KEY

# Run migrations
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -f "$f"
done

# Start in dev mode
npm run dev

# Run tests (requires Docker for testcontainers-based Postgres):
npm test
```

The test suite spins up isolated Postgres + pgvector containers via Testcontainers, applies all migrations, and runs 255 integration and unit tests covering every tool, RLS isolation, rate limiting, usage events, and cross-user security boundaries.

## Architecture Overview

```
┌──────────────┐     POST /mcp      ┌──────────────────────────────────────┐
│  MCP Client  │ ──────────────────> │          Fastify Server              │
│  (AI Agent)  │ <────────────────── │  (Streamable HTTP Transport)         │
└──────────────┘    JSON-RPC 2.0     └──────┬───────────────────────────────┘
                                            │
                                            ▼
                              ┌─────────────────────────┐
                              │   Auth Middleware        │
                              │   (Bearer API Key →     │
                              │    userId + tier)        │
                              └───────────┬─────────────┘
                                          │
                                          ▼
                              ┌─────────────────────────┐
                              │   Rate Limiter           │
                              │   (token-bucket per key) │
                              └───────────┬─────────────┘
                                          │
                                          ▼
                              ┌─────────────────────────┐
                              │   Usage Event Recorder   │
                              │   (fire-and-forget)      │
                              └───────────┬─────────────┘
                                          │
                                          ▼
             ┌─────────────────────────────────────────────┐
             │          Tool Dispatcher                    │
             │  ┌───────┬──────┬────────┬──────┬────────┐  │
             │  │remember│recall│list_mem│update│forget  │  │
             │  └───┬────┴──┬───┴───┬────┴──┬───┴───┬────┘  │
             └──────┼──────┼───────┼───────┼───────┼────────┘
                    │      │       │       │       │
                    ▼      ▼       ▼       ▼       ▼
              ┌──────────────────────────────────────┐
              │    Database Client (pg pool)          │
              │    with RLS user context              │
              └──────────┬───────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  PostgreSQL + pgvector│
              │  ┌──────────────────┐ │
              │  │ users            │ │
              │  │ api_keys         │ │
              │  │ memories (vec)   │ │
              │  │ usage_events     │ │
              │  └──────────────────┘ │
              │  Row-Level Security   │
              └──────────────────────┘
```

**Key design points:**

- **Auth is HTTP-only** — API keys are sent as Bearer tokens, never exposed in MCP tool arguments
- **Auth context flows via AsyncLocalStorage** — middleware stores `{ userId, tier, apiKeyId }` in a request-scoped context; tools read it transparently without explicit parameter passing
- **RLS is the security boundary** — every database query is wrapped in `SET LOCAL app.current_user_id`; Postgres enforces isolation at the row level. Even the database owner cannot bypass policies (`FORCE ROW LEVEL SECURITY`)
- **Rate limiter uses a pivot-resistant interface** — swap from in-memory to Redis by implementing two methods (`check()` and `lastDecisionMeta()`)
- **Usage events are fire-and-forget** — never blocks the response; failures are logged but never surfaced

## Logging & Observability

RecallMCP uses [pino](https://getpino.io/) for structured JSON logging:

- **Production:** JSON output (pipe through `pino-pretty` for local readability with `NODE_ENV=development`)
- **Request correlation:** Every request has a `request_id` that appears in both structured logs and the `usage_events.request_id` column, enabling cross-system joinability
- **Sensitive data redaction:** Memory content, query strings, and embedding vectors are SHA-256 hashed (8-char truncated) or replaced with `[redacted]` in logs
- **Tool-level wrapping:** All five tools are wrapped by `handleToolWithLogging`, which logs entry, exit (with `elapsed_ms`), and errors (with `error_code` and redacted details)

## Migration History

| # | File | What it does |
|---|------|--------------|
| 1 | `0001_init.sql` | Base schema: users, api_keys, memories (with `vector(1536)` embedding and content_hash for dedup), usage_events, RLS policies, update trigger for `updated_at` |
| 2 | `0002_force_rls_and_app_role.sql` | Forces RLS on memories and api_keys (table owner cannot bypass), creates `recall_app` role and `recall_app_test` role for CI |
| 3 | `0003_metadata_gin_index.sql` | GIN index (`jsonb_path_ops`) on `memories.metadata` for efficient metadata containment queries in `recall` |
| 4 | `0004_api_key_tier.sql` | Adds `tier` column to `api_keys` with CHECK constraint for per-key rate limit configuration |
| 5 | `0005_usage_events.sql` | Replaces the initial usage_events table with a richer schema: adds `api_key_id`, `request_id`, `tool_name`, `tokens_consumed`, `latency_ms`, `success`, `error_code`, `occurred_at`; removes old `event_type` and `metadata` columns. Includes FORCE RLS and dedicated indexes |

## Status & Roadmap

**Done — production hardening complete:**

- ✅ All five MCP tools with Zod validation
- ✅ Row-level security with FORCE (Zero-trust multi-tenancy)
- ✅ Semantic search with metadata filtering
- ✅ Content normalization & deduplication
- ✅ Two-step semantic deletion (preview → confirm)
- ✅ Auth middleware (API key → user + tier, 1-hour LRU cache)
- ✅ Per-API-key token-bucket rate limiting
- ✅ Structured logging with request correlation and redaction
- ✅ Usage event tracking (foundation for billing)
- ✅ 255-test integration+unit suite (Testcontainers)
- ✅ API key self-service issuance and management endpoints (R12)
- ✅ Stripe webhook integration for tier sync (R13)
- ✅ Docker and deployment guide (R14–15)
- ✅ MCP Registry manifest & npm publish prep (R16)

- ✅ Self-serve signup web flow (email → account → key shown once)
- ✅ Full-account JSON export (`GET /api/export`)
- ✅ Product site + connect guides for every MCP client (`public/`)

**In development:**

- 🔄 Public user dashboard (usage stats, key management)
- 🔄 Persona vault (first-class persona document type)
- 🔄 Journaling kit (continuity prompt + session summaries)

## License

[ISC](LICENSE)
