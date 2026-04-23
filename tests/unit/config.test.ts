import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadEnv, resetEnvCache, getConfig } from '../../src/config.js';

describe('config', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        // Clear cached validatedEnv
        resetEnvCache();
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('should load valid environment variables', () => {
        process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
        process.env.OPENAI_API_KEY = 'sk-test';
        process.env.APP_BASE_URL = 'http://localhost:8080';
        process.env.PORT = '8080';
        const env = loadEnv();
        expect(env.DATABASE_URL).toBe('postgresql://user:pass@localhost:5432/db');
        expect(env.OPENAI_API_KEY).toBe('sk-test');
        expect(env.PORT).toBe(8080);
        expect(env.LOG_LEVEL).toBe('info');
    });

    it('should default optional variables', () => {
        process.env.DATABASE_URL = 'postgresql://localhost/db';
        const env = loadEnv();
        expect(env.PORT).toBe(8080);
        expect(env.LOG_LEVEL).toBe('info');
        expect(env.RATE_LIMIT_PER_KEY).toBe(100);
    });

    it('should throw if required variable is missing', () => {
        delete process.env.DATABASE_URL;
        expect(() => loadEnv()).toThrow();
    });

    it('should validate DATABASE_URL format', () => {
        process.env.DATABASE_URL = 'invalid';
        expect(() => loadEnv()).toThrow();
    });

    it('should coerce numeric strings', () => {
        process.env.DATABASE_URL = 'postgresql://localhost/db';
        process.env.PORT = '3000';
        process.env.RATE_LIMIT_PER_KEY = '50';
        const env = loadEnv();
        expect(env.PORT).toBe(3000);
        expect(env.RATE_LIMIT_PER_KEY).toBe(50);
    });

    it('should treat NODE_ENV=test as development for isDev', () => {
        process.env.DATABASE_URL = 'postgresql://localhost/db';
        process.env.NODE_ENV = 'test';
        const env = loadEnv();
        expect(env.NODE_ENV).toBe('test');
        const config = getConfig();
        expect(config.isDev).toBe(true);
    });

    it('should treat NODE_ENV=production as not dev', () => {
        process.env.DATABASE_URL = 'postgresql://localhost/db';
        process.env.NODE_ENV = 'production';
        const env = loadEnv();
        expect(env.NODE_ENV).toBe('production');
        const config = getConfig();
        expect(config.isDev).toBe(false);
    });
});