import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const binCache = new Map<string, string>();

// Resolve a vendor CLI binary by name. Reviewer CLIs (codex, grok) live in places
// a bare/non-login env can't see (nvm, ~/.local/bin), so resolution tries, in
// order: an explicit env override, caller-supplied candidate paths, then the
// login shell's PATH (`zsh -ic`). Memoized by name (resolution is stable for the
// process lifetime). Throws if nothing resolves — a missing reviewer CLI should
// fail loud, not silently skip the review.
export function resolveBin(
  name: string,
  opts: { candidates?: string[]; envVar?: string } = {}
): string {
  const cached = binCache.get(name);
  if (cached) return cached;
  const candidates = [
    opts.envVar ? process.env[opts.envVar] : undefined,
    ...(opts.candidates ?? []),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      binCache.set(name, c);
      return c;
    }
  }
  const found = execFileSync('/bin/zsh', ['-ic', `whence -p ${name}`], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .pop();
  if (!found) throw new Error(`${name} binary not found`);
  binCache.set(name, found);
  return found;
}
