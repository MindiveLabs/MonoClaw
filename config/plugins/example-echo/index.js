/**
 * Example MonoClaw channel plugin — "echo".
 *
 * This plugin demonstrates the minimum structure for a MonoClaw channel plugin.
 * It is NOT active by default: it has no agent routing entries in any
 * config/agents/<name>.json, so messages it receives will be dropped by the
 * orchestrator with a "no routing entry" warning.
 *
 * To use this as a template:
 *   1. Copy this directory to config/plugins/<your-name>/
 *   2. Update openclaw.plugin.json with your channel id
 *   3. Implement messaging.send and messaging.onMessage
 *   4. Add routing entries to config/agents/<agent>.json:
 *        { "channel": "<your-id>", "chatId": "<your-chat-id>" }
 *   5. Restart MonoClaw
 *
 * To write plugins in TypeScript:
 *   import { defineChannelPluginEntry } from 'monoclaw/plugin-sdk';
 *   Compile to index.js before use.
 */

// Handlers registered via onMessage — fired for every inbound message.
const handlers = [];

// Runtime context delivered by the loader (env vars + logger).
let rt = null;

const echoPlugin = {
  messaging: {
    async send(chatId, text) {
      if (rt) rt.logger.debug({ chatId, text }, 'echo send (no-op in example)');
    },
    onMessage(handler) {
      handlers.push(handler);
    },
  },
  lifecycle: {
    async start() {
      if (rt) rt.logger.info('echo plugin started (example — does nothing)');
    },
    async stop() {},
  },
};

// defineChannelPluginEntry is the same function name as OpenClaw.
// In TypeScript: import { defineChannelPluginEntry } from 'monoclaw/plugin-sdk';
// Here we replicate the return shape directly for the plain-JS example.
export default {
  id: 'echo',
  name: 'Echo (example)',
  toChannel() {
    return {
      name: 'echo',
      send: (chatId, text) => echoPlugin.messaging.send(chatId, text),
      onMessage: (handler) => echoPlugin.messaging.onMessage(handler),
      start: () => echoPlugin.lifecycle.start(),
      stop: () => echoPlugin.lifecycle.stop(),
    };
  },
  applyRuntime(runtime) {
    rt = runtime;
  },
};
