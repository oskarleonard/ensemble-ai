import type { ConventionReader } from '../../core/conventions';

// The repo's OWN word on which paths hold fake secrets by design — its gitleaks
// allowlist. A gitleaks self-test, a bats fixture, a documented example key: the
// repo already declared them non-secret in `.gitleaks.toml`, and its CI scans them
// with that exemption. The inline-secret preflight honours the same declaration
// so a review is not vetoed on a fixture the repo's own scanner waves through.
//
// Only the GLOBAL `[allowlist]` / `[[allowlists]]` `paths` arrays count. Per-rule
// allowlists (`[rules.allowlist]`) exempt ONE gitleaks rule, which does not map
// onto this scanner's patterns, so they are ignored. `regexes` (line-level) are
// ignored too: they are written against gitleaks' rules, not these.
//
// The config is read through the SAME reader the conventions gatherer uses: the
// filesystem for a local review, the GitHub contents API pinned to the PR's BASE
// for a `--pr <url>` review — so a PR cannot widen its own allowlist.

export interface GitleaksAllowlist {
  // Repo-relative path of the config this came from.
  configPath: string;
  // The directory the config lives in ('' = repo root). Patterns are tried against
  // the file path relative to this dir AND the repo-relative path, because gitleaks
  // is run from the config's dir by `make` and from the root by a staged hook.
  dir: string;
  // Pattern sources that did not compile as a JS RegExp (RE2 syntax JS lacks).
  invalid: string[];
  patterns: RegExp[];
}

// Cap on a config read. A gitleaks config is a few KB; anything past this is not one.
const CONFIG_MAX_BYTES = 256 * 1024;
// A pattern longer than this is not a path allowlist entry.
const PATTERN_MAX_CHARS = 512;

// TOML section headers: `[allowlist]`, `[[allowlists]]`, `[rules.allowlist]`, …
const SECTION_RE = /^[ \t]*\[\[?[ \t]*([A-Za-z0-9_.-]+)[ \t]*\]\]?[ \t]*(?:#.*)?$/gm;
const PATHS_KEY_RE = /^[ \t]*paths[ \t]*=[ \t]*\[/m;

// Read the string elements of a TOML array starting just after its `[`. Walks the
// text as TOML does — a `#` outside a string is a comment to end of line, `'''…'''`
// and `'…'` are literal, `"…"` honours backslash escapes — so a `]` or a quote inside
// a regex never ends the array early. Stops at the array's own `]`.
export function readTomlStringArray(text: string, from: number): string[] {
  const out: string[] = [];
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === ']') break;
    if (c === '#') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (text.startsWith("'''", i)) {
      const end = text.indexOf("'''", i + 3);
      if (end === -1) break;
      out.push(text.slice(i + 3, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      if (end === -1) break;
      out.push(unescapeBasic(text.slice(i + 3, end)));
      i = end + 3;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) break;
      out.push(text.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) break;
      out.push(unescapeBasic(text.slice(i + 1, j)));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

function unescapeBasic(s: string): string {
  return s.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_m, e: string) => {
    switch (e[0]) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'u':
      case 'U':
        return String.fromCodePoint(parseInt(e.slice(1), 16));
      default:
        return e;
    }
  });
}

// RE2 → JS. The one inline flag gitleaks configs actually use is a leading `(?i)`;
// anything else JS cannot express fails to compile and is reported, not guessed.
function compileRe2(src: string): RegExp | null {
  if (src.length > PATTERN_MAX_CHARS) return null;
  let flags = '';
  let body = src;
  const m = /^\(\?([a-z]+)\)/.exec(body);
  if (m) {
    if (m[1] !== 'i') return null;
    flags = 'i';
    body = body.slice(m[0].length);
  }
  try {
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

// The global allowlist `paths` of a gitleaks config, compiled. PURE.
export function parseGitleaksAllowlistPaths(toml: string): { invalid: string[]; patterns: RegExp[] } {
  const patterns: RegExp[] = [];
  const invalid: string[] = [];
  const headers = [...toml.matchAll(SECTION_RE)];
  for (let h = 0; h < headers.length; h++) {
    const name = headers[h][1];
    if (name !== 'allowlist' && name !== 'allowlists') continue;
    const start = headers[h].index! + headers[h][0].length;
    const end = h + 1 < headers.length ? headers[h + 1].index! : toml.length;
    const body = toml.slice(start, end);
    const key = PATHS_KEY_RE.exec(body);
    if (!key) continue;
    for (const src of readTomlStringArray(body, key.index + key[0].length)) {
      const re = compileRe2(src);
      if (re) patterns.push(re);
      else invalid.push(src.slice(0, 80));
    }
  }
  return { invalid, patterns };
}

// Every `.gitleaks.toml` that could govern a file: the root's, then one per ancestor
// directory (`backend/.gitleaks.toml` for `backend/scripts/x.sh`). Root first.
export function gitleaksConfigCandidates(filePath: string): { configPath: string; dir: string }[] {
  const out = [{ configPath: '.gitleaks.toml', dir: '' }];
  const parts = filePath.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    out.push({ configPath: `${dir}/.gitleaks.toml`, dir });
  }
  return out;
}

// Does this allowlist exempt the file? Tried against the path relative to the
// config's dir and against the repo-relative path (see `dir`).
export function gitleaksAllowlisted(a: GitleaksAllowlist, filePath: string): boolean {
  const rel = a.dir && filePath.startsWith(`${a.dir}/`) ? filePath.slice(a.dir.length + 1) : filePath;
  return a.patterns.some((re) => re.test(rel) || (rel !== filePath && re.test(filePath)));
}

export interface GitleaksExemptions {
  // Configs that were found and parsed (repo-relative paths), in read order.
  configs: string[];
  // file path → the config that exempts it.
  exempt: Map<string, string>;
  // Pattern sources (per config) this scanner could not compile — named, never silent.
  invalid: { configPath: string; pattern: string }[];
}

// Resolve which of `paths` the repo's gitleaks allowlist exempts. Reads each
// candidate config ONCE through the reader; a missing config is the normal case.
export async function resolveGitleaksExemptions(
  reader: ConventionReader,
  paths: readonly string[]
): Promise<GitleaksExemptions> {
  const cache = new Map<string, GitleaksAllowlist | null>();
  const configs: string[] = [];
  const invalid: { configPath: string; pattern: string }[] = [];
  const exempt = new Map<string, string>();
  const load = async (configPath: string, dir: string): Promise<GitleaksAllowlist | null> => {
    if (cache.has(configPath)) return cache.get(configPath)!;
    const text = await reader.read(configPath, CONFIG_MAX_BYTES);
    let parsed: GitleaksAllowlist | null = null;
    if (text !== null) {
      const p = parseGitleaksAllowlistPaths(text);
      parsed = { configPath, dir, invalid: p.invalid, patterns: p.patterns };
      configs.push(configPath);
      for (const pattern of p.invalid) invalid.push({ configPath, pattern });
    }
    cache.set(configPath, parsed);
    return parsed;
  };
  for (const filePath of paths) {
    for (const { configPath, dir } of gitleaksConfigCandidates(filePath)) {
      const a = await load(configPath, dir);
      if (a && gitleaksAllowlisted(a, filePath)) {
        exempt.set(filePath, configPath);
        break;
      }
    }
  }
  return { configs, exempt, invalid };
}
