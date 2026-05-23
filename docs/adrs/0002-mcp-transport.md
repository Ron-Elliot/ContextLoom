# ADR 0002: MCP Transport Strategy

## Status

Accepted

## Context

ContextLoom's MCP server currently uses `StdioServerTransport`, which works for local `claude-desktop`
use (stdin/stdout pipe) but cannot serve a hosted Render deployment. Render runs containers that
accept inbound HTTP connections; there is no stdin/stdout pipe from a remote MCP client.

Three options were evaluated:

### Option A — stdio only (current state)

Keep `StdioServerTransport`. Simple; no changes required.

**Rejected because:** breaks hosted deployment. A container on Render has no attached stdin/stdout
from an MCP client. Hosting the query server requires HTTP.

### Option B — HTTP/SSE only

Replace `StdioServerTransport` with `StreamableHTTPServerTransport` unconditionally. All users,
including local `claude-desktop` users, connect over HTTP.

**Rejected because:** breaks the local dev workflow. `claude-desktop` and Claude Code connect to MCP
servers via stdio by default; switching all users to HTTP requires them to change their Claude
config and run a local HTTP server. This is unnecessary friction for local use.

### Option C — Hybrid (chosen)

Use `StdioServerTransport` when `CONTEXTLOOM_HOST` is unset (local dev default), and
`StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js` when
`CONTEXTLOOM_HOST` is set (production / hosted). Transport selection is purely env-driven; no CLI
argument changes are needed.

**Chosen because:**
- Local dev stays zero-config: `claude-desktop` users keep the existing stdio wiring unchanged.
- Hosted deployments set `CONTEXTLOOM_HOST=0.0.0.0` (and optionally `CONTEXTLOOM_PORT`, default
  8080) and get an HTTP server on the configured port.
- The same binary handles both cases; no conditional build or separate entry point is needed.
- The env-var contract is consistent with the `CONTEXTLOOM_*` prefix used throughout the project.

## Decision

Implement hybrid transport in `src/serve/server.ts`:

- **`CONTEXTLOOM_HOST` unset** → `StdioServerTransport` (existing behavior, unchanged)
- **`CONTEXTLOOM_HOST` set** → `StreamableHTTPServerTransport`; HTTP server binds to
  `CONTEXTLOOM_HOST:CONTEXTLOOM_PORT` (default port 8080); listening address is logged on startup

The `contextloom serve` command requires no argument changes. Transport is selected at runtime by
reading the environment.

## Consequences

- Local `claude-desktop` and Claude Code users are unaffected.
- Render deployments set `CONTEXTLOOM_HOST=0.0.0.0` in the service env vars.
- `CONTEXTLOOM_PORT` defaults to `8080`; Render's default health-check port is 8080, so this works
  out of the box.
- Each HTTP request creates a new `StreamableHTTPServerTransport` and `McpServer` instance
  (stateless per-request). The `Pool` is shared across requests for efficient DB connection reuse.
- Future work (v2) may add session management or authentication middleware; the HTTP path is the
  natural extension point.
