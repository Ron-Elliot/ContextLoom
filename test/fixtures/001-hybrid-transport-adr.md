# ADR 0002: Use Hybrid MCP Transport

**Status:** Accepted

## Context

The ContextLoom MCP server initially used only StdioServerTransport, which works
for local claude-desktop usage but cannot serve a hosted Render deployment that
requires an HTTP endpoint.

## Decision

Use a hybrid transport strategy: stdio when `CONTEXTLOOM_HOST` is unset (local
development default), HTTP/SSE via `StreamableHTTPServerTransport` when
`CONTEXTLOOM_HOST` is set (production deployment).

## Rationale

A hybrid approach preserves the existing local development workflow without any
changes to claude-desktop configuration, while enabling production deployment on
Render with a simple environment variable. Neither transport-only option satisfies
both use cases simultaneously.

## Consequences

- The server inspects `CONTEXTLOOM_HOST` at startup to select transport
- `CONTEXTLOOM_PORT` defaults to 8080 when running in HTTP mode
- Local development requires no changes — stdio behavior is unchanged
- Hosted deployments set `CONTEXTLOOM_HOST=0.0.0.0` to enable HTTP mode
