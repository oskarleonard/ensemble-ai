import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
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
    const big = 'x'.repeat(5_000);
    const reader = memoryConventionReader({
      'CLAUDE.md': '@AGENTS.md\n@ai-spec/DISCOVERIES.md',
      'AGENTS.md': big,
      'ai-spec/DISCOVERIES.md': big,
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
    // Every real read was bounded (never undefined) and never above the cap.
    const reads = seen.filter((n) => n !== undefined) as number[];
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((n) => n <= 6_000)).toBe(true);
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
