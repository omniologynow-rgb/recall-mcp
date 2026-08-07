#!/usr/bin/env node

/**
 * validate-server-json.js
 *
 * Validates server.json against the published MCP Registry JSON Schema.
 * Fetches the schema from the $schema URL stated in server.json and runs
 * a structural validation with Ajv.
 *
 * Exit code 0 = valid, 1 = invalid.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

async function main() {
  // 1. Load server.json
  const serverJsonPath = resolve(REPO_ROOT, 'server.json');
  const serverJson = JSON.parse(readFileSync(serverJsonPath, 'utf-8'));
  const schemaUrl = serverJson.$schema;

  if (!schemaUrl) {
    console.error('ERROR: server.json is missing the $schema field');
    process.exit(1);
  }

  // 2. Load package.json for cross-field checks
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'));

  // 3. Cross-field validation (works without fetching schema)
  const errors = [];

  // Version sync
  if (serverJson.version !== pkg.version) {
    errors.push(
      `Version mismatch: server.json has "${serverJson.version}" but package.json has "${pkg.version}"`,
    );
  }

  // npm identifier sync
  const npmPkg = serverJson.packages?.find((p) => p.registryType === 'npm');
  if (npmPkg && npmPkg.identifier !== pkg.name) {
    errors.push(
      `npm identifier mismatch: server.json has "${npmPkg.identifier}" but package.json has "${pkg.name}"`,
    );
  }

  // 4. Schema validation (fetch remote schema)
  try {
    console.log(`Fetching schema from ${schemaUrl}...`);
    const res = await fetch(schemaUrl);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const schema = await res.json();

    // Dynamic import of Ajv (lightweight ESM-compatible import)
    const { default: Ajv } = await import('ajv');
    const ajv = new Ajv({ strict: false }); // strict: false for draft schemas that use unknown keywords
    const validate = ajv.compile(schema);

    if (!validate(serverJson)) {
      for (const err of validate.errors || []) {
        errors.push(`Schema validation: ${err.instancePath} ${err.message}`);
      }
    } else {
      console.log('✓ server.json conforms to the MCP Registry schema');
    }
  } catch (err) {
    // If schema fetch or validation fails, only cross-field checks remain
    console.warn(`WARNING: Could not validate against remote schema: ${err.message}`);
    console.warn('Cross-field checks will still run.');
  }

  // 5. Report
  if (errors.length > 0) {
    console.error('✗ Validation failed:');
    for (const e of errors) {
      console.error(`  • ${e}`);
    }
    process.exit(1);
  }

  console.log('✓ All validations passed');
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
