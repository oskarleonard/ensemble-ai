import type { GitRun } from '../modes/review/worktree';

// pin-check: is a consumer's PINNED ensemble-ai commit still current with main?
//
// A consumer that installs ensemble-ai from a specific commit keeps running THAT commit
// silently after main advances — the staleness is invisible (a pinned pre-gate engine
// ran for a day+ while three PRs merged past it, unnoticed). This primitive compares the
// pinned commit against the tip of main and reports the drift, so a consumer's own doctor
// / health check can surface "N commits behind" instead of running stale.
//
// It is git-based because that IS the pin: consumers run a checkout, so the pinned commit
// is the checkout's HEAD and current-main is `origin/main`. The core takes an injected
// `GitRun` (the never-throwing seam the rest of the engine uses) so it is unit-tested with
// a fake, and drives real git through the same seam in the CLI.

export type PinStatus = 'current' | 'stale' | 'ahead' | 'diverged';

export interface PinDrift {
  repoDir: string;
  pinned: string; // full SHA of the pinned/running commit
  main: string; // full SHA of the compared main tip
  mainRef: string; // the ref compared against (default 'origin/main')
  behind: number; // commits `pinned` is BEHIND `main` — what a stale pin accrues
  ahead: number; // commits `pinned` is AHEAD of `main` — a local/unmerged build
  status: PinStatus;
  fetched: boolean; // did we refresh the remote ref, or read a possibly-stale local one?
  note?: string; // set when the fetch was skipped or failed (a best-effort local answer)
}

export interface PinCheckOptions {
  repoDir: string;
  git: GitRun;
  pin?: string; // explicit pinned commit/ref to check (default: the checkout's HEAD)
  mainRef?: string; // ref to compare against (default 'origin/main')
  fetch?: boolean; // default true — refresh the remote ref before comparing
}

// 'origin/main' → { remote:'origin', branch:'main' }. A ref with no '/' (a bare local
// branch/tag) has no remote to refresh — we skip the fetch and read it locally.
function remoteOf(mainRef: string): { remote: string; branch: string } | null {
  const i = mainRef.indexOf('/');
  if (i <= 0 || i === mainRef.length - 1) return null;
  return { remote: mainRef.slice(0, i), branch: mainRef.slice(i + 1) };
}

// Resolve a ref to a commit SHA, or null. `^{commit}` forces a commit object; a bad ref
// makes git exit non-zero, which the never-throwing GitRun returns as {ok:false} → null.
function revParse(git: GitRun, cwd: string, rev: string): string | null {
  const r = git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd });
  if (!r.ok) return null;
  const sha = r.text.trim();
  return sha.length ? sha : null;
}

function countRange(git: GitRun, cwd: string, range: string): number | null {
  const r = git(['rev-list', '--count', range], { cwd });
  if (!r.ok) return null;
  const n = Number(r.text.trim());
  return Number.isFinite(n) ? n : null;
}

export function checkPinDrift(opts: PinCheckOptions): PinDrift | { error: string } {
  const { git, repoDir } = opts;
  const mainRef = opts.mainRef ?? 'origin/main';
  const doFetch = opts.fetch !== false;

  const pinned = revParse(git, repoDir, opts.pin ?? 'HEAD');
  if (!pinned) {
    return {
      error: opts.pin
        ? `not a resolvable commit: ${opts.pin}`
        : `${repoDir} is not a git checkout (no resolvable HEAD) — pass --repo <ensemble-ai checkout> or --pin <sha>`,
    };
  }

  let fetched = false;
  let note: string | undefined;
  if (!doFetch) {
    note = `--no-fetch: compared against the local ${mainRef} (may be stale)`;
  } else {
    const remote = remoteOf(mainRef);
    if (!remote) {
      note = `"${mainRef}" has no remote to refresh; compared against the local ref`;
    } else {
      const f = git(['fetch', remote.remote, remote.branch], { cwd: repoDir });
      if (f.ok) fetched = true;
      else note = `fetch failed (${firstLine(f.error)}); compared against the last-known local ${mainRef}`;
    }
  }

  const main = revParse(git, repoDir, mainRef);
  if (!main) {
    return {
      error: `cannot resolve ${mainRef} in ${repoDir}${fetched ? '' : ' (fetch skipped/failed)'} — is its remote configured?`,
    };
  }

  const behind = countRange(git, repoDir, `${pinned}..${main}`);
  const ahead = countRange(git, repoDir, `${main}..${pinned}`);
  if (behind === null || ahead === null) {
    return { error: `could not compute drift between ${short(pinned)} and ${mainRef} (${short(main)})` };
  }

  const status: PinStatus =
    behind === 0 && ahead === 0 ? 'current' : ahead === 0 ? 'stale' : behind === 0 ? 'ahead' : 'diverged';

  return { repoDir, pinned, main, mainRef, behind, ahead, status, fetched, note };
}

export function short(sha: string): string {
  return sha.slice(0, 7);
}

function firstLine(s: string): string {
  return s.split('\n')[0].trim();
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

// A human one-liner for a drift result, shared by the CLI and any consumer that wants the
// same phrasing. STALE/DIVERGED are the attention states; the caller prefixes it.
export function describePinDrift(d: PinDrift): string {
  const tip = `${short(d.main)}${d.fetched ? '' : ' local'}`;
  if (d.status === 'current')
    return `current — pinned ${short(d.pinned)} is up to date with ${d.mainRef} (${tip}).`;
  if (d.status === 'ahead')
    return `ahead — pinned ${short(d.pinned)} is ${d.ahead} commit${plural(d.ahead)} ahead of ${d.mainRef} (${tip}) (a local/unmerged build).`;
  if (d.status === 'diverged')
    return `DIVERGED — pinned ${short(d.pinned)} is ${d.behind} behind and ${d.ahead} ahead of ${d.mainRef} (${tip}).`;
  return `STALE — pinned ${short(d.pinned)} is ${d.behind} commit${plural(d.behind)} behind ${d.mainRef} (${tip}). Update your pin.`;
}
