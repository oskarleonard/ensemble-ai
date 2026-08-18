import { FINDINGS_INSTRUCTIONS } from './findings';
import {
  type ReviewProfile,
  SECURITY_CLASSES,
} from '../modes/review/profile';
import type { ReviewPacket } from './types';

// The general-review ask (the `code` profile): correctness + security + conventions.
const CODE_ASK = [
  '## Your task',
  'Find correctness bugs, security issues, broken conventions, and risky',
  'choices IN THE DIFF. Be concrete and cite file + line. Do not nitpick style',
  'the conventions already allow. Prefer a few high-signal findings over many',
  'weak ones — false positives waste the arbiter’s time.',
  '',
  'TWIN-SURFACE PARITY: when the diff adds a surface that MIRRORS an existing one',
  '(alias routes, a twin API vocabulary, a parallel variant of an existing',
  'endpoint/handler/command set), enumerate the mirrored surface’s operations and',
  'behaviors as visible in the embedded context, diff the two, and flag any',
  'operation, guard, error contract, or test the original has that the new surface',
  'lacks WITHOUT a stated justification. An absence is a finding: cite where the',
  'original defines what the twin is missing, and say what breaks or is blocked by',
  'the gap. Diff-only review misses these by construction — the absence is not in',
  'the diff, so look for it deliberately.',
  '',
  'VISIBILITY↔ADDRESSABILITY PARITY: when the diff changes WHO can see the rows a',
  'list/collection endpoint returns (scoping, reachability, filters, redaction) or',
  'changes an authorization check, walk the LEAST-privileged caller that can now',
  'see each row and verify that same caller can also act on the row the way',
  'consumers address it — detail fetch, update, delete, deep link — through every',
  'reference the row carries. A row a caller can list but cannot address, or can',
  'address only through a reference that caller cannot read, is a finding even',
  'when each endpoint is correct in isolation: name the caller role, the reference',
  'used, and the request that fails. If the diff (or its description) claims',
  'consumers need no change, test that claim against the least-privileged caller,',
  'not the author/owner perspective.',
].join('\n');

// The `security` profile ask: an adversarial security-auditor framing. Same strict
// findings contract, but the reviewer is pointed at the exploit classes and asked to
// lead each finding's title with a [class] tag so the output can group by class.
function securityAsk(): string {
  const classes = SECURITY_CLASSES.filter((c) => c.id !== 'other')
    .map((c) => `  - [${c.id}] ${c.label}`)
    .join('\n');
  return [
    '## Your task — SECURITY AUDIT',
    'You are auditing this diff ADVERSARIALLY for exploitable security',
    'vulnerabilities a same-vendor author might miss. Think like an attacker:',
    'how could untrusted input reach a dangerous sink? Focus on these classes:',
    classes,
    '',
    'For EACH finding, lead the "title" with the matching class tag in brackets,',
    'e.g. "[injection] user id concatenated into SQL". Cite the exact file + line',
    'and name the attack: the untrusted source, the sink, and the exploit. Prefer a',
    'few high-signal, exploitable findings over many theoretical ones — but do NOT',
    'stay silent on a real vulnerability to keep the list short. Pure code-quality',
    'nits that are not security-relevant belong in a normal review, not here.',
  ].join('\n');
}

// Render the assembled packet into the reviewer prompt. A stateless reviewer (no
// memory of the repo, or "yesterday" — proven live: a reviewer literally could
// not review a file until its contents were embedded) has ONLY this text. So
// everything it needs is embedded, prefaced by an explicit "you have no prior
// memory" note, and closed with the strict findings-output contract. A great loop
// with a blind reviewer is theater — this is what makes the reviewer not-blind.
// `profile` swaps ONLY the framing (head line + ask); the embedded context, the
// findings contract, and the output schema are identical across profiles.
export function renderReviewPrompt(
  packet: ReviewPacket,
  profile: ReviewProfile = 'code'
): string {
  // The subject line: a PR for the code/PR profile (pr > 0); otherwise the
  // packet's `subject` label or a neutral line (a raw diff has no PR identity).
  const subject =
    packet.pr > 0
      ? `Repository: ${packet.repo} · Pull request #${packet.pr}`
      : packet.subject
        ? `Under review: ${packet.subject}`
        : `Repository: ${packet.repo || '(a working tree)'} · reviewing the diff below`;

  const role =
    profile === 'security'
      ? 'You are an adversarial SECURITY auditor from a DIFFERENT vendor than the author.'
      : 'You are an adversarial code reviewer from a DIFFERENT vendor than the author.';
  const head = [
    role,
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
    profile === 'security' ? securityAsk() : CODE_ASK,
    '',
    FINDINGS_INSTRUCTIONS,
  ].join('\n');

  return `${head}\n\n${body}\n\n${ask}\n`;
}
