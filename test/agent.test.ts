/**
 * AgentProcess tests (T1–T5).
 *
 * These tests mock the worker subprocess so they don't require pimono or a
 * real sandbox to be installed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import pino from 'pino';

const testDir = join(tmpdir(), `monoclaw-agent-test-${Date.now()}`);
process.env.MONOCLAW_DATA_DIR = testDir;

// We need to mock `child_process.spawn` and `./sandbox.js` to avoid real subprocess
vi.mock('../src/sandbox.js', () => ({
  buildSandboxedSpawn: vi.fn().mockReturnValue({
    cmd: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
    spawnOpts: { env: process.env },
  }),
}));

vi.mock('../src/db.js', () => ({
  upsertSessionFile: vi.fn(),
  enqueueOutbox: vi.fn().mockReturnValue('mock-outbox-id'),
  storeMessage: vi.fn(),
}));

const { AgentProcess } = await import('../src/agent.js');

const cfg = {
  name: 'test-agent',
  workspacePath: join(testDir, 'workspace'),
  memoryPath: join(testDir, 'workspace', 'AGENTS.md'),
  sessionDir: join(testDir, 'sessions'),
};

const logger = pino({ level: 'silent' });

beforeEach(() => {
  mkdirSync(cfg.workspacePath, { recursive: true });
  mkdirSync(cfg.sessionDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('AgentProcess', () => {
  it('T5: stop() terminates the subprocess cleanly', async () => {
    const agent = new AgentProcess(cfg, 9999, logger);
    await agent.start();
    // Should not throw
    await expect(agent.stop()).resolves.toBeUndefined();
  });

  it('T3: concurrent prompts are queued', async () => {
    const agent = new AgentProcess(cfg, 9999, logger);
    await agent.start();

    const sent: string[] = [];
    // Intercept queue behavior — both prompts should be accepted without error
    expect(() => {
      agent.prompt('first message', 'chat1', 'stdio');
      agent.prompt('second message', 'chat1', 'stdio'); // should be queued, not dropped
    }).not.toThrow();

    await agent.stop();
  });

  it('T1: AGENTS.md is created if missing', async () => {
    const agent = new AgentProcess(cfg, 9999, logger);
    await agent.start();
    const { existsSync } = await import('node:fs');
    expect(existsSync(cfg.memoryPath)).toBe(true);
    await agent.stop();
  });
});
