# Directory blitz — where Recall gets listed, and how

P0 item 4 from the productization ticket. Status as of 2026-08-19 (verified by
querying each directory's search/API): **Recall is not yet listed anywhere.**
The Omniology MCP (`io.github.omniologynow-rgb/mcp-server`) IS already live on
the official MCP Registry, so the GitHub-auth publish flow below is proven for
this org.

Publishing requires accounts / GitHub OAuth, so each submission is a Matt (or
operator) action. Everything below is paste-ready.

## The canonical facts (copy into every listing)

| Field | Value |
|---|---|
| Name | Recall |
| One-liner | Portable AI memory — one living memory shared by every MCP client. Exportable, never trained on. |
| Endpoint | `https://recall-mcp.fly.dev/mcp` (Streamable HTTP, stateless JSON) |
| Auth | `Authorization: Bearer recall_live_…` (or `?key=` for URL-only connector UIs) |
| Get a key | https://recall-mcp.fly.dev/signup (free — 100 memories) |
| Website | https://recall-mcp.fly.dev |
| Repo | https://github.com/omniologynow-rgb/recall-mcp |
| Tools | remember · recall · list_memories · update_memory · forget |

## 1. Official MCP Registry (registry.modelcontextprotocol.io)

`server.json` in this repo is schema-valid (CI runs `npm run validate:server-json`).
Two paths — pick one:

**A. Remote-only (no npm publish needed) — recommended first:**
temporarily strip the `packages` array from `server.json`, then:

```bash
brew install mcp-publisher   # or download from github.com/modelcontextprotocol/registry releases
mcp-publisher login github   # authenticate as omniologynow-rgb (matches the io.github.omniologynow-rgb/* namespace)
mcp-publisher publish
```

**B. Full (remote + npm stdio package):** publish to npm first —
`package.json` already carries the required `"mcpName": "io.github.omniologynow-rgb/recall-mcp"`:

```bash
npm publish --access public
mcp-publisher login github
mcp-publisher publish
```

Verify: `curl "https://registry.modelcontextprotocol.io/v0/servers?search=recall-mcp"`.
Downstream aggregators (including some client directories) sync from this
registry, so it's the highest-leverage single listing.

## 2. Smithery (smithery.ai)

Sign in with GitHub → Add server → point at the repo. NOTE (memory/`project_mcp_client_distribution`):
the Smithery namespace for this org is **`omniologynow/`, NOT `omniologynow-rgb/`**.
Recall is remote-capable; configure the hosted URL + bearer key schema so
Smithery's playground can exercise it.

## 3. mcp.so

Submit via the "Submit" form (GitHub repo URL) or open an issue/PR on
chatmcp/mcp-directory. No account beyond GitHub needed.

## 4. Glama (glama.ai/mcp/servers)

Sign in with GitHub → claim/add server by repo URL. Glama also auto-indexes
public GitHub repos with `server.json` — publishing step 1 usually gets us
indexed; verify and claim ownership.

## 5. PulseMCP (pulsemcp.com)

Submit form: https://www.pulsemcp.com/submit — name, repo, endpoint. They
hand-review; the one-liner above fits their format.

## 6. Anthropic connector directory (claude.ai)

Submission form (Anthropic operates intake for the claude.ai directory —
"Submit a connector"). Requirements to have ready: the remote endpoint,
auth description, privacy policy URL, support contact. ⚠️ Our auth is bearer
key (no OAuth); the directory strongly prefers OAuth for consumer listings —
if rejected, this becomes the trigger for the OAuth roadmap item, and users
can still add Recall as a custom connector meanwhile (the /connect/claude
guide covers it).

## 7. Mistral Le Chat directory

Le Chat custom connectors work today (see /connect/other-clients). The curated
directory intake is via Mistral's partner form — same materials as #6.

## 8. MCPize (billing marketplace — ALREADY WIRED)

The webhook (`POST /webhooks/mcpize/subscription`, HMAC via
`MCPIZE_BILLING_WEBHOOK_SECRET`) shipped in R13. Activation = create the
MCPize listing, set the webhook secret on both sides, and confirm their
payload shape matches (see FUTURE.md — header name + payload fields were
built against their draft docs and must be verified before flipping on).

## Verification checklist (re-run after each submission)

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=recall-mcp"
curl -s "https://registry.smithery.ai/servers?q=recall"
# then eyeball: mcp.so/?q=recall · glama.ai/mcp/servers?query=recall · pulsemcp.com search
```
