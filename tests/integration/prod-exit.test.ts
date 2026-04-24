import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const entryPoint = resolve(__dirname, '../../src/index.ts');

describe('Production startup guard', () => {
  it('should exit with code 1 and print clear error when NODE_ENV=production and OPENAI_API_KEY is missing', async () => {
    const child = spawn(
      'npx',
      ['tsx', entryPoint],
      {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'production',
          OPENAI_API_KEY: '',     // explicitly empty — triggers MockEmbedder guard
          DATABASE_URL: 'postgresql://localhost:5432/test-fake',
          LOG_LEVEL: 'error',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      }
    );

    // Collect stdout (pino writes to stdout) and stderr (config validation errors)
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    // Wait for process to exit (should be fast — validation + exit)
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
      setTimeout(() => {
        child.kill('SIGTERM');
        resolve(null);
      }, 8000);
    });

    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    const combined = stdout + stderr;

    // Guard must exit non-zero with the exact error message
    expect(exitCode).toBe(1);
    expect(combined).toContain('OPENAI_API_KEY is required in production');
  });
});
