# MonoClaw

A lightweight autonomous multi-agent runtime in Node.js/TypeScript. Each agent runs inside an OS-level sandbox with its own workspace and memory, reachable via message channels (Telegram, stdio).

Design philosophy: small, legible, forkable. Built on [pimono](https://github.com/mariozechner/pi-mono) (`@mariozechner/pi-coding-agent`).

## Architecture

```
                        ┌─────────────────────────────────────────┐
                        │               orchestrator               │
                        │                                          │
 Telegram / stdio  ───► │  channel router  ──►  AgentProcess       │
                        │                           │              │
                        │  outbox flush  ◄──────────┘              │
                        │      │                                   │
                        └──────┼────────────────────────────────── ┘
                               │ send()
                        ┌──────▼──────────────────────────────────┐
                        │         credential proxy (:PORT)         │
                        │  strips dummy key, injects real API key  │
                        └──────┬───────────────────────────────────┘
                               │ HTTPS (Anthropic API)
                        ┌──────▼──────────────────────────────────┐
                        │      sandboxed worker subprocess         │
                        │   (sandbox-exec / bwrap)                 │
                        │                                          │
                        │   pimono createAgentSession()            │
                        │   stdin: JSON prompts                    │
                        │   stdout: text_delta / agent_end events  │
                        └──────────────────────────────────────────┘
```

Each agent is a long-running sandboxed Node subprocess. The orchestrator sends prompts over stdin and reads responses from stdout as JSON lines. Agents never have access to the real API key — the credential proxy injects it transparently.

## Key components

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: start proxy → spawn agents → start channels → flush outbox |
| `src/agent.ts` | `AgentProcess`: spawn worker, FIFO queue, auto-restart once on crash |
| `src/worker.ts` | Sandboxed subprocess: pimono session loop, JSON-lines I/O |
| `src/sandbox.ts` | macOS Seatbelt / Linux bwrap policy generation |
| `src/credential-proxy.ts` | localhost HTTP proxy: injects real API key for workers |
| `src/db.ts` | SQLite (better-sqlite3): agents, routing, messages, sessions, outbox |
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

### Configure an agent

Agents are stored in SQLite. Add one programmatically before first run:

```ts
import { upsertAgent, setRouting } from './src/db.js';

upsertAgent({
  name: 'alice',
  workspacePath: '/home/user/.monoclaw/workspaces/alice',
  memoryPath: '/home/user/.monoclaw/workspaces/alice/AGENTS.md',
  sessionDir: '/home/user/.monoclaw/sessions/alice',
});

// Route a Telegram chat to alice
setRouting('telegram', '<your-chat-id>', 'alice');
```

### Run

```bash
# Telegram
ANTHROPIC_API_KEY=sk-... TELEGRAM_BOT_TOKEN=... npm start

# stdio (dev/debug)
ANTHROPIC_API_KEY=sk-... MONOCLAW_STDIO_CHANNEL=1 npm start
# then type:  alice hello there
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | yes | Real Anthropic API key (host process only; workers get a dummy) |
| `TELEGRAM_BOT_TOKEN` | for Telegram | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_CHAT_IDS` | no | Comma-separated chat IDs to allowlist |
| `MONOCLAW_STDIO_CHANNEL` | no | Set to `1` to enable the stdin/stdout debug channel |
| `MONOCLAW_DATA_DIR` | no | SQLite data directory (default: `~/.monoclaw`) |
| `MONOCLAW_MODEL` | no | Model ID override for workers (default: `claude-sonnet-4-20250514`) |
| `ANTHROPIC_BASE_URL` | no | Override Anthropic API base URL (useful for proxies/testing) |

## Sandbox

Workers run inside an OS sandbox that restricts what they can do:

- **macOS**: Apple Seatbelt (`sandbox-exec`). Allows reading the whole filesystem (required for Node.js startup), but restricts **writes** to the agent workspace and `/tmp`, and restricts **network** to the credential proxy port only. Note: `sandbox-exec` is deprecated by Apple but functional on macOS 15.x. See `TODOS.md` for the planned replacement.
- **Linux**: bubblewrap (`bwrap`). Bind-mounts the workspace read-write; system paths read-only. Requires `bwrap` to be installed.
- **Other platforms**: Falls back to no sandbox with a warning.

## Data model

SQLite schema (default: `~/.monoclaw/monoclaw.db`):

```
agents    — registered agents (name, workspace, memory, session paths)
routing   — (channel_name, chat_id) → agent_name
messages  — inbound/outbound message log (30-day TTL)
sessions  — latest pimono session file per agent
outbox    — pending channel deliveries (retry up to 5x, then dead-letter)
```

## Development

```bash
npm run dev          # run with tsx (no build step)
npm run typecheck    # tsc --noEmit
npm test             # vitest
```

Tests mock the worker subprocess and sandbox to avoid requiring a real API key or sandbox binary. The sandbox smoke tests (`test/sandbox.test.ts`) run only when `sandbox-exec` (macOS) or `bwrap` (Linux) is available.

## Project layout

```
src/
  index.ts            orchestrator entry point
  agent.ts            AgentProcess class
  worker.ts           sandboxed worker subprocess
  sandbox.ts          OS sandbox policy generation
  credential-proxy.ts localhost API key proxy
  db.ts               SQLite layer
  types.ts            shared interfaces
  logger.ts           pino logger
  channels/
    index.ts          channel registry
    telegram.ts       Telegram channel
    stdio.ts          stdin/stdout channel
test/
  agent.test.ts
  db.test.ts
  credential-proxy.test.ts
  sandbox.test.ts
  channels/telegram.test.ts
```
