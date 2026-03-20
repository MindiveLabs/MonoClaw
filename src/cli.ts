#!/usr/bin/env node
/**
 * monoclaw — CLI client for a running MonoClaw orchestrator.
 *
 * Discovers the daemon's port from {MONOCLAW_DATA_DIR}/api-port (written on startup).
 *
 * Commands:
 *   status                       health check + agent/outbox summary
 *   agents                       list configured agents
 *   agents show <name>           agent detail (config + routing)
 *   send <agent> <message>       fire-and-forget prompt (no reply shown)
 *   chat <agent> [message]       streaming chat; interactive REPL if no message
 *   restart <agent>              restart agent worker subprocess
 *   outbox                       show pending/failed outbox entries
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import http from 'node:http';

// ── Port discovery ────────────────────────────────────────────────────────

function getPort(): number {
  const dataDir = process.env.MONOCLAW_DATA_DIR ?? join(process.cwd(), '.runtime');
  try {
    return parseInt(readFileSync(join(dataDir, 'api-port'), 'utf-8').trim(), 10);
  } catch {
    console.error('MonoClaw is not running. Start with: npm start');
    process.exit(1);
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

async function apiGet(path: string): Promise<unknown> {
  const port = getPort();
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error: string };
    console.error(`API error ${res.status}: ${body.error}`);
    process.exit(1);
  }
  return res.json();
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const port = getPort();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error: string };
    console.error(`API error ${res.status}: ${err.error}`);
    process.exit(1);
  }
  return res.json();
}

// ── SSE streaming chat ────────────────────────────────────────────────────

function chatStream(agentName: string, text: string, chatId = 'cli'): Promise<void> {
  return new Promise((resolve, reject) => {
    const port = getPort();
    const bodyStr = JSON.stringify({ text, chatId });

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/v1/agents/${encodeURIComponent(agentName)}/messages`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          Accept: 'text/event-stream',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        let buffer = '';
        res.setEncoding('utf-8');

        res.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6)) as { type: string; text?: string };
              if (event.type === 'delta' && event.text) {
                process.stdout.write(event.text);
              } else if (event.type === 'done') {
                process.stdout.write('\n');
                resolve();
              }
            } catch {
              // skip malformed event lines
            }
          }
        });

        res.on('end', resolve);
        res.on('error', reject);
      },
    );

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Commands ──────────────────────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  const health = (await apiGet('/v1/health')) as {
    status: string;
    agents: Array<{ name: string; running: boolean }>;
    outbox: { pending: number; failed: number };
  };
  console.log(`Status: ${health.status}`);
  console.log(`\nAgents (${health.agents.length}):`);
  for (const a of health.agents) {
    console.log(`  ${a.running ? '●' : '○'} ${a.name}`);
  }
  console.log(`\nOutbox: ${health.outbox.pending} pending, ${health.outbox.failed} failed`);
}

async function cmdAgents(sub?: string, name?: string): Promise<void> {
  if (!sub || sub === 'list') {
    const agents = (await apiGet('/v1/agents')) as Array<{
      name: string;
      running: boolean;
      routing: Array<{ channel: string; chatId: string }>;
    }>;
    if (agents.length === 0) {
      console.log('No agents configured.');
      return;
    }
    for (const a of agents) {
      const routes = a.routing.map((r) => `${r.channel}:${r.chatId}`).join(', ') || 'no routes';
      console.log(`  ${a.running ? '●' : '○'} ${a.name}  [${routes}]`);
    }
    return;
  }

  if (sub === 'show') {
    if (!name) {
      console.error('Usage: monoclaw agents show <name>');
      process.exit(1);
    }
    const agent = await apiGet(`/v1/agents/${encodeURIComponent(name)}`);
    console.log(JSON.stringify(agent, null, 2));
    return;
  }

  console.error(`Unknown subcommand: agents ${sub}`);
  process.exit(1);
}

async function cmdSend(agentName: string | undefined, text: string | undefined): Promise<void> {
  if (!agentName || !text) {
    console.error('Usage: monoclaw send <agent> <message>');
    process.exit(1);
  }
  const result = (await apiPost(
    `/v1/agents/${encodeURIComponent(agentName)}/messages`,
    { text },
  )) as { id: string };
  console.log(`Queued (id: ${result.id})`);
}

async function cmdChat(agentName: string | undefined, message: string | undefined): Promise<void> {
  if (!agentName) {
    console.error('Usage: monoclaw chat <agent> [message]');
    process.exit(1);
  }

  if (message) {
    await chatStream(agentName, message);
    return;
  }

  // Interactive REPL
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Chatting with ${agentName}. Ctrl+C to exit.\n`);

  const ask = (): void => {
    rl.question('> ', async (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        ask();
        return;
      }
      try {
        await chatStream(agentName, trimmed);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : err);
      }
      ask();
    });
  };

  rl.on('close', () => process.exit(0));
  ask();
}

async function cmdRestart(agentName: string | undefined): Promise<void> {
  if (!agentName) {
    console.error('Usage: monoclaw restart <agent>');
    process.exit(1);
  }
  await apiPost(`/v1/agents/${encodeURIComponent(agentName)}/restart`, {});
  console.log(`Restarted ${agentName}`);
}

async function cmdOutbox(): Promise<void> {
  const rows = (await apiGet('/v1/outbox')) as Array<{
    id: string;
    channel_name: string;
    chat_id: string;
    status: string;
    retry_count: number;
    last_error: string | null;
  }>;
  if (rows.length === 0) {
    console.log('Outbox is empty.');
    return;
  }
  for (const r of rows) {
    const err = r.last_error ? ` (${r.last_error})` : '';
    console.log(
      `[${r.status}] ${r.id}  ${r.channel_name}:${r.chat_id}  retries=${r.retry_count}${err}`,
    );
  }
}

function printUsage(): void {
  console.log(`Usage: monoclaw <command> [args]

Commands:
  status                       health check and agent status
  agents                       list all configured agents
  agents show <name>           show agent detail
  send <agent> <message>       fire-and-forget prompt
  chat <agent> [message]       streaming chat (interactive if no message given)
  restart <agent>              restart agent worker
  outbox                       show pending/failed outbox entries
`);
}

// ── Entry point ───────────────────────────────────────────────────────────

function die(err: unknown): void {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case 'status':
    cmdStatus().catch(die);
    break;
  case 'agents':
    cmdAgents(args[0], args[1]).catch(die);
    break;
  case 'send':
    cmdSend(args[0], args.slice(1).join(' ')).catch(die);
    break;
  case 'chat':
    cmdChat(args[0], args.slice(1).join(' ') || undefined).catch(die);
    break;
  case 'restart':
    cmdRestart(args[0]).catch(die);
    break;
  case 'outbox':
    cmdOutbox().catch(die);
    break;
  default:
    printUsage();
    if (cmd) process.exit(1);
}
