/**
 * MonoClaw orchestrator.
 *
 * Startup sequence:
 *   1. Load config/.env into process.env (env.ts runs as a side effect)
 *   2. Start credential proxy (injects real API key for sandboxed workers)
 *   3. Load agents from config/agents/*.json and spawn sandboxed workers
 *   4. Start message channels (Telegram, stdio)
 *   5. Route inbound messages → agents via config routing table
 *   6. Flush outbox → channels on a poll interval
 *
 * To add an agent: create config/agents/<name>.json and restart.
 * To change routing: edit the "routing" array in the agent config and restart.
 */

// env.ts MUST be first — it loads config/.env before any channel module reads
// process.env (channels self-register at module evaluation time).
import './env.js';
import './channels/telegram.js';
import './channels/stdio.js';

import { startCredentialProxy } from './credential-proxy.js';
import { AgentProcess } from './agent.js';
import { getAllChannels } from './channels/index.js';
import {
  getPendingOutbox,
  markOutboxSent,
  markOutboxFailed,
  getDb,
  DATA_DIR,
} from './db.js';
import { loadAgentConfigs } from './config.js';
import { startApi } from './api.js';
import { logger } from './logger.js';
import type { AgentFileConfig } from './config.js';

const OUTBOX_POLL_MS = 2_000;

// (channelName + ':' + chatId) → AgentProcess
const routingMap = new Map<string, AgentProcess>();
const agents = new Map<string, AgentProcess>();

async function main(): Promise<void> {
  logger.info('MonoClaw starting');

  // Open the DB immediately so .runtime/ is created on startup rather than
  // waiting for the first outbox flush or message.
  getDb();

  // 1. Start credential proxy
  const { port: proxyPort } = await startCredentialProxy(logger);
  logger.info({ proxyPort }, 'credential proxy ready');

  // 2. Load agents from config/agents/*.json
  const agentConfigs = loadAgentConfigs();
  if (agentConfigs.length === 0) {
    logger.warn(
      'No agents configured. Create config/agents/<name>.json and restart.',
    );
  }

  for (const cfg of agentConfigs) {
    await spawnAgent(cfg, proxyPort);
  }

  // 3. Start HTTP API
  await startApi(agents, agentConfigs, DATA_DIR, logger.child({ component: 'api' }));

  // 4. Start channels
  const channels = getAllChannels();
  if (channels.length === 0) {
    logger.warn(
      'No channels active. Set TELEGRAM_BOT_TOKEN or MONOCLAW_STDIO_CHANNEL=1.',
    );
  }

  for (const channel of channels) {
    channel.onMessage(async (msg) => {
      const key = `${msg.channelName}:${msg.chatId}`;
      const agent = routingMap.get(key);
      if (!agent) {
        logger.warn(
          { channel: msg.channelName, chatId: msg.chatId },
          'no routing entry — message dropped. Add routing in config/agents/<name>.json.',
        );
        return;
      }
      agent.prompt(msg.text, msg.chatId, msg.channelName);
    });

    await channel.start();
    logger.info({ channel: channel.name }, 'channel started');
  }

  // 5. Outbox flush loop
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

async function spawnAgent(
  cfg: AgentFileConfig,
  proxyPort: number,
): Promise<void> {
  const agent = new AgentProcess(cfg, proxyPort, logger.child({ agent: cfg.name }));
  agents.set(cfg.name, agent);

  // Register every (channel, chatId) route declared in the config
  for (const r of cfg.routing) {
    routingMap.set(`${r.channel}:${r.chatId}`, agent);
  }

  await agent.start();
  logger.info({ agent: cfg.name, routes: cfg.routing.length }, 'agent ready');
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
