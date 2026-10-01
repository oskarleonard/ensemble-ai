import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const binCache = new Map<string, string>();

// Resolve a vendor CLI binary by name. An explicitly set env override is
// AUTHORITATIVE: a set, non-empty `opts.envVar` returns that path if it exists and
// THROWS if it does not — it never falls through to the candidates, the cache or
// PATH, because an override is a pin (e.g. a canaried CLI copy) and silently
// running a different binary is the opposite of what the pin is for. Unset or
// empty → reviewer CLIs (codex, grok) live in places a bare/non-login env can't
// see (nvm, ~/.local/bin), so resolution tries caller-supplied candidate paths,
// then the login shell's PATH (`zsh -ic`), memoized by name (stable for the
// process lifetime). The override path is never memoized — a stat per call is
// nothing, and a throw must re-check. Throws if nothing resolves — a missing
// reviewer CLI should fail loud, not silently skip the review.
export function resolveBin(
  name: string,
  opts: { candidates?: string[]; envVar?: string } = {}
): string {
  const override = opts.envVar ? process.env[opts.envVar] : undefined;
  if (override) {
    if (fs.existsSync(override)) return override;
    throw new Error(
      `${opts.envVar}=${override} does not exist — unset it to use the default resolution`
    );
  }
  const cached = binCache.get(name);
  if (cached) return cached;
  for (const c of opts.candidates ?? []) {
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
