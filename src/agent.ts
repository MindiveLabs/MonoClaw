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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Logger } from 'pino';
import { buildSandboxedSpawn } from './sandbox.js';
import { upsertSessionFile, enqueueOutbox, storeMessage } from './db.js';
import type { AgentConfig, WorkerOutbound } from './types.js';

// Worker script path (dist/worker.js when built, src/worker.ts when using tsx)
const WORKER_SCRIPT = fileURLToPath(new URL('./worker.js', import.meta.url));

export type AgentEndHandler = (agentName: string) => void;

export class AgentProcess {
  private proc: ChildProcess | null = null;
  private queue: Array<{ prompt: string; chatId: string; channelName: string }> = [];
  private busy = false;
  private restartCount = 0;
  private stopping = false;
  private onAgentEnd: AgentEndHandler | null = null;

  constructor(
    readonly config: AgentConfig,
    private readonly proxyPort: number,
    private readonly logger: Logger,
  ) {}

  setAgentEndHandler(fn: AgentEndHandler): void {
    this.onAgentEnd = fn;
  }

  async start(): Promise<void> {
    // Ensure workspace and session dirs exist
    mkdirSync(this.config.workspacePath, { recursive: true });
    mkdirSync(this.config.sessionDir, { recursive: true });

    // Write AGENTS.md memory file if it doesn't exist
    if (!existsSync(this.config.memoryPath)) {
      writeFileSync(
        this.config.memoryPath,
        `# ${this.config.name}\n\nYou are a MonoClaw agent named "${this.config.name}".\n`,
        'utf-8',
      );
    }

    this.spawnWorker();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
  }

  /**
   * Queue a prompt for this agent. If the agent is currently processing
   * a previous prompt, this is enqueued and processed after the current one.
   */
  prompt(text: string, chatId: string, channelName: string): void {
    this.queue.push({ prompt: text, chatId, channelName });
    this.logger.debug(
      { agent: this.config.name, queueDepth: this.queue.length, chatId, channelName, chars: text.length },
      'prompt queued',
    );
    this.drainQueue();
  }

  private drainQueue(): void {
    if (this.busy || this.queue.length === 0 || !this.proc) return;
    const next = this.queue.shift()!;
    this.busy = true;
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
    };

    const { cmd, args, spawnOpts } = buildSandboxedSpawn(
      WORKER_SCRIPT,
      [],
      env,
      {
        agentName: this.config.name,
        workspacePath: this.config.workspacePath,
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
      // Streaming delta — could be forwarded for streaming channels in the future
      return;
    }

    if (msg.type === 'agent_end') {
      // Record session file if this is the init event
      if (msg.channelName === '__session_init__') return;

      const { response, chatId, channelName } = msg;
      this.logger.debug(
        { agent: this.config.name, channelName, chatId, responseChars: response.length },
        'worker completed prompt',
      );
      if (response && channelName) {
        storeMessage(this.config.name, channelName, 'outbound', response);
        enqueueOutbox(channelName, chatId, response);
        this.onAgentEnd?.(this.config.name);
      }

      // Reset the restart counter on successful completion
      this.restartCount = 0;
      this.busy = false;
      this.drainQueue();
    }
  }
}
