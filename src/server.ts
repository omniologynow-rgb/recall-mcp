import fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { createHmac, timingSafeEqual } from 'crypto';
import { DatabaseClient } from './db/client.js';
import { AuthService } from './auth/index.js';
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
import pino from 'pino';

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

  constructor(
    private embedder: Embedder,
    private options: ServerOptions = {}
  ) {
    const config = getConfig();
    const loggerOptions: pino.LoggerOptions = {
      level: config.logLevel,
    };
    if (config.isDev) {
      loggerOptions.transport = { target: 'pino-pretty' };
    }
    this.logger = pino(loggerOptions);
    this.version = this.loadVersion();
    this.fastify = fastify({
      logger: false,
      disableRequestLogging: true,
    });
    this.db = new DatabaseClient(config.databaseUrl);
    this.auth = new AuthService(this.db);
    this.health = new HealthService(this.db, embedder, this.version);
    this.mcpServer = this.createMcpServer();
    // Routes will be set up in start() based on transport type
    this.setupGracefulShutdown();
  }

  private loadVersion(): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = require('../../package.json');
      return pkg.version;
    } catch {
      return '0.0.0';
    }
  }

  private createMcpServer(): McpServer {
    const server = new McpServer(
      { name: 'RecallMCP', version: this.version },
      { capabilities: { tools: {} } }
    );

    // Instantiate tools
    const rememberTool = new RememberTool(this.db, this.embedder, this.auth);
    const recallTool = new RecallTool(this.db, this.embedder, this.auth);
    const listTool = new ListMemoriesTool(this.db, this.auth);
    const updateTool = new UpdateMemoryTool(this.db, this.embedder, this.auth);
    const forgetTool = new ForgetTool(this.db, this.auth);

    // Tool definitions for MCP
    const tools: Tool[] = [
      {
        name: 'remember',
        description: 'Store a memory with semantic embedding. Returns the memory ID.',
        inputSchema: {
          type: 'object',
          properties: {
            apiKey: { type: 'string', description: 'RecallMCP API key' },
            content: { type: 'string', description: 'Content to remember' },
            namespace: { type: 'string', description: 'Namespace (default: "default")', default: 'default' },
          },
          required: ['apiKey', 'content'],
        },
      },
      {
        name: 'recall',
        description: 'Retrieve memories similar to the query, ranked by semantic similarity.',
        inputSchema: {
          type: 'object',
          properties: {
            apiKey: { type: 'string', description: 'RecallMCP API key' },
            query: { type: 'string', description: 'Search query' },
            namespace: { type: 'string', description: 'Filter by namespace (default: "default")', default: 'default' },
            limit: { type: 'number', description: 'Maximum number of results (default: 10)', default: 10 },
            minSimilarity: { type: 'number', description: 'Minimum similarity score (0.0-1.0, default: 0.7)', default: 0.7 },
          },
          required: ['apiKey', 'query'],
        },
      },
      {
        name: 'list_memories',
        description: 'List memories for a user, optionally filtered by namespace.',
        inputSchema: {
          type: 'object',
          properties: {
            apiKey: { type: 'string', description: 'RecallMCP API key' },
            namespace: { type: 'string', description: 'Namespace (default: "default")', default: 'default' },
            limit: { type: 'number', description: 'Maximum number of results (default: 100)', default: 100 },
            offset: { type: 'number', description: 'Pagination offset (default: 0)', default: 0 },
          },
          required: ['apiKey'],
        },
      },
      {
        name: 'update_memory',
        description: 'Update a memory\'s content and/or namespace. Re-embeds the content.',
        inputSchema: {
          type: 'object',
          properties: {
            apiKey: { type: 'string', description: 'RecallMCP API key' },
            memoryId: { type: 'string', description: 'ID of the memory to update' },
            content: { type: 'string', description: 'New content' },
            namespace: { type: 'string', description: 'New namespace (default: "default")', default: 'default' },
          },
          required: ['apiKey', 'memoryId', 'content'],
        },
      },
      {
        name: 'forget',
        description: 'Permanently delete a memory.',
        inputSchema: {
          type: 'object',
          properties: {
            apiKey: { type: 'string', description: 'RecallMCP API key' },
            memoryId: { type: 'string', description: 'ID of the memory to delete' },
          },
          required: ['apiKey', 'memoryId'],
        },
      },
    ];

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools,
    }));

    // Register tool handlers (these will be replaced with proper Zod validation in R3)
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      if (!args) throw new Error('Missing arguments');
      switch (name) {
        case 'remember': {
          const apiKey = args.apiKey as string;
          const content = args.content as string;
          const namespace = (args.namespace as string) || 'default';
          const id = await rememberTool.remember(apiKey, content, namespace);
          return { content: [{ type: 'text', text: JSON.stringify({ id }) }] };
        }
        case 'recall': {
          const apiKey = args.apiKey as string;
          const query = args.query as string;
          const namespace = (args.namespace as string) || 'default';
          const limit = (args.limit as number) || 10;
          const minSimilarity = (args.minSimilarity as number) || 0.7;
          const results = await recallTool.recall(apiKey, query, namespace, limit, minSimilarity);
          return { content: [{ type: 'text', text: JSON.stringify(results) }] };
        }
        case 'list_memories': {
          const apiKey = args.apiKey as string;
          const namespace = (args.namespace as string) || 'default';
          const limit = (args.limit as number) || 100;
          const offset = (args.offset as number) || 0;
          const results = await listTool.list(apiKey, namespace, limit, offset);
          return { content: [{ type: 'text', text: JSON.stringify(results) }] };
        }
        case 'update_memory': {
          const apiKey = args.apiKey as string;
          const memoryId = args.memoryId as string;
          const content = args.content as string;
          const namespace = (args.namespace as string) || 'default';
          const success = await updateTool.update(apiKey, memoryId, content, namespace);
          return { content: [{ type: 'text', text: JSON.stringify({ success }) }] };
        }
        case 'forget': {
          const apiKey = args.apiKey as string;
          const memoryId = args.memoryId as string;
          const success = await forgetTool.forget(apiKey, memoryId);
          return { content: [{ type: 'text', text: JSON.stringify({ success }) }] };
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
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

    // Auth preHandler for /mcp route
    const authPreHandler = async (request: any, reply: any, done: (err?: Error) => void) => {
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        reply.code(401).send({ error: 'Missing or invalid Authorization header' });
        return done();
      }
      const apiKey = authHeader.slice('Bearer '.length);
      try {
        const { userId } = await this.auth.authenticate(apiKey);
        (request.raw as any).auth = { userId };
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

      // Handle MCP request via transport
      if (!this.transport || !(this.transport instanceof StreamableHTTPServerTransport)) {
        reply.code(500).send({ error: 'Transport not ready' });
        return;
      }
      // Hijack reply so Fastify doesn't try to double-write the response;
      // the MCP SDK's StreamableHTTP transport already writes to reply.raw
      reply.hijack();
      await this.transport.handleRequest(request.raw, reply.raw, request.body);
    });

    // Root redirect to health
    this.fastify.get('/', async (_request, reply) => {
      reply.redirect('/health');
    });
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
      const transportOptions: StreamableHTTPServerTransportOptions = {
        // No sessionIdGenerator — stateless mode (each request handled independently)
        enableJsonResponse: true,
        enableDnsRebindingProtection: this.options.enableDnsRebindingProtection ?? (getConfig().isDev ? false : true),
        allowedHosts: this.options.allowedHosts,
        allowedOrigins: this.options.allowedOrigins,
      } as any; // Cast to any to bypass exactOptionalPropertyTypes
      this.transport = new StreamableHTTPServerTransport(transportOptions);
      this.logger.info('Using HTTP/SSE transport');
    }

    // Connect MCP server to transport
    await this.mcpServer.connect(this.transport as any);

    // Set up HTTP routes only for HTTP transport
    this.setupRoutes(this.transportType);

    if (this.transportType === 'http') {
      const port = this.options.port || (process.env.PORT ? parseInt(process.env.PORT, 10) : 8080) || 8080;
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
