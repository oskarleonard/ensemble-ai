import { FINDINGS_INSTRUCTIONS } from './findings';
import type { ReviewPacket } from './types';

// Render the assembled packet into the reviewer prompt. A stateless reviewer (no
// memory of the repo, or "yesterday" — proven live: a reviewer literally could
// not review a file until its contents were embedded) has ONLY this text. So
// everything it needs is embedded, prefaced by an explicit "you have no prior
// memory" note, and closed with the strict findings-output contract. A great loop
// with a blind reviewer is theater — this is what makes the reviewer not-blind.
export function renderReviewPrompt(packet: ReviewPacket): string {
  // The subject line: a PR for the code/PR profile (pr > 0); otherwise the
  // packet's `subject` label or a neutral line (a raw diff has no PR identity).
  const subject =
    packet.pr > 0
      ? `Repository: ${packet.repo} · Pull request #${packet.pr}`
      : packet.subject
        ? `Under review: ${packet.subject}`
        : `Repository: ${packet.repo || '(a working tree)'} · reviewing the diff below`;

  const head = [
    'You are an adversarial code reviewer from a DIFFERENT vendor than the author.',
    'You have NO prior memory: your own memory, the repository, and every earlier',
    'conversation are unknown to you EXCEPT what is embedded below. Review only',
    'what is here; do not assume facts not present.',
    '',
    subject,
  ].join('\n');

  const body = packet.sections
    .map((s) => {
      const header = `## ${s.title}\n_(${s.note})_`;
      return s.included
        ? `${header}\n\n${s.body}`
        : `${header}\n\n(not available)`;
    })
    .join('\n\n');

  const ask = [
    '## Your task',
    'Find correctness bugs, security issues, broken conventions, and risky',
    'choices IN THE DIFF. Be concrete and cite file + line. Do not nitpick style',
    'the conventions already allow. Prefer a few high-signal findings over many',
    'weak ones — false positives waste the arbiter’s time.',
    '',
    FINDINGS_INSTRUCTIONS,
  ].join('\n');

  return `${head}\n\n${body}\n\n${ask}\n`;
}
