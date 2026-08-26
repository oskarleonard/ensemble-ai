import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type ConventionReader,
  extractDirRefs,
  extractRefs,
  fsConventionReader,
  gatherConventions,
  memoryConventionReader,
  resolveInRepo,
} from './conventions';

const included = (m: { files: { path: string; included: boolean }[] }): string[] =>
  m.files.filter((f) => f.included).map((f) => f.path);

describe('resolveInRepo — the boundary guard', () => {
  it('resolves in-tree relative refs', () => {
    expect(resolveInRepo('', 'AGENTS.md')).toBe('AGENTS.md');
    expect(resolveInRepo('pkg', '../CLAUDE.md')).toBe('CLAUDE.md');
    expect(resolveInRepo('', 'ai-spec/DISCOVERIES.md')).toBe('ai-spec/DISCOVERIES.md');
    expect(resolveInRepo('a', 'b.md#section')).toBe('a/b.md');
  });
  it('REJECTS absolute / home / url / escaping refs', () => {
    expect(resolveInRepo('', '~/brain/me/identity.md')).toBeNull();
    expect(resolveInRepo('', '/etc/passwd.md')).toBeNull();
    expect(resolveInRepo('', 'https://example.com/x.md')).toBeNull();
    expect(resolveInRepo('', '../../outside.md')).toBeNull();
    expect(resolveInRepo('pkg', '../../outside.md')).toBeNull();
  });
});

describe('extractRefs — three link mechanisms', () => {
  it('picks up @-imports, md links, prose refs — not emails', () => {
    const refs = extractRefs(
      '@AGENTS.md and @ai-spec/DISCOVERIES.md\nsee [arch](docs/ARCHITECTURE.md)\nplease read `TECH_DESIGN.md`\ncontact foo@bar.md'
    );
    expect(refs).toContain('AGENTS.md');
    expect(refs).toContain('ai-spec/DISCOVERIES.md');
    expect(refs).toContain('docs/ARCHITECTURE.md');
    expect(refs).toContain('TECH_DESIGN.md');
    expect(refs).not.toContain('bar.md'); // email, not an import
  });
});

// A1 — personal repo: @AGENTS.md @ai-spec/DISCOVERIES.md + md-link + dup import +
// absolute @~/x that MUST be ignored.
describe('A1 · personal @-import fixture', () => {
  const reader = memoryConventionReader({
    'CLAUDE.md':
      '# House rules\n@AGENTS.md\n@ai-spec/DISCOVERIES.md\n@AGENTS.md\n' + // dup import
      '@~/brain/me/identity.md\n' + // absolute — MUST be ignored
      'more in [learnings](ai-spec/AGENT_LEARNINGS.md)\n',
    'AGENTS.md': 'agents rules, see `ai-spec/DISCOVERIES.md`',
    'ai-spec/DISCOVERIES.md': 'discoveries body',
    'ai-spec/AGENT_LEARNINGS.md': 'learnings body',
  });

  it('flattens the linked set, deduped + in-repo only', async () => {
    const { text, manifest } = await gatherConventions(reader, ['src/app.ts']);
    const paths = included(manifest);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('ai-spec/DISCOVERIES.md');
    expect(paths).toContain('ai-spec/AGENT_LEARNINGS.md');
    // dedupe: AGENTS.md imported twice appears once
    expect(paths.filter((p) => p === 'AGENTS.md')).toHaveLength(1);
    // boundary: the absolute ~/brain import is NOT followed — no such file entry
    // (the `@~/…` line lives inside CLAUDE.md's own body, but it is never resolved).
    expect(paths.some((p) => p.includes('identity'))).toBe(false);
    expect(paths.some((p) => p.includes('brain'))).toBe(false);
    // each file headed by its path
    expect(text).toContain('===== CLAUDE.md =====');
    expect(text).toContain('discoveries body');
  });
});

// A2 — monorepo: root CLAUDE.md + pkg/CLAUDE.md + CONTRIBUTING.md, diff touches pkg/
// → gathers root AND pkg conventions + common-docs via walk-up + fallback + prose-ref;
// diff touching only root → does not pull unrelated packages.
describe('A2 · monorepo walk-up + fallback + prose-ref', () => {
  const reader = memoryConventionReader({
    'CLAUDE.md': 'root rules. Architecture in ARCHITECTURE.md',
    'CONTRIBUTING.md': 'contributing guide',
    'ARCHITECTURE.md': 'arch doc',
    'packages/api/CLAUDE.md': 'api package rules\n@AGENTS.md',
    'packages/api/AGENTS.md': 'api agents',
    'packages/web/CLAUDE.md': 'web package rules (unrelated)',
  });

  it('a pkg-touching diff gathers root + that pkg + common-docs, not siblings', async () => {
    const { manifest } = await gatherConventions(reader, [
      'packages/api/src/handler.ts',
    ]);
    const paths = included(manifest);
    expect(paths).toContain('CLAUDE.md'); // root (walk-up)
    expect(paths).toContain('CONTRIBUTING.md'); // common-docs fallback at root
    expect(paths).toContain('ARCHITECTURE.md'); // prose-ref from root CLAUDE.md
    expect(paths).toContain('packages/api/CLAUDE.md'); // touched package
    expect(paths).toContain('packages/api/AGENTS.md'); // its @-import
    expect(paths).not.toContain('packages/web/CLAUDE.md'); // unrelated sibling
  });

  it('a root-only diff does not pull any package', async () => {
    const { manifest } = await gatherConventions(reader, ['README.md']);
    const paths = included(manifest);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).not.toContain('packages/api/CLAUDE.md');
    expect(paths).not.toContain('packages/web/CLAUDE.md');
  });
});

// A3 — over-cap NAMED truncated in the manifest.
describe('A3 · over-cap files are NAMED, never silently dropped', () => {
  it('caps total size and names the truncated + omitted files', async () => {
    // DISTINCT contents — byte-identical files dedupe (see the duplicate-content suite below),
    // which would let everything fit and defeat this test's premise.
    const reader = memoryConventionReader({
      'CLAUDE.md': '@AGENTS.md\n@ai-spec/DISCOVERIES.md',
      'AGENTS.md': 'x'.repeat(5_000),
      'ai-spec/DISCOVERIES.md': 'y'.repeat(5_000),
    });
    const { text, manifest } = await gatherConventions(reader, ['a.ts'], {
      capBytes: 6_000,
    });
    // Something crossed the cap → it MUST be named (truncated or omitted), never silent.
    const named = manifest.files.filter((f) => f.truncated || f.reason === 'over-cap');
    expect(named.length).toBeGreaterThan(0);
    expect(manifest.totalBytes).toBeLessThanOrEqual(6_000);
    if (manifest.files.some((f) => f.truncated)) {
      expect(text).toContain('bytes truncated — over the');
    }
    // every gathered file is accounted for in the manifest (nothing silently dropped)
    expect(manifest.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['CLAUDE.md', 'AGENTS.md', 'ai-spec/DISCOVERIES.md'])
    );
  });

  it('FAIR SHARE: a giant file discovered first no longer starves a later mandatory doc', async () => {
    // The live incident this pins: CLAUDE.md links a ~180KB DISCOVERIES.md one line before a
    // 26KB LEARNINGS.md the repo calls mandatory. The old first-come allocation gave the giant
    // the whole remaining budget and omitted LEARNINGS entirely; water-filling takes the small
    // file WHOLE and head-truncates the giant into its own share.
    const reader = memoryConventionReader({
      'CLAUDE.md': 'see spec/DISCOVERIES.md then see spec/LEARNINGS.md',
      'spec/DISCOVERIES.md': 'd'.repeat(50_000),
      'spec/LEARNINGS.md': 'l'.repeat(3_000),
    });
    const { text, manifest } = await gatherConventions(reader, ['a.ts'], { capBytes: 10_000 });
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    expect(byPath['spec/LEARNINGS.md']).toMatchObject({ included: true, truncated: false });
    expect(byPath['spec/DISCOVERIES.md']).toMatchObject({ included: true, truncated: true, reason: 'over-cap' });
    expect(text).toContain('l'.repeat(3_000)); // the mandatory doc arrives WHOLE
    expect(manifest.totalBytes).toBeLessThanOrEqual(10_000);
  });

  it('DUPLICATE CONTENT: an AGENTS.md symlink/copy of CLAUDE.md spends the budget once, named', async () => {
    const shared = 'the one true conventions prose '.repeat(100); // ~3.1KB
    const reader = memoryConventionReader({
      'CLAUDE.md': shared,
      'AGENTS.md': shared,
      'CONTRIBUTING.md': 'c'.repeat(500),
    });
    const { text, manifest } = await gatherConventions(reader, ['a.ts'], { capBytes: 5_000 });
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    expect(byPath['CLAUDE.md']).toMatchObject({ included: true, truncated: false });
    expect(byPath['AGENTS.md']).toMatchObject({ included: false, reason: 'duplicate', duplicateOf: 'CLAUDE.md' });
    expect(byPath['CONTRIBUTING.md']).toMatchObject({ included: true });
    // the shared prose appears exactly once in the packet
    expect(text.indexOf(shared)).toBe(text.lastIndexOf(shared));
  });

  it('--no-conventions is modeled as an empty gather by the caller (no reader call)', async () => {
    // The gatherer itself, given no reachable files, yields empty text + empty manifest.
    const { text, manifest } = await gatherConventions(
      memoryConventionReader({}),
      ['a.ts']
    );
    expect(text).toBe('');
    expect(manifest.files).toHaveLength(0);
    expect(manifest.totalBytes).toBe(0);
  });
});

// A4 — _work-style fixture with an absolute @~/brain/... import → NOT followed
// (boundary). A _work packet contains ONLY that repo's own files.
describe('A4 · boundary — a _work repo never pulls anything external', () => {
  const reader = memoryConventionReader({
    'CLAUDE.md':
      '# work monorepo\n@~/brain/INDEX.md\n@~/brain/me/identity.md\n@services/pay/CLAUDE.md',
    'services/pay/CLAUDE.md': 'payments service rules',
  });

  it('follows only in-repo imports, never the ~/brain ones', async () => {
    const { text, manifest } = await gatherConventions(reader, [
      'services/pay/src/charge.ts',
    ]);
    const paths = included(manifest);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('services/pay/CLAUDE.md');
    // NONE of the ~/brain imports are resolved into the packet as file entries
    // (the `@~/…` lines live in CLAUDE.md's body but are never followed).
    expect(text).toContain('payments service rules'); // the in-repo import WAS followed
    expect(manifest.files.every((f) => !f.path.includes('brain'))).toBe(true);
  });
});

// Config lever — explicit conventions for a non-standard layout.
describe('config lever · explicit conventions paths', () => {
  it('adds explicitly-declared files (and still boundary-guards them)', async () => {
    const reader = memoryConventionReader({
      'docs/house-style.md': 'the non-standard convention file',
      'CLAUDE.md': 'root',
    });
    const { manifest } = await gatherConventions(reader, ['a.ts'], {
      conventions: ['docs/house-style.md', '~/brain/escape.md'],
    });
    const paths = included(manifest);
    expect(paths).toContain('docs/house-style.md');
    expect(paths.some((p) => p.includes('brain'))).toBe(false); // escape rejected
  });
});

describe('C · byte-cap bounds the READ (never slurp a huge file to trim it)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-conv-'));
  });
  afterEach(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  it('fs reader reads AT MOST maxBytes off disk, and the full file when unbounded', async () => {
    const full = 'y'.repeat(200_000);
    fs.writeFileSync(path.join(root, 'big.md'), full);
    const reader = fsConventionReader(root);
    const bounded = await reader.read('big.md', 1_000);
    expect(bounded).not.toBeNull();
    expect(Buffer.byteLength(bounded as string, 'utf8')).toBeLessThanOrEqual(1_000);
    expect((bounded as string).length).toBeLessThan(full.length); // truly bounded, not trimmed-after
    const whole = await reader.read('big.md');
    expect(Buffer.byteLength(whole as string, 'utf8')).toBe(200_000);
  });

  it('gatherConventions passes the cap as the read bound (memory reader honors it)', async () => {
    const reader = memoryConventionReader({ 'CLAUDE.md': 'z'.repeat(50_000) });
    const seen: (number | undefined)[] = [];
    const spy = {
      read: (rel: string, maxBytes?: number) => {
        seen.push(maxBytes);
        return reader.read(rel, maxBytes);
      },
      list: reader.list,
    };
    await gatherConventions(spy, ['a.ts'], { capBytes: 6_000 });
    // Every real read was bounded (never undefined) and only a tiny margin past the cap
    // (the read-truncation detection probe = capBytes + a few bytes), never the whole file.
    const reads = seen.filter((n) => n !== undefined) as number[];
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((n) => n <= 6_100)).toBe(true);
  });
});

describe('C · maxFiles boundary file is NAMED, not silently dropped', () => {
  it('names the file that trips the ceiling with reason max-files', async () => {
    // Only CLAUDE.md (which links a.md) + a.md exist. With maxFiles=1, CLAUDE.md is the one
    // processed file; a.md is the boundary — it must be NAMED omitted, never silently gone.
    const reader = memoryConventionReader({
      'CLAUDE.md': '@a.md',
      'a.md': 'the linked doc',
    });
    const { manifest } = await gatherConventions(reader, ['x.ts'], { maxFiles: 1 });
    const boundary = manifest.files.find((f) => f.reason === 'max-files');
    expect(boundary).toBeDefined();
    expect(boundary?.path).toBe('a.md');
    expect(boundary?.included).toBe(false);
    // The one real file under the ceiling IS included — the ceiling didn't drop everything.
    expect(manifest.files.some((f) => f.path === 'CLAUDE.md' && f.included)).toBe(true);
  });
});

describe('read-truncation honesty (MED conventions.ts:189)', () => {
  it('an over-cap file is bounded-read, marked truncated, and never reported complete', async () => {
    const cap = 200;
    // A file far larger than the cap. A read must be BOUNDED (not slurp the whole file),
    // and its manifest entry must be head-only (truncated:true), never truncated:false.
    const big = 'A'.repeat(5000);
    const asks: Array<number | undefined> = [];
    const reader: ConventionReader = {
      async read(rel, maxBytes) {
        asks.push(maxBytes);
        if (rel !== 'AGENTS.md') return null;
        // Honor the bound like a real reader (return at most maxBytes bytes).
        return maxBytes === undefined ? big : big.slice(0, maxBytes);
      },
      async list() {
        return [];
      },
    };
    const { manifest } = await gatherConventions(reader, ['src/x.ts'], { capBytes: cap });
    const entry = manifest.files.find((f) => f.path === 'AGENTS.md');
    expect(entry).toBeDefined();
    expect(entry?.truncated).toBe(true); // a head, not a complete file
    expect(entry?.included).toBe(true); // its head IS in the flattened text
    expect(entry?.bytes).toBeLessThanOrEqual(cap); // never over the cap
    // The read was BOUNDED to a small probe of the cap — never an unbounded slurp.
    expect(asks.every((a) => typeof a === 'number' && a <= cap + 64)).toBe(true);
  });

  it('a small under-cap file is reported complete (truncated:false)', async () => {
    const reader: ConventionReader = {
      async read(rel) {
        return rel === 'AGENTS.md' ? '# short doc\n' : null;
      },
      async list() {
        return [];
      },
    };
    const { manifest } = await gatherConventions(reader, ['src/x.ts'], { capBytes: 4000 });
    const entry = manifest.files.find((f) => f.path === 'AGENTS.md');
    expect(entry).toMatchObject({ included: true, truncated: false });
  });
});

// ── Tiers: the budget is filled MANDATORY → NAMED → SWEPT, so a rule the repo asked
// reviewers to apply can never lose its share to a runbook that happened to be linked.
describe('tiers · rules dirs and entry files are MANDATORY and fill the budget first', () => {
  it('sweeps .claude/rules/*.md as mandatory even when CLAUDE.md names only the directory', async () => {
    const reader = memoryConventionReader({
      'CLAUDE.md': 'Project review criteria are in `.claude/rules/` — apply them.',
      '.claude/rules/architecture.md': 'a'.repeat(1_000),
      '.claude/rules/testing.md': 't'.repeat(1_000),
    });
    const { manifest } = await gatherConventions(reader, ['pkg/x.go']);
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    expect(byPath['.claude/rules/architecture.md']).toMatchObject({ included: true, tier: 0 });
    expect(byPath['.claude/rules/testing.md']).toMatchObject({ included: true, tier: 0 });
    expect(byPath['CLAUDE.md']).toMatchObject({ included: true, tier: 0 });
  });

  it('a big linked runbook cannot squeeze the rules: MANDATORY takes its share first', async () => {
    // The live shape of run 2026-08-26-10-45-52: CLAUDE.md links a 12 KB on-call runbook;
    // under pure fair-share it took budget the rules never got.
    const reader = memoryConventionReader({
      'CLAUDE.md': 'see docs/runbook.md for on-call',
      '.claude/rules/a.md': 'a'.repeat(3_000),
      '.claude/rules/b.md': 'b'.repeat(3_000),
      'docs/runbook.md': 'r'.repeat(6_000),
    });
    const { manifest, text } = await gatherConventions(reader, ['x.go'], { capBytes: 8_000 });
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    expect(byPath['.claude/rules/a.md']).toMatchObject({ included: true, truncated: false, tier: 0 });
    expect(byPath['.claude/rules/b.md']).toMatchObject({ included: true, truncated: false, tier: 0 });
    // the runbook gets only what the rules left — truncated or omitted, but NAMED
    expect(byPath['docs/runbook.md'].tier).toBe(1);
    expect(byPath['docs/runbook.md'].included && !byPath['docs/runbook.md'].truncated).toBe(false);
    expect(manifest.totalBytes).toBeLessThanOrEqual(8_000);
    // and the packet reads the rules BEFORE the runbook
    expect(text.indexOf('===== .claude/rules/a.md')).toBeLessThan(text.indexOf('===== docs/runbook.md') === -1 ? Infinity : text.indexOf('===== docs/runbook.md'));
  });

  it('an @-include of an entry file is mandatory even when a docs/ sweep found it first as swept', async () => {
    // Seeds enqueue the docs/ sweep (tier 2) BEFORE CLAUDE.md is read and found to
    // @-include the same file; the stronger claim must win, and the include's own
    // named links must be re-tiered beneath it.
    const reader = memoryConventionReader({
      'CLAUDE.md': 'read this\n@docs/architecture.md',
      'docs/architecture.md': 'see docs/deep.md\n' + 'x'.repeat(500),
      'docs/deep.md': 'deep',
    });
    const { manifest } = await gatherConventions(reader, ['x.go']);
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    expect(byPath['docs/architecture.md'].tier).toBe(0);
    expect(byPath['docs/deep.md'].tier).toBe(1); // named by a tier-0 file
  });

  it('explicit --conventions paths are mandatory', async () => {
    const reader = memoryConventionReader({
      'CLAUDE.md': 'root',
      'docs/house-style.md': 'h'.repeat(100),
    });
    const { manifest } = await gatherConventions(reader, ['x.go'], { conventions: ['docs/house-style.md'] });
    expect(manifest.files.find((f) => f.path === 'docs/house-style.md')?.tier).toBe(0);
  });

  it('a swept doc nobody names is SWEPT; a file it links stays swept', async () => {
    const reader = memoryConventionReader({
      'CLAUDE.md': 'root',
      'docs/random.md': 'see docs/other.md',
      'docs/other.md': 'o',
    });
    const { manifest } = await gatherConventions(reader, ['x.go']);
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    expect(byPath['docs/random.md'].tier).toBe(2);
    expect(byPath['docs/other.md'].tier).toBe(2);
  });
});

describe('discovery · backticked paths and directories', () => {
  it('a backticked path in a table cell is followed (the mobile repo names its mandatory doc that way)', async () => {
    const reader = memoryConventionReader({
      'CLAUDE.md': '| `spec-ai/LEARNINGS.md` | mandatory before every task |',
      'spec-ai/LEARNINGS.md': 'learnings',
    });
    const { manifest } = await gatherConventions(reader, ['x.ts']);
    expect(manifest.files.find((f) => f.path === 'spec-ai/LEARNINGS.md')).toMatchObject({ included: true, tier: 1 });
  });

  it('a backticked directory names every *.md directly inside it', async () => {
    const reader = memoryConventionReader({
      'CLAUDE.md': 'The guides live in `guides/`.',
      'guides/one.md': '1',
      'guides/two.md': '2',
      'guides/nested/three.md': '3', // one level only, like every other sweep
    });
    const { manifest } = await gatherConventions(reader, ['x.ts']);
    const paths = included(manifest);
    expect(paths).toContain('guides/one.md');
    expect(paths).toContain('guides/two.md');
    expect(paths).not.toContain('guides/nested/three.md');
  });

  it('a backticked ref that resolves outside the repo, or to nothing, is ignored', async () => {
    const reader = memoryConventionReader({ 'CLAUDE.md': 'see `../escape.md` and `missing.md` and `~/brain/x.md`' });
    const { manifest } = await gatherConventions(reader, ['x.ts']);
    expect(manifest.files.map((f) => f.path)).toEqual(['CLAUDE.md']);
  });

  it('extractDirRefs needs the trailing slash — a bare word is not a directory', () => {
    expect(extractDirRefs('in `.claude/rules/` and `docs` and `src/lib/`')).toEqual(['.claude/rules/', 'src/lib/']);
  });
});

describe('READMEs never rise above SWEPT unless pinned', () => {
  it('a README named by a rule stays swept; an explicitly configured one is mandatory', async () => {
    const reader = memoryConventionReader({
      'CLAUDE.md': 'see docs/diagrams/README.md and see scripts/pilot/README.md',
      'docs/diagrams/README.md': 'g'.repeat(100),
      'scripts/pilot/README.md': 'p'.repeat(100),
    });
    const { manifest } = await gatherConventions(reader, ['x.go'], { conventions: ['scripts/pilot/README.md'] });
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    expect(byPath['docs/diagrams/README.md'].tier).toBe(2);
    expect(byPath['scripts/pilot/README.md'].tier).toBe(0);
  });
});

describe('allocation · a whole small doc beats a useless head of every doc', () => {
  it('admits the smallest docs whole when the equal share fits none', async () => {
    // A 14 KB remainder over one 13 KB doc and six 1.7 KB docs: equal share ≈ 2 KB fits
    // nothing; the six small docs must arrive whole, the big one takes what is left.
    const files: Record<string, string> = { 'CLAUDE.md': 'root' };
    // distinct contents — byte-identical files dedupe into one candidate
    for (let i = 0; i < 6; i++) files[`docs/s${i}.md`] = `${i}`.repeat(1_700);
    files['docs/big.md'] = 'b'.repeat(13_000);
    const { manifest } = await gatherConventions(memoryConventionReader(files), ['x.go'], {
      capBytes: 14_000 + 'root'.length + 20,
    });
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    for (let i = 0; i < 6; i++) {
      expect(byPath[`docs/s${i}.md`], `s${i}`).toMatchObject({ included: true, truncated: false });
    }
    expect(byPath['docs/big.md'].included && !byPath['docs/big.md'].truncated).toBe(false);
    expect(manifest.totalBytes).toBeLessThanOrEqual(14_000 + 'root'.length + 20);
  });
});

describe('fs reader · a gitignored file is never a convention', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-gitignore-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), '_localnotes/\n');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'see `_localnotes/token.md` and `docs/real.md`');
    fs.mkdirSync(path.join(dir, '_localnotes'));
    fs.writeFileSync(path.join(dir, '_localnotes/token.md'), 'SENTRY_AUTH_TOKEN=abc');
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs/real.md'), 'real');
  });
  afterEach(() => {
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it('a linked ignored file reads as absent, and an ignored dir lists as empty', async () => {
    const reader = fsConventionReader(dir);
    expect(await reader.read('_localnotes/token.md')).toBeNull();
    expect(await reader.list('_localnotes')).toEqual([]);
    expect(await reader.read('docs/real.md')).toBe('real');
    const { manifest, text } = await gatherConventions(reader, ['a.ts']);
    expect(manifest.files.map((f) => f.path)).not.toContain('_localnotes/token.md');
    expect(text).not.toContain('SENTRY_AUTH_TOKEN');
    expect(included(manifest)).toContain('docs/real.md');
  });

  it('outside a git repo everything still reads', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-nogit-'));
    try {
      fs.writeFileSync(path.join(plain, 'CLAUDE.md'), 'root');
      expect(await fsConventionReader(plain).read('CLAUDE.md')).toBe('root');
    } finally {
      fs.rmSync(plain, { force: true, recursive: true });
    }
  });
});

describe('file ceiling · spent on the strongest tiers first, and every real file left behind is named', () => {
  it('a tier-0 include is read before seventy swept docs, and the unread docs are named max-files', async () => {
    const files: Record<string, string> = { 'CLAUDE.md': '@guides/mandatory.md' };
    files['guides/mandatory.md'] = 'the mandatory doc';
    for (let i = 0; i < 70; i++) files[`docs/d${String(i).padStart(2, '0')}.md`] = `doc ${i}`;
    const { manifest } = await gatherConventions(memoryConventionReader(files), ['a.ts'], { maxFiles: 10 });
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    expect(byPath['guides/mandatory.md']).toMatchObject({ included: true, tier: 0 });
    // 72 real files exist; every one is in the manifest — read, or named max-files
    expect(manifest.files).toHaveLength(72);
    expect(manifest.files.filter((f) => f.reason === 'max-files')).toHaveLength(72 - 10);
  });
});

describe('twins · a duplicate keeps the strongest tier of any copy', () => {
  it("a swept copy read first is allocated at the @-included original's tier", async () => {
    const shared = 'the rules '.repeat(300); // ~3 KB, byte-identical in both files
    const reader = memoryConventionReader({
      'CLAUDE.md': '@guides/rules.md',
      'CONTRIBUTING.md': shared, // a COMMON_DOCS seed: read before the BFS reaches the include
      'guides/rules.md': shared,
      'docs/big.md': 'b'.repeat(2_500),
    });
    const { manifest } = await gatherConventions(reader, ['a.ts'], { capBytes: 3_400 });
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    const survivor = byPath['CONTRIBUTING.md'].reason === 'duplicate' ? 'guides/rules.md' : 'CONTRIBUTING.md';
    expect(byPath[survivor]).toMatchObject({ included: true, truncated: false, tier: 0 });
    expect(byPath['docs/big.md'].included && !byPath['docs/big.md'].truncated).toBe(false);
  });
});

describe('discovery · a dot-dir path from a nested doc is tried repo-relative', () => {
  it('`.hidden/notes.md` named inside docs/ resolves from the root', async () => {
    const reader = memoryConventionReader({
      'CLAUDE.md': '@docs/architecture.md',
      'docs/architecture.md': 'see `.hidden/notes.md`',
      '.hidden/notes.md': 'n',
    });
    const { manifest } = await gatherConventions(reader, ['a.ts']);
    expect(included(manifest)).toContain('.hidden/notes.md');
  });
});

describe('READMEs · an @-included README keeps its carrier\'s tier', () => {
  it('CLAUDE.md that is just `@README.md` still gets the README as mandatory', async () => {
    const reader = memoryConventionReader({ 'CLAUDE.md': '@README.md', 'README.md': 'the conventions' });
    const { manifest } = await gatherConventions(reader, ['a.ts']);
    expect(manifest.files.find((f) => f.path === 'README.md')?.tier).toBe(0);
  });
});

describe('allocation · a mandatory tier that frames nothing at the equal share still gets one head', () => {
  it('the budget does not leak past tier 0 to a tier-1 file', async () => {
    const reader = memoryConventionReader({
      'CLAUDE.md': 'see docs/tiny.md',
      '.claude/rules/a.md': 'a'.repeat(2_000),
      '.claude/rules/b.md': 'b'.repeat(2_000),
      '.claude/rules/c.md': 'c'.repeat(2_000),
      'docs/tiny.md': 'tiny',
    });
    const { manifest } = await gatherConventions(reader, ['a.ts'], { capBytes: 400 });
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    const tier0Included = manifest.files.filter((f) => f.tier === 0 && f.included);
    expect(tier0Included.length).toBeGreaterThan(0);
    expect(byPath['docs/tiny.md'].included).toBe(false);
    expect(manifest.totalBytes).toBeLessThanOrEqual(400);
  });
});

describe('fs reader · the read buffer is sized to the file, not the cap', () => {
  it('a huge maxBytes still reads a small file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-bigcap-'));
    try {
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'small');
      expect(await fsConventionReader(dir).read('CLAUDE.md', 64 * 1024 * 1024)).toBe('small');
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });
});
