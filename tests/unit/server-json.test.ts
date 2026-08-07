import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

interface ServerJson {
  $schema: string;
  name: string;
  version: string;
  packages?: Array<{
    registryType: string;
    identifier: string;
    version: string;
  }>;
}

interface PkgJson {
  name: string;
  version: string;
}

describe('server.json', () => {
  let serverJson: ServerJson;
  let pkg: PkgJson;

  beforeAll(() => {
    serverJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'server.json'), 'utf-8'));
    pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'));
  });

  it('conforms to the MCP Registry schema via validation script', async () => {
    // Run the validation script as a shell command
    const { execSync } = await import('node:child_process');
    const result = execSync('node scripts/validate-server-json.js', {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result).toContain('All validations passed');
  });

  it('has version equal to package.json version', () => {
    expect(serverJson.version).toBe(pkg.version);
  });

  it('has npm package identifier equal to package.json name', () => {
    const npmPkg = serverJson.packages?.find((p) => p.registryType === 'npm');
    expect(npmPkg).toBeDefined();
    expect(npmPkg!.identifier).toBe(pkg.name);
  });
});
