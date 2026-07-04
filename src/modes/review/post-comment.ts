// `--post-comment`: render a COMPLETED review as a GitHub PR comment and post it via
// `gh pr comment`. This is the review verb's ONE outward action, so it is OPT-IN only and
// preserves the read-only gate contract absolutely: rendering is pure, posting takes an
// INJECTABLE runner (so it is unit-tested without spawning gh), and a post failure can NEVER
// change the review's stdout or exit code — it degrades to a LOUD stderr warning and the
// caller returns the exit code the review already earned. The comment mirrors the terminal
// summary: synthesis (agree/disagree/bottom line) + the grounded per-finding gate verdict tags
// + per-reviewer findings grouped by severity + a footer with the trail path, receipt line, and
// the resolved gate seat. Only a PR diff source has a postable target (postTargetFromSelection).

import { evidenceRef, SEVERITY_LABEL, SEVERITY_ORDER } from '../../core/findings';
import { scrubControl } from '../../core/sanitize';
import type { StoredReview } from '../../core/types';

import type { GateVerdict, GateVerdictRecord } from './gate';
import { verdictCounts } from './gate';
import { classifySecurityFinding, type ReviewProfile, stripSecurityTag } from './profile';
import type { ClaudeLayerResult } from './self-contained';
import type { DiffSourceSelection } from './source';
import type { ReviewSynthesis } from './synthesis';

// GitHub caps an issue/PR comment body at 65536 characters; a longer body is rejected by the
// API. The renderer's output is capped under this with a NAMED truncation marker so an
// over-long review still posts (pointing at the full trail) instead of failing the post.
export const GITHUB_COMMENT_MAX = 65536;

// The PR a `--post-comment` run would post to. Only a PR diff source (`--pr <N>` or a PR URL)
// has one; `repoSlug` (owner/repo) is set for a URL PR so `gh` works from any cwd, absent for a
// bare `--pr <N>` (which targets the cwd's repo, exactly as the diff fetch did).
export interface PostTarget {
  pr: number;
  repoSlug?: string;
}

// Derive the postable PR target from the SAME resolved selection the review runs over — the one
// source of truth for "which sources can `--post-comment` post to". Anything that is not a PR
// (local working-tree/staged/branch, a raw --diff-file, piped stdin) has no PR → null, and the
// CLI refuses `--post-comment` upfront.
export function postTargetFromSelection(sel: DiffSourceSelection): PostTarget | null {
  if (sel.kind !== 'pr' || typeof sel.pr !== 'number') return null;
  return sel.owner && sel.repo
    ? { pr: sel.pr, repoSlug: `${sel.owner}/${sel.repo}` }
    : { pr: sel.pr };
}

// The resolved GATE seat, pre-formatted by the CLI (which owns loadGateSeat), for the footer.
export interface CommentGateSeat {
  effort: string;
  effortSource: string;
  model: string;
  modelSource: string;
}

// The receipt facts the footer needs — precomputed by the CLI from the run's DiffReviewReceipt.
export interface CommentReceipt {
  completed: string[];
  digest: string | null;
  error: string | null;
  path: string | null;
}

export interface RenderCommentInput {
  claudeLayer: ClaudeLayerResult | null;
  gateSeat: CommentGateSeat | null;
  headSha: string;
  headline: string;
  profile: ReviewProfile;
  receipt: CommentReceipt;
  repoId: string | null;
  reviews: StoredReview[];
  trailDir: string;
}

// The per-finding verdict tag as the directive names it: `false` → `false-dismissed` (the gate
// dismissed it), the rest verbatim. Kept off the raw enum so the outward comment reads clearly.
const VERDICT_TAG: Record<GateVerdict, string> = {
  agree: 'agree',
  false: 'false-dismissed',
  partial: 'partial',
  unverified: 'unverified',
};

// Reviewer/gate/synthesis text is UNTRUSTED (a crafted diff can induce a reviewer to emit
// arbitrary strings). md() is the scrub for a value rendered in normal markdown FLOW (a heading,
// list item, prose line, or `<sub>` attribute); code() is for a value inside an inline code span.
// scrubControl strips control chars + collapses whitespace to one line, so an untrusted value can't
// inject a MULTI-line block on its own — but two single-line vectors remain, both closed here:
//   1. Raw HTML — GitHub renders a whitelist (<details>/<summary>/<h1>/<!-- … -->/…), so a value
//      like `<details><summary>Clean</summary>` or an HTML comment could COLLAPSE or HIDE the gate
//      + findings beneath it, or spoof approval. HTML-escaping &,<,> renders them as literal text
//      (the entity shows as the char) and closes every raw-HTML vector — leading OR embedded. `&`
//      MUST be escaped first so the < / > entities aren't themselves double-escaped.
//   2. A leading Markdown block marker — a ``` fence swallows the rest of the comment; #/-/*/~/|
//      spoof a heading/list/table. Backslash-escape a leading one so the value stays literal
//      wherever it lands (standalone line, list item, or blockquote). `<`/`>` are already entity-
//      escaped in step 1, so blockquote (`>`) needs no entry here; `-` is class-last (a literal,
//      not a range); ordered-list digits are left alone (a leading `1.` garbles only its own line).
function md(s: string): string {
  const scrubbed = scrubControl(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return /^[`~#*+|-]/.test(scrubbed) ? `\\${scrubbed}` : scrubbed;
}
// Inside an inline code span raw HTML/markdown is inert, so no entity-escaping is needed — only
// neutralize backticks so the value can't terminate the span and break back out into markdown.
function code(s: string): string {
  return scrubControl(s).replace(/`/g, "'");
}

// One reviewer finding as a markdown list item, matching the terminal findingLine: a `[class]`
// security tag in the security profile (the reviewer's own leading tag stripped to avoid
// duplication), then `file:line` evidence, then the title.
function findingItem(f: StoredReview['findings'][number], profile: ReviewProfile): string {
  const ref = evidenceRef(f.evidence.file, f.evidence.line, code);
  if (profile === 'security') {
    const cls = classifySecurityFinding(f);
    return `- \`${ref}\` — [${cls}] ${md(stripSecurityTag(f.title))}`;
  }
  return `- \`${ref}\` — ${md(f.title)}`;
}

// A single reviewer's block: its terminal state + findings grouped HIGH → MED → LOW. A
// non-reviewed (failed/cut-off) reviewer renders its summary excerpt instead, so the comment is
// honest about an incomplete reviewer rather than silently dropping it.
function reviewerBlock(
  id: string,
  vendor: string,
  model: string,
  reviewed: boolean,
  findings: StoredReview['findings'],
  summary: string,
  profile: ReviewProfile
): string[] {
  const state = reviewed ? 'reviewed' : 'failed';
  const out: string[] = ['', `#### ${md(id)} — ${state} <sub>[${md(vendor)}/${md(model)}]</sub>`];
  if (!reviewed) {
    out.push(`> ${md(summary).slice(0, 300)}`);
    return out;
  }
  if (findings.length === 0) {
    out.push('_no findings_');
    return out;
  }
  for (const sev of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    out.push(`**${SEVERITY_LABEL[sev]}**`);
    for (const f of group) out.push(findingItem(f, profile));
  }
  return out;
}

function synthesisSection(s: ReviewSynthesis): string[] {
  const out: string[] = [
    '',
    `### Synthesis${s.by ? ` (by ${md(s.by)})` : ''}${s.degraded ? ' — ⚠ DEGRADED (deterministic fallback, not cross-confirmed)' : ''}`,
  ];
  if (s.summary) out.push('', md(s.summary));
  if (s.agreements.length > 0) {
    out.push('', '**✓ Agree (confident)**');
    for (const a of s.agreements) {
      const who = a.voices.length ? `  _[${a.voices.map(md).join(', ')}]_` : '';
      out.push(`- ${md(a.point)}${who}`);
    }
  }
  if (s.disagreements.length > 0) {
    out.push('', '**⚠ Disagree (look closer)**');
    for (const d of s.disagreements) {
      out.push(`- ${md(d.point)}`);
      for (const p of d.positions) out.push(`  - ${md(p)}`);
    }
  }
  if (s.bottomLine) out.push('', '**→ Bottom line**', '', md(s.bottomLine));
  return out;
}

// The grounded per-finding gate verdicts (agree/partial/false-dismissed/unverified) with reasons
// + host downgrade notes, then the count line + the trail marker — the same facts the terminal
// gate block prints, in markdown.
function gateSection(records: GateVerdictRecord[], trailWritten: boolean): string[] {
  const out: string[] = ['', '### Gate — grounded verdicts'];
  if (records.length === 0) {
    out.push('_no findings to verdict_');
    return out;
  }
  for (const r of records) {
    const where = evidenceRef(r.file, r.line, code);
    const reason = r.reason ? ` — ${md(r.reason).slice(0, 300)}` : '';
    const dg = r.downgradeReason ? `  _(host: ${md(r.downgradeReason)})_` : '';
    out.push(
      `- **[${VERDICT_TAG[r.effectiveVerdict]}]** \`${code(r.findingId)}\` · ${SEVERITY_LABEL[r.severity]} · \`${where}\` — ${md(r.title).slice(0, 160)}${reason}${dg}`
    );
  }
  const c = verdictCounts(records);
  out.push(
    '',
    `_${c.agree} agree · ${c.partial} partial · ${c.false} false (dismissed) · ${c.unverified} unverified — gate trail ${trailWritten ? 'written' : 'NOT durably written (dismissals not honored)'}_`
  );
  return out;
}

// Render a completed review as a GitHub PR comment (markdown). PURE + deterministic — no I/O, no
// clock — so it is snapshot-tested directly. Capping is a separate step (capComment) so the
// renderer can be asserted structurally and the cap can be exercised with a small limit.
export function renderReviewComment(input: RenderCommentInput): string {
  const { profile, claudeLayer, reviews, receipt } = input;
  const kind = profile === 'security' ? 'security' : 'review';
  const out: string[] = [];
  out.push(`## 🔭 ensemble-ai ${kind} — cross-vendor review`);
  out.push('');
  out.push(`\`${code(input.headline)}\``);
  out.push('');
  out.push(`head \`${code(input.headSha)}\`${input.repoId ? ` · repo \`${code(input.repoId)}\`` : ''}`);

  // Synthesis + gate verdicts (present only when the Opus gate layer ran; --no-claude drops it).
  if (claudeLayer) {
    out.push(...synthesisSection(claudeLayer.synthesis));
    out.push(...gateSection(claudeLayer.gateVerdicts, claudeLayer.gateTrailWritten));
  }

  out.push('', '### Findings by reviewer');
  for (const r of reviews) {
    const id = r.reviewerId ?? r.reviewer.vendor;
    out.push(
      ...reviewerBlock(
        id,
        r.reviewer.vendor,
        r.reviewer.model,
        r.terminalState === 'reviewed',
        r.findings,
        r.summary,
        profile
      )
    );
  }
  // The cold Opus (claude) reviewer is a full peer, rendered from the claude layer (it is not in
  // `reviews`, which is the codex/grok core).
  const cr = claudeLayer?.claudeReview;
  if (cr) {
    out.push(
      ...reviewerBlock(
        'claude',
        'anthropic',
        claudeLayer!.modelLabel,
        cr.ok,
        cr.findings,
        cr.summary,
        profile
      )
    );
  }

  // Footer: the trail path, receipt line, and resolved gate seat — the provenance a reader (or a
  // fix-loop) follows back to the auditable artifacts.
  const receiptLine = receipt.path
    ? `receipt \`${code(receipt.path)}\`${receipt.digest ? ` (${code(receipt.digest)})` : ''}`
    : `receipt none — ${md(receipt.error ?? 'not qualified')}`;
  const seat = input.gateSeat;
  const seatLine = seat
    ? `gate seat anthropic/${md(seat.model)} @ ${md(seat.effort)} (model: ${seat.modelSource}, effort: ${seat.effortSource})`
    : 'gate seat n/a (no gate ran)';
  const completed = receipt.completed.length ? ` · completed: ${receipt.completed.map(md).join(', ')}` : '';
  out.push('', '---');
  out.push(
    `<sub>trail \`${code(input.trailDir)}\` · ${receiptLine}${completed} · ${seatLine} · posted by \`ensemble-ai\`</sub>`
  );
  return out.join('\n');
}

// Cap the rendered body under GitHub's comment limit with a NAMED truncation marker pointing at
// the full trail. `maxLen` is a parameter (defaulting to the real limit) so tests can exercise
// truncation without a 65k fixture. A body already under the limit is returned verbatim.
export function capComment(body: string, trailDir: string, maxLen = GITHUB_COMMENT_MAX): string {
  if (body.length <= maxLen) return body;
  const marker = `\n\n> **⚠ Comment truncated by ensemble-ai** — the full review exceeded GitHub's ${maxLen}-character comment limit. Read the complete trail at \`${scrubControl(trailDir)}\`.`;
  const room = Math.max(0, maxLen - marker.length);
  return body.slice(0, room) + marker;
}

// ── Posting (injectable exec) ─────────────────────────────────────────────────────────────

export type PostResult = { error: string; ok: false } | { ok: true; url?: string };

// The exec seam: given `gh` args + the comment body (piped to gh's stdin via `--body-file -`),
// perform the post. The CLI supplies a real `gh` runner; tests supply a fake so the degrade path
// is exercised without spawning gh. A runner reports failure by RETURNING {ok:false} — it must
// not throw (postReviewComment backstops a throw anyway).
export type PostRunner = (args: string[], body: string) => PostResult;

// Post the rendered comment to the PR. Builds the `gh pr comment` argv (with `-R owner/repo` only
// for a URL PR), runs it through the injected runner, and REPORTS the outcome — success as a
// quiet progress line, failure as a LOUD stderr warning that states the exit code is unchanged.
// Returns the result but NEVER throws: `--post-comment` can never alter the review's exit code.
export function postReviewComment(
  body: string,
  target: PostTarget,
  opts: { cmd?: string; log?: (m: string) => void; run: PostRunner }
): PostResult {
  const log = opts.log ?? (() => {});
  const cmd = opts.cmd ?? 'review';
  const where = target.repoSlug ? `${target.repoSlug} PR #${target.pr}` : `PR #${target.pr}`;
  const args = [
    'pr',
    'comment',
    String(target.pr),
    ...(target.repoSlug ? ['-R', target.repoSlug] : []),
    '--body-file',
    '-',
  ];
  let result: PostResult;
  try {
    result = opts.run(args, body);
  } catch (e) {
    // A runner MUST report failure by returning {ok:false}, but backstop a throw anyway — and read
    // the message defensively (`throw null`/a non-Error would make `(e as Error).message` throw
    // INSIDE the catch and escape, breaking the "NEVER throws" contract above).
    result = { error: e instanceof Error ? e.message : String(e), ok: false };
  }
  if (result.ok) {
    log(`· posted the ${cmd} to ${where}${result.url ? ` — ${result.url}` : ''}`);
  } else {
    log(
      `⚠ --post-comment: could NOT post to ${where} — ${result.error}. ` +
        `The review above and its exit code are unaffected (posting never changes the gate contract).`
    );
  }
  return result;
}
