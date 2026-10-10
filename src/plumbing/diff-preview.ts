// The `diff` plumbing command's PURE core — assemble the EXACT review packet the
// engine would send to the reviewers, WITHOUT running any reviewer (a cost-preview
// / debug view). It reuses the same acquireDiff output + assembleCodePacket +
// renderReviewPrompt the engine uses, and reproduces runReviewMode's packet inputs
// (default objective per profile, pr 0, repoId) — so the preview never drifts from
// the real payload. No spawn, no network, no config read.

import type { ConventionManifest } from '../core/conventions';
import { assembleCodePacket } from '../core/packet';
import { renderReviewPrompt } from '../core/prompt';
import type { ReviewPacket } from '../core/types';
import { renderChangeScope } from '../modes/review/chunks';
import { type AcquiredDiff, coverageCounts, omittedLine } from '../modes/review/diff';
import { DEFAULT_OBJECTIVE } from '../modes/review';
import { type ReviewProfile, SECURITY_OBJECTIVE } from '../modes/review/profile';

export interface PacketPreview {
  packet: ReviewPacket;
  // The review PARTS (modes/review/chunks.ts) when the change previews as more than one packet:
  // each part's own packet + prompt, in part order. `packet`/`prompt` above are part 1's. One
  // entry (or absent) for a change that fits one packet.
  parts?: { index: number; label: string; packet: ReviewPacket; prompt: string }[];
  // The fully rendered reviewer prompt — the literal text each reviewer receives.
  prompt: string;
}

// Assemble the packet + render the prompt exactly as runReviewMode does for the
// given profile. PURE: a function of the acquired diff + profile (+ the gathered
// conventions text, if any), so "it assembles without spawning a reviewer" is true
// by construction (this module imports no reviewer adapter).
export function buildPacketPreview(
  acquired: AcquiredDiff,
  profile: ReviewProfile,
  agentsMd?: string,
  agentsBudget?: number,
  // The coverage ceiling `acquired.diff` was admitted under — the preview must budget the diff
  // section exactly as runReviewMode does, or it previews a splice the review never makes.
  diffBudget?: number
): PacketPreview {
  const objective = profile === 'security' ? SECURITY_OBJECTIVE : DEFAULT_OBJECTIVE;
  const plan = acquired.plan;
  const scoped = plan.chunks.length > 1 || plan.overflow.length > 0;
  const scopeInput = { coverage: acquired.coverage, plan };
  const build = (diff: string, chunkIndex?: number): ReviewPacket =>
    assembleCodePacket({
      agentsBudget,
      agentsMd,
      diff,
      diffBudget,
      objective,
      pr: 0,
      repo: acquired.repoId ?? '',
      ...(chunkIndex !== undefined && scoped ? { scope: renderChangeScope(scopeInput, chunkIndex) } : {}),
    });
  if (plan.chunks.length <= 1) {
    const packet = build(acquired.diff, plan.chunks[0]?.index);
    return { packet, prompt: renderReviewPrompt(packet, profile) };
  }
  const parts = plan.chunks.map((c) => {
    const packet = build(c.diff, c.index);
    return { index: c.index, label: c.label, packet, prompt: renderReviewPrompt(packet, profile) };
  });
  return { packet: parts[0].packet, parts, prompt: parts[0].prompt };
}

// The gathered convention files, rendered for the `diff` preview + review summary —
// which files fed the reviewers, and which were truncated/omitted over the cap. One
// renderer so the preview and the review summary can't drift on the wording.
export function renderConventionManifest(m: ConventionManifest): string[] {
  const out: string[] = [];
  const inc = m.files.filter((f) => f.included).length;
  out.push(
    `  conventions:  ${inc}/${m.files.length} file(s) gathered, ${m.totalBytes} bytes (cap ${m.capBytes})`
  );
  const tierLabel = ['mandatory', 'named', 'swept'];
  for (const f of m.files) {
    const flag = f.included ? (f.truncated ? '~' : '✓') : '·';
    // Name the actual reason: a duplicate or a file-ceiling omission is not "over cap".
    const tag = f.truncated
      ? ' (truncated — over cap)'
      : f.reason === 'duplicate'
        ? ` (duplicate of ${f.duplicateOf ?? '?'})`
        : f.reason === 'max-files'
          ? ' (omitted — file ceiling)'
          : !f.included
            ? ' (omitted — over cap)'
            : '';
    const tier = f.tier === undefined ? '' : ` [${tierLabel[f.tier]}]`;
    out.push(`    ${flag} ${f.path} (${f.bytes} bytes)${tier}${tag}`);
  }
  return out;
}

// The formatted preview: the diff identity + coverage + the per-section manifest
// (what the reviewer will and won't see) + the prompt-size cost preview. With
// `full`, the entire rendered prompt is appended (the literal payload). PURE.
export function renderPacketPreview(
  acquired: AcquiredDiff,
  preview: PacketPreview,
  opts: {
    conventions?: ConventionManifest;
    full: boolean;
    profile: ReviewProfile;
    reviewers: string[];
  }
): string {
  const c = acquired.coverage;
  const out: string[] = [];
  out.push('');
  out.push(`ensemble-ai diff — the assembled ${opts.profile} review packet (no reviewer run)`);
  if (acquired.repoId) out.push(`  repo:    ${acquired.repoId}`);
  if (acquired.baseRef) out.push(`  base:    ${acquired.baseRef} (${acquired.baseSha ?? '?'})`);
  out.push(`  head:    ${acquired.headSha}`);
  out.push(`  mode:    ${acquired.mode}`);
  out.push(`  digest:  ${acquired.canonicalDigest}`);
  out.push(
    `  files:   ${coverageCounts(c)} · ${c.includedBytes}/${c.totalBytes} bytes covered`
  );
  for (const f of c.files.filter((x) => !x.included)) {
    out.push(`             ${omittedLine({ kind: f.kind, path: f.path, reason: f.omitReason })}`);
  }
  // A review in PARTS: the plan, part by part, with each packet's size — the cost line below then
  // sums the parts, because every seat reviews every part.
  const parts = preview.parts ?? [];
  if (parts.length > 1) {
    out.push(
      `  parts:   ${parts.length} (ceiling ${acquired.plan.ceilingBytes.toLocaleString('en-US')} bytes per part) — each seat reviews every part; one gate judges them together`
    );
    for (const p of parts) {
      const chunk = acquired.plan.chunks.find((x) => x.index === p.index);
      out.push(
        `             part ${p.index}: ${p.label} — ${chunk?.paths.length ?? '?'} file(s), ${(chunk?.bytes ?? 0).toLocaleString('en-US')} bytes · prompt ~${p.prompt.length.toLocaleString('en-US')} chars`
      );
    }
    if (acquired.plan.overflow.length > 0) {
      out.push(`             ⚠ ${acquired.plan.overflow.length} file(s) past the part limit (over-limit above; raise --max-chunks)`);
    }
  }
  out.push('');
  out.push(parts.length > 1 ? '  packet sections (part 1 — what the reviewer sees):' : '  packet sections (what the reviewer sees):');
  for (const s of preview.packet.sections) {
    const flag = s.included ? (s.truncated ? '~' : '✓') : '·';
    out.push(`    ${flag} ${s.title} — ${s.note}`);
  }
  if (opts.conventions) {
    out.push('');
    out.push(...renderConventionManifest(opts.conventions));
  }
  out.push('');
  out.push(`  packet complete: ${preview.packet.complete ? 'yes' : 'NO — a blind review (diff missing/too small)'}`);
  // The rendered prompt is reviewer-INDEPENDENT today (renderReviewPrompt keys off
  // the profile, not the reviewer), so cost scales by count: N chars × R reviewers.
  // If the prompt ever becomes reviewer-specific, this preview must render per reviewer.
  const totalChars = parts.length > 1 ? parts.reduce((n, p) => n + p.prompt.length, 0) : preview.prompt.length;
  out.push(
    `  cost preview:    ~${totalChars} prompt chars${parts.length > 1 ? ` across ${parts.length} parts` : ''} × ${opts.reviewers.length} reviewer(s) [${opts.reviewers.join(', ')}]`
  );
  if (opts.full) {
    out.push('');
    if (parts.length > 1) {
      for (const p of parts) {
        out.push(`  ── rendered prompt — part ${p.index} of ${parts.length}: ${p.label} ──`);
        out.push(p.prompt);
        out.push('');
      }
    } else {
      out.push('  ── rendered prompt ──');
      out.push(preview.prompt);
    }
  } else {
    out.push('  (pass --full to print the entire rendered prompt)');
  }
  out.push('');
  return out.join('\n');
}
