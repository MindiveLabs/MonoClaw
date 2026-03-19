/**
 * Channel self-registration registry.
 *
 * Each channel file calls registerChannel() at module load time.
 * The orchestrator imports all channel files at startup so they register.
 * To add a new channel: create src/channels/myservice.ts and call registerChannel().
 */
import type { Channel } from '../types.js';

const registry = new Map<string, Channel>();

export function registerChannel(channel: Channel): void {
  registry.set(channel.name, channel);
}

export function getChannel(name: string): Channel | undefined {
  return registry.get(name);
}

export function getAllChannels(): Channel[] {
  return [...registry.values()];
}
