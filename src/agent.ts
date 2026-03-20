/**
 * AgentProcess — host-side wrapper around a sandboxed worker subprocess.
 *
 * Responsibilities:
 *   - Spawn the worker inside the OS sandbox
 *   - Serialize incoming prompts via a per-agent FIFO queue
 *   - Auto-restart once on crash, notify the originating channel
 *   - Emit agent_end events so the orchestrator can flush the outbox
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { buildSandboxedSpawn } from './sandbox.js';
import { upsertSessionFile, enqueueOutbox, storeMessage } from './db.js';
import type { AgentConfig, WorkerOutbound } from './types.js';

export interface WorkerRuntime {
  scriptPath: string;
  requiresTsxLoader: boolean;
}

export function resolveWorkerRuntime(importMetaUrl: string): WorkerRuntime {
  // Built runtime: dist/worker.js exists next to dist/agent.js
  const jsPath = fileURLToPath(new URL('./worker.js', importMetaUrl));
  if (existsSync(jsPath)) {
    return { scriptPath: jsPath, requiresTsxLoader: false };
  }

  // Dev runtime: src/worker.ts exists next to src/agent.ts
  const tsPath = fileURLToPath(new URL('./worker.ts', importMetaUrl));
  if (existsSync(tsPath)) {
    return { scriptPath: tsPath, requiresTsxLoader: true };
  }

  throw new Error(`Worker entrypoint not found next to ${importMetaUrl}`);
}

const WORKER_RUNTIME = resolveWorkerRuntime(import.meta.url);

export type AgentEndHandler = (agentName: string) => void;

export class AgentProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private queue: Array<{ requestId: string; prompt: string; chatId: string; channelName: string }> = [];
  private currentRequestId: string | null = null;
  private busy = false;
  private restartCount = 0;
  private stopping = false;
  private onAgentEnd: AgentEndHandler | null = null;

  constructor(
    readonly config: AgentConfig,
    private readonly proxyPort: number,
    private readonly logger: Logger,
  ) {
    super();
  }

  setAgentEndHandler(fn: AgentEndHandler): void {
    this.onAgentEnd = fn;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.restartCount = 0;
    this.busy = false;
    // Ensure workspace and session dirs exist
    mkdirSync(this.config.workspacePath, { recursive: true });
    mkdirSync(this.config.sessionDir, { recursive: true });

    // config/agents/<name>.md is the editable source of truth for agent memory.
    // Ensure it exists, then copy it into the workspace so pimono can discover
    // it via its AGENTS.md walk (cwd = workspacePath).
    mkdirSync(dirname(this.config.memoryPath), { recursive: true });
    if (!existsSync(this.config.memoryPath)) {
      writeFileSync(
        this.config.memoryPath,
        `# ${this.config.name}\n\nYou are a MonoClaw agent named "${this.config.name}".\n`,
        'utf-8',
      );
    }
    writeFileSync(
      join(this.config.workspacePath, 'AGENTS.md'),
      readFileSync(this.config.memoryPath, 'utf-8'),
      'utf-8',
    );

    this.spawnWorker();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      // Notify any open SSE streams that the in-flight request was abandoned.
      if (this.busy && this.currentRequestId) {
        this.emit('interrupt', { requestId: this.currentRequestId });
      }
      // Signal EOF on stdin: the worker's readline loop will end naturally after
      // the current session.prompt() call finishes, letting pimono flush the
      // session file before exiting. This prevents orphaned user messages.
      proc.stdin?.end();
      // Wait up to 10 s for the worker to exit cleanly, then SIGTERM as fallback.
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          proc.kill('SIGTERM');
          resolve();
        }, 10_000);
        proc.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }

  /**
   * Queue a prompt for this agent. If the agent is currently processing
   * a previous prompt, this is enqueued and processed after the current one.
   * Returns a requestId that can be used to correlate the 'response' event.
   */
  prompt(text: string, chatId: string, channelName: string): string {
    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.queue.push({ requestId, prompt: text, chatId, channelName });
    this.logger.debug(
      { agent: this.config.name, queueDepth: this.queue.length, chatId, channelName, chars: text.length },
      'prompt queued',
    );
    this.drainQueue();
    return requestId;
  }

  private drainQueue(): void {
    if (this.busy || this.queue.length === 0 || !this.proc) return;
    const next = this.queue.shift()!;
    this.busy = true;
    this.currentRequestId = next.requestId;
    storeMessage(this.config.name, next.channelName, 'inbound', next.prompt);
    const msg = JSON.stringify({
      type: 'prompt',
      prompt: next.prompt,
      chatId: next.chatId,
      channelName: next.channelName,
    });
    this.logger.debug(
      { agent: this.config.name, chatId: next.chatId, channelName: next.channelName, chars: next.prompt.length },
      'dispatching prompt to worker',
    );
    this.proc.stdin?.write(msg + '\n', (err) => {
      if (err) {
        this.logger.error(
          { agent: this.config.name, err: err.message },
          'failed writing prompt to worker stdin',
        );
        this.busy = false;
        this.drainQueue();
      }
    });
  }

  private spawnWorker(): void {
    const nodePath = process.execPath; // path to the current node binary
    const nodeModulesPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'node_modules',
    );

    const env: NodeJS.ProcessEnv = {
      MONOCLAW_AGENT_NAME: this.config.name,
      MONOCLAW_WORKSPACE: this.config.workspacePath,
      MONOCLAW_SESSION_DIR: this.config.sessionDir,
      MONOCLAW_MEMORY_PATH: this.config.memoryPath,
      MONOCLAW_PROXY_PORT: String(this.proxyPort),
      ANTHROPIC_API_KEY: 'worker-session-token',  // proxy substitutes real key
      // Pass through PATH so the worker can find system tools
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      ...(this.config.model ? { MONOCLAW_MODEL: this.config.model } : {}),
      ...(this.config.skills?.length ? { MONOCLAW_SKILLS: JSON.stringify(this.config.skills) } : {}),
    };
    if (WORKER_RUNTIME.requiresTsxLoader) {
      const existingNodeOptions = process.env.NODE_OPTIONS?.trim();
      env.NODE_OPTIONS = existingNodeOptions
        ? `${existingNodeOptions} --import tsx`
        : '--import tsx';
    }

    const { cmd, args, spawnOpts } = buildSandboxedSpawn(
      WORKER_RUNTIME.scriptPath,
      [],
      env,
      {
        agentName: this.config.name,
        workspacePath: this.config.workspacePath,
        sessionDir: this.config.sessionDir,
        proxyPort: this.proxyPort,
        nodeModulesPath,
        nodePath,
      },
    );

    this.proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...spawnOpts,
    });

    this.logger.info({ agent: this.config.name, pid: this.proc.pid }, 'worker started');
    this.drainQueue();

    // Stream stderr to our logger
    this.proc.stderr?.on('data', (data: Buffer) => {
      this.logger.debug({ agent: this.config.name }, data.toString().trim());
    });

    // Parse worker stdout as JSON lines
    const rl = createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => this.handleWorkerLine(line));

    this.proc.on('exit', (code, signal) => {
      if (this.stopping) return;
      this.logger.warn(
        { agent: this.config.name, code, signal },
        'worker exited unexpectedly',
      );
      this.busy = false;
      this.proc = null;

      if (this.restartCount < 1) {
        this.restartCount++;
        this.logger.info({ agent: this.config.name }, 'restarting worker (attempt 1)');
        // Notify via outbox if we had a pending prompt
        this.spawnWorker();
      } else {
        this.logger.error(
          { agent: this.config.name },
          'worker failed twice — agent halted',
        );
      }
    });
  }

  private handleWorkerLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: WorkerOutbound;
    try {
      msg = JSON.parse(trimmed) as WorkerOutbound;
    } catch {
      this.logger.warn({ agent: this.config.name, line }, 'non-JSON from worker');
      return;
    }

    if (msg.type === 'error') {
      this.logger.error({ agent: this.config.name, message: msg.message }, 'worker error');
      this.busy = false;
      this.drainQueue();
      return;
    }

    if (msg.type === 'text_delta') {
      // Emit delta for SSE streaming (API consumers)
      if (this.currentRequestId) {
        this.emit('delta', { requestId: this.currentRequestId, text: msg.delta });
      }
      return;
    }

    if (msg.type === 'agent_end') {
      // Record session file if this is the init event
      if (msg.channelName === '__session_init__') return;

      const { response, chatId, channelName } = msg;
      const requestId = this.currentRequestId ?? '';
      this.currentRequestId = null;
      this.logger.debug(
        { agent: this.config.name, channelName, chatId, responseChars: response.length },
        'worker completed prompt',
      );
      if (response && channelName) {
        storeMessage(this.config.name, channelName, 'outbound', response);
        // __api__ channel: response is delivered via event, not through the outbox
        if (channelName !== '__api__') {
          enqueueOutbox(channelName, chatId, response);
          this.onAgentEnd?.(this.config.name);
        }
      }

      // Notify API/SSE listeners
      this.emit('response', { requestId, text: response, chatId, channelName });

      // Reset the restart counter on successful completion
      this.restartCount = 0;
      this.busy = false;
      this.drainQueue();
    }
  }
}
