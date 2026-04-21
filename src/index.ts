#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { DatabaseClient } from './db/client.js';
import { AuthService } from './auth/index.js';
import type { Embedder } from './embedder/index.js';
import { OpenAIEmbedder } from './embedder/openai.js';
import { MockEmbedder } from './embedder/mock.js';
import { RememberTool } from './tools/remember.js';
import { RecallTool } from './tools/recall.js';
import { ListMemoriesTool } from './tools/list.js';
import { UpdateMemoryTool } from './tools/update.js';
import { ForgetTool } from './tools/forget.js';
import pino from 'pino';
import { getConfig } from './config.js';
const config = getConfig();

const loggerOptions: pino.LoggerOptions = {
  level: config.logLevel,
};
if (config.isDev) {
  loggerOptions.transport = { target: 'pino-pretty' };
}
const logger = pino(loggerOptions);

async function main() {
  logger.info('Starting RecallMCP server');

  // Database client
  const db = new DatabaseClient(config.databaseUrl);
  await db.registerVectorTypes();
  logger.debug('Database client ready');

  // Embedder
  let embedder: Embedder;
  if (config.openaiApiKey) {
    embedder = new OpenAIEmbedder({ apiKey: config.openaiApiKey });
    logger.info('Using OpenAIEmbedder');
  } else {
    embedder = new MockEmbedder();
    logger.warn('OPENAI_API_KEY not set; using MockEmbedder (not suitable for production)');
  }

  // Auth service
  const auth = new AuthService(db);
  logger.debug('Auth service ready');

  // Tools
  const rememberTool = new RememberTool(db, embedder, auth);
  const recallTool = new RecallTool(db, embedder, auth);
  const listTool = new ListMemoriesTool(db, auth);
  const updateTool = new UpdateMemoryTool(db, embedder, auth);
  const forgetTool = new ForgetTool(db, auth);

  // MCP server
  const server = new Server(
    {
      name: 'recall-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Tool definitions
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
      description: 'Update a memory’s content and/or namespace. Re‑embeds the content.',
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

  server.setRequestHandler('tools/list' as any, async () => ({
    tools,
  }));

  server.setRequestHandler('tools/call' as any, async (request) => {
    const { name, arguments: args } = request.params;
    logger.debug({ tool: name, args }, 'Tool call');

    try {
      switch (name) {
        case 'remember': {
          const memoryId = await rememberTool.remember(
            args.apiKey as string,
            args.content as string,
            (args.namespace as string) || 'default'
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ memoryId }, null, 2),
              },
            ],
          };
        }
        case 'recall': {
          const results = await recallTool.recall(
            args.apiKey as string,
            args.query as string,
            (args.namespace as string) || 'default',
            (args.limit as number) || 10,
            (args.minSimilarity as number) || 0.7
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(results, null, 2),
              },
            ],
          };
        }
        case 'list_memories': {
          const results = await listTool.list(
            args.apiKey as string,
            (args.namespace as string) || 'default',
            (args.limit as number) || 100,
            (args.offset as number) || 0
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(results, null, 2),
              },
            ],
          };
        }
        case 'update_memory': {
          const success = await updateTool.update(
            args.apiKey as string,
            args.memoryId as string,
            args.content as string,
            (args.namespace as string) || 'default'
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success }, null, 2),
              },
            ],
          };
        }
        case 'forget': {
          const success = await forgetTool.forget(
            args.apiKey as string,
            args.memoryId as string
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success }, null, 2),
              },
            ],
          };
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error: any) {
      logger.error({ error, tool: name }, 'Tool error');
      // If it's a ToolError, convert to MCP error shape
      if (error.code && error.message) {
        throw {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          meta: error.meta,
        };
      }
      // Generic internal error
      throw {
        code: 'internal_error',
        message: error.message || 'Internal server error',
        retryable: false,
      };
    }
  });

  // Transport (stdio for MCP)
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('RecallMCP server running on stdio');
}

main().catch((error) => {
  logger.fatal(error, 'Failed to start server');
  process.exit(1);
});