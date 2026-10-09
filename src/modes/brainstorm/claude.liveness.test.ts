import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { runClaudeVoice } from './claude';
import type { VoiceConfig } from './types';

// THE PHASE-0 PROOF (hugin spec doc-review-evidence §5): the doc voice is reclaimed by the right
// watchdog, with the reason and its last activity on the result — never by a blind absolute cap
// while it is working. REAL spawns of a stand-in "claude" (a shell script that speaks stream-json),
// through the same group-killed spawn primitive production uses, with the bars shrunk to ms.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-voice-liveness-'));
afterAll(() => fs.rmSync(dir, { force: true, recursive: true }));

function fakeClaude(name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

const cfg: VoiceConfig = { cmd: 'claude', effort: 'max', id: 'claude', model: 'opus', vendor: 'anthropic', web: true };
const EVENT = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"WebSearch"}]}}';
const RESULT = '{"type":"result","is_error":false,"result":"the reply"}';

describe('runClaudeVoice — liveness contract (stream-json + inactivity watchdog + backstop)', () => {
  it('a seat silent INSIDE an in-flight tool call is reclaimed by the inactivity watchdog, naming the tool', async () => {
    // One event (a WebSearch starts), then nothing — a wedge, not slow honest work. The bar is
    // 1.5 s: a detached `sh` needs a few hundred ms to emit its first line (measured 2026-10-09).
    const bin = fakeClaude('silent', `echo '${EVENT}'; sleep 30`);
    const res = await runClaudeVoice('p', cfg, { timeoutMs: 20_000 }, { bin, inactivityTimeoutMs: 1_500 });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.timedOutReason).toBe('inactivity');
    expect(res.failWhy).toMatch(/^stalled: no stream output/);
    expect(res.stream).toContain('WebSearch');
  }, 15_000);

  it('a seat that keeps streaming is cut only by the absolute backstop, and says so', async () => {
    const bin = fakeClaude('busy', `i=0; while [ $i -lt 100 ]; do echo '${EVENT}'; sleep 0.05; i=$((i+1)); done`);
    const res = await runClaudeVoice('p', cfg, { timeoutMs: 400 }, { bin, inactivityTimeoutMs: 5_000 });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.timedOutReason).toBe('absolute');
    expect(res.failWhy).toMatch(/backstop/);
  }, 15_000);

  it('a completed stream yields the result event text as the reply (ok, no reason)', async () => {
    const bin = fakeClaude('done', `echo '${EVENT}'; echo '${RESULT}'`);
    const res = await runClaudeVoice('p', cfg, { timeoutMs: 5_000 }, { bin, inactivityTimeoutMs: 2_000 });
    expect(res.ok).toBe(true);
    expect(res.raw).toBe('the reply');
    expect(res.timedOut).toBe(false);
    expect(res.timedOutReason).toBeUndefined();
  }, 15_000);

  it('a plain-text reply (no stream events) still works as the raw text', async () => {
    const bin = fakeClaude('plain', `echo 'just text'`);
    const res = await runClaudeVoice('p', cfg, { timeoutMs: 5_000 }, { bin, inactivityTimeoutMs: 2_000 });
    expect(res.ok).toBe(true);
    expect(res.raw).toBe('just text');
  }, 15_000);
});
