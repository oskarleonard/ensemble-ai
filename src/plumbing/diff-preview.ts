// The `diff` plumbing command's PURE core — assemble the EXACT review packet the
// engine would send to the reviewers, WITHOUT running any reviewer (a cost-preview
// / debug view). It reuses the same acquireDiff output + assembleCodePacket +
// renderReviewPrompt the engine uses, and reproduces runReviewMode's packet inputs
// (default objective per profile, pr 0, repoId) — so the preview never drifts from
// the real payload. No spawn, no network, no config read.

import { assembleCodePacket } from '../core/packet';
import { renderReviewPrompt } from '../core/prompt';
import type { ReviewPacket } from '../core/types';
import type { AcquiredDiff } from '../modes/review/diff';
import { DEFAULT_OBJECTIVE } from '../modes/review';
import { type ReviewProfile, SECURITY_OBJECTIVE } from '../modes/review/profile';

export interface PacketPreview {
  packet: ReviewPacket;
  // The fully rendered reviewer prompt — the literal text each reviewer receives.
  prompt: string;
}

// Assemble the packet + render the prompt exactly as runReviewMode does for the
// given profile. PURE: a function of the acquired diff + profile, so "it assembles
// without spawning a reviewer" is true by construction (this module imports no
// reviewer adapter).
export function buildPacketPreview(
  acquired: AcquiredDiff,
  profile: ReviewProfile
): PacketPreview {
  const packet = assembleCodePacket({
    diff: acquired.diff,
    objective: profile === 'security' ? SECURITY_OBJECTIVE : DEFAULT_OBJECTIVE,
    pr: 0,
    repo: acquired.repoId ?? '',
  });
  return { packet, prompt: renderReviewPrompt(packet, profile) };
}

// The formatted preview: the diff identity + coverage + the per-section manifest
// (what the reviewer will and won't see) + the prompt-size cost preview. With
// `full`, the entire rendered prompt is appended (the literal payload). PURE.
export function renderPacketPreview(
  acquired: AcquiredDiff,
  preview: PacketPreview,
  opts: { full: boolean; profile: ReviewProfile; reviewers: string[] }
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
    `  files:   ${c.totalFiles} total · ${c.includedFiles} reviewed · ${c.omittedFiles} omitted · ${c.includedBytes}/${c.totalBytes} bytes covered`
  );
  for (const f of c.files.filter((x) => !x.included)) {
    out.push(`             omitted: ${f.path} (${f.omitReason}/${f.kind})`);
  }
  out.push('');
  out.push('  packet sections (what the reviewer sees):');
  for (const s of preview.packet.sections) {
    const flag = s.included ? (s.truncated ? '~' : '✓') : '·';
    out.push(`    ${flag} ${s.title} — ${s.note}`);
  }
  out.push('');
  out.push(`  packet complete: ${preview.packet.complete ? 'yes' : 'NO — a blind review (diff missing/too small)'}`);
  out.push(
    `  cost preview:    ~${preview.prompt.length} prompt chars × ${opts.reviewers.length} reviewer(s) [${opts.reviewers.join(', ')}]`
  );
  if (opts.full) {
    out.push('');
    out.push('  ── rendered prompt ──');
    out.push(preview.prompt);
  } else {
    out.push('  (pass --full to print the entire rendered prompt)');
  }
  out.push('');
  return out.join('\n');
}
