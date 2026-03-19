import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Point DB at a temp dir for each test run
const testDataDir = join(tmpdir(), `monoclaw-test-${Date.now()}`);
process.env.MONOCLAW_DATA_DIR = testDataDir;

// Import after setting env so getDb() picks up testDataDir
const { getDb, closeDb, upsertAgent, getAllAgents, resolveAgent, setRouting,
        storeMessage, enqueueOutbox, getPendingOutbox,
        markOutboxSent, markOutboxFailed } = await import('../src/db.js');

beforeEach(() => {
  mkdirSync(testDataDir, { recursive: true });
});

afterEach(() => {
  closeDb();
  rmSync(testDataDir, { recursive: true, force: true });
});

describe('agents', () => {
  it('upserts and retrieves an agent', () => {
    upsertAgent({
      name: 'alice',
      workspacePath: '/ws/alice',
      memoryPath: '/ws/alice/AGENTS.md',
      sessionDir: '/sessions/alice',
    });
    const agents = getAllAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe('alice');
  });

  it('updates an existing agent on upsert', () => {
    upsertAgent({ name: 'bob', workspacePath: '/old', memoryPath: '/m', sessionDir: '/s' });
    upsertAgent({ name: 'bob', workspacePath: '/new', memoryPath: '/m', sessionDir: '/s' });
    const agents = getAllAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]!.workspacePath).toBe('/new');
  });
});

describe('routing', () => {
  it('resolves routing entry', () => {
    upsertAgent({ name: 'alice', workspacePath: '/ws', memoryPath: '/m', sessionDir: '/s' });
    setRouting('telegram', '12345', 'alice');
    expect(resolveAgent('telegram', '12345')).toBe('alice');
  });

  it('returns null for unknown chatId', () => {
    expect(resolveAgent('telegram', 'unknown')).toBeNull();
  });
});

describe('outbox', () => {
  it('enqueues and retrieves pending rows', () => {
    enqueueOutbox('telegram', '123', 'hello world');
    const rows = getPendingOutbox();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload).text).toBe('hello world');
    expect(rows[0]!.status).toBe('pending');
  });

  it('marks as sent', () => {
    const id = enqueueOutbox('telegram', '123', 'hi');
    markOutboxSent(id);
    expect(getPendingOutbox()).toHaveLength(0);
  });

  it('marks as failed then dead after max retries', () => {
    const id = enqueueOutbox('telegram', '123', 'hi');
    // 5 failures → dead
    for (let i = 0; i < 5; i++) {
      markOutboxFailed(id, 'network error');
    }
    const rows = getDb()
      .prepare('SELECT status, retry_count FROM outbox WHERE id = ?')
      .get(id) as { status: string; retry_count: number };
    expect(rows.status).toBe('dead');
    expect(rows.retry_count).toBe(5);
  });
});

describe('messages', () => {
  it('stores inbound and outbound messages', () => {
    storeMessage('alice', 'telegram', 'inbound', 'hello');
    storeMessage('alice', 'telegram', 'outbound', 'hi there');
    const rows = getDb()
      .prepare('SELECT * FROM messages WHERE agent_name = ?')
      .all('alice') as Array<{ direction: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.direction).sort()).toEqual(['inbound', 'outbound']);
  });
});
