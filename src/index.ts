#!/usr/bin/env node

import { getConfig } from './config.js';
import { OpenAIEmbedder } from './embedder/openai.js';
import { MockEmbedder } from './embedder/mock.js';
import { RecallServer } from './server.js';
import pino from 'pino';

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

  // Embedder
  let embedder;
  if (config.openaiApiKey) {
    embedder = new OpenAIEmbedder({ apiKey: config.openaiApiKey });
    logger.info('Using OpenAIEmbedder');
  } else {
    if (config.isDev) {
      embedder = new MockEmbedder();
      logger.warn('OPENAI_API_KEY not set; using MockEmbedder (not suitable for production)');
    } else {
      logger.error('OPENAI_API_KEY is required in production. Please set the environment variable.');
      process.exit(1);
    }
  }

  // Determine transport from environment
  const transport = process.env.TRANSPORT as 'stdio' | 'http' | undefined;
  const enableDnsRebindingProtection = !config.isDev;
  const allowedHosts = config.isDev ? ['localhost'] : undefined;
  const allowedOrigins = config.isDev ? ['http://localhost:*'] : undefined;

  const options: any = {
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 8080,
  };
  if (transport !== undefined) options.transport = transport;
  if (enableDnsRebindingProtection !== undefined) options.enableDnsRebindingProtection = enableDnsRebindingProtection;
  if (allowedHosts !== undefined) options.allowedHosts = allowedHosts;
  if (allowedOrigins !== undefined) options.allowedOrigins = allowedOrigins;

  const server = new RecallServer(embedder, options);

  await server.start();
}

main().catch((error) => {
  logger.fatal(error, 'Failed to start server');
  process.exit(1);
});