import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Severity } from '../../core/types';

import {
  MIN_ANCHOR_NONWS,
  type GateVerdictRecord,
  honoredHighDismissals,
  renderHighGate,
  resolveHighGate,
} from './gate';
import { clusterPostable } from './gate-dedup';
import { HOLISTIC_SEAT_ID } from './holistic';
import {
  HOLISTIC_MIN_ANCHOR_NONWS,
  type HolisticEntry,
  type HolisticPolicyDeps,
  applyHolisticPolicy,
  findQuoteSpan,
  isConventionsDoc,
  parseConventionCitation,
  parseHolisticSites,
  verifySiteAtHead,
  worktreeReader,
} from './holistic-gate';

// The REAL fixture tree is the worktree these tests verify against — no mocked filesystem, so a
// quote that "verifies" here verifies against bytes on disk exactly as it would at headSha.
const FIXTURE = fileURLToPath(new URL('../../../fixtures/holistic', import.meta.url));
const read = worktreeReader(FIXTURE);

// The planted currency reinvention (positive #1) and its pattern home, quoted verbatim.
const DIFF_SITE = {
  file: 'src/checkout/receipt.ts',
  line: 4,
  quote: 'export function centsToDisplay(cents: number): string {',
  role: 'diff' as const,
};
const PATTERN_SITE = {
  file: 'src/util/money.ts',
  line: 2,
  quote: "export function formatCents(cents: number, currency = 'USD'): string {",
  role: 'pattern' as const,
};
const CONVENTION_CITATION = {
  file: 'AGENTS.md',
  line: 12,
  quote: 'All currency rendering MUST go through `formatCents` in `src/util/money.ts`. A hand-rolled',
};

const DEPS: HolisticPolicyDeps = {
  diffFiles: new Set([DIFF_SITE.file]),
  readAtHead: read,
};

function record(over: Partial<GateVerdictRecord> = {}): GateVerdictRecord {
  return {
    downgradeReason: null,
    effectiveVerdict: 'agree',
    file: DIFF_SITE.file,
    findingId: `${HOLISTIC_SEAT_ID}#1`,
    line: DIFF_SITE.line,
    postableBody: 'centsToDisplay duplicates formatCents',
    postableFix: 'keep',
    postableStatus: 'postable',
    rawVerdict: 'agree',
    reason: 'confirmed both sites',
    rescoredSeverity: null,
    reviewer: HOLISTIC_SEAT_ID,
    severity: 'high',
    title: 'reinvented currency formatter',
    ...over,
  };
}

const entry = (e: HolisticEntry): ReadonlyMap<string, HolisticEntry | undefined> =>
  new Map([[`${HOLISTIC_SEAT_ID}#1`, e]]);

const BOTH_SITES: HolisticEntry = { sites: [DIFF_SITE, PATTERN_SITE] };

describe('the anchor bar matches the gate\'s own citation rule', () => {
  it('HOLISTIC_MIN_ANCHOR_NONWS === gate MIN_ANCHOR_NONWS', () => {
    expect(HOLISTIC_MIN_ANCHOR_NONWS).toBe(MIN_ANCHOR_NONWS);
  });
});

describe('findQuoteSpan', () => {
  const lines = ['const a = 1;', 'export function longEnoughToAnchor(x: number): number {', '  return x;', '}'];

  it('locates a complete-line quote and reports its 1-based span', () => {
    expect(findQuoteSpan(lines, 'export function longEnoughToAnchor(x: number): number {')).toEqual({ end: 2, start: 2 });
  });

  it('matches a multi-line quote as consecutive lines, whitespace-normalized', () => {
    expect(findQuoteSpan(lines, 'export function longEnoughToAnchor(x: number): number {\n     return x;')).toEqual({ end: 3, start: 2 });
  });

  it('rejects a quote with no substantial anchor line (a `}` proves nothing)', () => {
    expect(findQuoteSpan(lines, '}')).toBeNull();
    expect(findQuoteSpan(lines, '  return x;')).toBeNull(); // 9 non-ws chars < 16
  });

  it('rejects text that is not in the file, and a partial-line substring', () => {
    expect(findQuoteSpan(lines, 'export function neverWrittenAnywhere(): void {')).toBeNull();
    expect(findQuoteSpan(lines, 'function longEnoughToAnchor(x: number)')).toBeNull();
  });
});

describe('worktreeReader — the untrusted-tree fence', () => {
  it('reads a file inside the worktree', () => {
    expect(read('src/util/money.ts')?.[1]).toContain('formatCents');
  });

  it('refuses absolute paths, traversal, and missing files', () => {
    expect(read('/etc/passwd')).toBeNull();
    expect(read('../../package.json')).toBeNull();
    expect(read('src/util/nope.ts')).toBeNull();
  });

  it('refuses a SYMLINK that escapes the worktree (a crafted tree must not quote a secret)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holistic-fence-'));
    const secret = path.join(root, 'secret.txt');
    const tree = path.join(root, 'tree');
    fs.mkdirSync(tree);
    fs.writeFileSync(secret, 'AWS_SECRET_ACCESS_KEY=hunter2hunter2hunter2\n');
    fs.symlinkSync(secret, path.join(tree, 'CONVENTIONS.md'));
    const fenced = worktreeReader(tree);
    expect(fenced('CONVENTIONS.md')).toBeNull();
    fs.rmSync(root, { force: true, recursive: true });
  });

  it('an unreadable worktree yields a reader that verifies nothing (fail closed)', () => {
    expect(worktreeReader('/nope/not/a/dir')('anything.ts')).toBeNull();
  });
});

describe('verifySiteAtHead', () => {
  it('accepts a verbatim quote at its cited line', () => {
    expect(verifySiteAtHead(PATTERN_SITE, read)).toEqual({ ok: true });
  });

  it('rejects a quote that is real but cited at the wrong place', () => {
    const bad = verifySiteAtHead({ ...PATTERN_SITE, line: 40 }, read);
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.reason).toContain('is not where that quote lives');
  });

  it('rejects a hallucinated quote', () => {
    const bad = verifySiteAtHead({ ...PATTERN_SITE, quote: 'export function formatMoneyAmount(cents: number): string {' }, read);
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.reason).toContain('do not appear verbatim');
  });

  it('rejects a file that is not in the tree', () => {
    const bad = verifySiteAtHead({ ...PATTERN_SITE, file: 'src/util/ghost.ts' }, read);
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.reason).toContain('not a readable file');
  });
});

describe('isConventionsDoc — the only source that may uncap', () => {
  it('accepts the canonical names anywhere in the tree', () => {
    expect(isConventionsDoc('AGENTS.md')).toBe(true);
    expect(isConventionsDoc('docs/CONVENTIONS.md')).toBe(true);
    expect(isConventionsDoc('./CLAUDE.md')).toBe(true);
  });

  it('rejects a README and ordinary source', () => {
    expect(isConventionsDoc('README.md')).toBe(false);
    expect(isConventionsDoc('src/util/money.ts')).toBe(false);
  });

  it('accepts a doc the run actually GATHERED, whatever it is named', () => {
    expect(isConventionsDoc('docs/house-rules.md', ['docs/house-rules.md'])).toBe(true);
    expect(isConventionsDoc('docs/house-rules.md', ['docs/other.md'])).toBe(false);
  });
});

describe('parsers reject malformed sites / citations (fail closed)', () => {
  it('drops sites missing a field, a positive line, or a known role', () => {
    expect(parseHolisticSites([{ file: 'a.ts', line: 1 }])).toBeUndefined();
    expect(parseHolisticSites([{ file: 'a.ts', line: 0, quote: 'q', role: 'diff' }])).toBeUndefined();
    expect(parseHolisticSites([{ file: 'a.ts', line: 1, quote: 'q', role: 'elsewhere' }])).toBeUndefined();
    expect(parseHolisticSites('nope')).toBeUndefined();
    expect(parseHolisticSites([DIFF_SITE])).toHaveLength(1);
  });

  it('drops a citation missing a field', () => {
    expect(parseConventionCitation({ file: 'AGENTS.md', line: 12 })).toBeUndefined();
    expect(parseConventionCitation(CONVENTION_CITATION)).toEqual(CONVENTION_CITATION);
  });
});

describe('applyHolisticPolicy — the three guardrails, mechanized', () => {
  it('leaves non-holistic records untouched, by identity', () => {
    const codex = record({ findingId: 'codex#1', reviewer: 'codex' });
    const out = applyHolisticPolicy([codex], new Map(), DEPS);
    expect(out[0]).toBe(codex);
  });

  it('BOTH SITES: a verified agree posts, and records what it verified', () => {
    const [out] = applyHolisticPolicy([record()], entry(BOTH_SITES), DEPS);
    expect(out.effectiveVerdict).toBe('agree');
    expect(out.postableStatus).toBe('postable');
    expect(out.holistic?.verifiedSites).toEqual([DIFF_SITE, PATTERN_SITE]);
    expect(out.holistic?.singleSeat).toBe(true);
  });

  it('BOTH SITES: one site only ⇒ unverified (invalid-citation)', () => {
    const [out] = applyHolisticPolicy([record()], entry({ sites: [DIFF_SITE] }), DEPS);
    expect(out.effectiveVerdict).toBe('unverified');
    expect(out.downgradeReason).toBe('invalid-citation');
    expect(out.postableStatus).toBe('not-postable');
    expect(out.reason).toContain('must quote BOTH sites');
  });

  it('BOTH SITES: a hallucinated pattern home ⇒ unverified (reference-not-found)', () => {
    const ghost = { ...PATTERN_SITE, quote: 'export function formatMoneyAmount(cents: number): string {' };
    const [out] = applyHolisticPolicy([record()], entry({ sites: [DIFF_SITE, ghost] }), DEPS);
    expect(out.effectiveVerdict).toBe('unverified');
    expect(out.downgradeReason).toBe('reference-not-found');
    expect(out.reason).toContain('pattern site could not be verified at headSha');
  });

  it('BOTH SITES: the reinvention must be cited INSIDE the change', () => {
    const outside = { ...DIFF_SITE, file: 'src/util/slug.ts', line: 2, quote: 'export function slugify(input: string): string {' };
    const [out] = applyHolisticPolicy([record()], entry({ sites: [outside, PATTERN_SITE] }), DEPS);
    expect(out.downgradeReason).toBe('invalid-citation');
    expect(out.reason).toContain('is not a file this PR changes');
  });

  it('BOTH SITES: a pattern cannot reinvent itself', () => {
    const self = { ...PATTERN_SITE, ...DIFF_SITE, role: 'pattern' as const };
    const [out] = applyHolisticPolicy([record()], entry({ sites: [DIFF_SITE, self] }), DEPS);
    expect(out.downgradeReason).toBe('invalid-citation');
    expect(out.reason).toContain('same line');
  });

  it('AGREE-ONLY: a partial keeps its verdict in the trail but never posts', () => {
    const [out] = applyHolisticPolicy(
      [record({ effectiveVerdict: 'partial', postableBody: 'narrowed', postableStatus: 'postable' })],
      entry(BOTH_SITES),
      DEPS
    );
    expect(out.effectiveVerdict).toBe('partial');
    expect(out.postableStatus).toBe('not-postable');
    expect(out.postableBody).toBeNull();
    expect(out.postableNote).toContain('agree-only');
  });

  it('MED CAP: a HIGH with no conventions citation is capped, and says where from', () => {
    const [out] = applyHolisticPolicy([record()], entry(BOTH_SITES), DEPS);
    expect(out.severity).toBe('medium');
    expect(out.holistic?.cappedFrom).toBe('high');
    expect(out.holistic?.uncapCitation).toBeUndefined();
  });

  it('MED CAP: a GATE-VERIFIED conventions citation lifts it', () => {
    const [out] = applyHolisticPolicy(
      [record()],
      entry({ ...BOTH_SITES, conventionCitation: CONVENTION_CITATION }),
      DEPS
    );
    expect(out.severity).toBe('high');
    expect(out.holistic?.cappedFrom).toBeUndefined();
    expect(out.holistic?.uncapCitation).toEqual(CONVENTION_CITATION);
  });

  it('MED CAP: a citation of a NON-conventions file never uncaps', () => {
    const [out] = applyHolisticPolicy(
      [record()],
      entry({ ...BOTH_SITES, conventionCitation: { ...PATTERN_SITE } }),
      DEPS
    );
    expect(out.severity).toBe('medium');
  });

  it('MED CAP: a citation of a REAL conventions doc with a fabricated quote never uncaps', () => {
    const [out] = applyHolisticPolicy(
      [record()],
      entry({ ...BOTH_SITES, conventionCitation: { ...CONVENTION_CITATION, quote: 'All currency rendering MUST go through the CheckoutFormatter service.' } }),
      DEPS
    );
    expect(out.severity).toBe('medium');
    expect(out.holistic?.cappedFrom).toBe('high');
  });

  it('MED CAP: a citation at the WRONG LINE of the right doc never uncaps', () => {
    const [out] = applyHolisticPolicy(
      [record()],
      entry({ ...BOTH_SITES, conventionCitation: { ...CONVENTION_CITATION, line: 30 } }),
      DEPS
    );
    expect(out.severity).toBe('medium');
  });

  it('a LOW holistic finding keeps its severity (the cap is a ceiling, not a floor)', () => {
    const [out] = applyHolisticPolicy([record({ severity: 'low' as Severity })], entry(BOTH_SITES), DEPS);
    expect(out.severity).toBe('low');
    expect(out.holistic?.cappedFrom).toBeUndefined();
  });

  it('NO WORKTREE: a holistic record without evidence is fail-closed, never postable', () => {
    const [out] = applyHolisticPolicy([record()], entry(BOTH_SITES), null);
    expect(out.effectiveVerdict).toBe('unverified');
    expect(out.downgradeReason).toBe('invalid-citation');
    expect(out.postableStatus).toBe('not-postable');
    expect(out.severity).toBe('medium');
    expect(out.reason).toContain('must not run on packet evidence');
  });

  it('an agree the postable pass already escalated is not resurrected (this policy only removes authority)', () => {
    const [out] = applyHolisticPolicy(
      [record({ postableBody: null, postableFix: null, postableStatus: 'escalated' })],
      entry(BOTH_SITES),
      DEPS
    );
    expect(out.postableStatus).toBe('escalated');
    expect(out.postableBody).toBeNull();
  });
});

describe('single-seat honesty — the lens never borrows corroboration', () => {
  const near = (findingId: string, reviewer: string): GateVerdictRecord =>
    record({
      findingId,
      postableBody: 'centsToDisplay duplicates the canonical formatCents util in src/util/money.ts',
      reviewer,
      severity: 'medium',
      title: 'reinvented currency formatter',
    });

  it('a holistic finding gets NO cluster, and does not inflate a reviewer cluster it sits on top of', () => {
    const out = clusterPostable([near('codex#1', 'codex'), near('grok#1', 'grok'), near(`${HOLISTIC_SEAT_ID}#1`, HOLISTIC_SEAT_ID)]);
    const byId = new Map(out.map((r) => [r.findingId, r]));

    expect(byId.get(`${HOLISTIC_SEAT_ID}#1`)?.cluster).toBeUndefined();
    // codex + grok still corroborate each OTHER — the lens is simply not in the count.
    expect(byId.get('codex#1')?.cluster?.corroboration).toBe(2);
    expect(byId.get('codex#1')?.cluster?.corroborators).toEqual(['grok#1']);
  });

  it('two reviewers alone corroborate exactly as before the lens existed', () => {
    const out = clusterPostable([near('codex#1', 'codex'), near('grok#1', 'grok')]);
    expect(out[0].cluster?.corroboration).toBe(2);
  });
});

describe('the lens is advisory — it can never flip the exit contract', () => {
  // An UNCAPPED holistic HIGH (a verified conventions citation lifted the cap) is still a
  // suggestion about architecture, not a defect in the change. It must not force exit 4 — and it
  // must not be dismissible as if a reviewer had raised it.
  const holisticHigh = record({ findingId: `${HOLISTIC_SEAT_ID}#1`, severity: 'high' });
  const codexHigh = record({ findingId: 'codex#1', reviewer: 'codex', severity: 'high' });

  it('an uncapped holistic HIGH never gates', () => {
    expect(resolveHighGate([holisticHigh], true, false)).toEqual({ dismissedHighIds: [], gatingHighIds: [] });
    expect(resolveHighGate([codexHigh, holisticHigh], true, false).gatingHighIds).toEqual(['codex#1']);
  });

  it('a holistic `false` is never counted as an honored HIGH dismissal', () => {
    const dismissed = record({ effectiveVerdict: 'false', findingId: `${HOLISTIC_SEAT_ID}#1`, severity: 'high' });
    expect(honoredHighDismissals([dismissed], true)).toEqual([]);
  });

  it('the HIGH-gate block does not render the lens at all', () => {
    expect(renderHighGate([holisticHigh], resolveHighGate([holisticHigh], true, true), {
      authorityActive: true,
      authorityLabel: 'ON',
      scrub: (s) => s,
    })).toEqual([]);
  });
});
