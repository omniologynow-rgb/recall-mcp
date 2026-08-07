# RecallMCP — Deployment Guide

## Overview

RecallMCP is a Node.js application that provides a persistent memory layer for
MCP (Model Context Protocol) agents. It needs:

- **Node.js 20+** (runtime)
- **PostgreSQL 16+** with **pgvector** extension
- **~512 MB RAM** minimum (more under load)
- **Persistent disk** for Postgres data (managed DB recommended)

The app itself is stateless — all state lives in Postgres. For production, use
a managed Postgres service (Supabase, Neon, RDS) and run the app container
behind a reverse proxy.

---

## Environment Variables

RecallMCP reads the following environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | ✅ Yes | — | PostgreSQL connection string (e.g. `postgresql://user:pass@host:5432/db`) |
| `PORT` | No | `8080` | HTTP port to listen on |
| `TRANSPORT` | No | `http` | Transport mode: `http` for HTTP/SSE, `stdio` for MCP stdio |
| `LOG_LEVEL` | No | `info` | Log level: trace, debug, info, warn, error, fatal |
| `NODE_ENV` | No | — | Set to `production` to enable production defaults |
| `OPENAI_API_KEY` | ✅ Yes | — | OpenAI API key for embeddings |
| `STRIPE_SECRET_KEY` | No | — | Stripe secret key (webhook disabled if absent) |
| `STRIPE_WEBHOOK_SECRET` | No | — | Stripe webhook signing secret |
| `STRIPE_PRICE_TO_TIER` | No | — | JSON mapping of price IDs to tiers, e.g. `{"price_abc":"starter"}` |
| `MCPIZE_BILLING_WEBHOOK_SECRET` | No | — | Webhook secret for MCPize.com billing integration |

> **Note:** `OPENAI_API_KEY` is required at startup for the embedding service.
> The app will fail to start without it.

---

## Quickstart with Docker Compose

```bash
# 1. Clone the repo
git clone https://github.com/yourorg/recall-mcp.git
cd recall-mcp

# 2. Configure environment
cp .env.example .env
# Edit .env with your values (DATABASE_URL, OPENAI_API_KEY, etc.)

# 3. Start services
docker compose up -d

# 4. Run database migrations
docker compose exec app node dist/migrate.js

# 5. Create the first admin user
docker compose exec app \
  node dist/admin/create-user.js --email admin@example.com --tier pro

# 6. Verify health
curl http://localhost:8080/health
# → { "ok": true, "version": "0.1.0", "db": "up", "embedder": "up", "timestamp": "2025-05-11T…" }
```

---

## Database Migrations

Migrations must be applied in order. Each file is in `supabase/migrations/`.

| File | Description |
|---|---|
| `0001_init.sql` | Creates `vector` extension, users, api_keys, memories tables |
| `0002_usage_events.sql` | Creates usage_events table for telemetry |
| `0003_trace_sessions.sql` | Creates trace_sessions table for traceability |
| `0004_repeated_analysis.sql` | Adds repeat-analysis tracking columns |
| `0005_api_key_tier.sql` | Adds `tier` column to api_keys (per-key overrides) |
| `0006_tier_limits.sql` | Adds tier_config table for rate-limit parameters |
| `0007_stripe_integration.sql` | Adds `stripe_customer_id` to users + stripe_events table |

> Migration 0007 is required even if you're not using Stripe yet — the
> column and table sit unused but keep the schema consistent.

To run migrations manually:

```bash
node dist/migrate.js
```

Or from inside the container:

```bash
docker compose exec app node dist/migrate.js
```

---

## First-User Bootstrap

After migrations, create the initial admin user with the admin CLI:

```bash
node dist/admin/create-user.js --email admin@example.com --tier pro
```

The command outputs JSON with the user, API key, and tier. **The API key is
shown exactly once** — save it immediately. It cannot be retrieved later.

Required flags:
- `--email` — valid email address
- `--tier` — one of: `free`, `starter`, `pro`, `team`

Optional: `--label` (defaults to `"initial"`)

Example output:

```json
{
  "user_id": "abc-123",
  "email": "admin@example.com",
  "tier": "pro",
  "api_key": "recall_live_AbCdEfGhIjKlMnOpQrStUvWxYz123456",
  "key_id": "key-456",
  "label": "initial",
  "created_at": "2026-05-11T00:00:00.000Z"
}
```

---

## Stripe Webhook Configuration

Once deployed, configure the Stripe Dashboard to send events:

1. Go to Stripe Dashboard → Developers → Webhooks
2. Click **Add endpoint**
3. Set the endpoint URL: `https://yourdomain.com/api/stripe/webhook`
4. Enable the following event types:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `customer.created`
5. Copy the **Signing secret** into your `.env` as `STRIPE_WEBHOOK_SECRET`
6. Restart the app container

When creating Stripe customers, include `metadata.app_user_id` with the
RecallMCP user's UUID to automatically bind the customer to the user record.

---

## Production Considerations

- **SSL termination** — handle at the ingress layer (nginx, Caddy, Traefik,
  cloud LB), **not** in the app. The app serves plain HTTP on the configured
  port.

- **Managed Postgres** — strong preference over self-hosted for production.
  Supabase, Neon, and RDS all offer pgvector-compatible Postgres and handle
  backups, failover, and connection pooling.

- **Pool sizing** — the default connection pool is adequate for single-replica
  deployments. If you need a `DATABASE_POOL_MAX` env var for finer control,
  that's a future config knob.

- **Logging** — the app emits structured JSON to stdout. Pipe it to
  Datadog, Honeycomb, Logtail, or whatever observability stack you use.
  `docker logs` works for local dev.

- **Backups** — schedule `pg_dump` or use your managed Postgres provider's
  built-in backup feature. Without backups, a DB failure means losing all
  user memories.

- **Scaling** — RecallMCP is a single-process application today. Multi-replica
  deployments require the Redis-backed distributed rate limiter (the interface
  is ready per R8 design; implementation is deferred). For beta, a single
  instance handles moderate traffic.

---

## Health Checks

**Endpoint:** `GET /health`

**200 response (healthy):**
```json
{ "ok": true, "version": "0.1.0", "db": "up", "embedder": "up", "timestamp": "2025-05-11T…" }
```

**503 response (degraded):**
```json
{ "ok": false, "version": "0.1.0", "db": "down", "embedder": "up", "timestamp": "2025-05-11T…" }
```

The health check runs a lightweight `SELECT 1` with a 2-second timeout. It
is safe for load balancer health probes and container orchestrator liveness
checks.

The root path `/` issues a 302 redirect to `/health`.

---

## Deploying to Specific Platforms

### Fly.io

```bash
fly launch
# Edit fly.toml to set DATABASE_URL and OPENAI_API_KEY as secrets
fly secrets set DATABASE_URL=postgresql://...
fly secrets set OPENAI_API_KEY=sk-...
fly deploy
```

Use Fly Postgres (add `fly pg create` and attach) or point at an external
managed Postgres. See [fly.io docs](https://fly.io/docs/).

### Railway

1. Create a new project on [Railway](https://railway.app/)
2. Add a Postgres plugin (it provides `DATABASE_URL` automatically)
3. Deploy from GitHub or use the CLI: `railway up`
4. Set `OPENAI_API_KEY` in the dashboard environment variables
5. Railway auto-detects Node.js and runs `npm start`

### Render

1. Create a **Web Service** on [Render](https://render.com/)
2. Point at your GitHub repo
3. Set build command: `npm ci && npm run build`
4. Set start command: `node dist/server.js`
5. Add environment variables: `DATABASE_URL`, `OPENAI_API_KEY`
6. Optionally add a managed Postgres via Render Dashboard

### Self-Hosted VPS

```bash
# Install Docker + Docker Compose on your VPS
git clone https://github.com/yourorg/recall-mcp.git
cd recall-mcp
cp .env.example .env
# Edit .env
docker compose up -d

# Set up nginx as reverse proxy:
# server {
#   listen 443 ssl;
#   server_name recall.example.com;
#   location / {
#     proxy_pass http://127.0.0.1:8080;
#     proxy_http_version 1.1;
#     proxy_set_header Upgrade $http_upgrade;
#     proxy_set_header Connection "upgrade";
#     proxy_set_header Host $host;
#   }
# }
```

---

## Troubleshooting

### "Migration 0007 fails with pg.Client quirk"

Migration 0007 uses `pg.Client` style (direct connection, not pool). If
running migrations via `dist/migrate.js`, ensure `DATABASE_URL` is set and
the `vector` extension exists. The `registerVectorTypes()` call must happen
**after** `applyMigrations()` because `0001_init.sql` creates the extension.

**Workaround:** If you get `type "vector" does not exist`, run migrations
in the correct order: `0001` first (creates extension), then the rest.

### "Stripe webhook returns 503"

The Stripe webhook route auto-disables when its env vars are missing:

```
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET  
STRIPE_PRICE_TO_TIER
```

Check all three are set in your environment. If you're not using Stripe yet,
this is expected behavior — the rest of the app works fine.

### "Rate limiter not working across replicas"

The rate limiter is in-memory per process. With multiple replicas, each has
its own token bucket. The Redis-backed distributed rate limiter interface
is ready (designed in R8) but not implemented. For beta, run a single
instance or accept per-replica rate windows.

### "Subscription events arriving but user tier isn't updating"

Check the Stripe customer object includes `metadata.app_user_id` set to the
RecallMCP user's UUID. Without this binding, the webhook can't map from
the Stripe customer to the RecallMCP user.

### "Can't find API key after creating user"

The admin CLI prints the full API key exactly once on stdout. It is
immediately hashed and stored — there is no way to retrieve it later.
Generate a new key via the API key management endpoints or the admin CLI.

### "Health check is returning 503"

The DB connection is down. Check:
1. Postgres is running (`docker compose ps`)
2. `DATABASE_URL` is correct
3. Network connectivity between app and DB
4. Postgres isn't rejecting connections (too many, authentication, etc.)
