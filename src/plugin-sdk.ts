/**
 * MonoClaw Plugin SDK.
 *
 * Provides the same structural conventions as OpenClaw's plugin SDK so that
 * plugin authors familiar with OpenClaw feel at home. The interface is much
 * simpler — no config adapters, pairing, or security hooks. Plugins read
 * configuration from process.env, exactly like MonoClaw's built-in channels.
 *
 * Usage (plugin entry point, identical shape to OpenClaw):
 *
 *   import { defineChannelPluginEntry } from 'monoclaw/plugin-sdk';
 *
 *   export default defineChannelPluginEntry({
 *     id: 'discord',
 *     name: 'Discord',
 *     plugin: discordPlugin,           // implements MonoClawChannelPlugin
 *     setRuntime: (rt) => { ... },     // optional — receive env + logger
 *   });
 *
 * Plugin manifest (openclaw.plugin.json — identical format to OpenClaw):
 *
 *   { "id": "discord", "channels": ["discord"] }
 */

import type { Channel, InboundMessage } from './types.js';

export type { InboundMessage };

/**
 * The MonoClaw channel plugin interface.
 *
 * Simpler than OpenClaw's ChannelPlugin (no config adapters, pairing, or
 * security hooks). The parts that map to OpenClaw: id/name via the entry,
 * messaging.send ↔ channel.send, messaging.onMessage ↔ channel.onMessage,
 * lifecycle.start/stop ↔ channel.start/stop.
 */
export interface MonoClawChannelPlugin {
  messaging: {
    send(chatId: string, text: string): Promise<void>;
    onMessage(handler: (msg: InboundMessage) => void): void;
  };
  lifecycle?: {
    start(): Promise<void>;
    stop(): Promise<void>;
  };
}

/**
 * Minimal runtime context passed to a plugin's setRuntime callback.
 * Equivalent of OpenClaw's PluginRuntime, stripped to what MonoClaw can offer.
 */
export interface MonoClawRuntime {
  env: NodeJS.ProcessEnv;
  logger: import('pino').Logger;
}

/** Input to defineChannelPluginEntry — mirrors OpenClaw's entry shape. */
export interface PluginEntry {
  id: string;
  name: string;
  description?: string;
  plugin: MonoClawChannelPlugin;
  /** Called at load time before toChannel(). May be async — the loader awaits it. */
  setRuntime?: (runtime: MonoClawRuntime) => void | Promise<void>;
}

/** Result of defineChannelPluginEntry, consumed by the plugin loader. */
export interface PluginEntryResult {
  readonly id: string;
  readonly name: string;
  /** Wrap the plugin into a MonoClaw Channel. */
  toChannel(): Channel;
  /** Deliver runtime context to the plugin (called before toChannel). */
  applyRuntime(runtime: MonoClawRuntime): Promise<void>;
}

/**
 * Define a channel plugin entry point.
 *
 * Mirror of OpenClaw's defineChannelPluginEntry — same function name and
 * compatible shape. Wraps a MonoClawChannelPlugin into the Channel interface
 * that MonoClaw's orchestrator expects.
 */
export function defineChannelPluginEntry(entry: PluginEntry): PluginEntryResult {
  return {
    id: entry.id,
    name: entry.name,
    toChannel(): Channel {
      return {
        name: entry.id,
        send: (chatId, text) => entry.plugin.messaging.send(chatId, text),
        onMessage: (handler) => entry.plugin.messaging.onMessage(handler),
        start: () => entry.plugin.lifecycle?.start() ?? Promise.resolve(),
        stop: () => entry.plugin.lifecycle?.stop() ?? Promise.resolve(),
      };
    },
    async applyRuntime(runtime: MonoClawRuntime): Promise<void> {
      await entry.setRuntime?.(runtime);
    },
  };
}
