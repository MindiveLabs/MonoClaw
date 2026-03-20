/**
 * stdin/stdout debug channel.
 *
 * Reads prompts from stdin in the format: <agentName> <message>
 * Prints responses to stdout.
 *
 * Used for local testing and development. Not active in production
 * unless MONOCLAW_STDIO_CHANNEL=1 is set.
 *
 * When an active agent is set (single-agent mode or after /agent <name>),
 * plain messages are routed to that agent without the <agentName> prefix.
 * Switch agents at any time with: /agent <name>
 *
 * Call printStdioBanner(agentNames) after startup to show the prompt.
 */
import { createInterface } from 'node:readline';
import type { Channel, InboundMessage } from '../types.js';
import { registerChannel } from './index.js';
import { logger } from '../logger.js';

class StdioChannel implements Channel {
  readonly name = 'stdio';
  private handlers: Array<(msg: InboundMessage) => void> = [];
  private rl: ReturnType<typeof createInterface> | null = null;
  private activeAgent: string | null = null;
  private knownAgents: string[] = [];
  promptStr = '> ';

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handlers.push(handler);
  }

  private switchAgent(name: string): void {
    this.activeAgent = name;
    this.promptStr = `${name}> `;
    process.stdout.write(`Switched to ${name}.\n\n${this.promptStr}`);
  }

  async start(): Promise<void> {
    this.rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        process.stdout.write(this.promptStr);
        return;
      }

      // /agent <name> — switch active agent
      if (trimmed.startsWith('/agent ')) {
        const name = trimmed.slice(7).trim();
        if (!name) {
          process.stdout.write(`Usage: /agent <name>  •  available: ${this.knownAgents.join(', ')}\n\n${this.promptStr}`);
          return;
        }
        this.switchAgent(name);
        return;
      }

      // Unknown slash command
      if (trimmed.startsWith('/')) {
        process.stdout.write(`Unknown command. Try /agent <name>\n\n${this.promptStr}`);
        return;
      }

      let chatId: string;
      let text: string;

      if (this.activeAgent) {
        // Active agent set — whole line is the message
        chatId = this.activeAgent;
        text = trimmed;
      } else {
        // No active agent — require <agentName> <message> format
        const spaceIdx = trimmed.indexOf(' ');
        if (spaceIdx === -1) {
          process.stdout.write(`Usage: <agentName> <message>  or  /agent <name> to set active agent\n\n${this.promptStr}`);
          return;
        }
        chatId = trimmed.slice(0, spaceIdx);
        text = trimmed.slice(spaceIdx + 1).trim();
      }

      logger.debug({ chatId, text }, 'stdio inbound');
      for (const h of this.handlers) {
        h({ channelName: 'stdio', chatId, text });
      }
      process.stdout.write('\n');
    });

    this.rl.on('close', () => {
      logger.info('stdio channel closed');
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }

  async send(chatId: string, text: string): Promise<void> {
    process.stdout.write(`${chatId}: ${text}\n\n${this.promptStr}`);
  }

  init(agentNames: string[]): void {
    this.knownAgents = agentNames;
    if (agentNames.length === 1) {
      this.activeAgent = agentNames[0]!;
      this.promptStr = `${agentNames[0]}> `;
    }
  }
}

let _channel: StdioChannel | null = null;

/**
 * Print the welcome banner and first prompt. Call this after all startup
 * logs are emitted so the prompt appears cleanly at the bottom.
 */
export function printStdioBanner(agentNames: string[]): void {
  if (!_channel) return;
  _channel.init(agentNames);

  const agentList = agentNames.join(', ');
  const single = agentNames.length === 1;
  const switchHint = single
    ? `/agent <name> to switch`
    : `<agent> <message> or /agent <name> to set active`;
  const usage = single
    ? `Chatting with ${agentNames[0]}. Type a message and press Enter. ${switchHint}. Ctrl+C to quit.`
    : `Agents: ${agentList}  •  ${switchHint}. Ctrl+C to quit.`;

  process.stdout.write(`\n${usage}\n\n${_channel.promptStr}`);
}

// Self-register when this module is imported
if (process.env.MONOCLAW_STDIO_CHANNEL === '1') {
  _channel = new StdioChannel();
  registerChannel(_channel);
}

export {};
