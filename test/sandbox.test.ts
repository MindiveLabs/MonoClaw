/**
 * Sandbox smoke tests (T6, T7).
 *
 * These are integration tests that require:
 *   - macOS: /usr/bin/sandbox-exec to be present
 *   - Linux: bwrap to be installed
 *
 * They verify that the sandbox policy allows workspace access and
 * denies access to paths outside the workspace.
 *
 * These tests are skipped if the sandbox binary is not available.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, platform, homedir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxedSpawn } from '../src/sandbox.js';

const os = platform();
const hasSandboxExec = os === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const hasBwrap = os === 'linux' && (() => {
  try { execSync('which bwrap', { stdio: 'ignore' }); return true; } catch { return false; }
})();
const hasSandbox = hasSandboxExec || hasBwrap;

const workspace = join(tmpdir(), `monoclaw-sandbox-test-${Date.now()}`);
const sessionDir = join(workspace, 'sessions');
const nodeModulesPath = join(process.cwd(), 'node_modules');
const nodePath = process.execPath;
const proxyPort = 9999;

beforeAll(() => {
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(workspace, 'hello.txt'), 'hello from workspace', 'utf-8');
});

describe.skipIf(!hasSandbox)('sandbox smoke tests', () => {
  it('T6: sandbox allows reading workspace files', () => {
    const testScript = join(workspace, 'read-test.mjs');
    writeFileSync(
      testScript,
      `import { readFileSync } from 'fs';
const data = readFileSync('${join(workspace, 'hello.txt')}', 'utf-8');
process.stdout.write(data);`,
      'utf-8',
    );

    const { cmd, args, spawnOpts } = buildSandboxedSpawn(testScript, [], process.env, {
      agentName: 'test-agent',
      workspacePath: workspace,
      sessionDir,
      proxyPort,
      nodeModulesPath,
      nodePath,
    });

    const result = spawnSync(cmd, args, {
      env: spawnOpts.env ?? process.env,
      encoding: 'utf-8',
      timeout: 10_000,
    });

    expect(result.stdout).toContain('hello from workspace');
    expect(result.status).toBe(0);
  });

  it('T7: sandbox denies writing files outside workspace', () => {
    // Note: sandbox-exec with modern Node.js requires broad file-read* (subpath "/")
    // to avoid startup hangs caused by unpredictable Node internals.
    // The write restriction (workspace + sessionDir only) is the primary sandbox security value.
    const testScript = join(workspace, 'escape-test.mjs');
    // Try to write to the user's home dir — clearly outside the workspace
    const escapeTarget = join(homedir(), 'monoclaw-escape-test.txt');
    writeFileSync(
      testScript,
      `import { writeFileSync } from 'fs';
try {
  writeFileSync('${escapeTarget}', 'escaped', 'utf-8');
  process.stdout.write('ESCAPED');
} catch (e) {
  process.stdout.write('BLOCKED:' + e.code);
}`,
      'utf-8',
    );

    const { cmd, args, spawnOpts } = buildSandboxedSpawn(testScript, [], process.env, {
      agentName: 'test-agent',
      workspacePath: workspace,
      sessionDir,
      proxyPort,
      nodeModulesPath,
      nodePath,
    });

    const result = spawnSync(cmd, args, {
      env: spawnOpts.env ?? process.env,
      encoding: 'utf-8',
      timeout: 10_000,
    });

    // Write outside workspace should be denied
    expect(result.stdout).not.toContain('ESCAPED');
  });
});

describe.skipIf(hasSandbox)('sandbox not available', () => {
  it('returns unsandboxed spawn with warning', () => {
    const { cmd } = buildSandboxedSpawn('worker.js', [], {}, {
      agentName: 'test',
      workspacePath: workspace,
      sessionDir,
      proxyPort,
      nodeModulesPath,
      nodePath,
    });
    // Falls back to node directly
    expect(cmd).toBe(nodePath);
  });
});
