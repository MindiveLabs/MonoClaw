/**
 * stdin/stdout debug channel.
 *
 * Reads prompts from stdin in the format: <agentName> <message>
 * Prints responses to stdout.
 *
 * Used for local testing and development. Not active in production
 * unless MONOCLAW_STDIO_CHANNEL=1 is set.
 *
 * The chatId for this channel is the agent name itself, so routing
 * must be set up in the routing table: stdio/<agentName> → <agentName>.
 */
import { createInterface } from 'node:readline';
import type { Channel, InboundMessage } from '../types.js';
import { registerChannel } from './index.js';
import { logger } from '../logger.js';

class StdioChannel implements Channel {
  readonly name = 'stdio';
  private handlers: Array<(msg: InboundMessage) => void> = [];
  private rl: ReturnType<typeof createInterface> | null = null;

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    this.rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

    process.stdout.write('MonoClaw stdio channel ready. Format: <agentName> <message>\n> ');

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        process.stdout.write('> ');
        return;
      }
      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx === -1) {
        process.stdout.write('Usage: <agentName> <message>\n> ');
        return;
      }
      const chatId = trimmed.slice(0, spaceIdx);   // agent name is the chatId
      const text = trimmed.slice(spaceIdx + 1).trim();

      logger.debug({ chatId, text }, 'stdio inbound');
      for (const h of this.handlers) {
        h({ channelName: 'stdio', chatId, text });
      }
    });

    this.rl.on('close', () => {
      logger.info('stdio channel closed');
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }

  async send(chatId: string, text: string): Promise<void> {
    process.stdout.write(`\n[${chatId}] ${text}\n> `);
  }
}

// Self-register when this module is imported
if (process.env.MONOCLAW_STDIO_CHANNEL === '1') {
  registerChannel(new StdioChannel());
}

export {};
