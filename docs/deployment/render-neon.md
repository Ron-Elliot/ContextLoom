# Deploying ContextLoom on Render + Neon

This guide covers the complete setup for running ContextLoom with a Neon PostgreSQL database (hosted reads) and local ingest.

## Architecture

- **Neon** — hosted PostgreSQL + pgvector. The shared database for all entities, artifacts, and embeddings.
- **Render** — hosts the `contextloom serve` MCP query server (read-only, no LLM calls).
- **Local** — you run `contextloom ingest` locally against `CONTEXTLOOM_DATABASE_URL` pointing at Neon.

The hosted Render service does **not** call OpenAI. `OPENAI_API_KEY` is only needed locally for ingest.

## 1. Enable pgvector on Neon

In the Neon console SQL editor, run:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Confirm the extension is active:

```sql
SELECT * FROM pg_extension WHERE extname = 'vector';
```

## 2. Run migrations

From your local machine, point `CONTEXTLOOM_DATABASE_URL` at your Neon connection string and run migrations:

```bash
CONTEXTLOOM_DATABASE_URL=postgres://USER:PASSWORD@your-project.neon.tech/neondb npm run migrate
```

## 3. Deploy to Render

Create a new **Web Service** on Render pointing at this repository. Render will use the `Dockerfile` at the repo root.

Set the following environment variables in the Render service settings:

| Variable | Value |
|---|---|
| `CONTEXTLOOM_DATABASE_URL` | `postgres://USER:PASSWORD@your-project.neon.tech/neondb` |
| `CONTEXTLOOM_HOST` | `0.0.0.0` |
| `CONTEXTLOOM_PORT` | `8080` |
| `CONTEXTLOOM_LOG_LEVEL` | `info` |

> **Note:** Do NOT set `OPENAI_API_KEY` on Render. The hosted serve command performs only SQL queries — it never calls OpenAI.

The container runs:

```
node dist/cli.js serve --config /etc/contextloom/contextloom.yaml
```

Mount your `contextloom.yaml` config file at `/etc/contextloom/contextloom.yaml` using a Render disk or config secret.

## 4. Run ingest locally

Point your local environment at the Neon database and run ingest:

```bash
export CONTEXTLOOM_DATABASE_URL=postgres://USER:PASSWORD@your-project.neon.tech/neondb
export OPENAI_API_KEY=sk-your-openai-key-here
contextloom ingest --config contextloom.yaml
```

This pushes entities, artifacts, embeddings, and claims to the shared Neon database. The hosted Render service immediately serves the updated data.

## 5. Connect via MCP

Configure your MCP client to connect to the Render service URL. When `CONTEXTLOOM_HOST` is set, the server uses HTTP transport (StreamableHTTP) on port 8080.
