/**
 * MonoClaw worker — runs inside the OS sandbox.
 *
 * Lifecycle:
 *   1. Start: createAgentSession() with the agent's workspace and session dir.
 *   2. Loop: read prompts from stdin (JSON lines), run session.prompt(), emit
 *      text_delta events and agent_end to stdout (JSON lines).
 *   3. Exit cleanly when stdin closes.
 *
 * Communication protocol (JSON lines on stdin/stdout):
 *   Inbound  { type: 'prompt'; prompt: string; chatId: string; channelName: string }
 *   Outbound { type: 'text_delta'; delta: string }
 *            { type: 'agent_end'; response: string; chatId: string; channelName: string }
 *            { type: 'error'; message: string }
 *
 * Environment vars set by the host before spawning:
 *   MONOCLAW_AGENT_NAME      — agent name (for logging)
 *   MONOCLAW_WORKSPACE       — workspace directory (cwd for createAgentSession)
 *   MONOCLAW_SESSION_DIR     — persistent session directory
 *   MONOCLAW_MEMORY_PATH     — path to AGENTS.md context file
 *   MONOCLAW_PROXY_PORT      — credential proxy port
 *   ANTHROPIC_API_KEY        — dummy token (real key is in the host proxy)
 */
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
} from '@mariozechner/pi-coding-agent';
import { createInterface } from 'node:readline';
import type { WorkerInbound, WorkerOutbound } from './types.js';

const AGENT_NAME = process.env.MONOCLAW_AGENT_NAME ?? 'unknown';
const WORKSPACE = process.env.MONOCLAW_WORKSPACE;
const SESSION_DIR = process.env.MONOCLAW_SESSION_DIR;
const MEMORY_PATH = process.env.MONOCLAW_MEMORY_PATH;
const PROXY_PORT = process.env.MONOCLAW_PROXY_PORT;

if (!WORKSPACE || !SESSION_DIR) {
  emit({ type: 'error', message: 'MONOCLAW_WORKSPACE and MONOCLAW_SESSION_DIR must be set' });
  process.exit(1);
}

function emit(msg: WorkerOutbound): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function debugLog(message: string): void {
  process.stderr.write(`[worker:${AGENT_NAME}] ${message}\n`);
}

// Minimal interface for the parts of SessionManager used in session rollback.
// Matches the pimono API; extracted here so tests can provide plain objects.
export interface SessionManagerLike {
  buildSessionContext(): { messages: unknown[] };
  getBranch(): Array<{ type: string; id: string; message?: unknown }>;
  branch(id: string): void;
  resetLeaf(): void;
}

/**
 * Detects and recovers from an incomplete session turn left by a worker that
 * was killed mid-generation. Rolls the session leaf back to the last complete
 * assistant response, or resets to empty context if no complete turn exists.
 * Exported for unit testing.
 */
export function applySessionRollback(
  sessionManager: SessionManagerLike,
  debugLog: (msg: string) => void,
): void {
  const priorContext = sessionManager.buildSessionContext();
  if (priorContext.messages.length === 0) return;

  const lastMsg = priorContext.messages.at(-1) as Record<string, unknown>;
  const lastRole = typeof lastMsg?.role === 'string' ? lastMsg.role : null;
  const lastStopReason = typeof lastMsg?.stopReason === 'string' ? lastMsg.stopReason : null;
  const isTurnComplete = lastRole === 'assistant' && lastStopReason !== 'toolUse';
  if (isTurnComplete) return;

  const branch = sessionManager.getBranch();
  let lastCompleteId: string | undefined;
  for (const entry of branch) {
    if (entry.type === 'message') {
      const msg = entry.message as unknown as Record<string, unknown>;
      if (msg.role === 'assistant' && msg.stopReason !== 'toolUse') {
        lastCompleteId = entry.id;
      }
    }
  }
  if (lastCompleteId) {
    sessionManager.branch(lastCompleteId);
    debugLog('Prior generation was interrupted — rolled back session to last complete turn');
  } else {
    sessionManager.resetLeaf();
    debugLog('Prior generation was interrupted before any complete turn — starting with empty context');
  }
}

function getLastAssistantMeta(session: {
  messages: Array<Record<string, unknown>>;
}): { stopReason?: string; errorMessage?: string } {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role === 'assistant') {
      return {
        stopReason:
          typeof msg.stopReason === 'string' ? msg.stopReason : undefined,
        errorMessage:
          typeof msg.errorMessage === 'string' ? msg.errorMessage : undefined,
      };
    }
  }
  return {};
}

async function main(): Promise<void> {
  // Point all LLM calls at the credential proxy instead of api.anthropic.com.
  // The proxy injects the real API key; the worker only has a dummy token.
  const proxyBaseUrl = PROXY_PORT
    ? `http://localhost:${PROXY_PORT}`
    : undefined;

  // AuthStorage.inMemory() so the worker never reads ~/.pi/agent/auth.json
  // (which may not be accessible inside the sandbox).
  const authStorage = AuthStorage.inMemory({
    anthropic: { type: 'api_key', key: 'worker-session-token' },
  });

  // Continue the most recent session for this agent, or start fresh.
  const sessionManager = SessionManager.continueRecent(WORKSPACE!, SESSION_DIR);

  // Detect and recover from an incomplete turn caused by the worker being killed
  // mid-generation. pimono writes user messages to disk before the LLM call
  // completes, so an interrupted generation leaves the session ending with an
  // unanswered user message or a partial tool-use turn. On the next start,
  // sending a new prompt would cause consecutive user-role messages → Anthropic
  // API error. We roll back the session leaf to the last complete assistant
  // response so the session is in a valid state.
  applySessionRollback(sessionManager, debugLog);

  // Build createAgentSession options. If we have a proxy, we need to pass a
  // model with the proxy baseUrl. We let pimono pick the default model from
  // settings/env, then patch the baseUrl below via a model override if needed.
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd: WORKSPACE,
    sessionManager,
    authStorage,
  };

  // If a proxy is configured, create a custom model pointing to it.
  if (proxyBaseUrl) {
    // Import getModel lazily to keep worker startup light
    const { getModel } = await import('@mariozechner/pi-ai');
    // Prefer MONOCLAW_MODEL env var, fall back to claude-sonnet-4-6
    const modelId = process.env.MONOCLAW_MODEL ?? 'claude-sonnet-4-20250514';
    const baseModel = getModel('anthropic', modelId as Parameters<typeof getModel>[1]);
    if (baseModel) {
      // Patch baseUrl to point at our credential proxy
      (sessionOpts as Record<string, unknown>).model = {
        ...baseModel,
        baseUrl: proxyBaseUrl,
      };
    }
  }

  const { session } = await createAgentSession(sessionOpts);

  // Emit session file so the orchestrator can track it in SQLite.
  if (session.sessionFile) {
    emit({
      type: 'agent_end',
      response: '',
      chatId: '',
      channelName: '__session_init__',
    });
    // Reuse agent_end with special channelName to signal session file
    // (orchestrator ignores this for outbox but records session file)
  }

  // Process prompts from stdin one at a time.
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: WorkerInbound;
    try {
      msg = JSON.parse(trimmed) as WorkerInbound;
    } catch {
      emit({ type: 'error', message: `bad JSON from host: ${trimmed}` });
      continue;
    }

    if (msg.type !== 'prompt') continue;

    const startedAt = Date.now();
    let fullResponse = '';
    const { chatId, channelName, prompt } = msg;
    debugLog(`prompt received (channel=${channelName}, chatId=${chatId}, chars=${prompt.length})`);

    const unsub = session.subscribe((event) => {
      if (
        event.type === 'message_update' &&
        event.assistantMessageEvent.type === 'text_delta'
      ) {
        const delta = event.assistantMessageEvent.delta;
        fullResponse += delta;
        emit({ type: 'text_delta', delta });
      }
    });

    try {
      await session.prompt(prompt);
    } catch (err) {
      unsub();
      debugLog(
        `prompt failed after ${Date.now() - startedAt}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
      emit({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (!fullResponse) fullResponse = session.getLastAssistantText() ?? '';

    const { stopReason, errorMessage } = getLastAssistantMeta(
      session as unknown as { messages: Array<Record<string, unknown>> },
    );
    if (!fullResponse && stopReason) {
      if (stopReason === 'error' || stopReason === 'aborted') {
        fullResponse = `Agent ${stopReason}: ${errorMessage ?? 'Unknown error'}`;
      } else {
        fullResponse = `Agent produced no text (stopReason=${stopReason})`;
      }
    }

    if (stopReason === 'error' || stopReason === 'aborted') {
      debugLog(
        `assistant stopReason=${stopReason}, error=${errorMessage ?? 'n/a'}`,
      );
    }
    debugLog(
      `prompt finished in ${Date.now() - startedAt}ms (responseChars=${fullResponse.length})`,
    );
    unsub();
    emit({ type: 'agent_end', response: fullResponse, chatId, channelName });
  }

  session.dispose();
}

main().catch((err) => {
  emit({ type: 'error', message: String(err) });
  process.exit(1);
});
