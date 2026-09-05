import { describe, expect, it } from 'vitest';

import { WORKTREE_SUFFIX_HEADER, worktreePromptSuffix } from './seat-evidence';
import { splitWorktreePrompt } from './reseat';

const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);

describe('splitWorktreePrompt — recover the pinned packet prompt from a persisted seat prompt', () => {
  it('returns a packet-mode prompt unchanged', () => {
    expect(splitWorktreePrompt('PINNED PROMPT')).toEqual({ baseSha: null, hadWorktree: false, packetPrompt: 'PINNED PROMPT' });
  });

  it('strips the worktree preamble at the shared header and recovers the base SHA', () => {
    const prompt = 'PINNED PROMPT' + worktreePromptSuffix({ baseSha: BASE, headSha: HEAD, worktree: '/tmp/old-worktree' });
    expect(prompt).toContain(WORKTREE_SUFFIX_HEADER);
    const split = splitWorktreePrompt(prompt);
    expect(split.packetPrompt).toBe('PINNED PROMPT');
    expect(split.hadWorktree).toBe(true);
    expect(split.baseSha).toBe(BASE);
  });

  it('a preamble with no base range yields baseSha null', () => {
    const prompt = 'P' + worktreePromptSuffix({ baseSha: null, headSha: HEAD, worktree: '/tmp/w' });
    expect(splitWorktreePrompt(prompt)).toEqual({ baseSha: null, hadWorktree: true, packetPrompt: 'P' });
  });
});
