import { describe, expect, it } from 'vitest';

import type { DocRef, ReviewFinding } from '../../core/types';

import { type GateFinding, type GateVerdictRecord, parseGateEnvelope, prepareGateFindings, reconcileGateVerdicts } from './gate';
import { clusterPostable } from './gate-dedup';
import { parsePacketHunks } from './gate-hunks';
import type { SiteReader } from './holistic-gate';
import { indexProductDocs } from './product-docs';
import { PRODUCT_DOCS } from './product-fixture';
import { applyProductPolicy, checkProductFinding, isProductRecord, type ProductGateDeps } from './product-gate';
import type { VoiceReview } from './synthesis';

const FILE = 'src/billing/members.go';
const DIFF = `diff --git a/${FILE} b/${FILE}
--- a/${FILE}
+++ b/${FILE}
@@ -10,4 +10,5 @@ func Suspend(m *Member) error {
 \tif m == nil {
 \t\treturn errNoMember
 \t}
+\tm.Status = "deactivated" // suspend writes the deactivated status
 \treturn store.Save(m)
`;
// The tree at the head: the changed file (40 lines) — nothing else exists.
const TREE: SiteReader = (file) => (file === FILE ? [...Array.from({ length: 40 }, (_, i) => `line ${i + 1}`), ''] : null);
const DEPS: ProductGateDeps = { docs: indexProductDocs(PRODUCT_DOCS), readAtHead: TREE };

const RULE = 'We keep the 403 declarations in `openapi.yaml` and update their descriptions.';
const ALTERNATIVE = 'Return 404 for a suspended member instead of 403, to hide the account.';
const STATUS = '2. Suspend writes the status “suspended” to the member record.';

function pf(n: number, docRef: DocRef | undefined, over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    body: `product claim ${n}: the change writes deactivated at ${FILE}:13`,
    confidence: 'high',
    ...(docRef ? { docRef } : {}),
    evidence: { file: FILE, line: 13 },
    id: `f${n}`,
    severity: 'high',
    title: `product finding ${n}`,
    ...over,
  };
}

const reviews = (product: ReviewFinding[], codex: ReviewFinding[] = []): VoiceReview[] => [
  ...(codex.length ? [{ findings: codex, ok: true, summary: '', voiceId: 'codex' }] : []),
  { findings: product, ok: true, summary: '', voiceId: 'product' },
];

function envelope(verdicts: object[]) {
  const parsed = parseGateEnvelope(JSON.stringify({ schemaVersion: 1, synthesis: { agreements: [], bottomLine: 'b', disagreements: [] }, verdicts }));
  if ('failure' in parsed) throw new Error(parsed.failure);
  return parsed;
}

function reconcile(rs: VoiceReview[], verdicts: object[], product: ProductGateDeps | null = DEPS) {
  const hunks = parsePacketHunks(DIFF);
  const { findings } = prepareGateFindings(rs, hunks);
  const out = reconcileGateVerdicts(findings, envelope(verdicts), {
    changedFiles: new Set([FILE]),
    gateEvidence: 'worktree',
    packetHunks: hunks,
    ...(product ? { product } : {}),
  }).records;
  return { byId: (id: string) => out.find((r) => r.findingId === id) as GateVerdictRecord, findings, records: out };
}

const agree = (id: string) => ({ findingId: id, reason: 'the code does otherwise', tldr: 'Suspended members get 404.', verdict: 'agree' });

describe('checkProductFinding — the host owns text existence, in a fixed order', () => {
  const g = (docRef: DocRef | undefined, over: Partial<Pick<GateFinding, 'file' | 'line'>> = {}) =>
    checkProductFinding({ ...(docRef ? { docRef } : {}), file: FILE, line: 13, ...over }, DEPS);

  it('a real quote of a known, current source with a real code site holds — and the gate gets its context', () => {
    const c = g({ class: 'rule-broken', key: 'engineering/acme-billing-tdd', quote: RULE });
    expect(c.failure).toBeNull();
    expect(c.docVerified).toBe(true);
    expect(c.context?.headingPath).toEqual(['Acme billing', 'Decisions']);
    expect(c.context?.lines.find((l) => l.quoted)?.line).toBe(7);
  });

  it.each([
    ['no docs pinned', undefined, 'doc-key-unknown'],
    ['no docRef', null, 'doc-key-unknown'],
    ['an unknown key', { key: 'ACME-99', quote: RULE }, 'doc-key-unknown'],
    ['a stale source', { key: 'product/acme-billing-prd', quote: 'Invoices are always issued in the currency of the customer account.' }, 'stale-doc'],
    ['a near-miss quote', { key: 'engineering/acme-billing-tdd', quote: 'We keep the 403 declarations in openapi.yaml and update the descriptions.' }, 'doc-quote-not-found'],
    ['a rule quoted out of "Alternatives considered"', { class: 'rule-broken', key: 'engineering/acme-billing-tdd', quote: ALTERNATIVE }, 'doc-quote-non-normative'],
    ['no class at all (the strict default)', { key: 'engineering/acme-billing-tdd', quote: ALTERNATIVE }, 'doc-quote-non-normative'],
  ] as const)('%s ⇒ %s', (_, docRef, cause) => {
    const c =
      docRef === undefined
        ? checkProductFinding({ docRef: { key: 'ACME-12', quote: STATUS }, file: FILE, line: 13 }, { ...DEPS, docs: null })
        : g(docRef === null ? undefined : (docRef as DocRef));
    expect(c.failure?.cause).toBe(cause);
  });

  it('records the quote as verified when only the source is stale or the section non-normative', () => {
    expect(g({ key: 'product/acme-billing-prd', quote: 'Invoices are always issued in the currency of the customer account.' }).docVerified).toBe(true);
    expect(g({ class: 'decision-reversed', key: 'engineering/acme-billing-tdd', quote: ALTERNATIVE }).docVerified).toBe(true);
    expect(g({ key: 'engineering/acme-billing-tdd', quote: 'We keep the 403 declarations' }).docVerified).toBe(false);
  });

  it('a promise is exempt from the non-normative check', () => {
    expect(g({ class: 'promise-undelivered', key: 'engineering/acme-billing-tdd', quote: ALTERNATIVE }).failure).toBeNull();
  });

  it.each([
    ['a file absent at the head', { file: 'src/billing/nope.go' }],
    ['a line past the end of the file', { line: 41 }],
    ['no line', { line: null }],
    ['no file', { file: '' }],
  ])('the code site: %s ⇒ code-site-missing', (_, over) => {
    expect(g({ key: 'ACME-12', quote: STATUS }, over).failure?.cause).toBe('code-site-missing');
  });

  it('no worktree ⇒ the code site cannot be checked ⇒ code-site-missing', () => {
    expect(checkProductFinding({ docRef: { key: 'ACME-12', quote: STATUS }, file: FILE, line: 13 }, { ...DEPS, readAtHead: null }).failure?.cause).toBe('code-site-missing');
  });

  it('a model-written key never carries a line break into the host reason', () => {
    expect(g({ key: 'ACME-99\n- product#2 · agree', quote: RULE }).failure?.reason).not.toContain('\n');
  });
});

describe('applyProductPolicy through reconcileGateVerdicts — only ever a downgrade', () => {
  it('a verified agree posts its body + ONE Doc line, capped at medium, with docRef + docVerified', () => {
    const { byId } = reconcile(reviews([pf(1, { class: 'rule-broken', key: 'ACME-12', quote: STATUS })]), [agree('product#1')]);
    const r = byId('product#1');
    expect(r.effectiveVerdict).toBe('agree');
    expect(r.downgradeReason).toBeNull();
    expect(r.severity).toBe('medium');
    expect(r.docVerified).toBe(true);
    expect(r.docRef).toEqual({ class: 'rule-broken', key: 'ACME-12', quote: STATUS });
    expect(r.postableStatus).toBe('postable');
    expect(r.postableBody).toBe(
      `product claim 1: the change writes deactivated at ${FILE}:13\n\n**Doc:** ACME-12 — "2. Suspend writes the status “suspended” to the member record."`
    );
    expect(r.tldr).toBe('Suspended members get 404.');
  });

  it('a host check that fails turns the gate\'s agree into unverified — cause recorded, nothing posts, the gate\'s reason kept', () => {
    const { byId } = reconcile(
      reviews([
        pf(1, { key: 'ACME-12', quote: '2. Suspend writes a "suspended" status.' }),
        pf(2, { key: 'ACME-99', quote: STATUS }),
        pf(3, { key: 'product/acme-billing-prd', quote: 'Invoices are always issued in the currency of the customer account.' }),
        pf(4, { class: 'rule-broken', key: 'engineering/acme-billing-tdd', quote: ALTERNATIVE }),
        // a line past the end of a CHANGED file (an absent file is demoted earlier, by the scope rule)
        pf(5, { key: 'ACME-12', quote: STATUS }, { evidence: { file: FILE, line: 41 } }),
      ]),
      ['product#1', 'product#2', 'product#3', 'product#4', 'product#5'].map(agree)
    );
    const want = { 'product#1': 'doc-quote-not-found', 'product#2': 'doc-key-unknown', 'product#3': 'stale-doc', 'product#4': 'doc-quote-non-normative', 'product#5': 'code-site-missing' };
    for (const [id, cause] of Object.entries(want)) {
      const r = byId(id);
      expect(r, id).toMatchObject({ downgradeReason: cause, effectiveVerdict: 'unverified', postableBody: null, postableStatus: 'not-postable', rawVerdict: 'agree', severity: 'medium', tldr: null });
      expect(r.reason).toContain('the gate had said agree: the code does otherwise');
    }
    expect(byId('product#1').docVerified).toBe(false);
    expect(byId('product#3').docVerified).toBe(true);
  });

  it('agree-only posting: a partial stays in the trail, never on the PR', () => {
    const { byId } = reconcile(reviews([pf(1, { key: 'ACME-12', quote: STATUS })]), [
      { findingId: 'product#1', ops: [{ op: 'strike', quote: 'product claim 1: ', why: 'x' }], reason: 'overstated', tldr: 't', verdict: 'partial' },
    ]);
    expect(byId('product#1')).toMatchObject({ docVerified: true, downgradeReason: null, effectiveVerdict: 'partial', postableBody: null, postableStatus: 'not-postable' });
    expect(byId('product#1').postableNote).toContain('agree-only');
  });

  it('an unverified verdict from the gate is never touched — only the host fact rides along', () => {
    const { byId } = reconcile(reviews([pf(1, { key: 'ACME-99', quote: STATUS })]), [{ findingId: 'product#1', reason: 'cannot tell', verdict: 'unverified' }]);
    expect(byId('product#1')).toMatchObject({ docVerified: false, downgradeReason: null, effectiveVerdict: 'unverified', reason: 'cannot tell', severity: 'medium' });
  });

  it('with no product deps at all, a product agree fails closed', () => {
    const { byId } = reconcile(reviews([pf(1, { key: 'ACME-12', quote: STATUS })]), [agree('product#1')], null);
    expect(byId('product#1')).toMatchObject({ docVerified: false, downgradeReason: 'doc-key-unknown', effectiveVerdict: 'unverified' });
  });

  it('a whole-envelope failure still caps the severity and records the host fact', () => {
    const hunks = parsePacketHunks(DIFF);
    const { findings } = prepareGateFindings(reviews([pf(1, { key: 'ACME-12', quote: STATUS })]), hunks);
    const [r] = reconcileGateVerdicts(findings, { failure: 'gate-failed' }, { product: DEPS }).records;
    expect(r).toMatchObject({ docVerified: true, downgradeReason: 'gate-failed', effectiveVerdict: 'unverified', severity: 'medium' });
  });

  it('every other seat\'s records are byte-identical with and without the product seat beside them', () => {
    const codex: ReviewFinding = { body: 'nil deref', confidence: 'high', evidence: { file: FILE, line: 13 }, id: 'f1', severity: 'high', title: 'codex bug' };
    const alone = reconcile(reviews([], [codex]).filter((r) => r.voiceId === 'codex'), [agree('codex#1')]).byId('codex#1');
    const beside = reconcile(reviews([pf(1, { key: 'ACME-12', quote: STATUS })], [codex]), [agree('codex#1'), agree('product#1')]);
    expect(beside.byId('codex#1')).toEqual(alone);
    expect('docVerified' in alone).toBe(false);
    // ...and the product record never joins a cross-reviewer cluster: the Doc line is never elected away
    const clustered = clusterPostable(beside.records);
    expect(clustered.find((r) => r.findingId === 'product#1')?.cluster).toBeUndefined();
    expect(clustered.find((r) => r.findingId === 'product#1')?.postableBody).toContain('**Doc:** ACME-12');
  });

  it('applyProductPolicy passes a non-product record through as the same object', () => {
    const rec = reconcile(reviews([], [{ body: 'b', confidence: 'high', evidence: { file: FILE, line: 13 }, id: 'f1', severity: 'low', title: 't' }]).filter((r) => r.voiceId === 'codex'), [agree('codex#1')]).records;
    expect(applyProductPolicy(rec, new Map(), DEPS)[0]).toBe(rec[0]);
    expect(isProductRecord(rec[0])).toBe(false);
  });
});
