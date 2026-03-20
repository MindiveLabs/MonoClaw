# Changelog

All notable changes to MonoClaw are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.2.1] - 2026-03-20

### Added
- **Per-agent model override** (`config/agents/<name>.json`): Optional `"model"` field lets
  each agent specify a different model ID (e.g. `"claude-opus-4-5"`). Passed to the worker
  subprocess as `MONOCLAW_MODEL` env var and used when creating the pimono session.
- **Per-agent skill paths** (`config/agents/<name>.json`): Optional `"skills"` field accepts
  an array of paths (relative or absolute) to additional skill directories or files. Paths are
  resolved against `process.cwd()`, JSON-serialized into `MONOCLAW_SKILLS`, and injected into
  the worker's `DefaultResourceLoader` so pimono loads them at session startup.

## [0.2.0] - 2026-03-20

### Added
- **HTTP API** (`src/api.ts`): REST server on a random loopback port with endpoints for
  health check, agent listing, prompt submission (fire-and-forget, poll, and SSE streaming),
  agent restart, and outbox inspection. Port written to `.runtime/api-port` on startup.
- **monoclaw CLI** (`src/cli.ts`): Thin HTTP client CLI with commands `status`, `agents`,
  `agents show <name>`, `send`, `chat` (interactive REPL + one-shot streaming), `restart`,
  and `outbox`. Port auto-discovered from `.runtime/api-port`.
- **Agent config loader** (`src/config.ts`): Reads `config/agents/*.json`, validates with
  zod, resolves relative paths against `process.cwd()`. Agent name derived from filename.
- **Env loader** (`src/env.ts`): Loads `config/.env` at startup, parses KEY=VALUE pairs,
  never overwrites already-set env vars.
- **SSE interrupt signal**: `AgentProcess` now emits an `interrupt` event when `stop()` is
  called while a prompt is in-flight, allowing SSE clients to receive a clean error response
  instead of hanging indefinitely.
- Example agent config: `config/agents/alice.json` and `config/agents/alice.md`.

### Fixed
- **Session persistence bug**: Worker subprocess no longer causes Anthropic API errors after
  server restart. If the previous generation was interrupted (worker killed mid-prompt), the
  new worker now rolls back the pimono session to the last complete assistant turn instead of
  leaving an orphaned user message that would trigger a consecutive-user-message API error.
- **Queue freeze after graceful restart**: `AgentProcess.start()` now resets `this.busy` and
  drains any queued prompts, preventing the prompt queue from freezing permanently when an
  agent is restarted while processing a request.
- **Overly harsh body rejection**: `readBody` now drains the request instead of calling
  `req.destroy()` on oversized bodies, so the server can return a proper 400 response
  instead of causing an ECONNRESET on the client.

### Changed
- Agent definitions and routing moved from SQLite to `config/agents/*.json` files — human-
  readable, version-controllable, and inspectable without a DB client.
- `AgentProcess` extends `EventEmitter` and emits `delta` and `response` events for API/SSE
  consumers, replacing the previous callback-only model.
- `AgentProcess.resolveWorkerRuntime()` auto-detects built (`dist/worker.js`) vs development
  (`src/worker.ts`) worker and injects `--import tsx` into `NODE_OPTIONS` when needed.
- `AgentProcess.stop()` now waits up to 10 s for the worker to exit cleanly before sending
  SIGTERM, giving pimono time to flush the session file.
- Sandbox `SandboxConfig` now includes `sessionDir` for write-access grants.
- Default data directory changed from `~/.monoclaw` to `.runtime/` in the project root
  (configurable via `MONOCLAW_DATA_DIR`).

### Removed
- `agents` and `routing` SQLite tables and associated functions (`getAllAgents`, `upsertAgent`,
  `resolveAgent`, `setRouting`) — replaced by JSON config files.

## [0.1.0] - 2026-03-19

### Added
- Initial MonoClaw runtime: sandboxed worker subprocess, credential proxy, pimono session
  management, Telegram and stdio channels, SQLite outbox, OS-level sandboxing (macOS
  Seatbelt / Linux bwrap).
