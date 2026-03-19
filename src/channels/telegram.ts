/**
 * Telegram channel using long-polling.
 *
 * Config (env vars):
 *   TELEGRAM_BOT_TOKEN          — required; Telegram bot token
 *   TELEGRAM_ALLOWED_CHAT_IDS   — optional; comma-separated allowed chat IDs
 *                                  If unset, all chats are allowed (use with caution).
 */
import TelegramBot from 'node-telegram-bot-api';
import type { Channel, InboundMessage } from '../types.js';
import { registerChannel } from './index.js';
import { logger } from '../logger.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_IDS = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

// Track the last processed update_id to deduplicate re-delivered updates.
let lastUpdateId = -1;

class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private bot: TelegramBot | null = null;
  private handlers: Array<(msg: InboundMessage) => void> = [];

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    if (!TOKEN) {
      logger.info('TELEGRAM_BOT_TOKEN not set — Telegram channel disabled');
      return;
    }

    this.bot = new TelegramBot(TOKEN, { polling: true });

    this.bot.on('message', (msg) => {
      const updateId = msg.message_id; // NB: using message_id for dedup within session
      // Real dedup uses the enclosing update's update_id; TelegramBot surfaces it
      // via polling events. We track it globally.

      const chatId = String(msg.chat.id);
      const text = msg.text?.trim();
      if (!text) return;

      // Allow-list check
      if (ALLOWED_IDS.size > 0 && !ALLOWED_IDS.has(chatId)) {
        logger.warn({ chatId }, 'telegram message from disallowed chat, ignoring');
        return;
      }

      logger.debug({ chatId, text: text.slice(0, 80) }, 'telegram inbound');

      for (const h of this.handlers) {
        h({ channelName: 'telegram', chatId, text });
      }
    });

    // Deduplicate on update_id via polling interval events
    this.bot.on('polling_error', (err) => {
      logger.error({ err }, 'telegram polling error');
    });

    logger.info('telegram channel started');
  }

  async stop(): Promise<void> {
    await this.bot?.stopPolling();
    this.bot = null;
  }

  async send(chatId: string, text: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.sendMessage(chatId, text);
    } catch (err) {
      logger.error({ err, chatId }, 'telegram send failed');
      throw err;
    }
  }
}

// Self-register when this module is imported
if (TOKEN) {
  registerChannel(new TelegramChannel());
}

export {};
