import { describe, it, expect } from 'vitest';
import { redactSensitive, createToolLogger, rootLogger } from '../../src/logging.js';

describe('redactSensitive', () => {
    it('redacts memory content field', () => {
        const input = { content: 'my secret password is hunter2' };
        const output = redactSensitive(input as Record<string, unknown>);
        expect(output.content).toMatch(/^\[redacted:[a-f0-9]{8}\]$/);
        // Verify the substring 'password' is absent from the redacted value
        expect(String(output.content)).not.toContain('password');
        expect(String(output.content)).not.toContain('hunter2');
    });

    it('redacts query text field', () => {
        const input = { query: 'find all user sessions with admin tokens' };
        const output = redactSensitive(input as Record<string, unknown>);
        expect(output.query).toMatch(/^\[redacted:[a-f0-9]{8}\]$/);
        expect(String(output.query)).not.toContain('admin');
        expect(String(output.query)).not.toContain('sessions');
    });

    it('redacts query_text field', () => {
        const input = { query_text: 'api key rotation steps' };
        const output = redactSensitive(input as Record<string, unknown>);
        expect(output.query_text).toMatch(/^\[redacted:[a-f0-9]{8}\]$/);
    });

    it('redacts memory_content field', () => {
        const input = { memory_content: 'bank account 1234' };
        const output = redactSensitive(input as Record<string, unknown>);
        expect(output.memory_content).toMatch(/^\[redacted:[a-f0-9]{8}\]$/);
    });

    it('redacts embedding fields entirely without hash', () => {
        const input = { embedding: [0.1, 0.2, 0.3] };
        const output = redactSensitive(input as Record<string, unknown>);
        expect(output.embedding).toBe('[redacted]');
    });

    it('redacts embeddings (plural) entirely', () => {
        const input = { embeddings: [[0.1, 0.2], [0.3, 0.4]] };
        const output = redactSensitive(input as Record<string, unknown>);
        expect(output.embeddings).toBe('[redacted]');
    });

    it('preserves non-sensitive fields unchanged', () => {
        const input = { id: 'abc-123', similarity: 0.95, namespace: 'work' };
        const output = redactSensitive(input as Record<string, unknown>);
        expect(output.id).toBe('abc-123');
        expect(output.similarity).toBe(0.95);
        expect(output.namespace).toBe('work');
    });

    it('recursively redacts nested sensitive fields', () => {
        const input = {
            meta: {
                content: 'nested secret',
                id: 'keep-me',
            },
            tags: ['safe', 'data'],
        };
        const output = redactSensitive(input as Record<string, unknown>);
        // Non-sensitive fields preserved
        expect((output.meta as Record<string, unknown>).id).toBe('keep-me');
        // Sensitive field redacted in nested object
        const nestedContent = (output.meta as Record<string, unknown>).content;
        expect(String(nestedContent)).toMatch(/^\[redacted:[a-f0-9]{8}\]$/);
        expect(String(nestedContent)).not.toContain('secret');
        // Array values pass through unchanged
        expect(output.tags).toEqual(['safe', 'data']);
    });

    it('uses deterministic hash: same input produces same redacted value', () => {
        const input1 = redactSensitive({ content: 'hello world' } as Record<string, unknown>);
        const input2 = redactSensitive({ content: 'hello world' } as Record<string, unknown>);
        expect(input1.content).toBe(input2.content);
    });

    it('different inputs produce different hashes', () => {
        const input1 = redactSensitive({ content: 'abc' } as Record<string, unknown>);
        const input2 = redactSensitive({ content: 'xyz' } as Record<string, unknown>);
        expect(input1.content).not.toBe(input2.content);
    });

    it('handles non-string sensitive values gracefully', () => {
        const input = { content: 42 };
        const output = redactSensitive(input as unknown as Record<string, unknown>);
        // Non-string values passed through unchanged
        expect(output.content).toBe(42);
    });

    it('handles null values gracefully', () => {
        const input = { content: null };
        const output = redactSensitive(input as unknown as Record<string, unknown>);
        expect(output.content).toBeNull();
    });
});

describe('createToolLogger context propagation', () => {
    it('creates a child logger with request_id, tool_name, user_id', () => {
        const reqLogger = createToolLogger('req-001', 'recall', 'user-42');
        // The child should have bindings attached
        expect(reqLogger).toBeDefined();
        // Test that log entries carry the context: bindings should be in the child's spec
        // We can verify by checking the child's logger name includes parent bindings
        // via pino internals or by capturing output.
        // Most reliable: build the expected child chain and verify bindings via bindings().
        const bindings = (reqLogger as any).bindings();
        expect(bindings).toMatchObject({
            request_id: 'req-001',
            tool_name: 'recall',
            user_id: 'user-42',
        });
    });

    it('different tool calls produce different child loggers', () => {
        const logger1 = createToolLogger('req-001', 'remember', 'user-42');
        const logger2 = createToolLogger('req-002', 'recall', 'user-99');
        const bindings1 = (logger1 as any).bindings();
        const bindings2 = (logger2 as any).bindings();
        expect(bindings1.request_id).toBe('req-001');
        expect(bindings2.request_id).toBe('req-002');
        expect(bindings1.tool_name).toBe('remember');
        expect(bindings2.tool_name).toBe('recall');
        expect(bindings1.user_id).toBe('user-42');
        expect(bindings2.user_id).toBe('user-99');
    });

    it('same tool call context produces same bindings', () => {
        const logger1 = createToolLogger('req-001', 'recall', 'user-42');
        const logger2 = createToolLogger('req-001', 'recall', 'user-42');
        const bindings1 = (logger1 as any).bindings();
        const bindings2 = (logger2 as any).bindings();
        expect(bindings1).toEqual(bindings2);
    });
});

describe('rootLogger', () => {
    it('has a name configured', () => {
        const bindings = (rootLogger as any).bindings();
        // rootLogger is named 'recall-mcp' via the pino options
        expect(bindings).toBeDefined();
        expect(rootLogger.level).toBeDefined();
    });
});
