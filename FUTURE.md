# Future Work & Known Gaps

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