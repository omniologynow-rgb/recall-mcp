# Future Work & Known Gaps

## Transport: Stateless + `enableJsonResponse: true`

**Rationale (R2.2):** The MCP Streamable HTTP transport was configured without a
`sessionIdGenerator` (stateless mode) and with `enableJsonResponse: true`.

- **Stateless** means each HTTP request is handled independently with no session
affinity. This avoids requiring an `initialize` handshake before `tools/call`,
simplifying the client contract. The downside is no SSE streaming for
gradual tool responses — each response is a single HTTP 200 JSON body.
- **`enableJsonResponse: true`** returns JSON-RPC response bodies directly
instead of SSE `text/event-stream`. This is simpler for most MCP clients
and avoids needing SSE parsing logic on the client side.

**⚠️ Verify before production deploy:** Confirm that MCPize's hosting layer
accepts stateless-mode JSON responses. Some MCP hosting platforms expect
sessionful SSE streaming. If MCPize requires sessionful mode, re-enable
`sessionIdGenerator` and ensure clients send the `initialize` handshake
before their first tool call request.

## MCPize Webhook Integration

The current webhook implementation (`POST /webhooks/mcpize/subscription`) uses a placeholder HMAC‑SHA256 verification with the following assumptions:

- **Signature header:** `X‑MCPize‑Signature` (custom header; actual header name to be confirmed with MCPize's published spec)
- **Payload shape:** Expects `{ userId: string, tier: string }` JSON body. The actual shape (field names, possible event types, timestamp, etc.) must be verified against MCPize's official webhook documentation before first production deployment.
- **Secret:** Loaded from `MCPIZE_BILLING_WEBHOOK_SECRET` environment variable.

**Action required before production deployment:**  
Replace the placeholder verification with the exact HMAC algorithm, header name, and payload validation specified by MCPize.

## Other Gaps

- **Rate limiting:** Not yet implemented (planned for R7).
- **Forget by‑query:** The `forget` tool currently only deletes by memory ID; a `forget_by_query` mode with `confirm: true` and `max_delete` bound is planned for R5.
- **Content normalization:** Deduplication currently uses exact SHA‑256 of raw content; planned normalization (trim + collapse whitespace + NFC) will be added in R4.
- **Metadata parameter:** The `remember` tool does not yet accept a `metadata` parameter (planned for R4).
- **Prompt‑injection wrapping:** Recall output wraps memories in `<memory>` tags for prompt-injection defense (completed in R3).
## Error shape layering (R3 ADR)

RecallMCP uses a layered error strategy:

1. **HTTP layer (Fastify preHandler, pre-transport):**
   - Auth failures (missing/invalid API key) return `HTTP 401` with
     `{ error: "Unauthorized" }` or `{ error: "Missing or invalid Authorization header" }`.
   - These errors fire before the MCP transport ever sees the request.
   - This layer is thin — only auth checks live here.

2. **JSON‑RPC layer (MCP SDK, inside transport):**
   - Auth context (`authContext` AsyncLocalStorage) is set in the route handler
     before calling `transport.handleRequest()`. If missing, the handler returns
     `{ error: { code: 'unauthorized', message: '...', retryable: false } }`
     inside the tool result content.
   - Zod validation failures produce `{ error: { code: 'validation_error',
     message: '...', retryable: false, meta: { issues: [...] } } }`
     via `ToolError`'s `toMcpError()`.
   - Business logic errors (tier limits, not found, duplicates) produce
     `ToolError` instances that serialize to the same consistent shape.
   - **All errors are returned inside the `result.content` as JSON text,**
     never thrown as JavaScript exceptions. Throwing would land in the
     JSON‑RPC error envelope (error code -32603), which is harder for
     MCP clients to distinguish from transport-level failures.

3. **When each applies:**
   - `HTTP 401` → only for pre-transport auth failures (missing/invalid
     `Authorization` header or Bearer token).
   - `{ error: { code, message } }` in `result.content` → all tool-level
     errors: validation, authorization, tier limits, not found, internal
     errors, unknown tool names.

**⚠️ MCP client expectations:** Some MCP clients expect tool errors to be
thrown as exceptions (wrapped in the JSON‑RPC error envelope). If integration
issues arise, this layer can be adjusted to throw `ToolError` instead of
returning it in content, by replacing `return { content: [serialized] }`
with `throw toolError` in the handler.
- **Cross‑user isolation test for recall:** Additional integration test needed (planned for R3).
- **Sigstore provenance:** GitHub Actions workflow for supply‑chain verification not yet set up (planned for R9).
- **Dockerfile:** Distroless image with health check not yet created (planned for R8).