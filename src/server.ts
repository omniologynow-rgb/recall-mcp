import fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { createHmac, timingSafeEqual } from 'crypto';
import { DatabaseClient } from './db/client.js';
import { AuthService } from './auth/index.js';
import { authContext } from './auth/storage.js';
import { HealthService } from './health.js';
import { RememberTool } from './tools/remember.js';
import { RecallTool } from './tools/recall.js';
import { ListMemoriesTool } from './tools/list.js';
import { UpdateMemoryTool } from './tools/update.js';
import { ForgetTool } from './tools/forget.js';
import type { Embedder } from './embedder/index.js';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport, type StreamableHTTPServerTransportOptions } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getConfig } from './config.js';
import {
  RememberInputSchema, RecallInputSchema, ListMemoriesInputSchema,
  UpdateMemoryInputSchema, ForgetInputSchema,
  validateArgs, validateOutput,
  RememberOutputSchema, RecallOutputSchema, ListMemoriesOutputSchema,
  UpdateMemoryOutputSchema, ForgetOutputSchema,
} from './schemas.js';
import pino from 'pino';
import { rootLogger, createToolLogger, redactSensitive } from './logging.js';
import { InMemoryRateLimiter } from './ratelimit/in-memory.js';
import { recordUsageEvent } from './db/usage.js';
import { registerApiKeyRoutes } from './routes/api-keys.js';
import { registerStripeWebhook } from './routes/stripe-webhook.js';
import { registerSignupRoute } from './routes/signup.js';
import { registerExportRoute } from './routes/export.js';
import { registerSiteRoutes } from './routes/site.js';
import { extractApiKey } from './auth/extract.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

export interface ServerOptions {
  port?: number | undefined;
  host?: string | undefined;
  transport?: 'stdio' | 'http' | undefined;
  enableDnsRebindingProtection?: boolean | undefined;
  allowedHosts?: string[] | undefined;
  allowedOrigins?: string[] | undefined;
}

// Module-level store for raw body buffers, keyed by IncomingMessage reference
const rawBodyStore = new WeakMap<object, Buffer>();

export class RecallServer {
  public readonly fastify: FastifyInstance;
  private db: DatabaseClient;
  private auth: AuthService;
  private health: HealthService;
  private mcpServer: McpServer;
  private transport: StreamableHTTPServerTransport | StdioServerTransport | null = null;
  private transportType: 'stdio' | 'http' = 'http';
  private logger: pino.Logger;
  private version: string;
  private isShuttingDown = false;
  private rateLimiter: InMemoryRateLimiter;

  constructor(
    private embedder: Embedder,
    private options: ServerOptions = {}
  ) {
    const config = getConfig();
    this.logger = rootLogger.child({ name: 'RecallServer' });
    this.version = this.loadVersion();
    this.fastify = fastify({
      logger: false,
      disableRequestLogging: true,
    });
    this.db = new DatabaseClient(config.databaseUrl);
    this.auth = new AuthService(this.db);
    this.health = new HealthService(this.db, embedder, this.version);
    this.rateLimiter = new InMemoryRateLimiter();
    this.mcpServer = this.createMcpServer();
    // Routes will be set up in start() based on transport type
    this.setupGracefulShutdown();
  }

  private loadVersion(): string {
    try {
      // dist/server.js → ../package.json (same layout from src/ via tsx)
      const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  /** Options for a per-request stateless HTTP transport (SDK 1.30 pattern). */
  private httpTransportOptions(): StreamableHTTPServerTransportOptions {
    return {
      // No sessionIdGenerator — stateless mode (each request handled independently)
      enableJsonResponse: true,
      enableDnsRebindingProtection: this.options.enableDnsRebindingProtection ?? (getConfig().isDev ? false : true),
      allowedHosts: this.options.allowedHosts,
      allowedOrigins: this.options.allowedOrigins,
    } as any; // Cast to any to bypass exactOptionalPropertyTypes
  }

  private createMcpServer(): McpServer {
    const server = new McpServer(
      { name: 'RecallMCP', version: this.version },
      { capabilities: { tools: {} } }
    );

    // Instantiate tools (auth is passed via AsyncLocalStorage, not constructor)
    const rememberTool = new RememberTool(this.db, this.embedder);
    const recallTool = new RecallTool(this.db, this.embedder);
    const listTool = new ListMemoriesTool(this.db);
    const updateTool = new UpdateMemoryTool(this.db, this.embedder);
    const forgetTool = new ForgetTool(this.db, this.embedder);

    // Tool definitions for MCP (auth is HTTP-header-only, not in tool args)
    const tools: Tool[] = [
      {
        name: 'remember',
        description: 'Store a memory with semantic embedding.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Content to remember (1-50000 chars)' },
            namespace: { type: 'string', description: 'Namespace (default: "default")' },
            metadata: { type: 'object', description: 'Optional metadata' },
          },
          required: ['content'],
        },
      },
      {
        name: 'recall',
        description: 'Retrieve memories similar to the query, ranked by semantic similarity.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (1-10000 chars)' },
            namespace: { type: 'string', description: 'Filter by namespace (default: "default")' },
            limit: { type: 'number', description: 'Maximum results (1-50, default: 10)' },
            threshold: { type: 'number', description: 'Minimum similarity 0.0-1.0 (default: 0.7)' },
            metadata_filter: { type: 'object', description: 'Filter by metadata key=value pairs (AND semantics, max 8 keys, primitives only)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'list_memories',
        description: 'List memories for a user, optionally filtered by namespace.',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: { type: 'string', description: 'Filter by namespace (default: "default")' },
            limit: { type: 'number', description: 'Maximum results (1-100, default: 20)' },
            offset: { type: 'number', description: 'Pagination offset (default: 0)' },
            order: { type: 'string', enum: ['created_at', 'updated_at'], description: 'Sort order (default: created_at)' },
          },
          required: [],
        },
      },
      {
        name: 'update_memory',
        description: 'Update a memory\'s content and/or metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid', description: 'Memory ID' },
            content: { type: 'string', description: 'New content' },
            metadata: { type: 'object', description: 'New metadata' },
          },
          required: ['id'],
        },
      },
      {
        name: 'forget',
        description: 'Delete a memory by ID (two-step: preview → confirm) or by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['by_id', 'by_query'], description: "Delete mode: 'by_id' or 'by_query'" },
            id: { type: 'string', format: 'uuid', description: 'Memory ID (for mode: by_id)' },
            query: { type: 'string', description: 'Semantic search query (for mode: by_query preview)' },
            namespace: { type: 'string', description: 'Namespace scope (for mode: by_query preview)' },
            threshold: { type: 'number', description: 'Minimum similarity 0.0-1.0 (for mode: by_query preview)' },
            limit: { type: 'number', description: 'Max preview results 1-50 (for mode: by_query preview)' },
            confirmation_token: { type: 'string', description: 'Token from preview (for mode: by_query confirm)' },
          },
          required: ['mode'],
        },
      },
    ];

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools,
    }));

    // Helper to wrap a tool handler with request-scoped logging and usage event recording
    const handleToolWithLogging = (
      toolName: string,
      handler: () => Promise<{ content: Array<{ type: string; text: string }> }>,
    ): Promise<{ content: Array<{ type: string; text: string }> }> => {
      const auth = authContext.getStore();
      if (!auth) {
        return Promise.resolve({ content: [{ type: 'text', text: JSON.stringify({ error: { code: 'unauthorized', message: 'Authentication required', retryable: false } }) }] });
      }
      const reqLogger = createToolLogger(auth.requestId, toolName, auth.userId);
      const start = Date.now();
      reqLogger.info('Handling tool call');

      // Determine error code string from error object
      const errorCodeFrom = (err: unknown): string | null => {
        if (err instanceof Error && (err as any).toMcpError) {
          const mcpErr = (err as any).toMcpError();
          return mcpErr.code || 'internal_error';
        }
        if (err instanceof Error && err.name === 'ValidationError') {
          return 'validation_failed';
        }
        return 'internal_error';
      };

      const resultPromise = handler().then((result) => {
        const elapsed = Date.now() - start;
        reqLogger.info({ elapsed_ms: elapsed }, 'Tool call completed');
        // Fire-and-forget: record SUCCESS usage event
        recordUsageEvent(this.db, {
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          requestId: auth.requestId,
          toolName,
          tokensConsumed: 1,
          latencyMs: elapsed,
          success: true,
          errorCode: null,
        }, (logErr) => {
          reqLogger.warn({ error: logErr.message }, 'usage_event_write_failed');
        });
        return result;
      }).catch((err: unknown) => {
        const elapsed = Date.now() - start;
        const errorCode = errorCodeFrom(err);
        const errInfo = err instanceof Error ? { message: err.message, name: err.name } : { message: String(err) };
        reqLogger.error({ elapsed_ms: elapsed, error_code: errorCode, ...redactSensitive(errInfo) }, 'Tool call failed');
        // Fire-and-forget: record FAILURE usage event
        recordUsageEvent(this.db, {
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          requestId: auth.requestId,
          toolName,
          tokensConsumed: 1,
          latencyMs: elapsed,
          success: false,
          errorCode,
        }, (logErr) => {
          reqLogger.warn({ error: logErr.message }, 'usage_event_write_failed');
        });
        const errMsg = err instanceof Error && (err as any).toMcpError
          ? JSON.stringify((err as any).toMcpError())
          : JSON.stringify({ error: { code: 'internal_error', message: err instanceof Error ? err.message : 'Unknown error', retryable: false } });
        return { content: [{ type: 'text', text: errMsg }] };
      });

      return resultPromise;
    };

    // Register tool handlers with Zod validation, auth context, and error wrapping
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      if (!args) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'invalid_request', message: 'Missing arguments', retryable: false } }) }] };
      }

      // Get auth context from AsyncLocalStorage (set by HTTP preHandler)
      const auth = authContext.getStore();
      if (!auth) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'unauthorized', message: 'Authentication required', retryable: false } }) }] };
      }

      switch (name) {
        case 'remember':
          return handleToolWithLogging('remember', async () => {
            const validated = validateArgs(RememberInputSchema, args);
            const id = await rememberTool.remember(auth.userId, auth.tier, validated.content, validated.namespace, validated.metadata);
            const output = validateOutput(RememberOutputSchema, { id });
            return { content: [{ type: 'text', text: JSON.stringify(output) }] };
          });
        case 'recall':
          return handleToolWithLogging('recall', async () => {
            const validated = validateArgs(RecallInputSchema, args);
            const results = await recallTool.recall(auth.userId, validated.query, validated.namespace, validated.limit, validated.threshold, validated.metadata_filter);
            validateOutput(RecallOutputSchema, results);
            const formatted = RecallTool.formatBatchForRecall(results);
            return { content: [{ type: 'text', text: formatted }] };
          });
        case 'list_memories':
          return handleToolWithLogging('list_memories', async () => {
            const validated = validateArgs(ListMemoriesInputSchema, args);
            const results = await listTool.list(auth.userId, validated.namespace, validated.limit, validated.offset, validated.order);
            const output = validateOutput(ListMemoriesOutputSchema, results);
            return { content: [{ type: 'text', text: JSON.stringify(output) }] };
          });
        case 'update_memory':
          return handleToolWithLogging('update_memory', async () => {
            const validated = validateArgs(UpdateMemoryInputSchema, args);
            const success = await updateTool.update(auth.userId, validated.id, validated.content, validated.metadata);
            const output = validateOutput(UpdateMemoryOutputSchema, { success });
            return { content: [{ type: 'text', text: JSON.stringify(output) }] };
          });
        case 'forget':
          return handleToolWithLogging('forget', async () => {
            const validated = validateArgs(ForgetInputSchema, args);
            if (validated.mode === 'by_id') {
              const success = await forgetTool.forget(auth.userId, validated.id);
              const output = validateOutput(ForgetOutputSchema, { success });
              return { content: [{ type: 'text', text: JSON.stringify(output) }] };
            } else if ('confirmation_token' in validated) {
              const result = await forgetTool.forgetByQueryConfirm(auth.userId, validated.confirmation_token);
              const output = validateOutput(ForgetOutputSchema, result);
              return { content: [{ type: 'text', text: JSON.stringify(output) }] };
            } else {
              const result = await forgetTool.forgetByQueryPreview(
                auth.userId, validated.query, validated.namespace,
                validated.threshold, validated.limit,
              );
              const output = validateOutput(ForgetOutputSchema, result);
              return { content: [{ type: 'text', text: JSON.stringify(output) }] };
            }
          });
        default:
          return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'unknown_tool', message: `Unknown tool: ${name}`, retryable: false } }) }] };
      }
    });

    return server;
  }

  private setupRoutes(transportType: 'stdio' | 'http') {

    // Only register HTTP routes if transport is HTTP
    if (transportType !== 'http') {
      return;
    }

    // Register helmet for security headers
    this.fastify.register(helmet);

    // Custom JSON body parser that captures the raw buffer for webhook HMAC.
    // Stores the raw body using a module-level WeakMap keyed by the IncomingMessage.
    this.fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      if (body == null || (Buffer.isBuffer(body) && body.length === 0)) {
        const err: any = new Error('Body cannot be empty');
        err.statusCode = 400;
        done(err, undefined);
        return;
      }
      // Store raw body buffer, keyed by the raw IncomingMessage
      rawBodyStore.set(req, body as Buffer);

      try {
        const json = JSON.parse(body.toString('utf8'));
        done(null, json);
      } catch (err: any) {
        err.statusCode = 400;
        done(err, undefined);
      }
    });

    // Health endpoint
    this.fastify.get('/health', async (_request, reply) => {
      const health = await this.health.getHealth();
      reply.code(health.ok ? 200 : 503).send(health);
    });

    // Readiness endpoint
    this.fastify.get('/ready', async (_request, reply) => {
      const ready = await this.health.getReady();
      if (ready.ok) {
        reply.code(200).send(ready);
      } else {
        reply.code(503).send(ready);
      }
    });

    // MCPize webhook endpoint with HMAC verification
    this.fastify.post('/webhooks/mcpize/subscription', async (request, reply) => {
      const secret = process.env.MCPIZE_BILLING_WEBHOOK_SECRET;
      if (!secret) {
        this.logger.warn('MCPIZE_BILLING_WEBHOOK_SECRET not set, rejecting webhook');
        reply.code(401).send({ error: 'Webhook secret not configured' });
        return;
      }

      const signatureHeader = request.headers['x-mcpize-signature'];
      if (!signatureHeader || typeof signatureHeader !== 'string') {
        reply.code(401).send({ error: 'Missing signature header' });
        return;
      }

      // Get the raw body via the module-level WeakMap (populated by content type parser)
      const rawBody = rawBodyStore.get(request as object);
      if (!rawBody) {
        reply.code(400).send({ error: 'Missing request body' });
        return;
      }

      const computedHmac = createHmac('sha256', secret).update(rawBody).digest('hex');
      const providedHmac = signatureHeader;

      // Use timing-safe comparison
      let isValid = false;
      try {
        isValid = timingSafeEqual(Buffer.from(computedHmac, 'hex'), Buffer.from(providedHmac, 'hex'));
      } catch {
        // Length mismatch
      }

      if (!isValid) {
        this.logger.warn('Invalid HMAC signature for webhook');
        reply.code(401).send({ error: 'Invalid signature' });
        return;
      }

      // Use parsed JSON body for payload fields
      const body = request.body as any;
      const { userId, tier } = body;
      if (!userId || !tier) {
        reply.code(400).send({ error: 'Missing userId or tier' });
        return;
      }

      try {
        await this.db.query(
          'UPDATE users SET tier = $1 WHERE id = $2',
          [tier, userId]
        );
        this.logger.info({ userId, tier }, 'Updated user tier via webhook');
        reply.code(200).send({ updated: true });
      } catch (error) {
        this.logger.error({ error, userId, tier }, 'Failed to update user tier');
        reply.code(500).send({ error: 'Internal server error' });
      }
    });

    // Auth preHandler for /mcp route.
    // Accepts `Authorization: Bearer` (preferred) or `?key=` in the URL — the
    // latter exists because several hosted connector UIs (claude.ai, ChatGPT
    // developer mode, Le Chat) accept a server URL with no header fields.
    const authPreHandler = async (request: any, reply: any, done: (err?: Error) => void) => {
      const apiKey = extractApiKey(request);
      if (!apiKey) {
        reply.code(401).send({ error: 'Missing or invalid Authorization header' });
        return done();
      }
      try {
        const authResult = await this.auth.authenticate(apiKey);
        (request.raw as any).auth = { userId: authResult.userId, tier: authResult.tier, keyId: authResult.keyId };
        done();
      } catch {
        // Do not leak whether the key existed
        reply.code(401).send({ error: 'Unauthorized' });
        return done();
      }
    };

    // MCP endpoint
    this.fastify.post('/mcp', { preHandler: authPreHandler }, async (request, reply) => {
      if (this.isShuttingDown) {
        reply.code(503).send({ error: 'Server is shutting down' });
        return;
      }

      // Auth info already attached by preHandler
      const auth = (request.raw as any).auth;
      if (!auth || !auth.userId) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }

      // Rate limit check: enforce per-API-key token bucket
      const tier = auth.tier || 'free';
      const { allowed, retryAfter } = await this.rateLimiter.check(auth.keyId, tier);
      const rateMeta = this.rateLimiter.lastDecisionMeta();
      if (!allowed) {
        reply.header('Retry-After', String(retryAfter));
        reply.code(429).send({ error: 'Too Many Requests', retry_after: retryAfter });
        this.logger.info({
          event: 'rate_limit_exceeded',
          user_id: auth.userId,
          ...rateMeta,
        }, 'Rate limit exceeded');
        // Fire-and-forget usage event for rate-limited request
        recordUsageEvent(this.db, {
          userId: auth.userId,
          apiKeyId: auth.keyId,
          requestId: String(request.id || 'unknown'),
          toolName: 'unknown',
          tokensConsumed: 0,
          latencyMs: 0,
          success: false,
          errorCode: 'rate_limited',
        }, (logErr) => {
          this.logger.warn({ error: logErr.message }, 'usage_event_write_failed');
        });
        return;
      }
      this.logger.debug({
        event: 'rate_limit_allowed',
        user_id: auth.userId,
        ...rateMeta,
      }, 'Rate limit allowed');

      // Handle MCP request via a FRESH per-request transport + server.
      //
      // SDK >=1.30 makes stateless transports single-use: reusing one across
      // requests throws 'Stateless transport cannot be reused across
      // requests' inside hono's request listener, which surfaces as an
      // empty-body HTTP 500 on every /mcp call after the first (live
      // incident 2026-08-18: engine persona saves all failed HTTP 500).
      // The documented stateless pattern is a new transport + server per
      // request; both are lightweight (tool tables + handler closures).
      // Hijack reply so Fastify doesn't try to double-write the response;
      // the MCP SDK's StreamableHTTP transport already writes to reply.raw
      reply.hijack();
      // Wrap transport in auth context so MCP tool handlers can read userId/tier
      // from AsyncLocalStorage instead of receiving them in tool arguments
      const requestId = String(request.id || 'unknown');
      (request.raw as any).auth.requestId = requestId;
      await authContext.run({ userId: auth.userId, tier: auth.tier || 'free', requestId, apiKeyId: auth.keyId }, async () => {
        const perRequestServer = this.createMcpServer();
        const perRequestTransport = new StreamableHTTPServerTransport(this.httpTransportOptions());
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await perRequestServer.connect(perRequestTransport as any);
          await perRequestTransport.handleRequest(request.raw, reply.raw, request.body);
        } finally {
          // Best-effort teardown — the transport is single-use by contract.
          await perRequestTransport.close().catch(() => {});
        }
      });
    });

    // API key management endpoints
    registerApiKeyRoutes(this.fastify, this.db, this.auth, this.logger);

    // Self-serve signup (email → account + first key, shown once)
    registerSignupRoute(this.fastify, this.db, this.logger);

    // Full-account data export ("your data leaves with you, anytime")
    registerExportRoute(this.fastify, this.db, this.auth, this.rateLimiter, this.logger);

    // Stripe webhook (for tier sync)
    registerStripeWebhook(this.fastify, {
      db: this.db,
      logger: this.logger,
      rawBodyStore,
    });

    // Product site: landing, signup UI, connect guides (replaces the old
    // '/' → /health redirect; /health remains the operational endpoint)
    registerSiteRoutes(this.fastify);
  }

  private setupGracefulShutdown() {
    const signals = ['SIGTERM', 'SIGINT'] as const;
    signals.forEach(signal => {
      process.on(signal, async () => {
        this.logger.info(`Received ${signal}, starting graceful shutdown`);
        this.isShuttingDown = true;

        // Force exit after 30 seconds
        const forceExitTimer = setTimeout(() => {
          this.logger.error('Graceful shutdown timeout exceeded, forcing exit');
          process.exit(1);
        }, 30_000);
        forceExitTimer.unref(); // don't keep event loop alive solely for this timer

        try {
          await this.stop();
          clearTimeout(forceExitTimer);
          process.exit(0);
        } catch (error) {
          this.logger.error({ error }, 'Error during graceful shutdown');
          clearTimeout(forceExitTimer);
          process.exit(1);
        }
      });
    });
  }

  async start(): Promise<void> {
    await this.db.registerVectorTypes();
    this.logger.info('Database client ready');

    // Choose transport based on env or options
    this.transportType = this.options.transport || (process.env.TRANSPORT as 'stdio' | 'http') || 'http';
    if (this.transportType === 'stdio') {
      this.transport = new StdioServerTransport();
      this.logger.info('Using stdio transport');
    } else {
      // HTTP mode: transports are created PER REQUEST in the /mcp handler
      // (SDK >=1.30 stateless transports are single-use). Nothing to build or
      // connect at boot.
      this.transport = null;
      this.logger.info('Using HTTP/SSE transport (per-request stateless transports)');
    }

    // Connect the shared MCP server only for stdio (long-lived transport).
    if (this.transportType === 'stdio' && this.transport) {
      await this.mcpServer.connect(this.transport as any);
    }

    // Set up HTTP routes only for HTTP transport
    this.setupRoutes(this.transportType);

    if (this.transportType === 'http') {
      const port = this.options.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 8080) ?? 8080;
      const host = this.options.host || '0.0.0.0';
      await this.fastify.listen({ port, host });
      this.logger.info(`HTTP server listening on ${host}:${port}`);
    } else {
      this.logger.info('MCP server running on stdio');
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping server...');
    // 1. Stop accepting new requests
    this.isShuttingDown = true;
    // 2. Close HTTP server if running
    await this.fastify.close();
    // 3. Close MCP transport
    if (this.transport) {
      await this.transport.close();
    }
    // 4. Close database pool
    await this.db.close();
    this.logger.info('Server stopped');
  }
}
