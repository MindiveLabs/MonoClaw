/**
 * MonoClaw orchestrator.
 *
 * Startup sequence:
 *   1. Start credential proxy (injects real API key for sandboxed workers)
 *   2. Load agents from SQLite and spawn sandboxed workers
 *   3. Start message channels (Telegram, stdio)
 *   4. Route inbound messages → agents via routing table
 *   5. Flush outbox → channels on a poll interval
 *
 * To add an agent, call `upsertAgent()` and restart MonoClaw.
 * To add a channel routing, call `setRouting()`.
 */
import './channels/telegram.js';
import './channels/stdio.js';

import { startCredentialProxy } from './credential-proxy.js';
import { AgentProcess } from './agent.js';
import { getAllChannels } from './channels/index.js';
import {
  getAllAgents,
  resolveAgent,
  getPendingOutbox,
  markOutboxSent,
  markOutboxFailed,
  getDb,
} from './db.js';
import { logger } from './logger.js';
import type { AgentConfig } from './types.js';

const OUTBOX_POLL_MS = 2_000;   // How often to flush pending outbox rows
const agents = new Map<string, AgentProcess>();

async function main(): Promise<void> {
  logger.info('MonoClaw starting');

  // 1. Start credential proxy
  const { port: proxyPort } = await startCredentialProxy(logger);
  logger.info({ proxyPort }, 'credential proxy ready');

  // 2. Load agents and spawn workers
  const agentConfigs = getAllAgents();
  if (agentConfigs.length === 0) {
    logger.warn(
      'No agents configured. Add agents via upsertAgent() then restart.',
    );
  }

  for (const cfg of agentConfigs) {
    await spawnAgent(cfg, proxyPort);
  }

  // 3. Start channels
  const channels = getAllChannels();
  if (channels.length === 0) {
    logger.warn(
      'No channels active. Set TELEGRAM_BOT_TOKEN or MONOCLAW_STDIO_CHANNEL=1.',
    );
  }

  for (const channel of channels) {
    channel.onMessage(async (msg) => {
      const agentName = resolveAgent(msg.channelName, msg.chatId);
      if (!agentName) {
        logger.warn(
          { channel: msg.channelName, chatId: msg.chatId },
          'no routing entry — message dropped. Add via setRouting().',
        );
        return;
      }
      const agent = agents.get(agentName);
      if (!agent) {
        logger.error({ agentName }, 'agent not found in registry');
        return;
      }
      agent.prompt(msg.text, msg.chatId, msg.channelName);
    });

    await channel.start();
    logger.info({ channel: channel.name }, 'channel started');
  }

  // 4. Outbox flush loop
  startOutboxFlush(channels);

  logger.info('MonoClaw ready');

  // Graceful shutdown
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      logger.info({ sig }, 'shutting down');
      for (const agent of agents.values()) await agent.stop();
      for (const channel of channels) await channel.stop();
      getDb().close();
      process.exit(0);
    });
  }
}

async function spawnAgent(cfg: AgentConfig, proxyPort: number): Promise<void> {
  const agent = new AgentProcess(cfg, proxyPort, logger.child({ agent: cfg.name }));
  agent.setAgentEndHandler((_agentName) => {
    // Outbox is flushed on the poll interval; nothing extra to do here.
  });
  agents.set(cfg.name, agent);
  await agent.start();
  logger.info({ agent: cfg.name }, 'agent ready');
}

function startOutboxFlush(
  channels: ReturnType<typeof getAllChannels>,
): void {
  const channelMap = new Map(channels.map((c) => [c.name, c]));

  const flush = async () => {
    const rows = getPendingOutbox();
    for (const row of rows) {
      const channel = channelMap.get(row.channel_name);
      if (!channel) {
        logger.warn({ channel: row.channel_name }, 'channel not found for outbox row');
        markOutboxFailed(row.id, 'channel not found');
        continue;
      }
      try {
        const { text } = JSON.parse(row.payload) as { text: string };
        await channel.send(row.chat_id, text);
        markOutboxSent(row.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ outboxId: row.id, err: message }, 'outbox delivery failed');
        markOutboxFailed(row.id, message);
      }
    }
    setTimeout(flush, OUTBOX_POLL_MS);
  };

  setTimeout(flush, OUTBOX_POLL_MS);
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal error');
  process.exit(1);
});
