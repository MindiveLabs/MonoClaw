import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startCredentialProxy } from '../src/credential-proxy.js';
import pino from 'pino';

const log = pino({ level: 'silent' });

// Fake upstream: records last received x-api-key header
let lastApiKey: string | undefined;
let upstreamServer: Server;
let upstreamPort: number;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    upstreamServer = createServer((req, res) => {
      lastApiKey = req.headers['x-api-key'] as string | undefined;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    upstreamServer.listen(0, '127.0.0.1', () => {
      const addr = upstreamServer.address();
      upstreamPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
  // Point the proxy at our fake upstream
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstreamPort}`;
  process.env.ANTHROPIC_API_KEY = 'real-secret-key';
});

afterAll(() => {
  upstreamServer.close();
});

describe('credential-proxy', () => {
  it('T14: valid request is forwarded with real key substituted', async () => {
    const { server, port } = await startCredentialProxy(log);

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'worker-dummy-token',  // worker sends dummy
      },
      body: JSON.stringify({ model: 'test' }),
    });

    expect(res.status).toBe(200);
    // Upstream should have received the REAL key, not the dummy
    expect(lastApiKey).toBe('real-secret-key');

    await new Promise<void>((res) => server.close(() => res()));
  });

  it('T15: proxy binds to localhost only', async () => {
    const { server, port } = await startCredentialProxy(log);
    const addr = server.address();
    expect(typeof addr).toBe('object');
    expect((addr as { address: string }).address).toBe('127.0.0.1');
    await new Promise<void>((res) => server.close(() => res()));
  });
});
