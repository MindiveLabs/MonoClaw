/**
 * HTTP API tests.
 *
 * Spins up a real HTTP server with a mock AgentProcess to test all routes.
 * No real worker subprocess or pimono required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

const testDir = join(tmpdir(), `monoclaw-api-test-${Date.now()}`);

vi.mock('../src/db.js', () => ({
  getPendingOutbox: vi.fn().mockReturnValue([
    {
      id: 'out-1',
      channel_name: 'telegram',
      chat_id: '999',
      payload: '{"text":"hi"}',
      status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    },
  ]),
}));

class MockAgent extends EventEmitter {
  config: { name: string };
  lastPrompt: { text: string; chatId: string; channelName: string } | null = null;
  promptRequestId = 'req-mock-1';

  constructor(name: string) {
    super();
    this.config = { name };
  }

  prompt(text: string, chatId: string, channelName: string): string {
    this.lastPrompt = { text, chatId, channelName };
    return this.promptRequestId;
  }

  async stop() {}
  async start() {}
}

function makeConfig(name: string) {
  return {
    name,
    workspacePath: join(testDir, 'workspace', name),
    sessionDir: join(testDir, 'sessions', name),
    memoryPath: join(testDir, 'config', 'agents', `${name}.md`),
    routing: [{ channel: 'stdio', chatId: name }],
  };
}

async function req(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    body: await res.json().catch(() => null),
  };
}

const { startApi } = await import('../src/api.js');

let port: number;
let alice: MockAgent;
let agents: Map<string, MockAgent>;

beforeEach(async () => {
  mkdirSync(testDir, { recursive: true });
  alice = new MockAgent('alice');
  agents = new Map([['alice', alice]]);
  port = await startApi(
    agents as never,
    [makeConfig('alice')],
    testDir,
    { info: () => {}, error: () => {}, debug: () => {}, warn: () => {}, child: () => ({ info: () => {}, error: () => {}, debug: () => {}, warn: () => {} }) } as never,
  );
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('GET /v1/health', () => {
  it('returns 200 with agent and outbox status', async () => {
    const { status, body } = await req(port, 'GET', '/v1/health');
    expect(status).toBe(200);
    const b = body as { status: string; agents: Array<{ name: string; running: boolean }>; outbox: { pending: number; failed: number } };
    expect(b.status).toBe('ok');
    expect(b.agents).toEqual([{ name: 'alice', running: true }]);
    expect(b.outbox.pending).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /v1/outbox', () => {
  it('returns outbox rows', async () => {
    const { status, body } = await req(port, 'GET', '/v1/outbox');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });
});

describe('GET /v1/agents', () => {
  it('returns list of agents', async () => {
    const { status, body } = await req(port, 'GET', '/v1/agents');
    expect(status).toBe(200);
    const list = body as Array<{ name: string; running: boolean }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('alice');
    expect(list[0]!.running).toBe(true);
  });
});

describe('GET /v1/agents/:name', () => {
  it('returns agent detail', async () => {
    const { status, body } = await req(port, 'GET', '/v1/agents/alice');
    expect(status).toBe(200);
    const b = body as { name: string; running: boolean; routing: unknown[] };
    expect(b.name).toBe('alice');
    expect(b.running).toBe(true);
    expect(b.routing).toHaveLength(1);
  });

  it('returns 404 for unknown agent', async () => {
    const { status } = await req(port, 'GET', '/v1/agents/bob');
    expect(status).toBe(404);
  });
});

describe('POST /v1/agents/:name/messages', () => {
  it('queues prompt and returns requestId', async () => {
    const { status, body } = await req(port, 'POST', '/v1/agents/alice/messages', { text: 'hello' });
    expect(status).toBe(202);
    expect((body as { id: string }).id).toBe('req-mock-1');
    expect(alice.lastPrompt?.text).toBe('hello');
    expect(alice.lastPrompt?.channelName).toBe('__api__');
  });

  it('returns 400 when text is missing', async () => {
    const { status } = await req(port, 'POST', '/v1/agents/alice/messages', { chatId: 'cli' });
    expect(status).toBe(400);
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/agents/alice/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for oversized body', async () => {
    const large = 'x'.repeat(2 * 1024 * 1024); // 2 MB
    const res = await fetch(`http://127.0.0.1:${port}/v1/agents/alice/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: large }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown agent', async () => {
    const { status } = await req(port, 'POST', '/v1/agents/bob/messages', { text: 'hi' });
    expect(status).toBe(404);
  });
});

describe('GET /v1/agents/:name/messages/:id', () => {
  it('returns pending when reply not yet stored', async () => {
    const { status, body } = await req(port, 'GET', '/v1/agents/alice/messages/no-such-id');
    expect(status).toBe(200);
    expect((body as { status: string }).status).toBe('pending');
  });

  it('returns done after agent emits response event', async () => {
    alice.promptRequestId = 'req-poll-1';
    await req(port, 'POST', '/v1/agents/alice/messages', { text: 'poll test' });
    // Simulate agent completing the request
    alice.emit('response', { requestId: 'req-poll-1', text: 'the answer', chatId: 'cli', channelName: '__api__' });

    const { status, body } = await req(port, 'GET', '/v1/agents/alice/messages/req-poll-1');
    expect(status).toBe(200);
    const b = body as { status: string; text: string };
    expect(b.status).toBe('done');
    expect(b.text).toBe('the answer');
  });
});

describe('POST /v1/agents/:name/restart', () => {
  it('restarts agent and returns ok', async () => {
    const stopSpy = vi.spyOn(alice, 'stop').mockResolvedValue(undefined);
    const startSpy = vi.spyOn(alice, 'start').mockResolvedValue(undefined);
    const { status, body } = await req(port, 'POST', '/v1/agents/alice/restart', {});
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
    expect(stopSpy).toHaveBeenCalledOnce();
    expect(startSpy).toHaveBeenCalledOnce();
  });

  it('returns 404 for unknown agent', async () => {
    const { status } = await req(port, 'POST', '/v1/agents/bob/restart', {});
    expect(status).toBe(404);
  });
});

describe('unknown routes', () => {
  it('returns 404 for unrecognised path', async () => {
    const { status } = await req(port, 'GET', '/v1/unknown');
    expect(status).toBe(404);
  });
});

describe('SSE streaming', () => {
  it('streams delta events and closes on done', async () => {
    alice.promptRequestId = 'req-sse-1';
    const chunks: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const bodyStr = JSON.stringify({ text: 'stream me' });
      const httpReq = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/agents/alice/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr),
            Accept: 'text/event-stream',
          },
        },
        (res) => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          res.setEncoding('utf-8');
          let buf = '';
          res.on('data', (chunk: string) => {
            buf += chunk;
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
              if (line.startsWith('data: ')) chunks.push(line.slice(6));
            }
          });
          res.on('end', resolve);
          res.on('error', reject);
          // Emit delta then done from the mock agent after a tick
          setImmediate(() => {
            alice.emit('delta', { requestId: 'req-sse-1', text: 'Hello' });
            alice.emit('delta', { requestId: 'req-sse-1', text: ' world' });
            alice.emit('response', {
              requestId: 'req-sse-1',
              text: 'Hello world',
              chatId: 'cli',
              channelName: '__api__',
            });
          });
        },
      );
      httpReq.on('error', reject);
      httpReq.write(bodyStr);
      httpReq.end();
    });

    const events = chunks.map((c) => JSON.parse(c) as { type: string; text?: string });
    expect(events[0]).toEqual({ type: 'delta', text: 'Hello' });
    expect(events[1]).toEqual({ type: 'delta', text: ' world' });
    expect(events[2]).toEqual({ type: 'done', text: 'Hello world' });
  });

  it('sends error event when agent is interrupted', async () => {
    alice.promptRequestId = 'req-sse-2';
    const chunks: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const bodyStr = JSON.stringify({ text: 'interrupt me' });
      const httpReq = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/agents/alice/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr),
            Accept: 'text/event-stream',
          },
        },
        (res) => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          res.setEncoding('utf-8');
          let buf = '';
          res.on('data', (chunk: string) => {
            buf += chunk;
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
              if (line.startsWith('data: ')) chunks.push(line.slice(6));
            }
          });
          res.on('end', resolve);
          res.on('error', reject);
          setImmediate(() => {
            alice.emit('interrupt', { requestId: 'req-sse-2' });
          });
        },
      );
      httpReq.on('error', reject);
      httpReq.write(bodyStr);
      httpReq.end();
    });

    const events = chunks.map((c) => JSON.parse(c) as { type: string; message?: string });
    expect(events[0]).toMatchObject({ type: 'error', message: 'agent restarted' });
  });
});
