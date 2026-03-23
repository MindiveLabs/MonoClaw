/**
 * plugin-sdk unit tests.
 *
 * Tests every codepath of defineChannelPluginEntry:
 *   - toChannel() delegation to messaging and lifecycle
 *   - lifecycle absent → start/stop resolve without error
 *   - applyRuntime() calls setRuntime if provided
 *   - applyRuntime() is a no-op when setRuntime is absent
 */
import { describe, it, expect, vi } from 'vitest';
import { defineChannelPluginEntry } from '../src/plugin-sdk.js';
import type { MonoClawChannelPlugin, MonoClawRuntime } from '../src/plugin-sdk.js';

function makePlugin(overrides: Partial<MonoClawChannelPlugin> = {}): MonoClawChannelPlugin {
  return {
    messaging: {
      send: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn(),
      ...overrides.messaging,
    },
    ...overrides,
  };
}

function makeRuntime(): MonoClawRuntime {
  return {
    env: process.env,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as MonoClawRuntime['logger'],
  };
}

describe('defineChannelPluginEntry', () => {
  it('returns a result with the correct id and name', () => {
    const result = defineChannelPluginEntry({
      id: 'test',
      name: 'Test Channel',
      plugin: makePlugin(),
    });
    expect(result.id).toBe('test');
    expect(result.name).toBe('Test Channel');
  });

  it('toChannel() returns a Channel whose name matches entry.id', () => {
    const result = defineChannelPluginEntry({
      id: 'myid',
      name: 'My Channel',
      plugin: makePlugin(),
    });
    expect(result.toChannel().name).toBe('myid');
  });

  it('toChannel().send delegates to plugin.messaging.send', async () => {
    const plugin = makePlugin();
    const channel = defineChannelPluginEntry({ id: 'x', name: 'X', plugin }).toChannel();
    await channel.send('chat1', 'hello');
    expect(plugin.messaging.send).toHaveBeenCalledWith('chat1', 'hello');
  });

  it('toChannel().onMessage delegates to plugin.messaging.onMessage', () => {
    const plugin = makePlugin();
    const channel = defineChannelPluginEntry({ id: 'x', name: 'X', plugin }).toChannel();
    const handler = vi.fn();
    channel.onMessage(handler);
    expect(plugin.messaging.onMessage).toHaveBeenCalledWith(handler);
  });

  it('toChannel().start calls plugin.lifecycle.start when lifecycle is provided', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const plugin = makePlugin({ lifecycle: { start, stop: vi.fn().mockResolvedValue(undefined) } });
    const channel = defineChannelPluginEntry({ id: 'x', name: 'X', plugin }).toChannel();
    await channel.start();
    expect(start).toHaveBeenCalledOnce();
  });

  it('toChannel().start resolves without error when no lifecycle is provided', async () => {
    const plugin = makePlugin(); // no lifecycle
    const channel = defineChannelPluginEntry({ id: 'x', name: 'X', plugin }).toChannel();
    await expect(channel.start()).resolves.toBeUndefined();
  });

  it('toChannel().stop calls plugin.lifecycle.stop when lifecycle is provided', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const plugin = makePlugin({ lifecycle: { start: vi.fn().mockResolvedValue(undefined), stop } });
    const channel = defineChannelPluginEntry({ id: 'x', name: 'X', plugin }).toChannel();
    await channel.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('toChannel().stop resolves without error when no lifecycle is provided', async () => {
    const plugin = makePlugin(); // no lifecycle
    const channel = defineChannelPluginEntry({ id: 'x', name: 'X', plugin }).toChannel();
    await expect(channel.stop()).resolves.toBeUndefined();
  });

  it('applyRuntime calls setRuntime with the runtime object', async () => {
    const setRuntime = vi.fn();
    const result = defineChannelPluginEntry({
      id: 'x',
      name: 'X',
      plugin: makePlugin(),
      setRuntime,
    });
    const runtime = makeRuntime();
    await result.applyRuntime(runtime);
    expect(setRuntime).toHaveBeenCalledWith(runtime);
  });

  it('applyRuntime awaits an async setRuntime', async () => {
    let resolved = false;
    const setRuntime = vi.fn(async () => {
      await Promise.resolve();
      resolved = true;
    });
    const result = defineChannelPluginEntry({
      id: 'x',
      name: 'X',
      plugin: makePlugin(),
      setRuntime,
    });
    await result.applyRuntime(makeRuntime());
    expect(resolved).toBe(true);
  });

  it('applyRuntime is a no-op when setRuntime is not provided', async () => {
    const result = defineChannelPluginEntry({
      id: 'x',
      name: 'X',
      plugin: makePlugin(),
      // no setRuntime
    });
    const runtime = makeRuntime();
    await expect(result.applyRuntime(runtime)).resolves.toBeUndefined();
  });
});
