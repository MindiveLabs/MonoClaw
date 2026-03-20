/**
 * HTTP API server for MonoClaw.
 *
 * Endpoints:
 *   GET  /v1/health                         liveness + agent/outbox stats
 *   GET  /v1/agents                         list all configured agents
 *   GET  /v1/agents/:name                   single agent detail
 *   POST /v1/agents/:name/messages          send prompt; returns { id }
 *                                           or SSE stream if Accept: text/event-stream
 *   GET  /v1/agents/:name/messages/:id      poll for reply
 *   POST /v1/agents/:name/restart           restart worker subprocess
 *   GET  /v1/outbox                         pending/failed outbox rows
 *
 * Port is written to {dataDir}/api-port on startup for CLI discovery.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import { getPendingOutbox } from './db.js';
import type { AgentProcess } from './agent.js';
import type { AgentFileConfig } from './config.js';

// Completed replies are held in memory for this long before eviction.
const REPLY_TTL_MS = 5 * 60 * 1000;

type ReplyStore = Map<string, { text: string; ts: number }>;

export async function startApi(
  agents: Map<string, AgentProcess>,
  agentConfigs: AgentFileConfig[],
  dataDir: string,
  logger: Logger,
): Promise<number> {
  const replies: ReplyStore = new Map();

  // Populate the reply store when any agent finishes a prompt (for poll mode).
  for (const agent of agents.values()) {
    agent.on('response', (ev: { requestId: string; text: string }) => {
      replies.set(ev.requestId, { text: ev.text, ts: Date.now() });
    });
  }

  // Evict stale replies to avoid unbounded growth.
  setInterval(() => {
    const cutoff = Date.now() - REPLY_TTL_MS;
    for (const [id, { ts }] of replies) {
      if (ts < cutoff) replies.delete(id);
    }
  }, 60_000).unref();

  const server = createServer((req, res) => {
    route(req, res, agents, agentConfigs, replies, logger).catch((err) => {
      logger.error({ err }, 'API handler error');
      if (!res.headersSent) json(res, 500, { error: 'internal server error' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      writeFileSync(join(dataDir, 'api-port'), String(port), 'utf-8');
      logger.info({ port }, 'API listening');
      resolve(port);
    });
  });
}

// ── Router ─────────────────────────────────────────────────────────────────

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  agents: Map<string, AgentProcess>,
  agentConfigs: AgentFileConfig[],
  replies: ReplyStore,
  logger: Logger,
): Promise<void> {
  const method = req.method ?? 'GET';
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;

  // GET /v1/health
  if (method === 'GET' && path === '/v1/health') {
    const outbox = getPendingOutbox();
    const pending = outbox.filter((r) => r.status === 'pending').length;
    const failed = outbox.filter((r) => r.status === 'failed').length;
    return json(res, 200, {
      status: 'ok',
      agents: agentConfigs.map((c) => ({ name: c.name, running: agents.has(c.name) })),
      outbox: { pending, failed },
    });
  }

  // GET /v1/outbox
  if (method === 'GET' && path === '/v1/outbox') {
    return json(res, 200, getPendingOutbox());
  }

  // GET /v1/agents
  if (method === 'GET' && path === '/v1/agents') {
    return json(
      res,
      200,
      agentConfigs.map((c) => ({
        name: c.name,
        running: agents.has(c.name),
        routing: c.routing,
        workspacePath: c.workspacePath,
        sessionDir: c.sessionDir,
      })),
    );
  }

  // All remaining routes are under /v1/agents/:name
  const agentMatch = path.match(/^\/v1\/agents\/([^/]+)(\/.*)?$/);
  if (!agentMatch) return notFound(res);

  const agentName = decodeURIComponent(agentMatch[1]!);
  const subPath = agentMatch[2] ?? '';

  // GET /v1/agents/:name
  if (method === 'GET' && subPath === '') {
    const cfg = agentConfigs.find((c) => c.name === agentName);
    if (!cfg) return json(res, 404, { error: `Agent '${agentName}' not found` });
    return json(res, 200, {
      name: cfg.name,
      running: agents.has(cfg.name),
      routing: cfg.routing,
      workspacePath: cfg.workspacePath,
      sessionDir: cfg.sessionDir,
      memoryPath: cfg.memoryPath,
    });
  }

  // POST /v1/agents/:name/restart
  if (method === 'POST' && subPath === '/restart') {
    const agent = agents.get(agentName);
    if (!agent) return json(res, 404, { error: `Agent '${agentName}' not found` });
    await agent.stop();
    await agent.start();
    logger.info({ agent: agentName }, 'restarted via API');
    return json(res, 200, { ok: true });
  }

  // POST /v1/agents/:name/messages
  if (method === 'POST' && subPath === '/messages') {
    const agent = agents.get(agentName);
    if (!agent) return json(res, 404, { error: `Agent '${agentName}' not found` });

    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }

    const text = typeof body.text === 'string' ? body.text : null;
    if (!text) return json(res, 400, { error: 'Missing required field: text' });
    const chatId = typeof body.chatId === 'string' ? body.chatId : 'cli';

    const requestId = agent.prompt(text, chatId, '__api__');

    if (req.headers.accept?.includes('text/event-stream')) {
      return streamResponse(req, res, agent, requestId);
    }
    return json(res, 202, { id: requestId });
  }

  // GET /v1/agents/:name/messages/:id
  const msgMatch = subPath.match(/^\/messages\/([^/]+)$/);
  if (method === 'GET' && msgMatch) {
    const msgId = msgMatch[1]!;
    const reply = replies.get(msgId);
    if (!reply) return json(res, 200, { status: 'pending' });
    return json(res, 200, { status: 'done', text: reply.text });
  }

  notFound(res);
}

// ── SSE streaming ──────────────────────────────────────────────────────────

function streamResponse(
  req: IncomingMessage,
  res: ServerResponse,
  agent: AgentProcess,
  requestId: string,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // Flush headers immediately so the client receives the 200 before any events arrive.
  res.flushHeaders();

  const onDelta = (ev: { requestId: string; text: string }) => {
    if (ev.requestId !== requestId) return;
    res.write(`data: ${JSON.stringify({ type: 'delta', text: ev.text })}\n\n`);
  };

  const onResponse = (ev: { requestId: string; text: string }) => {
    if (ev.requestId !== requestId) return;
    cleanup();
    res.write(`data: ${JSON.stringify({ type: 'done', text: ev.text })}\n\n`);
    res.end();
  };

  const onInterrupt = (ev: { requestId: string }) => {
    if (ev.requestId !== requestId) return;
    cleanup();
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'agent restarted' })}\n\n`);
    res.end();
  };

  const cleanup = () => {
    agent.off('delta', onDelta);
    agent.off('response', onResponse);
    agent.off('interrupt', onInterrupt);
  };

  agent.on('delta', onDelta);
  agent.on('response', onResponse);
  agent.on('interrupt', onInterrupt);
  req.on('close', cleanup);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse): void {
  json(res, 404, { error: 'not found' });
}

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) return; // drain without storing
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (total > MAX_BODY_BYTES) {
        return reject(new Error('Request body too large'));
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
