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
import { pathToFileURL } from 'node:url';
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

const { AgentProcess, resolveWorkerRuntime } = await import('../src/agent.js');
const { buildSandboxedSpawn } = await import('../src/sandbox.js');

const cfg = {
  name: 'test-agent',
  workspacePath: join(testDir, 'workspace'),
  // memoryPath is the config source (config/agents/<name>.md),
  // NOT the workspace copy — agent.ts copies it into the workspace.
  memoryPath: join(testDir, 'config', 'agents', 'test-agent.md'),
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

  it('T6: model and skills from config are passed as env vars to worker', async () => {
    const cfgWithExtras = {
      ...cfg,
      model: 'claude-opus-4-5',
      skills: ['/some/skill/path'],
    };
    const spy = vi.mocked(buildSandboxedSpawn);
    spy.mockClear();

    const agent = new AgentProcess(cfgWithExtras, 9999, logger);
    await agent.start();

    expect(spy).toHaveBeenCalled();
    const envArg = spy.mock.calls[0]![2] as Record<string, string | undefined>;
    expect(envArg['MONOCLAW_MODEL']).toBe('claude-opus-4-5');
    expect(JSON.parse(envArg['MONOCLAW_SKILLS']!)).toEqual(['/some/skill/path']);

    await agent.stop();
  });

  it('T1: AGENTS.md source is created in config and copied to workspace', async () => {
    const agent = new AgentProcess(cfg, 9999, logger);
    await agent.start();
    const { existsSync, join: pathJoin } = await import('node:fs').then(
      async (fs) => ({ existsSync: fs.existsSync, join: (await import('node:path')).join }),
    );
    // Config source file created
    expect(existsSync(cfg.memoryPath)).toBe(true);
    // Workspace copy created for pimono
    expect(existsSync(pathJoin(cfg.workspacePath, 'AGENTS.md'))).toBe(true);
    await agent.stop();
  });
});

describe('resolveWorkerRuntime', () => {
  it('prefers worker.js when present', () => {
    const dir = join(testDir, 'runtime-js');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'worker.js'), 'export {};\n', 'utf-8');
    writeFileSync(join(dir, 'worker.ts'), 'export {};\n', 'utf-8');
    writeFileSync(join(dir, 'agent.ts'), 'export {};\n', 'utf-8');

    const runtime = resolveWorkerRuntime(pathToFileURL(join(dir, 'agent.ts')).href);
    expect(runtime.scriptPath).toBe(join(dir, 'worker.js'));
    expect(runtime.requiresTsxLoader).toBe(false);
  });

  it('falls back to worker.ts when worker.js is missing', () => {
    const dir = join(testDir, 'runtime-ts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'worker.ts'), 'export {};\n', 'utf-8');
    writeFileSync(join(dir, 'agent.ts'), 'export {};\n', 'utf-8');

    const runtime = resolveWorkerRuntime(pathToFileURL(join(dir, 'agent.ts')).href);
    expect(runtime.scriptPath).toBe(join(dir, 'worker.ts'));
    expect(runtime.requiresTsxLoader).toBe(true);
  });
});
