import { describe, it, expect } from 'vitest';
import {
  RememberInputSchema,
  MetadataSchema,
  RecallInputSchema,
  ListMemoriesInputSchema,
  UpdateMemoryInputSchema,
  ForgetInputSchema,
  RememberOutputSchema,
  RecallOutputSchema,
  ListMemoriesOutputSchema,
  UpdateMemoryOutputSchema,
  ForgetOutputSchema,
  validateArgs,
  validateOutput,
} from '../../src/schemas.js';

// ─── RememberInputSchema ─────────────────────────────────────────────────────

describe('RememberInputSchema', () => {
  it('should accept valid minimal input', () => {
    const result = RememberInputSchema.safeParse({ content: 'Hello world' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content).toBe('Hello world');
      expect(result.data.namespace).toBe('default'); // default applied
    }
  });

  it('should accept content with namespace and metadata', () => {
    const result = RememberInputSchema.safeParse({
      content: 'Test memory',
      namespace: 'work',
      metadata: { key: 'value', tags: ['important'] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.namespace).toBe('work');
      expect(result.data.metadata).toEqual({ key: 'value', tags: ['important'] });
    }
  });

  it('should reject empty content', () => {
    const result = RememberInputSchema.safeParse({ content: '' });
    expect(result.success).toBe(false);
  });

  it('should reject content exceeding 50000 characters', () => {
    const result = RememberInputSchema.safeParse({ content: 'x'.repeat(50001) });
    expect(result.success).toBe(false);
  });

  it('should reject missing content', () => {
    const result = RememberInputSchema.safeParse({ namespace: 'test' });
    expect(result.success).toBe(false);
  });
});

// ─── MetadataSchema ───────────────────────────────────────────────────────────

describe('MetadataSchema', () => {
  it('should accept valid metadata', () => {
    const result = MetadataSchema.safeParse({ key: 'value', num: 42 });
    expect(result.success).toBe(true);
  });

  it('should accept empty metadata', () => {
    const result = MetadataSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept metadata up to 4096 bytes', () => {
    const largeValue = 'x'.repeat(4000); // ~4KB value, well within 4096
    const result = MetadataSchema.safeParse({ key: largeValue });
    expect(result.success).toBe(true);
  });

  it('should reject metadata exceeding 4096 bytes serialized', () => {
    const hugeValue = 'x'.repeat(5000); // produces >4096 bytes serialized
    const result = MetadataSchema.safeParse({ key: hugeValue });
    expect(result.success).toBe(false);
    if (!result.success) {
      const allMessages = result.error.issues.map(i => i.message).join(' ');
      expect(allMessages).toContain('4096 bytes');
    }
  });
});

// ─── RecallInputSchema ────────────────────────────────────────────────────────

describe('RecallInputSchema', () => {
  it('should accept valid minimal input', () => {
    const result = RecallInputSchema.safeParse({ query: 'find something' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
      expect(result.data.threshold).toBe(0.7);
    }
  });

  it('should accept all optional fields', () => {
    const result = RecallInputSchema.safeParse({
      query: 'search query',
      namespace: 'docs',
      limit: 5,
      threshold: 0.5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.namespace).toBe('docs');
      expect(result.data.limit).toBe(5);
      expect(result.data.threshold).toBe(0.5);
    }
  });

  it('should reject empty query', () => {
    const result = RecallInputSchema.safeParse({ query: '' });
    expect(result.success).toBe(false);
  });

  it('should reject query exceeding 10000 characters', () => {
    const result = RecallInputSchema.safeParse({ query: 'x'.repeat(10001) });
    expect(result.success).toBe(false);
  });

  it('should reject limit above 50', () => {
    const result = RecallInputSchema.safeParse({ query: 'test', limit: 51 });
    expect(result.success).toBe(false);
  });

  it('should reject limit below 1', () => {
    const result = RecallInputSchema.safeParse({ query: 'test', limit: 0 });
    expect(result.success).toBe(false);
  });

  it('should reject threshold above 1.0', () => {
    const result = RecallInputSchema.safeParse({ query: 'test', threshold: 1.1 });
    expect(result.success).toBe(false);
  });

  it('should reject threshold below 0', () => {
    const result = RecallInputSchema.safeParse({ query: 'test', threshold: -0.1 });
    expect(result.success).toBe(false);
  });
});

// ─── ListMemoriesInputSchema ──────────────────────────────────────────────────

describe('ListMemoriesInputSchema', () => {
  it('should accept empty input with defaults', () => {
    const result = ListMemoriesInputSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
      expect(result.data.offset).toBe(0);
      expect(result.data.order).toBe('created_at');
    }
  });

  it('should accept all optional fields', () => {
    const result = ListMemoriesInputSchema.safeParse({
      namespace: 'work',
      limit: 50,
      offset: 10,
      order: 'updated_at',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.namespace).toBe('work');
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(10);
      expect(result.data.order).toBe('updated_at');
    }
  });

  it('should reject limit above 100', () => {
    const result = ListMemoriesInputSchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it('should reject invalid order value', () => {
    const result = ListMemoriesInputSchema.safeParse({ order: 'invalid_col' });
    expect(result.success).toBe(false);
  });
});

// ─── UpdateMemoryInputSchema ──────────────────────────────────────────────────

describe('UpdateMemoryInputSchema', () => {
  it('should accept valid id and content', () => {
    const result = UpdateMemoryInputSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      content: 'Updated content',
    });
    expect(result.success).toBe(true);
  });

  it('should accept valid id and metadata', () => {
    const result = UpdateMemoryInputSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      metadata: { key: 'value' },
    });
    expect(result.success).toBe(true);
  });

  it('should reject non-uuid id', () => {
    const result = UpdateMemoryInputSchema.safeParse({
      id: 'not-a-uuid',
      content: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('should reject when neither content nor metadata is provided', () => {
    const result = UpdateMemoryInputSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(false);
  });
});

// ─── ForgetInputSchema (discriminated union) ──────────────────────────────────

describe('ForgetInputSchema', () => {
  describe('mode: by_id', () => {
    it('should accept valid by_id input', () => {
      const result = ForgetInputSchema.safeParse({
        mode: 'by_id',
        id: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mode).toBe('by_id');
        // TypeScript discriminated union narrowing
        if (result.data.mode === 'by_id') {
          expect(result.data.id).toBe('550e8400-e29b-41d4-a716-446655440000');
        }
      }
    });

    it('should reject by_id with non-uuid id', () => {
      const result = ForgetInputSchema.safeParse({
        mode: 'by_id',
        id: 'not-a-uuid',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('mode: by_query', () => {
    it('should accept valid by_query input', () => {
      const result = ForgetInputSchema.safeParse({
        mode: 'by_query',
        confirm: true,
        max_delete: 50,
        namespace: 'test',
      });
      expect(result.success).toBe(true);
      if (result.success && result.data.mode === 'by_query') {
        expect(result.data.max_delete).toBe(50);
        expect(result.data.confirm).toBe(true);
      }
    });

    it('should reject by_query without confirm: true', () => {
      const result = ForgetInputSchema.safeParse({
        mode: 'by_query',
        max_delete: 10,
      });
      expect(result.success).toBe(false);
    });

    it('should reject by_query with max_delete above 100', () => {
      const result = ForgetInputSchema.safeParse({
        mode: 'by_query',
        confirm: true,
        max_delete: 101,
      });
      expect(result.success).toBe(false);
    });

    it('should reject by_query with max_delete below 1', () => {
      const result = ForgetInputSchema.safeParse({
        mode: 'by_query',
        confirm: true,
        max_delete: 0,
      });
      expect(result.success).toBe(false);
    });

    it('should reject by_query with neither namespace nor query (mass-delete guard)', () => {
      const result = ForgetInputSchema.safeParse({
        mode: 'by_query',
        confirm: true,
        max_delete: 50,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map(i => i.message);
        expect(messages).toContain('by_query mode requires at least one of namespace or query');
      }
    });

    it('should accept by_query with query only (no namespace)', () => {
      const result = ForgetInputSchema.safeParse({
        mode: 'by_query',
        query: 'delete-me',
        confirm: true,
        max_delete: 50,
      });
      expect(result.success).toBe(true);
    });

    it('should accept by_query with namespace only (no query)', () => {
      const result = ForgetInputSchema.safeParse({
        mode: 'by_query',
        namespace: 'temp',
        confirm: true,
        max_delete: 50,
      });
      expect(result.success).toBe(true);
    });
  });

  it('should reject unknown mode', () => {
    const result = ForgetInputSchema.safeParse({
      mode: 'invalid_mode',
    });
    expect(result.success).toBe(false);
  });
});

// ─── Output Schema ────────────────────────────────────────────────────────────

describe('RememberOutputSchema', () => {
  it('should accept valid output', () => {
    const result = RememberOutputSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });

  it('should reject non-uuid id', () => {
    const result = RememberOutputSchema.safeParse({ id: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });
});

describe('RecallOutputSchema', () => {
  it('should accept an array of memory results', () => {
    const result = RecallOutputSchema.safeParse([
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        content: 'test memory',
        similarity: 0.95,
        metadata: {},
        namespace: 'default',
        created_at: '2024-01-01T00:00:00Z',
      },
    ]);
    expect(result.success).toBe(true);
  });

  it('should reject similarity outside 0-1', () => {
    const result = RecallOutputSchema.safeParse([
      {
        id: '1',
        content: 'test',
        similarity: 1.5,
        metadata: {},
        namespace: 'default',
        created_at: '2024-01-01T00:00:00Z',
      },
    ]);
    expect(result.success).toBe(false);
  });
});

describe('ListMemoriesOutputSchema', () => {
  it('should accept valid output', () => {
    const result = ListMemoriesOutputSchema.safeParse([
      {
        id: '1',
        content: 'test',
        namespace: 'default',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
    ]);
    expect(result.success).toBe(true);
  });
});

describe('UpdateMemoryOutputSchema', () => {
  it('should accept boolean success', () => {
    expect(UpdateMemoryOutputSchema.safeParse({ success: true }).success).toBe(true);
    expect(UpdateMemoryOutputSchema.safeParse({ success: false }).success).toBe(true);
  });
});

describe('ForgetOutputSchema', () => {
  it('should accept boolean success', () => {
    expect(ForgetOutputSchema.safeParse({ success: true }).success).toBe(true);
    expect(ForgetOutputSchema.safeParse({ success: false }).success).toBe(true);
  });
});

// ─── validateArgs / validateOutput helpers ─────────────────────────────────────

describe('validateArgs', () => {
  it('should return parsed data on success', () => {
    const data = validateArgs(RememberInputSchema, { content: 'test' });
    expect(data.content).toBe('test');
    expect(data.namespace).toBe('default');
  });

  it('should throw ToolError on validation failure', () => {
    expect(() => validateArgs(RememberInputSchema, {})).toThrow();
    expect(() => validateArgs(RememberInputSchema, { content: '' })).toThrow();
  });

  it('should throw ToolError with validation_error code', () => {
    try {
      validateArgs(RememberInputSchema, {});
    } catch (err: any) {
      expect(err.code).toBe('validation_error');
    }
  });
});

describe('validateOutput', () => {
  it('should return parsed data on success', () => {
    const data = validateOutput(RememberOutputSchema, { id: '550e8400-e29b-41d4-a716-446655440000' });
    expect(data.id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('should throw ToolError on unexpected shape', () => {
    expect(() => validateOutput(RememberOutputSchema, { id: 123 })).toThrow();
  });
});
