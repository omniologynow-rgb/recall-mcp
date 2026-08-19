/**
 * date-serialization.test.ts — 2026-08-18 P0: "Output shape validation
 * failed: expected string, received Date". SDK 1.30 enforces output schemas;
 * pg returns timestamptz columns as Date objects. Locks the boundary
 * serializer + every output schema against realistic pg-shaped rows —
 * a unit-level read-after-write (the full DB round-trip lives in the
 * testcontainers suites, which require Docker).
 */
import { describe, expect, it } from 'vitest';
import {
    serializeDatesDeep,
    validateOutput,
    RecallOutputSchema,
    ListMemoriesOutputSchema,
    RememberOutputSchema,
    UpdateMemoryOutputSchema,
    ForgetOutputSchema,
} from '../src/schemas.js';

const NOW = new Date('2026-08-18T22:30:00.000Z');

describe('serializeDatesDeep', () => {
    it('converts Dates at any depth, leaves everything else alone', () => {
        const out = serializeDatesDeep({
            a: NOW,
            b: [{ c: NOW, d: 5 }],
            e: 'x',
            f: null,
            g: { nested: { h: NOW } },
        }) as Record<string, unknown>;
        expect(out['a']).toBe('2026-08-18T22:30:00.000Z');
        expect((out['b'] as Array<Record<string, unknown>>)[0]!['c']).toBe('2026-08-18T22:30:00.000Z');
        expect((out['b'] as Array<Record<string, unknown>>)[0]!['d']).toBe(5);
        expect(out['e']).toBe('x');
        expect(out['f']).toBeNull();
        expect((out['g'] as { nested: { h: unknown } }).nested.h).toBe('2026-08-18T22:30:00.000Z');
    });
});

describe('read-after-write shapes — every output schema accepts pg-shaped rows', () => {
    it('THE LIVE FAILURE: recall rows with Date created_at now validate', () => {
        const rows = [{
            id: '0c9d5c2a-1111-2222-3333-444455556666',
            content: 'persona text',
            similarity: 0.91,
            metadata: { kind: 'persona' },
            namespace: 'creature:x:persona',
            created_at: NOW, // ← what pg actually returns
        }];
        const out = validateOutput(RecallOutputSchema, rows);
        expect(out[0]!.created_at).toBe('2026-08-18T22:30:00.000Z');
    });

    it('list_memories rows with Date created_at/updated_at validate', () => {
        const out = validateOutput(ListMemoriesOutputSchema, [{
            id: 'a', content: 'c', namespace: 'n', created_at: NOW, updated_at: NOW,
        }]);
        expect(out[0]!.updated_at).toBe('2026-08-18T22:30:00.000Z');
    });

    it('similarity float error outside [0,1] is the callers job to clamp — schema still guards', () => {
        // The tools clamp; the schema stays strict so a regression is caught.
        expect(() => validateOutput(RecallOutputSchema, [{
            id: 'a', content: 'c', similarity: 1.0000001, metadata: {}, namespace: 'n', created_at: NOW,
        }])).toThrow();
    });

    it('remember/update/forget shapes unchanged and green', () => {
        expect(validateOutput(RememberOutputSchema, { id: '0c9d5c2a-1111-4222-8333-444455556666' }).id).toContain('0c9d');
        expect(validateOutput(UpdateMemoryOutputSchema, { success: true }).success).toBe(true);
        expect(validateOutput(ForgetOutputSchema, { success: true })).toEqual({ success: true });
        const preview = validateOutput(ForgetOutputSchema, {
            preview: true,
            matches: [{ id: 'a', content: 'c', similarity: 0.8 }],
            total_matches: 1,
            confirmation_token: 't',
            expires_at: NOW, // Date here too — serialized at the boundary
        });
        expect((preview as { expires_at: string }).expires_at).toBe('2026-08-18T22:30:00.000Z');
    });
});
