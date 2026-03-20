/**
 * Config loader tests.
 *
 * Verifies that agent subdirectory configs are read, validated, and that
 * relative paths are resolved against cwd.
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

/** Create a minimal agent subdirectory with a JSON config file. */
function makeAgent(name: string, cfg: object): void {
  const dir = join(agentsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(cfg));
}

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

  it('loads a valid agent config and derives name from directory', () => {
    makeAgent('bob', {
      workspacePath: '.runtime/workspaces/bob',
      sessionDir: '.runtime/sessions/bob',
      routing: [{ channel: 'stdio', chatId: 'bob' }],
    });

    const configs = loadAgentConfigs();
    expect(configs).toHaveLength(1);
    const cfg = configs[0]!;
    expect(cfg.name).toBe('bob');
    expect(cfg.workspacePath).toBe(resolve(testDir, '.runtime/workspaces/bob'));
    expect(cfg.sessionDir).toBe(resolve(testDir, '.runtime/sessions/bob'));
    // memoryPath lives inside the agent subdirectory
    expect(cfg.memoryPath).toBe(join(agentsDir, 'bob', 'bob.md'));
    expect(cfg.routing).toEqual([{ channel: 'stdio', chatId: 'bob' }]);
  });

  it('skips subdirs that have no matching <name>.json', () => {
    mkdirSync(join(agentsDir, 'empty-dir'), { recursive: true });
    expect(loadAgentConfigs()).toEqual([]);
  });

  it('accepts absolute paths unchanged', () => {
    makeAgent('abs', {
      workspacePath: '/absolute/workspace',
      sessionDir: '/absolute/sessions',
      routing: [],
    });

    const [cfg] = loadAgentConfigs();
    expect(cfg!.workspacePath).toBe('/absolute/workspace');
    expect(cfg!.sessionDir).toBe('/absolute/sessions');
  });

  it('defaults routing to empty array when omitted', () => {
    makeAgent('minimal', { workspacePath: '.runtime/w', sessionDir: '.runtime/s' });
    const [cfg] = loadAgentConfigs();
    expect(cfg!.routing).toEqual([]);
  });

  it('throws on malformed JSON', () => {
    const dir = join(agentsDir, 'bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), '{ not valid json');
    expect(() => loadAgentConfigs()).toThrow(/Failed to parse/);
  });

  it('throws on invalid schema (missing required field)', () => {
    makeAgent('invalid', { sessionDir: '.runtime/s' }); // missing workspacePath
    expect(() => loadAgentConfigs()).toThrow(/Invalid agent config/);
  });

  it('passes through optional model field', () => {
    makeAgent('modeled', {
      workspacePath: '.runtime/workspaces/modeled',
      sessionDir: '.runtime/sessions/modeled',
      model: 'claude-opus-4-5',
      routing: [],
    });
    const [cfg] = loadAgentConfigs();
    expect(cfg!.model).toBe('claude-opus-4-5');
  });

  it('auto-includes the skills/ subdirectory when present', () => {
    makeAgent('skilled', {
      workspacePath: '.runtime/workspaces/skilled',
      sessionDir: '.runtime/sessions/skilled',
      routing: [],
    });
    mkdirSync(join(agentsDir, 'skilled', 'skills'), { recursive: true });

    const [cfg] = loadAgentConfigs();
    expect(cfg!.skills).toEqual([join(agentsDir, 'skilled', 'skills')]);
  });

  it('prepends skills/ dir before explicit skills entries', () => {
    makeAgent('skilled', {
      workspacePath: '.runtime/workspaces/skilled',
      sessionDir: '.runtime/sessions/skilled',
      skills: ['/absolute/skill'],
      routing: [],
    });
    mkdirSync(join(agentsDir, 'skilled', 'skills'), { recursive: true });

    const [cfg] = loadAgentConfigs();
    expect(cfg!.skills).toEqual([
      join(agentsDir, 'skilled', 'skills'),
      '/absolute/skill',
    ]);
  });

  it('resolves explicit skill paths relative to cwd', () => {
    makeAgent('skilled', {
      workspacePath: '.runtime/workspaces/skilled',
      sessionDir: '.runtime/sessions/skilled',
      skills: ['./extra/my-skill', '/absolute/skill'],
      routing: [],
    });
    // No skills/ directory — only explicit paths
    const [cfg] = loadAgentConfigs();
    expect(cfg!.skills).toEqual([
      resolve(testDir, 'extra/my-skill'),
      '/absolute/skill',
    ]);
  });

  it('leaves model and skills undefined when omitted and no skills/ dir', () => {
    makeAgent('bare', { workspacePath: '.runtime/w', sessionDir: '.runtime/s' });
    const [cfg] = loadAgentConfigs();
    expect(cfg!.model).toBeUndefined();
    expect(cfg!.skills).toBeUndefined();
  });
});
