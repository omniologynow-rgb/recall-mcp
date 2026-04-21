import { describe, it, expect } from 'vitest';
import { ToolError } from '../../src/errors/tool-error.js';

describe('ToolError', () => {
    it('should create error with code and message', () => {
        const err = new ToolError('test_code', 'test message', false);
        expect(err.code).toBe('test_code');
        expect(err.message).toBe('test message');
        expect(err.retryable).toBe(false);
        expect(err.name).toBe('ToolError');
    });

    it('should generate MCP error shape', () => {
        const err = new ToolError('validation_error', 'Invalid input', false, { field: 'email' });
        const shape = err.toMcpError();
        expect(shape).toEqual({
            error: {
                code: 'validation_error',
                message: 'Invalid input',
                retryable: false,
                meta: { field: 'email' },
            },
        });
    });

    describe('factory methods', () => {
        it('should create unauthorized error', () => {
            const err = ToolError.unauthorized();
            expect(err.code).toBe('unauthorized');
            expect(err.message).toContain('API key');
        });

        it('should create limit_exceeded error with upgrade URL', () => {
            const err = ToolError.limitExceeded();
            expect(err.code).toBe('limit_exceeded');
            expect(err.message).toBe(
                'Free tier allows 100 memories. Upgrade at https://recallmcp.dev/pricing'
            );
            expect(err.retryable).toBe(false);
        });

        it('should create not_found error', () => {
            const err = ToolError.notFound('Memory not found');
            expect(err.code).toBe('not_found');
            expect(err.message).toBe('Memory not found');
        });

        it('should create validation_error with meta', () => {
            const err = ToolError.validationError('Invalid email', { max: 255 });
            expect(err.code).toBe('validation_error');
            expect(err.meta).toEqual({ max: 255 });
        });

        it('should create internal_error', () => {
            const err = ToolError.internalError('Database connection failed');
            expect(err.code).toBe('internal_error');
            expect(err.message).toBe('Database connection failed');
        });
    });
});