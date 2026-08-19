import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        // Testcontainers: pulling + starting a Postgres container routinely
        // exceeds vitest's 10s default hook timeout in CI, and several suites
        // run many sequential container-backed requests per test.
        hookTimeout: 180_000,
        testTimeout: 60_000,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: ['node_modules', 'dist', 'tests'],
        },
    },
});