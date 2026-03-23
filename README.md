# MonoClaw

A compact, developer-first alternative to OpenClaw. MonoClaw provides isolated execution with a standalone agent runtime that is easy to inspect and customize.

- Full-featured agent runtime with persistent memory, powered by [pimono](https://github.com/mariozechner/pi-mono) (`@mariozechner/pi-coding-agent`)
- OS-level sandboxing for workers (`sandbox-exec` on macOS, `bwrap` on Linux). Credential proxy so real API keys stay on the host
- Local HTTP API + CLI for easy integration into tools and automations
- Lightweight messaging channels (Telegram and stdio) built-in, with straightforward expansion available

## Why MonoClaw

OpenClaw is powerful, but too large to fully understand and customize with confidence.

MonoClaw delivers the same core capabilities in a much smaller codebase (~ 1,000 lines). It runs on [pimono](https://github.com/mariozechner/pi-mono) (`@mariozechner/pi-coding-agent`), which also powered OpenClaw in its early days.

MonoClaw is a strong fit for developers who want a standalone agent runtime inside their own product or project. The codebase is intentionally small, so deep customization stays practical.

If your primary goal is day-to-day development with Claude Code, you may prefer [NanoClaw](https://github.com/qwibitai/nanoclaw).


## Architecture

```
 CLI / external      Telegram / stdio
 services            channels
     │                   │
     ▼                   ▼
 ┌───────────────────────────────────────────┐
 │                orchestrator               │
 │                                           │
 │  HTTP API (:PORT) ──► channel router ──►  AgentProcess
 │       │                                       │
 │  outbox flush  ◄──────────────────────────────┘
 │      │                                    │
 └──────┼────────────────────────────────────┘
        │ send()
 ┌──────▼─────────────────────────────────────┐
 │        credential proxy (:PORT)             │
 │  strips dummy key, injects real API key     │
 └──────┬──────────────────────────────────────┘
        │ HTTPS (Anthropic API)
 ┌──────▼──────────────────────────────────────┐
 │      sandboxed worker subprocess            │
 │   (sandbox-exec / bwrap)                    │
 │                                             │
 │   pimono createAgentSession()               │
 │   stdin: JSON prompts                       │
 │   stdout: text_delta / agent_end events     │
 └─────────────────────────────────────────────┘
```

Each agent is a long-running sandboxed Node subprocess. The orchestrator sends prompts over stdin and reads responses from stdout as JSON lines. Agents never have access to the real API key — the credential proxy injects it transparently.

The HTTP API starts automatically with the orchestrator and its port is written to `.runtime/api-port` so the `monoclaw` CLI can discover it.

## Key components

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: start proxy → spawn agents → start API → start channels → flush outbox |
| `src/api.ts` | HTTP API server: REST endpoints + SSE streaming for CLI and external services |
| `src/cli.ts` | `monoclaw` CLI: thin HTTP client for the API |
| `src/agent.ts` | `AgentProcess`: spawn worker, FIFO queue, EventEmitter for streaming, auto-restart |
| `src/worker.ts` | Sandboxed subprocess: pimono session loop, JSON-lines I/O |
| `src/sandbox.ts` | macOS Seatbelt / Linux bwrap policy generation |
| `src/credential-proxy.ts` | localhost HTTP proxy: injects real API key for workers |
| `src/db.ts` | SQLite (better-sqlite3): messages, sessions, outbox |
| `src/channels/telegram.ts` | Telegram Bot API polling channel |
| `src/channels/stdio.ts` | stdin/stdout debug channel |

## Getting started

### Prerequisites

- Node.js 20+
- An Anthropic API key
- (Optional) Telegram bot token

### Install

```bash
npm install
npm run build
```

### Configure

Copy the env template and fill in your keys:

```bash
cp config/.env.example config/.env
# edit config/.env — set ANTHROPIC_API_KEY and optionally TELEGRAM_BOT_TOKEN
```

Agent definitions live in `config/agents/`. An example `alice/` directory is included. Create a new subdirectory for each agent:

```bash
mkdir -p config/agents/mybot
cp config/agents/alice/alice.json config/agents/mybot/mybot.json
# edit config/agents/mybot/mybot.json
```

Each agent directory contains:
- `<name>.json` — agent config (required)
- `<name>.md` — agent memory / persona (created automatically on first run)
- `skills/` — drop skill files here; auto-included at startup

`<name>.json` schema:

```json
{
  "workspacePath": ".runtime/workspaces/mybot",
  "sessionDir": ".runtime/sessions/mybot",
  "routing": [
    { "channel": "telegram", "chatId": "123456789" },
    { "channel": "stdio", "chatId": "mybot" }
  ]
}
```

- **`workspacePath`** / **`sessionDir`** — relative paths are resolved from the project root; absolute paths work too
- **`routing`** — list every `(channel, chatId)` pair that should reach this agent; for Telegram, `chatId` is the numeric chat/user ID
- **`model`** — optional model override (e.g. `"claude-opus-4-5"`)
- **`skills`** — optional array of extra skill paths (relative or absolute); the `skills/` subdirectory is always prepended automatically

Edit `config/agents/<name>/<name>.md` to give the agent a persona, instructions, or persistent context. On every startup MonoClaw copies it into the workspace so pimono's `AGENTS.md` discovery picks it up — no extra wiring needed.

To add or change routing, edit the JSON and restart MonoClaw.

### Plugin channels

Drop a directory into `config/plugins/` to add a new messaging channel without touching MonoClaw core:

```
config/plugins/
  my-channel/
    openclaw.plugin.json   — manifest (must have "id")
    index.js               — compiled entry point
```

**`openclaw.plugin.json`** (same format as OpenClaw):
```json
{ "id": "my-channel", "channels": ["my-channel"] }
```

**`index.js`** (TypeScript: `import { defineChannelPluginEntry } from 'monoclaw/plugin-sdk'`):
```js
export default {
  id: 'my-channel',
  name: 'My Channel',
  toChannel() {
    return {
      name: 'my-channel',
      async send(chatId, text) { /* deliver text to chatId */ },
      onMessage(handler) { /* call handler({ channelName, chatId, text }) on inbound */ },
      async start() { /* connect, start polling, etc. */ },
      async stop() { /* teardown */ },
    };
  },
  applyRuntime(rt) {
    // rt.env — process.env, rt.logger — pino logger
    // Called synchronously at load time; defer async init to start()
  },
};
```

Then add routing entries to your agent config and restart:
```json
{ "channel": "my-channel", "chatId": "some-id" }
```

Override the plugins directory: `MONOCLAW_PLUGINS_DIR=/path/to/plugins`.

See `config/plugins/example-echo/` for a minimal working example.

**Security note:** Plugins run in the orchestrator process and inherit full access to `process.env` (including `ANTHROPIC_API_KEY`). Only load plugins you trust — plugin code is not sandboxed.

### Run

```bash
# Using config/.env (loaded automatically)
npm start          # production (built dist/)
npm run dev        # development (tsx, no build needed)

# Or pass env vars directly
ANTHROPIC_API_KEY=sk-... MONOCLAW_STDIO_CHANNEL=1 npm run dev
```

## CLI

The `monoclaw` binary is a thin client against the running orchestrator's HTTP API. The daemon must be running first (`npm start`).

```bash
# After npm install && npm run build, link globally:
npm link

monoclaw status                        # health check + agent/outbox summary
monoclaw agents                        # list configured agents (● = running)
monoclaw agents show <name>            # agent detail (config, routing, paths)
monoclaw send <agent> <message>        # fire-and-forget prompt
monoclaw chat <agent> [message]        # streaming chat; interactive REPL if no message
monoclaw restart <agent>               # restart the worker subprocess
monoclaw outbox                        # show pending/failed outbox entries
```

### Interactive REPL

```
$ monoclaw chat alice
Chatting with alice. Ctrl+C to exit.

> hello
Hi! How can I help you today?
> what files are in my workspace?
...
```

### One-shot

```bash
monoclaw chat alice "summarise the latest news"
```

## HTTP API

The orchestrator exposes a local HTTP API. Port is written to `.runtime/api-port` on startup.

```bash
PORT=$(cat .runtime/api-port)
BASE="http://127.0.0.1:$PORT"
```

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/health` | Liveness + agent status + outbox counts |
| `GET` | `/v1/agents` | List all configured agents |
| `GET` | `/v1/agents/:name` | Single agent detail |
| `POST` | `/v1/agents/:name/messages` | Send a prompt (see below) |
| `GET` | `/v1/agents/:name/messages/:id` | Poll for reply |
| `POST` | `/v1/agents/:name/restart` | Restart worker subprocess |
| `GET` | `/v1/outbox` | Pending/failed outbox rows |

### Send a prompt — fire and forget

```bash
curl -s -X POST "$BASE/v1/agents/alice/messages" \
  -H 'Content-Type: application/json' \
  -d '{"text": "hello"}' | jq
# → { "id": "abc123" }
```

### Send a prompt — poll for reply

```bash
ID=$(curl -s -X POST "$BASE/v1/agents/alice/messages" \
  -H 'Content-Type: application/json' \
  -d '{"text": "what time is it?"}' | jq -r .id)

# Poll until done
curl -s "$BASE/v1/agents/alice/messages/$ID" | jq
# → { "status": "pending" }   (while processing)
# → { "status": "done", "text": "It is 3:42 PM." }
```

### Send a prompt — streaming (SSE)

```bash
curl -s -X POST "$BASE/v1/agents/alice/messages" \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"text": "write me a haiku"}'
# data: {"type":"delta","text":"Autumn"}
# data: {"type":"delta","text":" leaves fall\n"}
# ...
# data: {"type":"done","text":"Autumn leaves fall\n..."}
# (if agent is restarted mid-stream)
# data: {"type":"error","message":"agent restarted"}
```

## Environment variables

Set these in `config/.env` (copied from `config/.env.example`) or export them in your shell:

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | yes | Real Anthropic API key (host process only; workers get a dummy) |
| `TELEGRAM_BOT_TOKEN` | for Telegram | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_CHAT_IDS` | no | Comma-separated chat IDs to allowlist |
| `MONOCLAW_STDIO_CHANNEL` | no | Set to `1` to enable the stdin/stdout debug channel |
| `MONOCLAW_DATA_DIR` | no | SQLite + runtime data directory (default: `.runtime` in the project root) |
| `MONOCLAW_MODEL` | no | Model ID override for workers (default: `claude-sonnet-4-20250514`) |
| `ANTHROPIC_BASE_URL` | no | Override Anthropic API base URL (useful for proxies/testing) |

## Sandbox

Workers run inside an OS sandbox that restricts what they can do:

- **macOS**: Apple Seatbelt (`sandbox-exec`). Allows reading the whole filesystem (required for Node.js startup), but restricts **writes** to the agent workspace and `/tmp`, and restricts **network** to the credential proxy port only. Note: `sandbox-exec` is deprecated by Apple but functional on macOS 15.x. See `TODOS.md` for the planned replacement.
- **Linux**: bubblewrap (`bwrap`). Bind-mounts the workspace read-write; system paths read-only. Requires `bwrap` to be installed.
- **Other platforms**: Falls back to no sandbox with a warning.

## Data model

SQLite schema (default: `.runtime/monoclaw.db`):

```
messages  — inbound/outbound message log (30-day TTL)
sessions  — latest pimono session file per agent
outbox    — pending channel deliveries (retry up to 5x, then dead-letter)
```

Agent definitions and routing are stored under `config/agents/<name>/`, not in SQLite, so they are human-readable and version-controllable.

## Development

```bash
npm run dev          # run with tsx (no build step)
npm run typecheck    # tsc --noEmit
npm test             # vitest
```

Tests mock the worker subprocess and sandbox to avoid requiring a real API key or sandbox binary. The sandbox smoke tests (`test/sandbox.test.ts`) run only when `sandbox-exec` (macOS) or `bwrap` (Linux) is available.

## Project layout

```
config/
  .env.example        env template (copy to config/.env and fill in keys)
  .env                secret env vars — git-ignored
  agents/
    alice/
      alice.json      agent config (workspacePath, sessionDir, routing, model, skills)
      alice.md        agent memory / persona (copied to workspace on each start)
      skills/         drop skill files here; auto-included at startup
src/
  index.ts            orchestrator entry point
  env.ts              loads config/.env at startup (side-effect import)
  config.ts           reads config/agents/*.json
  agent.ts            AgentProcess class (EventEmitter: delta, response events)
  api.ts              HTTP API server (REST + SSE)
  cli.ts              monoclaw CLI entry point
  worker.ts           sandboxed worker subprocess
  sandbox.ts          OS sandbox policy generation
  credential-proxy.ts localhost API key proxy
  db.ts               SQLite layer (outbox, messages, sessions)
  types.ts            shared interfaces
  logger.ts           pino logger
  channels/
    index.ts          channel registry
    telegram.ts       Telegram channel
    stdio.ts          stdin/stdout channel
test/
  agent.test.ts
  config.test.ts
  db.test.ts
  credential-proxy.test.ts
  sandbox.test.ts
  worker-rollback.test.ts
  channels/
    telegram.test.ts
    stdio.test.ts
```
