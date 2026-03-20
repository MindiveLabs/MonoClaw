/**
 * Config loader tests.
 *
 * Verifies that agent JSON files are read, validated, and that relative
 * paths are resolved against cwd.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const testDir = join(tmpdir(), `monoclaw-config-test-${Date.now()}`);
const agentsDir = join(testDir, 'config', 'agents');

// Redirect cwd() so the loader finds our temp config dir
vi.spyOn(process, 'cwd').mockReturnValue(testDir);

const { loadAgentConfigs } = await import('../src/config.js');

beforeEach(() => {
  mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('loadAgentConfigs', () => {
  it('returns empty array when config/agents is empty', () => {
    expect(loadAgentConfigs()).toEqual([]);
  });

  it('loads a valid agent config and derives name from filename', () => {
    writeFileSync(
      join(agentsDir, 'bob.json'),
      JSON.stringify({
        workspacePath: '.runtime/workspaces/bob',
        sessionDir: '.runtime/sessions/bob',
        routing: [{ channel: 'stdio', chatId: 'bob' }],
      }),
    );

    const configs = loadAgentConfigs();
    expect(configs).toHaveLength(1);
    const cfg = configs[0]!;
    expect(cfg.name).toBe('bob');
    expect(cfg.workspacePath).toBe(resolve(testDir, '.runtime/workspaces/bob'));
    expect(cfg.sessionDir).toBe(resolve(testDir, '.runtime/sessions/bob'));
    // memoryPath is the config source file, not the workspace copy
    expect(cfg.memoryPath).toBe(join(agentsDir, 'bob.md'));
    expect(cfg.routing).toEqual([{ channel: 'stdio', chatId: 'bob' }]);
  });

  it('accepts absolute paths unchanged', () => {
    writeFileSync(
      join(agentsDir, 'abs.json'),
      JSON.stringify({
        workspacePath: '/absolute/workspace',
        sessionDir: '/absolute/sessions',
        routing: [],
      }),
    );

    const [cfg] = loadAgentConfigs();
    expect(cfg!.workspacePath).toBe('/absolute/workspace');
    expect(cfg!.sessionDir).toBe('/absolute/sessions');
  });

  it('defaults routing to empty array when omitted', () => {
    writeFileSync(
      join(agentsDir, 'minimal.json'),
      JSON.stringify({ workspacePath: '.runtime/w', sessionDir: '.runtime/s' }),
    );
    const [cfg] = loadAgentConfigs();
    expect(cfg!.routing).toEqual([]);
  });

  it('throws on malformed JSON', () => {
    writeFileSync(join(agentsDir, 'bad.json'), '{ not valid json');
    expect(() => loadAgentConfigs()).toThrow(/Failed to parse/);
  });

  it('throws on invalid schema (missing required field)', () => {
    writeFileSync(
      join(agentsDir, 'invalid.json'),
      JSON.stringify({ sessionDir: '.runtime/s' }), // missing workspacePath
    );
    expect(() => loadAgentConfigs()).toThrow(/Invalid agent config/);
  });

  it('passes through optional model field', () => {
    writeFileSync(
      join(agentsDir, 'modeled.json'),
      JSON.stringify({
        workspacePath: '.runtime/workspaces/modeled',
        sessionDir: '.runtime/sessions/modeled',
        model: 'claude-opus-4-5',
        routing: [],
      }),
    );
    const [cfg] = loadAgentConfigs();
    expect(cfg!.model).toBe('claude-opus-4-5');
  });

  it('resolves skills paths relative to cwd', () => {
    writeFileSync(
      join(agentsDir, 'skilled.json'),
      JSON.stringify({
        workspacePath: '.runtime/workspaces/skilled',
        sessionDir: '.runtime/sessions/skilled',
        skills: ['./skills/my-skill', '/absolute/skill'],
        routing: [],
      }),
    );
    const [cfg] = loadAgentConfigs();
    expect(cfg!.skills).toEqual([
      resolve(testDir, 'skills/my-skill'),
      '/absolute/skill',
    ]);
  });

  it('leaves model and skills undefined when omitted', () => {
    writeFileSync(
      join(agentsDir, 'bare.json'),
      JSON.stringify({ workspacePath: '.runtime/w', sessionDir: '.runtime/s' }),
    );
    const [cfg] = loadAgentConfigs();
    expect(cfg!.model).toBeUndefined();
    expect(cfg!.skills).toBeUndefined();
  });
});
