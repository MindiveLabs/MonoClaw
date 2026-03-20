/**
 * StdioChannel tests.
 *
 * Covers: init(), send(), printStdioBanner(), /agent command handling,
 * active-agent routing, multi-agent prefix routing, and error paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Capture process.stdout.write output without actually writing. */
function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown) => {
    output.push(String(chunk));
    return true;
  };
  return {
    output,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

/** Fake readline interface that exposes an emit() method for simulating input. */
class FakeRl extends EventEmitter {
  close = vi.fn();
}

// ── module setup ──────────────────────────────────────────────────────────────

let fakeRl: FakeRl;

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => {
    fakeRl = new FakeRl();
    return fakeRl;
  }),
}));

// Import after mock is set up. Reset the module registry between tests so each
// test gets a fresh _channel and fresh knownAgents/activeAgent state.
async function freshImport() {
  vi.resetModules();
  process.env.MONOCLAW_STDIO_CHANNEL = '1';
  // Re-mock after module reset
  vi.mock('node:readline', () => ({
    createInterface: vi.fn(() => {
      fakeRl = new FakeRl();
      return fakeRl;
    }),
  }));
  const mod = await import('../../src/channels/stdio.js');
  // Also reload the channel registry
  const { getAllChannels } = await import('../../src/channels/index.js');
  return { ...mod, getAllChannels };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('StdioChannel', () => {
  let stdout: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    stdout = captureStdout();
  });

  afterEach(() => {
    stdout.restore();
    delete process.env.MONOCLAW_STDIO_CHANNEL;
  });

  // ── init() ──────────────────────────────────────────────────────────────────

  describe('printStdioBanner', () => {
    it('single-agent: sets activeAgent and shows "Chatting with" banner', async () => {
      const { printStdioBanner } = await freshImport();
      printStdioBanner(['alice']);
      const combined = stdout.output.join('');
      expect(combined).toMatch(/Chatting with alice/);
      expect(combined).toMatch(/\/agent <name> to switch/);
      expect(combined).toMatch(/alice>/);
    });

    it('multi-agent: shows agent list and prefix instructions', async () => {
      const { printStdioBanner } = await freshImport();
      printStdioBanner(['alice', 'bob']);
      const combined = stdout.output.join('');
      expect(combined).toMatch(/alice, bob/);
      expect(combined).toMatch(/<agent> <message>/);
      expect(combined).toMatch(/\/agent <name> to set active/);
    });

    it('no-op when channel is not active (env var not set)', async () => {
      vi.resetModules();
      delete process.env.MONOCLAW_STDIO_CHANNEL;
      const { printStdioBanner } = await import('../../src/channels/stdio.js');
      printStdioBanner(['alice']); // should not throw
      expect(stdout.output).toHaveLength(0);
    });
  });

  // ── send() ──────────────────────────────────────────────────────────────────

  describe('send()', () => {
    it('formats response as "chatId: text" followed by prompt', async () => {
      const { printStdioBanner } = await freshImport();
      printStdioBanner(['alice']);
      stdout.output.length = 0; // clear banner output

      // Get channel from registry
      const { getAllChannels } = await import('../../src/channels/index.js');
      const channel = getAllChannels().find((c) => c.name === 'stdio');
      await channel!.send('alice', 'hello there');

      const combined = stdout.output.join('');
      expect(combined).toMatch(/^alice: hello there/);
      expect(combined).toMatch(/alice>/);
    });
  });

  // ── /agent command ──────────────────────────────────────────────────────────

  describe('/agent command', () => {
    it('switches active agent and updates prompt', async () => {
      const { printStdioBanner } = await freshImport();
      printStdioBanner(['alice', 'bob']);

      const { getAllChannels } = await import('../../src/channels/index.js');
      const channel = getAllChannels().find((c) => c.name === 'stdio');
      await channel!.start();
      stdout.output.length = 0;

      fakeRl.emit('line', '/agent bob');
      const combined = stdout.output.join('');
      expect(combined).toMatch(/Switched to bob/);
      expect(combined).toMatch(/bob>/);
    });

    it('rejects unknown agent name', async () => {
      const { printStdioBanner } = await freshImport();
      printStdioBanner(['alice', 'bob']);

      const { getAllChannels } = await import('../../src/channels/index.js');
      const channel = getAllChannels().find((c) => c.name === 'stdio');
      await channel!.start();
      stdout.output.length = 0;

      fakeRl.emit('line', '/agent charlie');
      const combined = stdout.output.join('');
      expect(combined).toMatch(/Unknown agent "charlie"/);
      expect(combined).toMatch(/alice, bob/);
    });

    it('shows usage when /agent is given with no name', async () => {
      const { printStdioBanner } = await freshImport();
      printStdioBanner(['alice', 'bob']);

      const { getAllChannels } = await import('../../src/channels/index.js');
      const channel = getAllChannels().find((c) => c.name === 'stdio');
      await channel!.start();
      stdout.output.length = 0;

      fakeRl.emit('line', '/agent ');
      const combined = stdout.output.join('');
      expect(combined).toMatch(/Usage: \/agent <name>/);
    });

    it('shows error for unrecognised slash commands', async () => {
      const { printStdioBanner } = await freshImport();
      printStdioBanner(['alice']);

      const { getAllChannels } = await import('../../src/channels/index.js');
      const channel = getAllChannels().find((c) => c.name === 'stdio');
      await channel!.start();
      stdout.output.length = 0;

      fakeRl.emit('line', '/unknown');
      const combined = stdout.output.join('');
      expect(combined).toMatch(/Unknown command/);
    });
  });

  // ── message routing ──────────────────────────────────────────────────────────

  describe('message routing', () => {
    it('single-agent mode: routes whole line to active agent', async () => {
      const { printStdioBanner } = await freshImport();
      printStdioBanner(['alice']);

      const { getAllChannels } = await import('../../src/channels/index.js');
      const channel = getAllChannels().find((c) => c.name === 'stdio');

      const received: Array<{ chatId: string; text: string }> = [];
      channel!.onMessage((msg) => received.push({ chatId: msg.chatId, text: msg.text }));
      await channel!.start();

      fakeRl.emit('line', 'hello world');
      expect(received).toHaveLength(1);
      expect(received[0]!.chatId).toBe('alice');
      expect(received[0]!.text).toBe('hello world');
    });

    it('multi-agent mode: routes "<agentName> <message>" format', async () => {
      const { printStdioBanner } = await freshImport();
      printStdioBanner(['alice', 'bob']);

      const { getAllChannels } = await import('../../src/channels/index.js');
      const channel = getAllChannels().find((c) => c.name === 'stdio');

      const received: Array<{ chatId: string; text: string }> = [];
      channel!.onMessage((msg) => received.push({ chatId: msg.chatId, text: msg.text }));
      await channel!.start();

      fakeRl.emit('line', 'bob tell me something');
      expect(received).toHaveLength(1);
      expect(received[0]!.chatId).toBe('bob');
      expect(received[0]!.text).toBe('tell me something');
    });

    it('multi-agent mode: shows usage when no space in line', async () => {
      const { printStdioBanner } = await freshImport();
      printStdioBanner(['alice', 'bob']);

      const { getAllChannels } = await import('../../src/channels/index.js');
      const channel = getAllChannels().find((c) => c.name === 'stdio');
      await channel!.start();
      stdout.output.length = 0;

      fakeRl.emit('line', 'justoneword');
      const combined = stdout.output.join('');
      expect(combined).toMatch(/Usage: <agentName> <message>/);
    });

    it('empty line: reprints prompt', async () => {
      const { printStdioBanner } = await freshImport();
      printStdioBanner(['alice']);

      const { getAllChannels } = await import('../../src/channels/index.js');
      const channel = getAllChannels().find((c) => c.name === 'stdio');
      await channel!.start();
      stdout.output.length = 0;

      fakeRl.emit('line', '   ');
      expect(stdout.output.join('')).toMatch(/alice>/);
    });

    it('after /agent switch, routes to new agent', async () => {
      const { printStdioBanner } = await freshImport();
      printStdioBanner(['alice', 'bob']);

      const { getAllChannels } = await import('../../src/channels/index.js');
      const channel = getAllChannels().find((c) => c.name === 'stdio');

      const received: Array<{ chatId: string; text: string }> = [];
      channel!.onMessage((msg) => received.push({ chatId: msg.chatId, text: msg.text }));
      await channel!.start();

      fakeRl.emit('line', '/agent bob');
      fakeRl.emit('line', 'are you there?');

      expect(received).toHaveLength(1);
      expect(received[0]!.chatId).toBe('bob');
      expect(received[0]!.text).toBe('are you there?');
    });
  });
});
