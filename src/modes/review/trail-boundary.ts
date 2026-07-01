// Trail boundary guard — brain separation for `_work` repos (boundaries rule 14).
// A review of a `_work` (employer-side) repo must never write its trail/receipt into
// the personal brain, even when `--out` (or the default) would land there. General to
// EVERY review path, not any one reviewer.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Resolve a path through symlinks WITHOUT requiring it to exist yet (the trail out-dir
// is created later): realpath the nearest existing ancestor, then re-append the missing
// tail. A pure `path.resolve` is a STRING op that a symlink can defeat — e.g. a `_work`
// out dir symlinked into ~/brain would resolve to a non-brain string and slip the guard.
// Mirrors Part A's convention-boundary symlink fix.
function realpathBestEffort(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // hit the root without resolving
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

// True iff a path lies under a `_work` fence — the employer-side repo bucket. The
// review of such a repo must never write its trail into the personal brain. Realpath
// first so a symlinked repo path can't hide the `_work` segment.
export function isUnderWorkPath(p: string): boolean {
  return realpathBestEffort(p)
    .split(path.sep)
    .some((seg) => seg === '_work' || seg.startsWith('_work-'));
}

// PURE-ish: would writing the trail to `outDir` for a review of `cwd` cross the brain
// boundary? True iff the repo is a `_work` repo AND the out dir resolves under one of
// the personal-brain roots. Both sides are realpath'd (not string-resolved) so a
// symlinked out dir can't slip the fence. (Injectable roots keep this unit-testable.)
export function trailBoundaryViolation(
  cwd: string,
  outDir: string,
  brainRoots: string[]
): boolean {
  if (!isUnderWorkPath(cwd)) return false;
  const out = realpathBestEffort(outDir);
  // Realpath BOTH sides through the same resolver so any symlink transform (e.g. macOS
  // `/home` autofs) applies identically to out and the roots — a string-only compare
  // would spuriously miss/hit once one side is resolved.
  return brainRoots.some((root) => {
    const r = realpathBestEffort(root);
    return out === r || out.startsWith(r + path.sep);
  });
}

// The personal-brain roots to fence a `_work` trail out of (~/brain + its real target).
export function resolveBrainRoots(): string[] {
  const roots = new Set<string>();
  const candidates = [
    path.join(os.homedir(), 'brain'),
    path.join(os.homedir(), 'programming', 'projects', '_personal', 'my-brain'),
  ];
  for (const c of candidates) {
    try {
      roots.add(fs.realpathSync(c));
    } catch {
      // not present on this machine — skip
    }
    roots.add(path.resolve(c));
  }
  return [...roots];
}

// Enforce the boundary: for a `_work` repo, force the trail to a local temp dir when
// the requested out dir would land in the brain. Returns the safe out dir + whether it
// was overridden (so the CLI can warn).
export function enforceTrailBoundary(
  cwd: string,
  outDir: string,
  runId: string,
  brainRoots: string[] = resolveBrainRoots()
): { out: string; overridden: boolean } {
  if (trailBoundaryViolation(cwd, outDir, brainRoots)) {
    return { out: path.join(os.tmpdir(), 'ensemble-ai', runId), overridden: true };
  }
  return { out: outDir, overridden: false };
}
