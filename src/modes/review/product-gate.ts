import { scrubControl } from '../../core/sanitize';

import type { DowngradeReason, GateFinding, GateVerdictRecord } from './gate';
import type { SiteReader } from './holistic-gate';
import { capProductSeverity, PRODUCT_SEAT_ID } from './product';
import {
  type DocContext,
  docContext,
  docHeadingPath,
  findDocQuote,
  nonNormativeHeading,
  PRODUCT_DOCS_TRAIL_FILE,
  type ProductDocsIndex,
  renderDocLine,
  sourcesForKey,
} from './product-docs';

// THE PRODUCT GATE POLICY — the host half of verifying a product finding. The host owns TEXT
// EXISTENCE; the gate owns MEANING. Every check below is deterministic, reads only the pinned docs
// and the tree, and can only DOWNGRADE:
//
//  1. the key names a source of the pinned docs file             else doc-key-unknown
//  2. that source is not STALE                                    else stale-doc
//  3. the quote is a run of complete lines of that source         else doc-quote-not-found
//  4. a rule or a decision is not quoted out of a non-normative   else doc-quote-non-normative
//     section (non-goals, alternatives, drafts, open questions…)
//  5. the code site exists at the head, its line in range         else code-site-missing
//
// Then three postures: AGREE-ONLY posting (a "partial" document claim is not grounded enough for
// someone else's PR); MEDIUM, always (no lift — a verified quote proves the document says it, not
// that the code breaks it); and a verified agree posts with ONE fixed `**Doc:**` line.
// Non-product records pass through untouched, so a run without the seat is byte-identical.

export interface ProductGateDeps {
  // The pinned product-docs.md, indexed (product-docs.ts). null ⇒ missing/unreadable: nothing verifies.
  docs: ProductDocsIndex | null;
  // Reads the reviewed tree at headSha (holistic-gate.ts worktreeReader). null ⇒ no worktree.
  readAtHead: SiteReader | null;
}

export type ProductDowngradeReason = Extract<
  DowngradeReason,
  'code-site-missing' | 'doc-key-unknown' | 'doc-quote-non-normative' | 'doc-quote-not-found' | 'stale-doc'
>;

export interface ProductCheck {
  // The quote in its document context — set whenever the host located it (the gate is shown it).
  context: DocContext | null;
  // The host's verdict on the QUOTE: complete lines of a source the docs file names.
  docVerified: boolean;
  // The first host check that failed, in the order above; null ⇒ the text half holds.
  failure: { cause: ProductDowngradeReason; reason: string } | null;
}

export function isProductRecord(r: { reviewer: string }): boolean {
  return r.reviewer === PRODUCT_SEAT_ID;
}

// A model-written key inside a host sentence: one line, bounded, quoted.
const keyName = (key: string): string => JSON.stringify(scrubControl(key).slice(0, 80));

// The code half: the file exists at the head and the cited line is inside it.
function codeSiteProblem(f: Pick<GateFinding, 'file' | 'line'>, read: SiteReader | null): string | null {
  if (!read) return 'the code site cannot be checked without worktree evidence';
  if (!f.file) return 'the finding names no code site';
  const lines = read(f.file);
  if (!lines) return `${scrubControl(f.file).slice(0, 200)} is not a readable file at the reviewed head`;
  // A file ending in a newline reads with one empty trailing element; it is not a line.
  const count = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (f.line === null) return `the finding names no line in ${scrubControl(f.file).slice(0, 200)}`;
  if (f.line < 1 || f.line > count) return `${scrubControl(f.file).slice(0, 200)}:${f.line} is outside the file (${count} lines at the head)`;
  return null;
}

// Run the host checks for ONE product finding. Pure given its deps; runGate calls it to decide what
// the gate is shown, and the policy below calls it again to decide the record — same inputs, same
// answer, so the prompt can never promise what the policy then refuses.
export function checkProductFinding(f: Pick<GateFinding, 'docRef' | 'file' | 'line'>, deps: ProductGateDeps): ProductCheck {
  const fail = (cause: ProductDowngradeReason, reason: string, context: DocContext | null = null, docVerified = false): ProductCheck => ({
    context,
    docVerified,
    failure: { cause, reason },
  });
  if (!deps.docs || deps.docs.sources.length === 0)
    return fail('doc-key-unknown', `the pinned ${PRODUCT_DOCS_TRAIL_FILE} is missing or names no source — no quote can be verified`);
  const ref = f.docRef;
  if (!ref) return fail('doc-key-unknown', 'the finding names no document (no well-formed docRef)');
  const sources = sourcesForKey(deps.docs, ref.key);
  if (sources.length === 0) return fail('doc-key-unknown', `${keyName(ref.key)} is not a source of the pinned docs`);
  const match = findDocQuote(deps.docs, ref.key, ref.quote);
  const context = match.ok ? docContext(deps.docs, match.source, match.span) : null;
  if (match.ok ? match.source.stale : sources.some((s) => s.stale))
    return fail(
      'stale-doc',
      `source ${keyName(ref.key)} is STALE — its copy is older than 7 days and the refresh failed, so the change is not judged against it`,
      context,
      match.ok
    );
  if (!match.ok) return fail('doc-quote-not-found', match.reason);
  // A rule or a decision must be quoted from where the document SETS it. A promise is exempt: an
  // acceptance criterion may sit under any heading the author chose.
  if (ref.class !== 'promise-undelivered') {
    const heading = nonNormativeHeading(docHeadingPath(deps.docs, match.source, match.span).all);
    if (heading)
      return fail('doc-quote-non-normative', `the quote sits under "${scrubControl(heading).slice(0, 120)}" — not a rule or a decision in force`, context, true);
  }
  const site = codeSiteProblem(f, deps.readAtHead);
  if (site) return fail('code-site-missing', site, context, true);
  return { context, docVerified: true, failure: null };
}

// Same posture as gate.ts's NOT_POSTABLE (the posting fields cleared), with the host's note.
const notPostable = (note: string) =>
  ({
    postableBody: null,
    postableClass: null,
    postableFix: null,
    postableNote: note,
    postableStatus: 'not-postable' as const,
    postableSuggestion: null,
    rescoredSeverity: null,
    tldr: null,
  });

const REASON_CAP = 700;

// Apply the policy to a reconciled record set. Records of every other seat pass through UNTOUCHED.
// `deps: null` ⇒ nothing can be checked: every product agree/partial fails closed.
export function applyProductPolicy(
  records: GateVerdictRecord[],
  findingById: ReadonlyMap<string, Pick<GateFinding, 'docRef' | 'file' | 'line'>>,
  deps: ProductGateDeps | null
): GateVerdictRecord[] {
  const d: ProductGateDeps = deps ?? { docs: null, readAtHead: null };
  return records.map((r) => {
    if (!isProductRecord(r)) return r;
    const f = findingById.get(r.findingId) ?? { file: r.file, line: r.line };
    const check = checkProductFinding(f, d);
    const based: GateVerdictRecord = {
      ...r,
      ...(f.docRef ? { docRef: f.docRef } : {}),
      docVerified: check.docVerified,
      ...(r.rescoredSeverity ? { rescoredSeverity: capProductSeverity(r.rescoredSeverity) } : {}),
      severity: capProductSeverity(r.severity),
    };
    // The host only DOWNGRADES: a false/unverified verdict already never posts, so its own reason and
    // cause stand, and the host's fact about the quote rides along as docVerified.
    if (based.effectiveVerdict !== 'agree' && based.effectiveVerdict !== 'partial') return based;
    if (check.failure) {
      const reason = `${check.failure.reason}${r.reason ? ` · the gate had said ${r.effectiveVerdict}: ${r.reason}` : ''}`;
      return {
        ...based,
        ...notPostable(check.failure.reason),
        downgradeReason: check.failure.cause,
        effectiveVerdict: 'unverified',
        reason: reason.length > REASON_CAP ? `${reason.slice(0, REASON_CAP - 1)}…` : reason,
      };
    }
    if (based.effectiveVerdict !== 'agree')
      return { ...based, ...notPostable('the product seat posts agree-only — a "partial" document claim is not grounded enough to put on someone else\'s PR') };
    // A verified agree posts its grounded text plus ONE host-written line naming the document. An
    // agree that already failed the postable derivation stays as it is — this never grants posting.
    return based.postableStatus === 'postable' && based.postableBody && f.docRef
      ? { ...based, postableBody: `${based.postableBody}\n\n${renderDocLine(f.docRef)}` }
      : based;
  });
}
