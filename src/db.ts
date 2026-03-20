import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { OutboxRow } from './types.js';

const DATA_DIR =
  process.env.MONOCLAW_DATA_DIR ?? join(process.cwd(), '.runtime');
const DB_PATH = join(DATA_DIR, 'monoclaw.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  pruneOldMessages(_db);
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      channel    TEXT NOT NULL,
      direction  TEXT NOT NULL,
      content    TEXT NOT NULL,
      timestamp  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_agent_time
      ON messages (agent_name, timestamp);

    CREATE TABLE IF NOT EXISTS sessions (
      agent_name   TEXT PRIMARY KEY,
      session_file TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id           TEXT PRIMARY KEY,
      channel_name TEXT NOT NULL,
      chat_id      TEXT NOT NULL,
      payload      TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      retry_count  INTEGER NOT NULL DEFAULT 0,
      last_error   TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_status_created
      ON outbox (status, created_at);
  `);
}

// Prune messages older than 30 days on startup.
function pruneOldMessages(db: Database.Database): void {
  db.prepare(
    `DELETE FROM messages WHERE timestamp < datetime('now', '-30 days')`,
  ).run();
}

// ── Messages ──────────────────────────────────────────────────────────────

export function storeMessage(
  agentName: string,
  channel: string,
  direction: 'inbound' | 'outbound',
  content: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO messages (id, agent_name, channel, direction, content, timestamp)
       VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, datetime('now'))`,
    )
    .run(agentName, channel, direction, content);
}

// ── Sessions ──────────────────────────────────────────────────────────────

export function upsertSessionFile(agentName: string, sessionFile: string): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (agent_name, session_file, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(agent_name) DO UPDATE SET
         session_file = excluded.session_file,
         updated_at   = excluded.updated_at`,
    )
    .run(agentName, sessionFile);
}

// ── Outbox ────────────────────────────────────────────────────────────────

export function enqueueOutbox(
  channelName: string,
  chatId: string,
  text: string,
): string {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const payload = JSON.stringify({ text });
  getDb()
    .prepare(
      `INSERT INTO outbox (id, channel_name, chat_id, payload, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
    )
    .run(id, channelName, chatId, payload);
  return id;
}

export function getPendingOutbox(): OutboxRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM outbox WHERE status = 'pending' OR status = 'failed'
       ORDER BY created_at ASC LIMIT 100`,
    )
    .all() as OutboxRow[];
}

const MAX_RETRIES = 5;

export function markOutboxSent(id: string): void {
  getDb()
    .prepare(
      `UPDATE outbox SET status = 'sent', updated_at = datetime('now') WHERE id = ?`,
    )
    .run(id);
}

export function markOutboxFailed(id: string, error: string): void {
  const row = getDb()
    .prepare('SELECT retry_count FROM outbox WHERE id = ?')
    .get(id) as { retry_count: number } | undefined;
  const retries = (row?.retry_count ?? 0) + 1;
  const status = retries >= MAX_RETRIES ? 'dead' : 'failed';
  getDb()
    .prepare(
      `UPDATE outbox
       SET status = ?, retry_count = ?, last_error = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(status, retries, error, id);
}

export { DATA_DIR };
