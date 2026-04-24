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
- **Prompt‑injection wrapping:** Recall output does not yet wrap memories in `<memory>` tags to prevent prompt injection (planned for R3).
- **Error shape:** Tool errors are currently returned as MCP‑compatible `{ code, message, retryable, meta }` but the outer `error` property required by the spec is missing (planned for R3).
- **Cross‑user isolation test for recall:** Additional integration test needed (planned for R3).
- **Sigstore provenance:** GitHub Actions workflow for supply‑chain verification not yet set up (planned for R9).
- **Dockerfile:** Distroless image with health check not yet created (planned for R8).