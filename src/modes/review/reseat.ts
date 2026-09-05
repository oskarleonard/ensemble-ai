import { WORKTREE_SUFFIX_HEADER } from './seat-evidence';

// RESEAT — re-run ONE failed core reviewer seat against a run's own pinned packet, then regate the
// union. regate's sibling, one stage earlier (incident 2026-09-02b: a vendor CLI's self-update broke
// one seat's sandbox twice in a day; every other seat and the gate completed, and the only remedies
// were a two-voice review or re-billing everyone).

export interface SplitPrompt {
  // Recovered from the preamble's `git diff <base>...<head>` line; null when it had none.
  baseSha: string | null;
  hadWorktree: boolean;
  // The pinned packet prompt — byte-identical to what every seat saw, minus the preamble.
  packetPrompt: string;
}

// PURE. The persisted `prompt.<seat>.md` is the packet prompt PLUS, in worktree mode, a preamble
// naming the (long reaped) worktree dir. Strip at the shared header; never re-render the packet.
export function splitWorktreePrompt(prompt: string): SplitPrompt {
  const idx = prompt.indexOf(`\n\n${WORKTREE_SUFFIX_HEADER}`);
  if (idx === -1) return { baseSha: null, hadWorktree: false, packetPrompt: prompt };
  const suffix = prompt.slice(idx);
  const m = suffix.match(/git diff ([0-9a-f]{7,40})\.\.\.[0-9a-f]{7,40}/);
  return { baseSha: m ? m[1] : null, hadWorktree: true, packetPrompt: prompt.slice(0, idx) };
}
