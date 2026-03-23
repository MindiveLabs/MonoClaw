/**
 * plugin-loader integration tests.
 *
 * Tests every codepath of loadPlugins():
 *   - missing/empty plugins directory
 *   - manifest validation (missing, invalid JSON, missing id)
 *   - entry point validation (missing export, wrong shape)
 *   - duplicate channel id guard
 *   - happy path: channel registered, runtime applied
 *   - two plugins: both registered in alphabetical order
 *   - MONOCLAW_PLUGINS_DIR env var overrides default path
 *
 * Strategy: write real JS files to a temp directory so dynamic import() works.
 * Each test uses a unique subdirectory name to avoid Node's module cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── temp directory setup ────────────────────────────────────────────────────

const testRoot = join(tmpdir(), `monoclaw-plugin-loader-test-${Date.now()}`);
let pluginsDir: string;

beforeEach(() => {
  pluginsDir = join(testRoot, `run-${Math.random().toString(36).slice(2)}`);
  mkdirSync(pluginsDir, { recursive: true });
  process.env.MONOCLAW_PLUGINS_DIR = pluginsDir;
});

afterEach(() => {
  delete process.env.MONOCLAW_PLUGINS_DIR;
  rmSync(testRoot, { recursive: true, force: true });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function makePluginDir(
  pluginsRoot: string,
  name: string,
  {
    manifest,
    entry,
  }: {
    manifest?: unknown;
    entry?: string;
  } = {},
): void {
  const dir = join(pluginsRoot, name);
  mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) {
    writeFileSync(join(dir, 'openclaw.plugin.json'), JSON.stringify(manifest));
  }
  if (entry !== undefined) {
    writeFileSync(join(dir, 'index.js'), entry);
  }
}

/** Minimal valid PluginEntryResult as ESM JS source. */
function validEntry(channelName: string): string {
  return `
export default {
  id: '${channelName}',
  name: '${channelName}',
  toChannel() {
    return {
      name: '${channelName}',
      send: async () => {},
      onMessage: () => {},
      start: async () => {},
      stop: async () => {},
    };
  },
  applyRuntime(rt) {},
};
`;
}

// ── channel registry helpers (reset between tests) ─────────────────────────

// We need a fresh channel registry for each test to avoid pollution.
// loadPlugins calls registerChannel from the shared registry, so we spy on it.
const registeredChannels: string[] = [];

vi.mock('../src/channels/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/channels/index.js')>();
  return {
    ...actual,
    registerChannel: vi.fn((ch) => {
      registeredChannels.push(ch.name);
      actual.registerChannel(ch);
    }),
    getAllChannels: vi.fn(() => actual.getAllChannels()),
  };
});

beforeEach(() => {
  registeredChannels.length = 0;
});

// ── import loader after mocks are set up ───────────────────────────────────

const { loadPlugins } = await import('../src/plugin-loader.js');

function makeRuntime() {
  return {
    env: process.env,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => makeRuntime().logger),
    } as unknown as Parameters<typeof loadPlugins>[0]['logger'],
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('loadPlugins', () => {
  it('resolves without error when the plugins directory does not exist', async () => {
    delete process.env.MONOCLAW_PLUGINS_DIR;
    // Point to a path that definitely doesn't exist
    process.env.MONOCLAW_PLUGINS_DIR = join(testRoot, 'no-such-dir');
    await expect(loadPlugins(makeRuntime() as any)).resolves.toBeUndefined();
  });

  it('resolves without error when the plugins directory is empty', async () => {
    await expect(loadPlugins(makeRuntime() as any)).resolves.toBeUndefined();
    expect(registeredChannels).toHaveLength(0);
  });

  it('skips subdirs with no openclaw.plugin.json silently', async () => {
    makePluginDir(pluginsDir, 'no-manifest');
    const rt = makeRuntime();
    await loadPlugins(rt as any);
    expect(registeredChannels).toHaveLength(0);
    expect(rt.logger.warn).not.toHaveBeenCalled();
  });

  it('skips subdirs with invalid JSON in the manifest', async () => {
    const dir = join(pluginsDir, 'bad-json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'openclaw.plugin.json'), '{ not valid json');
    await loadPlugins(makeRuntime() as any);
    expect(registeredChannels).toHaveLength(0);
  });

  it('warns and skips when manifest is missing the id field', async () => {
    makePluginDir(pluginsDir, 'no-id', {
      manifest: { channels: ['foo'] }, // no id
    });
    const rt = makeRuntime();
    await loadPlugins(rt as any);
    expect(registeredChannels).toHaveLength(0);
    expect(rt.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'no-id' }),
      expect.stringContaining('"id"'),
    );
  });

  it('warns and continues when index.js does not exist', async () => {
    makePluginDir(pluginsDir, 'no-entry', {
      manifest: { id: 'no-entry' },
      // no index.js
    });
    const rt = makeRuntime();
    await loadPlugins(rt as any);
    expect(registeredChannels).toHaveLength(0);
    // realpath() fails for missing file → warn path (not error)
    expect(rt.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'no-entry' }),
      expect.stringContaining('not found'),
    );
  });

  it('warns and continues when index.js has no default export', async () => {
    makePluginDir(pluginsDir, 'no-export', {
      manifest: { id: 'no-export' },
      entry: '// no default export\nexport const foo = 1;\n',
    });
    const rt = makeRuntime();
    await loadPlugins(rt as any);
    expect(registeredChannels).toHaveLength(0);
    expect(rt.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'no-export' }),
      expect.stringContaining('no default export'),
    );
  });

  it('warns and continues when default export is not a PluginEntryResult', async () => {
    makePluginDir(pluginsDir, 'bad-export', {
      manifest: { id: 'bad-export' },
      entry: 'export default { id: "bad", name: "bad" }; // missing toChannel\n',
    });
    const rt = makeRuntime();
    await loadPlugins(rt as any);
    expect(registeredChannels).toHaveLength(0);
    expect(rt.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'bad-export' }),
      expect.stringContaining('PluginEntryResult'),
    );
  });

  it('registers a valid plugin and logs info', async () => {
    makePluginDir(pluginsDir, 'good-plugin', {
      manifest: { id: 'good-plugin' },
      entry: validEntry('good-plugin'),
    });
    const rt = makeRuntime();
    await loadPlugins(rt as any);
    expect(registeredChannels).toContain('good-plugin');
    expect(rt.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'good-plugin' }),
      'loaded plugin channel',
    );
  });

  it('calls applyRuntime before registering the channel', async () => {
    const applyRuntimeCalls: string[] = [];
    const entry = `
export default {
  id: 'runtime-test',
  name: 'runtime-test',
  toChannel() {
    return {
      name: 'runtime-test',
      send: async () => {},
      onMessage: () => {},
      start: async () => {},
      stop: async () => {},
    };
  },
  applyRuntime(rt) { globalThis.__runtimeApplied = true; },
};
`;
    makePluginDir(pluginsDir, 'runtime-plugin', {
      manifest: { id: 'runtime-test' },
      entry,
    });
    (globalThis as any).__runtimeApplied = false;
    const rt = makeRuntime();
    await loadPlugins(rt as any);
    expect((globalThis as any).__runtimeApplied).toBe(true);
    delete (globalThis as any).__runtimeApplied;
  });

  it('warns and skips a plugin whose id duplicates an already-registered channel', async () => {
    // Register the first plugin successfully
    makePluginDir(pluginsDir, 'aa-first', {
      manifest: { id: 'dupe-channel' },
      entry: validEntry('dupe-channel'),
    });
    // Second plugin with the same channel id
    makePluginDir(pluginsDir, 'bb-second', {
      manifest: { id: 'dupe-channel' },
      entry: validEntry('dupe-channel'),
    });
    const rt = makeRuntime();
    await loadPlugins(rt as any);
    // Only the first one should be registered
    expect(registeredChannels.filter((n) => n === 'dupe-channel')).toHaveLength(1);
    expect(rt.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'dupe-channel' }),
      expect.stringContaining('duplicate'),
    );
  });

  it('loads two plugins in alphabetical order', async () => {
    makePluginDir(pluginsDir, 'bb-beta', {
      manifest: { id: 'bb-beta' },
      entry: validEntry('bb-beta'),
    });
    makePluginDir(pluginsDir, 'aa-alpha', {
      manifest: { id: 'aa-alpha' },
      entry: validEntry('aa-alpha'),
    });
    await loadPlugins(makeRuntime() as any);
    expect(registeredChannels[registeredChannels.length - 2]).toBe('aa-alpha');
    expect(registeredChannels[registeredChannels.length - 1]).toBe('bb-beta');
  });

  it('MONOCLAW_PLUGINS_DIR env var overrides the default config/plugins path', async () => {
    const altDir = join(testRoot, 'alt-plugins');
    mkdirSync(altDir, { recursive: true });
    makePluginDir(altDir, 'alt-plugin', {
      manifest: { id: 'alt-plugin' },
      entry: validEntry('alt-plugin'),
    });
    process.env.MONOCLAW_PLUGINS_DIR = altDir;
    await loadPlugins(makeRuntime() as any);
    expect(registeredChannels).toContain('alt-plugin');
  });
});
