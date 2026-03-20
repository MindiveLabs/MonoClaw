// Core shared types for MonoClaw.

export interface AgentConfig {
  name: string;
  workspacePath: string;   // Isolated workspace directory for this agent
  memoryPath: string;      // Path to AGENTS.md context file
  sessionDir: string;      // Persistent pimono session directory (survives restarts)
  model?: string;          // Model ID override (e.g. "claude-opus-4-5")
  skills?: string[];       // Additional skill paths (files or directories)
}

// Channels operate on channel-specific IDs (Telegram chat_id, etc.).
// Routing from (channelName, chatId) → agentName lives in the orchestrator.
export interface Channel {
  name: string;
  send(chatId: string, text: string): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface InboundMessage {
  channelName: string;
  chatId: string;
  text: string;
}

export interface OutboxRow {
  id: string;
  channel_name: string;
  chat_id: string;
  payload: string;         // JSON: { text: string }
  status: 'pending' | 'sent' | 'failed' | 'dead';
  retry_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// Protocol between orchestrator and worker subprocess (via stdin/stdout JSON lines).
export type WorkerInbound =
  | { type: 'prompt'; prompt: string; chatId: string; channelName: string };

export type WorkerOutbound =
  | { type: 'text_delta'; delta: string }
  | { type: 'agent_end'; response: string; chatId: string; channelName: string }
  | { type: 'error'; message: string };
