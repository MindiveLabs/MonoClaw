/**
 * Session rollback tests.
 *
 * Tests the applySessionRollback() helper extracted from worker.ts.
 * Uses plain mock objects implementing SessionManagerLike — no pimono required.
 */
import { describe, it, expect, vi } from 'vitest';

// Set required env vars before importing worker.ts (module-level guard checks these).
process.env.MONOCLAW_WORKSPACE = '/tmp/rollback-test-ws';
process.env.MONOCLAW_SESSION_DIR = '/tmp/rollback-test-sd';

const { applySessionRollback } = await import('../src/worker.js');
import type { SessionManagerLike } from '../src/worker.js';

function noop() {}

function makeManager(overrides: Partial<SessionManagerLike> = {}): SessionManagerLike & {
  branch: ReturnType<typeof vi.fn>;
  resetLeaf: ReturnType<typeof vi.fn>;
} {
  return {
    buildSessionContext: () => ({ messages: [] }),
    getBranch: () => [],
    branch: vi.fn(),
    resetLeaf: vi.fn(),
    ...overrides,
  };
}

describe('applySessionRollback', () => {
  it('does nothing when session is empty', () => {
    const sm = makeManager();
    applySessionRollback(sm, noop);
    expect(sm.branch).not.toHaveBeenCalled();
    expect(sm.resetLeaf).not.toHaveBeenCalled();
  });

  it('does nothing when last message is a complete assistant turn', () => {
    const sm = makeManager({
      buildSessionContext: () => ({
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', stopReason: 'endTurn', content: 'hi' },
        ],
      }),
    });
    applySessionRollback(sm, noop);
    expect(sm.branch).not.toHaveBeenCalled();
    expect(sm.resetLeaf).not.toHaveBeenCalled();
  });

  it('rolls back to last complete turn when last message is an orphaned user message', () => {
    const sm = makeManager({
      buildSessionContext: () => ({
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', stopReason: 'endTurn', content: 'reply' },
          { role: 'user', content: 'orphaned — no assistant reply follows' },
        ],
      }),
      getBranch: () => [
        { type: 'message', id: 'id-user-1', message: { role: 'user' } },
        { type: 'message', id: 'id-asst-1', message: { role: 'assistant', stopReason: 'endTurn' } },
        { type: 'message', id: 'id-user-2', message: { role: 'user' } },
      ],
    });
    applySessionRollback(sm, noop);
    expect(sm.branch).toHaveBeenCalledWith('id-asst-1');
    expect(sm.resetLeaf).not.toHaveBeenCalled();
  });

  it('rolls back past a toolUse turn to the last non-toolUse assistant turn', () => {
    const sm = makeManager({
      buildSessionContext: () => ({
        messages: [
          { role: 'assistant', stopReason: 'toolUse' }, // incomplete — waiting for tool result
        ],
      }),
      getBranch: () => [
        { type: 'message', id: 'id-asst-complete', message: { role: 'assistant', stopReason: 'endTurn' } },
        { type: 'message', id: 'id-asst-tool', message: { role: 'assistant', stopReason: 'toolUse' } },
      ],
    });
    applySessionRollback(sm, noop);
    expect(sm.branch).toHaveBeenCalledWith('id-asst-complete');
  });

  it('resets to empty context when no complete assistant turn exists', () => {
    const sm = makeManager({
      buildSessionContext: () => ({
        messages: [{ role: 'user', content: 'first ever message, killed before reply' }],
      }),
      getBranch: () => [
        { type: 'message', id: 'id-user-1', message: { role: 'user' } },
      ],
    });
    const logs: string[] = [];
    applySessionRollback(sm, (msg) => logs.push(msg));
    expect(sm.resetLeaf).toHaveBeenCalledOnce();
    expect(sm.branch).not.toHaveBeenCalled();
    expect(logs[0]).toContain('empty context');
  });

  it('ignores non-message branch entries (e.g. compaction summaries)', () => {
    const sm = makeManager({
      buildSessionContext: () => ({
        messages: [{ role: 'user', content: 'orphaned' }],
      }),
      getBranch: () => [
        { type: 'compaction', id: 'compact-1' }, // no 'message' property
        { type: 'message', id: 'id-asst-1', message: { role: 'assistant', stopReason: 'endTurn' } },
        { type: 'message', id: 'id-user-1', message: { role: 'user' } },
      ],
    });
    applySessionRollback(sm, noop);
    expect(sm.branch).toHaveBeenCalledWith('id-asst-1');
  });
});
