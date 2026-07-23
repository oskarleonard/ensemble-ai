#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { escapesRoot, reviewDir, writeTrailFile } from './core/artifacts';
import {
  type ConventionManifest,
  type ConventionReader,
  fsConventionReader,
  gatherConventions,
} from './core/conventions';
import { isEntrypoint } from './core/entrypoint';
import { evidenceRef, SEVERITY_LABEL, SEVERITY_ORDER } from './core/findings';
import { listReviewers, REVIEWERS_FILE } from './core/reviewers';
import { scrubControl as clean } from './core/sanitize';
import {
  CORE_REVIEWER_IDS,
  isReviewerId,
  parseReviewerIds,
  REVIEWER_IDS,
  type ReviewerId,
  type Severity,
  type StoredReview,
} from './core/types';
import { runBrainstormMode } from './modes/brainstorm';
import { listVoices, VOICES_FILE } from './modes/brainstorm/voices';
import {
  type BrainstormResult,
  isVoiceId,
  parseVoiceIds,
  VOICE_IDS,
  type VoiceId,
} from './modes/brainstorm/types';
import { runConsultMode } from './modes/consult';
import type { ConsultResult } from './modes/consult/types';
import { isImplemented, isMode, resolveMode } from './modes';
import { runReviewMode, type ReviewModeResult } from './modes/review';
import {
  claudeLayerHasHigh,
  type ClaudeLayerResult,
  claudeModelLabel,
  renderClaudeLayer,
  resolveReviewRoster,
  runClaudeReviewLayer,
} from './modes/review/self-contained';
import type { DepSurfaceResult } from './modes/review/dep-surface';
import {
  gateAuthorityActive,
  type GateAuthorityInputs,
  gateAuthorityLabel,
  gateDispositionSummary,
  renderHighGate,
  resolveHighGate,
} from './modes/review/gate';
import { type GateSeat, loadClaudeReviewerSeat, loadGateSeat } from './modes/review/gate-seat';
import { loadHolisticSeat } from './modes/review/holistic';
import {
  acquireDiff,
  type AcquiredDiff,
  coverageCounts,
  DEFAULT_COVERAGE_CEILING,
  type DiffMode,
  omittedLine,
} from './modes/review/diff';
import {
  type EvidenceClass,
  type EvidenceMap,
  type EvidenceSeat,
  HARNESS_SEATS,
  type HarnessSeat,
} from './modes/review/evidence';
import {
  buildEvidenceManifest,
  writeEvidenceManifest,
} from './modes/review/evidence-manifest';
import {
  classifySecurityFinding,
  type ReviewProfile,
  stripSecurityTag,
} from './modes/review/profile';
import { formatEvidenceFooter } from './modes/review/seat-evidence';
import { isPreflightError } from './modes/review/worktree';
import { execGit } from './modes/review/git-exec';
import { checkPinDrift, describePinDrift } from './plumbing/pin-check';
import {
  buildHistoryPacket,
  type HistoryPacket,
  historyPacketConfig,
} from './modes/review/history-packet';
import { readEnsembleConfig } from './modes/review/ensemble-config';
import { openWorktree, type WorktreeSession } from './modes/review/worktree-run';
import {
  computePolicyHash,
  defaultReceiptStore,
  type DiffReviewReceipt,
  type PeerReviewerRecord,
  readReceipt,
  receiptIdentityMatches,
  type ReceiptKey,
  validateReceiptShape,
  writeReceipt,
} from './modes/review/receipt';
import {
  type DiffSourceSelection,
  hasExplicitSource,
  isDiffSourceError,
  selectDiffSource,
} from './modes/review/source';
import {
  capComment,
  type CommentGateSeat,
  type PostRunner,
  type PostTarget,
  postReviewComment,
  postTargetFromSelection,
  renderReviewComment,
} from './modes/review/post-comment';
import { loadPostingPosture } from './modes/review/posting-config';
import { evaluatePushFence, parsePushContext } from './modes/review/push-fence';
import { buildStagedReviewPayload, planPlacement } from './modes/review/stage-plan';
import { type GhRunner, type StageTarget, stageReview } from './modes/review/stage';
import {
  buildPacketPreview,
  renderConventionManifest,
  renderPacketPreview,
} from './plumbing/diff-preview';
import { renderRegistry, type RegistryView } from './plumbing/registry';
import {
  formatReceipt,
  formatVerify,
  isAttestedOnly,
  verifyExitCode,
  verifyReceipt,
} from './plumbing/verify';

const USAGE = `ensemble-ai — convene multiple AI models on a task, read-only.

Usage:
  ensemble-ai <mode> [options]

Modes:
  review       Cross-vendor review of a code diff (implemented).
  security     Cross-vendor SECURITY audit of a code diff (implemented) —
               the review engine with a security-auditor lens + a local
               dependency-surface flag; findings tagged by security class.
  brainstorm   Cross-vendor ideation on a TOPIC (implemented) — each voice
               generates ideas independently, critiques the others, then one
               synthesizes a ranked, de-duplicated recommendation.
  consult      Cross-vendor Q&A on a QUESTION (implemented; alias: ask) — each
               voice answers independently, then one synthesizes what they AGREE
               on (confident) vs where they DIVERGE (look closer).

Plumbing (no reviewer runs — inspect the engine):
  receipt      verify | show a content-tied diff receipt (the pre-PR gate primitive):
               \`receipt verify\` exits 0 iff the current diff is reviewed & current.
  reviewers    (alias: config) list the configured cross-vendor registry (read-only).
  diff         show the assembled review packet that WOULD be sent — cost-preview/debug.

Run \`ensemble-ai <mode|command> --help\` for options.`;

const REVIEW_USAGE = `ensemble-ai review — self-contained cross-vendor review of a diff.

Spawns THREE blind peer reviewers on the SAME pinned packet — codex + grok + a cold
headless \`claude -p\` (Opus, default-on) — each writing its own review into the trail,
then a \`claude -p\` GATE pass reads all three and emits AGREE(confident)/DISAGREE
(look-closer) · a grounded per-finding verdict (agree/partial/false/unverified) · a bottom
line. Runs from ANY terminal with
no Claude session. REVIEW-ONLY — it never edits code. With NO source flag it reviews the
current branch. \`--no-claude\` drops the Opus reviewer + synthesis (codex + grok only).

Usage:
  ensemble-ai review [<pr-url>] [options]

Diff source (give at most ONE; default = current branch):
  (default)            <base>...HEAD — the current branch vs its merge-base with
                       the default branch (origin/main; resolved like \`gh pr create\`)
  <pr-url>             a positional GitHub PR URL — sugar for \`--pr <url>\`, so you
                       can \`ensemble-ai review https://github.com/o/r/pull/7\` from ANY dir
  --pr <N|url>         the diff of a GitHub PR. A bare integer N → \`gh pr diff <N>\`
                       in the cwd's repo; a full URL (github.com/<owner>/<repo>/pull/<N>)
                       → \`gh pr diff <N> -R <owner>/<repo>\`, reviewable from ANY
                       directory with NO branch checkout
  --staged             staged changes (\`git diff --cached\`)
  --working-tree       uncommitted tracked changes vs HEAD (\`git diff HEAD\`)
  --diff-file <path>   a raw unified diff read from a file
  (stdin)              a piped diff, e.g. \`git diff main...HEAD | ensemble-ai review\`

Options:
  --base <ref>          base ref for the default (commit) mode
  --reviewers <ids>     comma-separated reviewer ids to subset the roster
                        (default: codex,grok,claude — claude is a valid id)
  --no-claude           drop the cold Opus reviewer + the synthesis pass (codex + grok
                        only) — e.g. from a terminal with no Claude CLI
  --holistic            add the HOLISTIC/architecture lens: one Anthropic seat that reads the
                        WHOLE project (reinvented patterns, convention drift, simplifiable
                        design). Default OFF. REQUIRES worktree evidence — with none it does
                        not run and says so; it never reviews on the packet.
  --conventions <paths> extra convention files to gather (comma-separated, in-repo)
  --no-conventions      do NOT gather the repo's conventions into the packet
  --no-fail-on-high     do NOT exit non-zero when a HIGH finding is present
  --strict-high         force STRICT: EVERY HIGH gates (exit 4), even one the gate dismissed —
                        overrides the provenance default (use for untrusted diffs / CI)
  --gate-dismissals     opt a FOREIGN diff (--pr/URL/stdin/--diff-file) INTO the gate's
                        dismiss-only authority (LOCAL diffs already have it on by default)
  --claude-model <m>    model for the claude REVIEWER (producer) seat — overrides the voices.json
                        \`claude\` entry; built-in default: opus. NEVER the interactive CLI's saved
                        default — a headless seat must not inherit a \`/model\` switch
  --claude-effort <e>   effort for the claude REVIEWER seat (low|medium|high|xhigh|max) —
                        overrides the file; built-in default: max
  --gate-model <m>      model for the GATE (synthesis) seat — overrides the voices.json
                        \`gate\` entry; the gate is always claude -p (keep it ≥ your strongest
                        reviewer, else it mostly returns unverified — the toothless mode)
  --gate-effort <e>     effort for the GATE seat (low|medium|high|xhigh|max) — overrides the
                        file; an unknown value is ignored (\`ensemble-ai config\` shows the seat)
  --stage               after a COMPLETED review, stage it as ONE **PENDING** GitHub review under
                        your account (opt-in; REQUIRES a PR **URL**, which binds the diff to the
                        head SHA — a bare \`--pr <N>\` has no commit identity to anchor to). Verified
                        bugs land as inline comments, quality findings in a collapsed summary
                        section, ≤3 gate-verified fixes as one-click \`suggestion\` blocks. NOTHING
                        is posted until you submit it on GitHub — a zero-bug run still stages the
                        summary. Re-running REPLACES the prior staged review (never duplicates); a
                        moved PR head REFUSES. Prints {stagedReviewUrl, counts, receipt} as JSON on
                        the last stdout line.
  --post-comment        DEPRECATED (prefer --stage): after a COMPLETED review, ALSO post it to the
                        PR as one markdown comment via \`gh pr comment\` — published IMMEDIATELY under
                        your account, with no submit step. Kept for existing consumers.
                        A gh failure warns loudly and leaves the review + exit code UNCHANGED.
  --out <dir>           trail BASE dir; a per-run <run-id>/ subdir is created under it
                        (default: repo-local .ensemble-ai/reviews when reviewing this
                        repo's own diff, else an OS temp dir — the path is printed)
  --sandbox <profile>   reviewer sandbox profile override (deny-by-default only)
  --allow-sensitive     review even if the diff carries secrets/sensitive paths
  --ceiling <bytes>     coverage byte ceiling (default 200000)
  --cwd <dir>           repo working dir (default: cwd)
  --run-id <id>         trail/receipt run id (default: generated)
  -h, --help            this help

Gate authority (exit 4): a HIGH stops the gate ONLY when the cold-Opus GATE returns a
citation-validated \`false\` grounded in the reviewed code — dismiss-only: it can never bless,
promote, or soften anything else. The grounding proves the gate READ the disputed code; it does
NOT prove the finding is false (the verdict is the gate model's judgment). Authority is ON by
default ONLY for LOCAL diffs (--working-tree/--staged/branch — the trusted self-review case) and
STRICT for FOREIGN provenance (--pr/URL/stdin/--diff-file), where every HIGH gates. --strict-high
forces STRICT anywhere; --gate-dismissals opts foreign provenance in. Dismissed HIGHs print loudly.

Exit codes: 0 = completed, no gating HIGH (or gate disabled) · 1 = a reviewer failed
(crash/timeout/no-parse) · 2 = blocked by the secret-scan · 3 = usage / no diff ·
4 = completed with a HIGH the gate did NOT dismiss (disable with --no-fail-on-high).`;

const SECURITY_USAGE = `ensemble-ai security — adversarial SECURITY audit of a diff with ALL reviewers.

A thin PROFILE over \`review\`: the SAME engine + diff sources + receipt + HIGH gate,
but the reviewers run under a security-auditor lens (injection · XSS · authn/authz ·
secret-leak · supply-chain · unsafe deserialization/eval · SSRF · path-traversal ·
crypto misuse) and findings are tagged by security class in the grouped output. It
also runs a LOCAL dependency-surface flag (manifest changes + risky imports in the
diff — NO network / no vuln DB) and reuses the engine's secret-scan.

Usage:
  ensemble-ai security [<pr-url>] [options]

Diff source (give at most ONE; default = current branch):
  (default)            <base>...HEAD — the current branch vs its merge-base with
                       the default branch (origin/main; resolved like \`gh pr create\`)
  <pr-url>             a positional GitHub PR URL — sugar for \`--pr <url>\`
  --pr <N|url>         the diff of a GitHub PR. A bare integer N → \`gh pr diff <N>\`
                       in the cwd's repo; a full URL (github.com/<owner>/<repo>/pull/<N>)
                       → \`gh pr diff <N> -R <owner>/<repo>\`, reviewable from ANY dir
  --staged             staged changes (\`git diff --cached\`)
  --working-tree       uncommitted tracked changes vs HEAD (\`git diff HEAD\`)
  --diff-file <path>   a raw unified diff read from a file
  (stdin)              a piped diff, e.g. \`git diff main...HEAD | ensemble-ai security\`

Options + exit codes are identical to \`ensemble-ai review\` (run \`review --help\`).`;

function genRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

// Clear a REUSED run-id's stale trail dir so a prior run's `review.<id>.json` can't be read
// back into THIS run's synthesis. A recursive delete of a path derived from user input
// (`--run-id`) is a footgun, so it is fenced with defense-in-depth: the runId is already
// path-sanitized by reviewDir/sanitizePathSegment (which now also neutralizes bare `.`/`..`),
// and HERE we independently realpath BOTH the base and the target and delete ONLY when the
// target resolves to a path STRICTLY INSIDE the realpath'd base — never the base itself, an
// ancestor, or (via a symlink hop) anywhere outside. A fresh / auto-generated run id has no
// dir to clear (realpath throws → we simply return). So the recursive rm can only ever remove
// this run's own subdir under the trail base.
function clearReusedRunTrail(baseDir: string, trailDir: string): void {
  // Refuse to clear THROUGH a symlinked run dir. writeAtomic won't WRITE into a symlinked
  // trail dir, so the cleaner must not DELETE through one either: a planted `base/<run-id>`
  // symlink would otherwise resolve (below) to another run's REAL dir inside the base and the
  // recursive rm would nuke it — exactly the "only this run's own subdir" guarantee this
  // fence exists to keep. lstat the pre-realpath path; a symlink here → refuse. (Absent /
  // fresh run id → lstat throws → nothing to clear.)
  try {
    if (fs.lstatSync(trailDir).isSymbolicLink()) return;
  } catch {
    return;
  }
  let realBase: string;
  let realTarget: string;
  try {
    realBase = fs.realpathSync(baseDir);
    realTarget = fs.realpathSync(trailDir);
  } catch {
    return; // base or per-run dir doesn't exist yet → nothing to clear (fresh run id)
  }
  const rel = path.relative(realBase, realTarget);
  if (!rel || escapesRoot(rel)) {
    return; // not strictly inside the base (would be the base itself or an escape) → refuse
  }
  fs.rmSync(realTarget, { force: true, recursive: true });
}

function readStdinIfPiped(): string | undefined {
  if (process.stdin.isTTY) return undefined;
  try {
    const s = fs.readFileSync(0, 'utf8');
    return s.trim() ? s : undefined;
  } catch {
    return undefined;
  }
}

// Capture a child command's stdout (e.g. `gh pr diff N`). A PR diff can be large,
// so the buffer ceiling is generous; a non-zero exit / missing binary returns the
// error text so the CLI can fail with a clear message (exit 3) instead of throwing.
function capture(
  cmd: string,
  cmdArgs: string[],
  cwd: string
): { error: string; ok: false } | { ok: true; text: string } {
  try {
    const text = execFileSync(cmd, cmdArgs, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      // stdin closed so `gh` can never sit on an interactive prompt; stderr 'pipe' rather
      // than the sync-exec default, which ALSO mirrors the child's stderr onto ours — every
      // expected-miss conventions probe used to print its own `gh: Not Found (HTTP 404)`
      // line into the run log (~60 per URL-PR run). The text still lands in err.stderr
      // below, so every failure path reports what broke; nothing is mirrored blind.
      stdio: ['ignore', 'pipe', 'pipe'],
      // Bound the call so a wedged `gh` (auth prompt, network hang) can't hang the
      // gate forever — fail with a clear error instead.
      timeout: 120_000,
    });
    return { ok: true, text };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    return { error: stderr || err.message || 'command failed', ok: false };
  }
}

// The git repo root of cwd, or null when cwd isn't in a work tree (e.g. reviewing
// a PR URL from /tmp) — then local convention gathering is simply skipped.
function gitToplevel(cwd: string): string | null {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return top || null;
  } catch {
    return null;
  }
}

// The DEFAULT trail BASE dir (a per-run `<runId>/` subdir is created under it by
// reviewDir). Repo-local `<gitRoot>/.ensemble-ai/reviews` ONLY when we're in a git repo
// AND the diff is that repo's own local state (localRepoTrail) — discoverable beside the
// code, and `.ensemble-ai/` is gitignored so it never lands in a commit. Otherwise (not a
// repo, OR a URL PR / raw diff / stdin whose provenance is a DIFFERENT or unknown repo)
// fall back to the OS temp dir — the fence that keeps a work/brain diff's trail from ever
// being written into an unrelated cwd repo. Keyed on the DIFF SOURCE, not just cwd.
export function resolveTrailBase(
  gitRoot: string | null,
  localRepoTrail: boolean
): string {
  if (gitRoot && localRepoTrail) {
    return path.join(gitRoot, '.ensemble-ai', 'reviews');
  }
  return path.join(os.tmpdir(), 'ensemble-ai', 'reviews');
}

// A gh-backed convention reader (the `--pr <url>` path) — reads repo-relative files
// + lists dirs from the PR repo at a fixed ref via `gh api …/contents`. Mirrors the
// dashboard's own gh reader, so both feed the SAME pure gatherConventions. Any gh
// failure degrades to null/[] (a missing convention file is not fatal).
function ghConventionReader(
  repoSlug: string,
  ref: string,
  cwd: string
): ConventionReader {
  // A repo-relative path / dir + the ref go into a URL — encode each so a path with a
  // space or a special char (`docs/a b.md`, `feature/x`) can't corrupt the request or
  // smuggle extra query params. Segments are encoded individually so `/` separators live.
  const encPath = (p: string): string =>
    p.split('/').map(encodeURIComponent).join('/');
  const encRef = encodeURIComponent(ref);
  // A probe MISS is the normal case (the gatherer walks candidate paths that mostly don't
  // exist) and stays silent — capture() no longer mirrors gh's stderr. Anything NON-404
  // (auth expiry, rate limit, network) surfaces ONCE per distinct message: this reader
  // degrades to null/[] by design, so a broken gh would otherwise read as "0/N gathered"
  // with no visible cause.
  const warned = new Set<string>();
  const warnUnlessExpectedMiss = (error: string): void => {
    if (/\bHTTP 404\b/.test(error)) return;
    const nl = error.indexOf('\n');
    const first = nl === -1 ? error : error.slice(0, nl);
    if (warned.has(first)) return;
    warned.add(first);
    console.error(`· conventions probe (gh): ${first}`);
  };
  return {
    async read(rel, maxBytes) {
      // `.type=="file"` guard: the contents API returns an ARRAY for a directory (and an
      // object for a file). Only a FILE object carries `.content` — for anything else emit
      // nothing (→ null) rather than base64-decoding a directory listing into garbage.
      const cap = capture(
        'gh',
        [
          'api',
          `repos/${repoSlug}/contents/${encPath(rel)}?ref=${encRef}`,
          '--jq',
          'if type=="object" and .type=="file" then .content else empty end',
        ],
        cwd
      );
      if (!cap.ok) {
        warnUnlessExpectedMiss(cap.error);
        return null;
      }
      if (!cap.text.trim()) return null;
      try {
        const decoded = Buffer.from(cap.text.replace(/\s/g, ''), 'base64').toString('utf8');
        if (maxBytes !== undefined && Buffer.byteLength(decoded, 'utf8') > maxBytes) {
          // Bound the returned content (drop a trailing partial multibyte char) so a huge
          // remote doc never sits whole in the heap past what the gatherer can emit.
          return Buffer.from(decoded, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/�$/, '');
        }
        return decoded;
      } catch {
        return null;
      }
    },
    async list(dirRel) {
      // A directory listing is an array; `.[].path` on a FILE (object) errors → non-zero
      // exit → [] (handled by !cap.ok), so listing a non-dir yields nothing, not garbage.
      const cap = capture(
        'gh',
        ['api', `repos/${repoSlug}/contents/${encPath(dirRel)}?ref=${encRef}`, '--jq', '.[].path'],
        cwd
      );
      if (!cap.ok) {
        warnUnlessExpectedMiss(cap.error);
        return [];
      }
      return cap.text
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.endsWith('.md'));
    },
  };
}

// Pick the reader for the diff source: gh (URL PR, at the PR head) else the local
// checkout (fs from the cwd's git root). null → gather nothing (non-repo cwd).
function buildConventionReader(
  cwd: string,
  ctx?: { ref: string; repoSlug: string }
): ConventionReader | null {
  if (ctx) return ghConventionReader(ctx.repoSlug, ctx.ref, cwd);
  const root = gitToplevel(cwd);
  return root ? fsConventionReader(root) : null;
}

// Turn the resolved diff-source SELECTION into the engine inputs, running the
// git/gh I/O each source needs. Returns a usage-error code (3) on any failure so
// the caller can return it directly.
function resolveSource(
  selection: DiffSourceSelection,
  cwd: string,
  stdinContent: string | undefined,
  cmd = 'review'
):
  | { code: number }
  | {
      // Where a `--pr <url>` review gathers its conventions from — the PR's repo at
      // its resolved head SHA (via gh). Absent for local/bare-PR sources, which
      // gather from the cwd's local checkout instead.
      conventionsCtx?: { ref: string; repoSlug: string };
      diffMode?: DiffMode;
      diffText?: string;
      headShaOverride?: string;
      // True ONLY when the diff is the cwd repo's OWN local state (commit/staged/
      // working-tree) — so a repo-local `.ensemble-ai/reviews` trail is safe to drop.
      // A URL PR (a DIFFERENT, possibly work/brain repo), a raw --diff-file, or piped
      // stdin has unknown provenance → left false → the trail defaults to a temp dir,
      // never written INTO the cwd repo. This is the trail fence keyed on the DIFF
      // SOURCE, not just cwd (a work PR reviewed from ~/brain must not trail into it).
      localRepoTrail?: boolean;
      // A URL PR reviews a DIFFERENT repo than the cwd. When its head SHA can't be
      // resolved (no gh ref to read conventions at), suppress the LOCAL-repo fallback:
      // gather NOTHING rather than the wrong repo's conventions.
      noLocalConventions?: boolean;
      // The PR's BASE SHA, resolved from the compare API alongside `headShaOverride` (the two are
      // resolved together or not at all). It is prompt context — the range `git diff <base>...<head>`
      // that the worktree seats and the holistic lens are told the change spans — and is
      // deliberately NOT fed to `acquireDiff`: the receipt's `baseSha` is part of the receipt KEY,
      // so populating it here would stale every PR-mode receipt on disk.
      prBaseSha?: string;
      staged?: boolean;
      workingTree?: boolean;
    } {
  switch (selection.kind) {
    case 'pr': {
      // A gh capture → the case's engine inputs (the PR diff, optionally SHA-bound via
      // `headShaOverride`), or a usage-error code for a failed/empty fetch. Centralizes
      // the ok/empty checks so every PR fetch path below is a single `return`.
      const prResult = (
        cap: ReturnType<typeof capture>,
        label: string,
        headShaOverride?: string
      ):
        | { code: number }
        | { diffMode: DiffMode; diffText: string; headShaOverride?: string } => {
        if (!cap.ok) {
          console.error(`ensemble-ai ${cmd}: \`${label}\` failed: ${cap.error}`);
          return { code: 3 };
        }
        if (!cap.text.trim()) {
          console.error(`ensemble-ai ${cmd}: PR #${selection.pr} has an empty diff`);
          return { code: 3 };
        }
        return { diffMode: 'pr', diffText: cap.text, headShaOverride };
      };

      // A URL PR carries owner/repo → fetch the diff BOUND to the exact head SHA via
      // the compare API: one `gh api pulls/<N>` reads the PR's base+head SHAs, then
      // `gh api compare/<base>...<head>` returns EXACTLY that range's diff. So the
      // receipt's headSha provably matches the reviewed bytes — no TOCTOU between a
      // `gh pr diff` and a separate head read (the compare diff is byte-identical to
      // `gh pr diff`). Works from ANY cwd. Any gh failure degrades to an unbound
      // `gh pr diff -R` (generic head label). A bare integer keeps `gh pr diff <N>`
      // against the cwd's repo, unchanged (no SHA binding).
      if (selection.owner && selection.repo) {
        const repoSlug = `${selection.owner}/${selection.repo}`;
        const meta = capture(
          'gh',
          [
            'api',
            `repos/${repoSlug}/pulls/${selection.pr}`,
            '--jq',
            '{base: .base.sha, head: .head.sha}',
          ],
          cwd
        );
        let baseSha: string | undefined;
        let headSha: string | undefined;
        if (meta.ok) {
          try {
            const o = JSON.parse(meta.text) as { base?: unknown; head?: unknown };
            if (typeof o.base === 'string' && o.base.trim()) baseSha = o.base.trim();
            if (typeof o.head === 'string' && o.head.trim()) headSha = o.head.trim();
          } catch {
            /* unresolved → fall through to the unbound gh pr diff below */
          }
        }
        if (baseSha && headSha) {
          const label = `gh api repos/${repoSlug}/compare/${baseSha.slice(0, 7)}...${headSha.slice(0, 7)}`;
          const cmp = capture(
            'gh',
            [
              'api',
              `repos/${repoSlug}/compare/${baseSha}...${headSha}`,
              '-H',
              'Accept: application/vnd.github.diff',
            ],
            cwd
          );
          const r = prResult(cmp, label, headSha);
          // A URL PR review gathers conventions from the PR repo at its BASE SHA — the maintained
          // branch the PR targets, NEVER the PR head. Conventions are an INSTRUCTION channel: the
          // gathered text lands verbatim in every seat's prompt, so reading them at the head would
          // let a PR author add a `CLAUDE.md` and address the reviewers directly. The base ref is
          // the repo owner's text; the head is the contributor's. (The worktree strip removes the
          // same files from the checkout — belt and braces, see worktree.ts stripAgentInstructions.)
          return 'code' in r
            ? r
            : { ...r, conventionsCtx: { ref: baseSha, repoSlug }, prBaseSha: baseSha };
        }
        // SHAs unresolved → unbound `gh pr diff -R` (no SHA binding, generic label). A
        // URL PR reviews a DIFFERENT repo than the cwd, so its conventions must come ONLY
        // from the PR repo — but with no resolved head SHA there is no ref to read them
        // at. Suppress the local-repo fallback: EMPTY conventions, never the wrong repo's.
        const label = `gh pr diff ${selection.pr} -R ${repoSlug}`;
        const cap = capture(
          'gh',
          ['pr', 'diff', String(selection.pr), '-R', repoSlug],
          cwd
        );
        const r = prResult(cap, label);
        return 'code' in r ? r : { ...r, noLocalConventions: true };
      }

      // Bare integer PR: the cwd's repo, current head — unchanged (no SHA binding).
      const label = `gh pr diff ${selection.pr}`;
      const cap = capture('gh', ['pr', 'diff', String(selection.pr)], cwd);
      return prResult(cap, label);
    }
    case 'diff-file': {
      let text: string;
      try {
        text = fs.readFileSync(String(selection.diffFile), 'utf8');
      } catch (e) {
        console.error(
          `ensemble-ai ${cmd}: cannot read --diff-file: ${(e as Error).message}`
        );
        return { code: 3 };
      }
      if (!text.trim()) {
        console.error(
          `ensemble-ai ${cmd}: --diff-file ${selection.diffFile} is empty`
        );
        return { code: 3 };
      }
      return { diffText: text };
    }
    case 'stdin':
      return { diffText: stdinContent };
    case 'staged':
      return { localRepoTrail: true, staged: true };
    case 'working-tree':
      return { localRepoTrail: true, workingTree: true };
    case 'commit':
      return { localRepoTrail: true };
  }
}

// True iff any COMPLETED reviewer surfaced a HIGH finding — the gate signal.
function hasHighFinding(reviews: StoredReview[]): boolean {
  return reviews.some(
    (r) =>
      r.terminalState === 'reviewed' &&
      r.findings.some((f) => f.severity === 'high')
  );
}

// The per-reviewer one-line tally for the gate-friendly summary, e.g. `codex 1H/2M`,
// `grok 2H`, `codex clean`, `grok failed`.
function reviewerTally(r: StoredReview): string {
  const id = r.reviewerId ?? r.reviewer.vendor;
  if (r.terminalState !== 'reviewed') return `${id} failed`;
  const counts: Record<Severity, number> = { high: 0, low: 0, medium: 0 };
  for (const f of r.findings) counts[f.severity]++;
  const parts = SEVERITY_ORDER.filter((s) => counts[s] > 0).map(
    (s) => `${counts[s]}${SEVERITY_LABEL[s][0]}`
  );
  return `${id} ${parts.length ? parts.join('/') : 'clean'}`;
}

// `codex 1H/2M · grok 2H · receipt sha256:abc…` — one line a gate/log can grep.
function oneLineSummary(result: ReviewModeResult): string {
  const tallies = result.reviews.map(reviewerTally).join(' · ');
  const receipt = result.receipt
    ? `receipt ${result.receipt.diffDigest.slice(0, 19)}…`
    : 'receipt none';
  return `${tallies} · ${receipt}`;
}

// One finding line: `file:line  title`, with a `[class]` security-class tag prepended
// in the security profile (the reviewer's own leading [tag] is stripped to avoid
// duplication, then re-rendered from the canonical class).
function findingLine(
  f: StoredReview['findings'][number],
  profile: ReviewProfile
): string {
  const ref = evidenceRef(f.evidence.file, f.evidence.line, clean);
  if (profile === 'security') {
    const cls = classifySecurityFinding(f);
    return `       [${cls}] ${ref}  ${clean(stripSecurityTag(f.title))}`;
  }
  return `       ${ref}  ${clean(f.title)}`;
}

// Per-reviewer findings grouped by severity (HIGH → MED → LOW), each line carrying
// its file:line evidence so a finding is actionable straight from stdout.
function reviewerBlock(r: StoredReview, profile: ReviewProfile): string[] {
  const id = r.reviewerId ?? r.reviewer.vendor;
  const out: string[] = [];
  out.push('');
  out.push(
    `  ── ${id} [${r.reviewer.vendor} · ${r.reviewer.model}] — ${r.terminalState} ──`
  );
  if (r.terminalState !== 'reviewed') {
    out.push(`     ${clean(r.summary).slice(0, 200)}`);
    return out;
  }
  if (r.findings.length === 0) {
    out.push('     no findings');
    return out;
  }
  for (const sev of SEVERITY_ORDER) {
    const group = r.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    out.push(`     ${SEVERITY_LABEL[sev]}`);
    for (const f of group) out.push(findingLine(f, profile));
  }
  return out;
}

// The local dependency-surface block (security profile only): manifest changes +
// risky imports drawn straight from the diff. Surfaced even when empty so a reader
// sees the check ran and found nothing.
function depSurfaceBlock(d: DepSurfaceResult): string[] {
  const out: string[] = ['  dependency surface:'];
  if (d.manifests.length === 0 && d.riskyImports.length === 0) {
    out.push('     none — no manifest changes or risky imports in the diff');
    return out;
  }
  for (const m of d.manifests) {
    const kind = m.isLockfile ? 'lockfile' : 'manifest';
    out.push(`     ${kind} ${m.label}: ${clean(m.path)} (+${m.added} line(s))`);
    for (const s of m.samples) out.push(`         + ${clean(s).slice(0, 100)}`);
  }
  for (const r of d.riskyImports) {
    out.push(`     risky [${r.cls}] ${r.label} — ${evidenceRef(r.path, r.line, clean)}`);
  }
  return out;
}

function printSummary(result: ReviewModeResult, profile: ReviewProfile): void {
  const a = result.acquired;
  const out: string[] = [];
  out.push('');
  out.push(`ensemble-ai ${profile === 'security' ? 'security' : 'review'} — ${a.mode} mode`);
  if (a.repoId) out.push(`  repo:    ${a.repoId}`);
  if (a.baseRef) out.push(`  base:    ${a.baseRef} (${a.baseSha ?? '?'})`);
  out.push(`  head:    ${a.headSha}`);
  out.push(`  digest:  ${a.canonicalDigest}`);
  out.push(`  files:   ${coverageCounts(a.coverage)}`);
  for (const f of a.coverage.files.filter((x) => !x.included)) {
    out.push(`             ${omittedLine({ kind: f.kind, path: f.path, reason: f.omitReason })}`);
  }
  if (result.conventionManifest && result.conventionManifest.files.length > 0) {
    out.push(...renderConventionManifest(result.conventionManifest));
  }
  const ss = result.secretScan;
  if (ss.sensitivePaths.length || ss.inlineSecrets.length) {
    out.push(
      `  secrets: ${ss.sensitivePaths.length} sensitive path(s), ${ss.inlineSecrets.length} inline${ss.overridden ? ' (overridden)' : ''}`
    );
  }
  if (result.depSurface) out.push(...depSurfaceBlock(result.depSurface));
  if (result.blocked) {
    out.push(`  BLOCKED: ${result.blockedReason}`);
    console.error(out.join('\n'));
    return;
  }
  for (const r of result.reviews) out.push(...reviewerBlock(r, profile));
  out.push('');
  if (result.receipt) {
    out.push(`  receipt: ${result.receiptPath}`);
    const peers = result.receipt.peerReviewers ?? [];
    const peerNote = peers.length
      ? ` · peers: ${peers.map((p) => `${p.id} ${p.state}`).join(', ')}`
      : '';
    out.push(
      `           completed: ${result.receipt.completed.join(', ')} · vendors: ${result.receipt.vendors.join(', ')}${peerNote}`
    );
  } else {
    out.push(`  receipt: none — ${result.receiptError ?? 'not qualified'}`);
  }
  out.push('');
  out.push(`  ${oneLineSummary(result)}`);
  out.push('');
  console.log(out.join('\n'));
}

// A bare positional GitHub PR URL is sugar for `--pr <url>` — so a PR can be reviewed
// with just `ensemble-ai review <url>` from any dir. Route ONLY a URL (something with a
// URL scheme); a bare number stays ambiguous with a path and is refused. Enforce it
// doesn't collide with an explicit --pr or a second positional. Returns the effective
// `--pr` source string (which selectDiffSource then validates), or a usage error.
function resolvePositionalPr(
  positionals: string[],
  prFlag: string | undefined,
  cmd: string
): { error: string } | { pr: string | undefined } {
  if (positionals.length === 0) return { pr: prFlag };
  if (positionals.length > 1) {
    return {
      error: `too many arguments (expected at most one GitHub PR URL): ${positionals.join(' ')}`,
    };
  }
  const arg = positionals[0].trim();
  if (!/^https?:\/\//i.test(arg)) {
    return {
      error: `unexpected argument "${arg}" — a positional accepts only a GitHub PR URL (https://github.com/<owner>/<repo>/pull/<N>); use \`${cmd} --pr <N>\` for a PR number`,
    };
  }
  if (prFlag !== undefined) {
    // "URL", not "PR URL": at this point arg has only passed the scheme check; whether
    // it's a *valid* PR URL is decided later in parsePrUrl. Two sources is the error here.
    return { error: 'choose at most ONE diff source — got a positional URL AND --pr' };
  }
  return { pr: arg };
}

// The ONE diff-source resolution shared by `review`, `security`, and `diff`: fold a
// bare positional PR URL into `--pr`, assemble the source flags, gate stdin, run the
// PURE selector, then perform the git/gh I/O the chosen source needs. Returns the
// engine inputs, or an exit code (3) already reported to stderr. Kept in one place so
// the three commands can't drift on what "the diff under review" means.
function resolveDiffSourceForCommand(
  values: Record<string, string | boolean | undefined>,
  positionals: string[],
  cmd: string,
  cwd: string
):
  | { code: number }
  | (Exclude<ReturnType<typeof resolveSource>, { code: number }> & {
      // The PR a `--post-comment` would post to (from the SAME selection the review runs over),
      // or null for a non-PR source. Computed here so the review command can refuse `--post-comment`
      // upfront without re-deriving the selection.
      postTarget: PostTarget | null;
    }) {
  // A bare positional PR URL (`<cmd> <url>`) is sugar for `--pr <url>`.
  const positionalPr = resolvePositionalPr(
    positionals,
    typeof values.pr === 'string' ? values.pr : undefined,
    cmd
  );
  if ('error' in positionalPr) {
    console.error(`ensemble-ai ${cmd}: ${positionalPr.error}`);
    return { code: 3 };
  }

  // At most one explicit flag (--pr/--staged/--working-tree/--diff-file), else a piped
  // diff, else the default current-branch range.
  const sourceFlags = {
    diffFile: typeof values['diff-file'] === 'string' ? values['diff-file'] : undefined,
    pr: positionalPr.pr,
    staged: Boolean(values.staged),
    workingTree: Boolean(values['working-tree']),
  };
  // Only consume stdin when NO explicit source is set — otherwise a CI shell that
  // leaves stdin attached to a pipe would BLOCK reading input the run never uses.
  const stdinContent = hasExplicitSource(sourceFlags) ? undefined : readStdinIfPiped();
  const selection = selectDiffSource({ ...sourceFlags, stdinPiped: stdinContent !== undefined });
  if (isDiffSourceError(selection)) {
    console.error(`ensemble-ai ${cmd}: ${selection.error}`);
    return { code: 3 };
  }
  const resolved = resolveSource(selection, cwd, stdinContent, cmd);
  if ('code' in resolved) return resolved;
  return { ...resolved, postTarget: postTargetFromSelection(selection) };
}

// THE ONE `gh` exec seam — shared by `--post-comment`, `--stage`, and `push-fence`: run
// `gh <args>` with an optional body on stdin. Injectable at the call sites' boundary (stageReview
// takes a GhRunner, postReviewComment a PostRunner) so every state machine over it is unit-tested
// without spawning gh. gh absent (ENOENT), unauthenticated, or a failed call all RETURN
// {ok:false} with a clear message — no caller throws. The stderr excerpt is bounded so a huge gh
// error can't become a multi-MB warning line.
function ghRunner(cwd: string): GhRunner {
  return (args, input) => {
    try {
      const text = execFileSync('gh', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
        ...(input !== undefined ? { input } : {}),
      });
      return { ok: true, text };
    } catch (e) {
      const err = e as { code?: string; message?: string; stderr?: Buffer | string };
      if (err.code === 'ENOENT') {
        return { error: 'the `gh` CLI is not on PATH — install GitHub CLI and run `gh auth login`', ok: false };
      }
      const stderr = err.stderr ? String(err.stderr).trim().slice(0, 500) : '';
      return { error: stderr || err.message || 'gh failed', ok: false };
    }
  };
}

// `--post-comment`'s exec: `gh pr comment … --body-file -` with the rendered comment on gh's
// stdin. Only the SUCCESS mapping differs from the seam above — gh prints the created comment's
// URL, which the confirmation line surfaces. postReviewComment turns a failure into a loud warning
// and never throws, so posting can never change the review's exit code.
function ghPostRunner(cwd: string): PostRunner {
  const gh = ghRunner(cwd);
  return (args, body) => {
    const res = gh(args, body);
    if (!res.ok) return res;
    const url = res.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    return url && /^https?:\/\//.test(url) ? { ok: true, url } : { ok: true };
  };
}

// The cwd repo's `owner/repo`, resolved the way `gh` itself would. `''` ⇒ not a GitHub repo, or gh
// failed; every caller treats that as "could not resolve" and refuses.
function repoSlugFromCwd(gh: GhRunner): string {
  const res = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  return res.ok ? res.text.trim() : '';
}

// GitHub's own vocabulary for an owner login / repo name. `owner` and `repo` are interpolated into
// a `gh api repos/<owner>/<repo>/…` path, so a segment like `..` would traverse to a different
// endpoint. Validated here rather than trusted from a pasted URL.
const REPO_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A staged review addresses the GitHub API by `owner/repo`, which a bare `--pr <N>` does not carry
// (it targets the cwd's repo). Null ⇒ report and refuse.
function resolveStageTarget(target: PostTarget, gh: GhRunner): StageTarget | null {
  const parts = (target.repoSlug ?? repoSlugFromCwd(gh)).split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  return REPO_SEGMENT_RE.test(owner) && REPO_SEGMENT_RE.test(repo) ? { owner, pr: target.pr, repo } : null;
}

// GateSeat → the footer's resolved seat: model/effort with the 'default' sentinel spelled out
// (a resolved-but-'default' model is the built-in Opus), plus the per-field source for provenance.
function toCommentGateSeat(seat: GateSeat): CommentGateSeat {
  // Reuse the reviewer layer's model-label rule (resolve to the configured model, else the
  // built-in `opus`) so the footer's seat model can't drift from the reviewer's own label.
  const model = claudeModelLabel(seat.config);
  const effort =
    seat.config.effort && seat.config.effort !== 'default' ? seat.config.effort : 'default';
  return { effort, effortSource: seat.effortSource, model, modelSource: seat.modelSource };
}

// The review's earned exit code, factored out of reviewCommand so `--post-comment` can be GATED
// on it and provably cannot change it. Owns the FULL precedence 2 > 1 > 4 > 0 — including
// `blocked` → 2 — so it returns the right code for ANY result and can't be mis-ordered by a
// caller. Emits the reviewer-incomplete stderr line (exit 1) as a side effect, verbatim from the
// inlined logic it replaced — the gate contract is unchanged.
function reviewExitCode(opts: {
  claudeLayer: ClaudeLayerResult | null;
  claudeLayerCrashed: boolean;
  claudeLayerExpected: boolean;
  cmd: string;
  highGate: ReturnType<typeof resolveHighGate>;
  noFailOnHigh: boolean;
  result: ReviewModeResult;
}): number {
  const {
    claudeLayer,
    claudeLayerCrashed,
    claudeLayerExpected,
    cmd,
    highGate,
    noFailOnHigh,
    result,
  } = opts;
  // 2 = the diff was secret-scan BLOCKED — a hard stop; no trustworthy review ran, so it
  // outranks everything below.
  if (result.blocked) return 2;
  // 1 = a reviewer failed to complete (crash / timeout / no parse) — the review is
  // not trustworthy, so this outranks the findings gate below.
  const allReviewed =
    result.reviews.length > 0 &&
    result.reviews.every((r) => r.terminalState === 'reviewed');
  if (!allReviewed) return 1;
  // The cold Opus (claude) reviewer is DEFAULT-ON — a THIRD reviewer, not an optional
  // extra. If it was in the roster but did NOT complete, the review is INCOMPLETE.
  // `--no-fail-on-high` does NOT suppress this — it only gates HIGH findings.
  if (claudeLayerExpected) {
    const claudeReviewed = claudeLayer?.claudeReview?.ok === true;
    if (!claudeReviewed) {
      const why = claudeLayer?.claudeReview
        ? clean(claudeLayer.claudeReview.summary).slice(0, 200)
        : claudeLayerCrashed
          ? 'the Opus review layer crashed'
          : 'the Opus review layer did not run to completion';
      console.error(
        `ensemble-ai ${cmd}: reviewer claude failed (${why}) — review INCOMPLETE: the codex/grok core completed, the Opus reviewer did not, so this is NOT a full 3-reviewer pass`
      );
      return 1;
    }
  }
  // 4 = the findings GATE: a completed review surfaced a HIGH — from ANY of the three reviewers
  // (codex + grok + the cold Opus voice). The gate's DISMISS-ONLY authority may drop a HIGH ONLY
  // when it is a citation-validated `false` under ACTIVE authority AND the trail durably wrote.
  // Fail-closed by IDENTITY, not count (see the detectedHighIds reconstruction below).
  if (
    !noFailOnHigh &&
    (hasHighFinding(result.reviews) || claudeLayerHasHigh(claudeLayer))
  ) {
    const detectedHighIds: string[] = [];
    for (const r of result.reviews) {
      if (r.terminalState !== 'reviewed') continue;
      const voiceId = r.reviewerId ?? r.reviewer.vendor;
      r.findings.forEach((f, i) => {
        if (f.severity === 'high') detectedHighIds.push(`${voiceId}#${i + 1}`);
      });
    }
    if (claudeLayer?.claudeReview?.ok) {
      claudeLayer.claudeReview.findings.forEach((f, i) => {
        if (f.severity === 'high') detectedHighIds.push(`claude#${i + 1}`);
      });
    }
    const honoredDismissed = new Set(highGate.dismissedHighIds);
    const allHighsDismissed =
      detectedHighIds.length > 0 &&
      highGate.gatingHighIds.length === 0 &&
      detectedHighIds.every((id) => honoredDismissed.has(id));
    if (!allHighsDismissed) return 4;
  }
  return 0;
}

// Shared by `review` (profile 'code') and `security` (profile 'security'): both run
// the SAME engine + diff-source resolution + exit-code contract; the profile only
// swaps the reviewer framing, adds the dependency-surface flag, and labels the usage.
async function reviewCommand(
  args: string[],
  profile: ReviewProfile = 'code'
): Promise<number> {
  const usage = profile === 'security' ? SECURITY_USAGE : REVIEW_USAGE;
  const cmd = profile === 'security' ? 'security' : 'review';
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        'allow-sensitive': { type: 'boolean' },
        base: { type: 'string' },
        ceiling: { type: 'string' },
        'claude-effort': { type: 'string' },
        'claude-model': { type: 'string' },
        conventions: { type: 'string' },
        cwd: { type: 'string' },
        'diff-file': { type: 'string' },
        'gate-dismissals': { type: 'boolean' },
        'gate-effort': { type: 'string' },
        'gate-model': { type: 'string' },
        help: { short: 'h', type: 'boolean' },
        holistic: { type: 'boolean' },
        'no-claude': { type: 'boolean' },
        'no-conventions': { type: 'boolean' },
        'no-fail-on-high': { type: 'boolean' },
        out: { type: 'string' },
        'post-comment': { type: 'boolean' },
        pr: { type: 'string' },
        repo: { type: 'string' },
        reviewers: { type: 'string' },
        'run-id': { type: 'string' },
        sandbox: { type: 'string' },
        stage: { type: 'boolean' },
        staged: { type: 'boolean' },
        'strict-high': { type: 'boolean' },
        'working-tree': { type: 'boolean' },
      },
    }));
  } catch (e) {
    console.error(`ensemble-ai ${cmd}: ${(e as Error).message}`);
    console.error(usage);
    return 3;
  }
  if (values.help) {
    console.log(usage);
    return 0;
  }

  const cwd = values.cwd ? path.resolve(String(values.cwd)) : process.cwd();

  const source = resolveDiffSourceForCommand(values, positionals, cmd, cwd);
  if ('code' in source) return source.code;

  // `--post-comment` / `--stage` are OPT-IN and PR-ONLY (publishing to GitHub is the review verb's
  // one outward action). Refuse UPFRONT — before running a full review — when the source has no PR
  // to post to, rather than reviewing for minutes and only then failing to post.
  const postComment = Boolean(values['post-comment']);
  const stage = Boolean(values.stage);
  for (const [flag, on] of [['--post-comment', postComment], ['--stage', stage]] as const) {
    if (on && !source.postTarget) {
      console.error(
        `ensemble-ai ${cmd}: ${flag} requires a PR diff source (--pr <N> or a PR URL) — ` +
          `the current source has no PR to post to. Re-run against a PR, or drop ${flag}.`
      );
      return 3;
    }
  }
  // `--stage` binds a review to a COMMIT. The pending review's `commit_id` and every inline line
  // anchor are only meaningful at the head SHA the diff was read at, and `stageReview`'s freshness
  // guard compares that SHA against the PR's live head. A bare `--pr <N>` fetches the diff with
  // `gh pr diff`, which carries NO commit identity — `acquireDiff` honestly labels its headSha
  // `gh pr diff (no local commit identity)` rather than inventing one, because re-reading the head
  // afterwards would be a TOCTOU (the head can move between the two calls). A PR URL binds the SHA
  // via the compare API; if that lookup fails it degrades to the same unbound fetch.
  //
  // Staging an unbound review would compare a label against a SHA and refuse with a fabricated "the
  // head moved" story — after reviewing for minutes. Refuse UPFRONT, and say what to do instead.
  if (stage && !source.headShaOverride) {
    console.error(
      `ensemble-ai ${cmd}: --stage needs a review bound to a commit, and this source has none — ` +
        '`gh pr diff` reports no head SHA, so there is nothing to anchor the inline comments to or ' +
        'to check the PR head against. Re-run with the full PR URL (`--pr https://github.com/o/r/pull/N`), ' +
        'which binds the diff to the exact head SHA via the compare API.'
    );
    return 3;
  }
  // The two outward actions are contradictory: `--post-comment` publishes immediately under the
  // user's account, `--stage` deliberately publishes NOTHING until they submit. Doing both would
  // silently defeat the staged review's whole point (posting authority).
  if (postComment && stage) {
    console.error(
      `ensemble-ai ${cmd}: choose ONE outward action — --stage stages a PENDING review that posts ` +
        'nothing until you submit it on GitHub, while --post-comment publishes a comment immediately.'
    );
    return 3;
  }
  // `--repo` = WORKTREE EVIDENCE MODE (spec §1). It materializes the PR head as a detached,
  // read-only worktree of a repo the user already has cloned, and hands it to every seat whose
  // sandbox qualifies. Two things are structurally required and neither can be invented:
  //   · the PR's `owner/repo` — the pre-flight PROVES the local checkout is that repo before any
  //     fetch, by comparing its remotes' fetch URLs (a bare `--pr <N>` carries no slug);
  //   · the head + base SHAs — materialization asserts `HEAD == headSha` before a seat runs, and
  //     the seats are told the exact `git diff <base>...<head>` range under review.
  // Both come from the compare API, which only a full PR URL reaches. Refuse UPFRONT otherwise,
  // rather than reviewing the packet while the caller believes they asked for whole-project
  // evidence — the exact silent downgrade the realized-evidence map exists to prevent.
  const repoFlag = typeof values.repo === 'string' ? values.repo : null;
  if (repoFlag && !(source.postTarget?.repoSlug && source.headShaOverride && source.prBaseSha)) {
    console.error(
      `ensemble-ai ${cmd}: --repo (worktree evidence mode) needs a PR bound to a commit — ` +
        're-run with the full PR URL (`--pr https://github.com/<owner>/<repo>/pull/<N>`), which ' +
        'carries the base repo to verify your checkout against and binds the base+head SHAs via ' +
        'the compare API. A bare `--pr <N>` or a local/raw diff source has neither, so there is ' +
        'nothing to fetch, nothing to assert HEAD against, and no repo identity to check.'
    );
    return 3;
  }

  // ONE worktree per run, opened here and reaped in the `finally` below — plus a `git worktree
  // prune` sweeper inside the reap, which self-heals the crash/SIGTERM path on the next run
  // (spec §9, grok-f1). Every failure is a NAMED cause, never a generic "git failed".
  let worktree: WorktreeSession | null = null;
  if (repoFlag && source.postTarget && source.headShaOverride && source.prBaseSha) {
    console.error(`· materializing the PR head as a read-only worktree of ${repoFlag}…`);
    const opened = openWorktree({
      baseSha: source.prBaseSha,
      headSha: source.headShaOverride,
      pr: source.postTarget.pr,
      prSlug: source.postTarget.repoSlug as string,
      repoPath: repoFlag,
    });
    if (isPreflightError(opened)) {
      console.error(`ensemble-ai ${cmd}: --repo pre-flight failed [${opened.kind}] — ${opened.message}`);
      return 3;
    }
    worktree = opened;
  }

  try {
    return await runReviewPipeline({ cmd, cwd, postComment, profile, source, stage, values, worktree });
  } finally {
    worktree?.reap();
  }
}

// The diff source, already resolved + validated by reviewCommand.
type ResolvedSource = Exclude<
  ReturnType<typeof resolveDiffSourceForCommand>,
  { code: number }
>;

interface ReviewPipelineInput {
  cmd: string;
  cwd: string;
  postComment: boolean;
  profile: ReviewProfile;
  source: ResolvedSource;
  stage: boolean;
  values: Record<string, string | boolean | undefined>;
  // The run's worktree evidence, or null for a packet-mode review. BORROWED here: the caller owns
  // its lifetime, so nothing below may reap it.
  worktree: WorktreeSession | null;
}

// The review itself — everything after the source + worktree are settled. Factored out of
// reviewCommand so the worktree's `finally` reap wraps EVERY exit path of the pipeline, including
// an early usage return and an unexpected throw.
async function runReviewPipeline(input: ReviewPipelineInput): Promise<number> {
  const { cmd, cwd, postComment, profile, source, stage, values, worktree } = input;

  // Convention gathering: the reviewers see the repo's real md web (root + touched
  // packages + linked/swept docs). Off with --no-conventions; a fs reader for local
  // sources, a gh reader (PR head) for a `--pr <url>`.
  const noConventions = Boolean(values['no-conventions']);
  const conventionPaths = parseConventionPaths(values.conventions);
  // A URL PR whose head SHA couldn't be resolved must NOT borrow the LOCAL cwd's
  // conventions — that's a different repo. Gather NOTHING (with a note) instead.
  if (source.noLocalConventions && !noConventions) {
    console.error(
      "· conventions: skipped — a URL PR's head SHA was unresolvable, so its conventions can't be fetched and the local repo's belong to a DIFFERENT repo"
    );
  }
  const conventionReader =
    noConventions || source.noLocalConventions
      ? null
      : buildConventionReader(cwd, source.conventionsCtx);

  // Resolve the roster: the cross-vendor CORE (codex/grok — subset with `--reviewers`,
  // fail-closed on a typo) + whether the cold Opus (claude) reviewer + synthesis run
  // (DEFAULT-ON; `--no-claude` opts out). `claude` is a valid `--reviewers` id. "no
  // --reviewers" → the full default core; a typo can never silently narrow the policy
  // (which would also mint a receipt under a weaker policy). Fail closed.
  const noClaude = Boolean(values['no-claude']);
  // resolveReviewRoster owns the single trim/filter/dedup of these tokens (and the
  // fail-closed unknown-id check), so pass the raw split — don't normalize twice.
  const requestedReviewers =
    typeof values.reviewers === 'string'
      ? values.reviewers.split(',')
      : undefined;
  const roster = resolveReviewRoster(requestedReviewers, noClaude);
  if ('error' in roster) {
    console.error(`ensemble-ai ${cmd}: --reviewers "${values.reviewers}" — ${roster.error}`);
    return 3;
  }
  // Preserve the "no --reviewers → undefined → engine runs ALL configured core" contract;
  // an explicit list threads the resolved core subset.
  const reviewers: ReviewerId[] | undefined =
    requestedReviewers === undefined ? undefined : roster.core;
  const runId = typeof values['run-id'] === 'string' ? values['run-id'] : genRunId();
  // The trail BASE dir. `--out` overrides; otherwise repo-local when reviewing the cwd
  // repo's OWN diff, else a temp dir (resolveTrailBase — the diff-source-keyed fence).
  // reviewDir appends the PATH-SANITIZED runId to get the actual per-run trail dir; it is
  // computed ONCE here so the packet writes (persistReview), the conventions manifest, the
  // pinned-input path, and the printed trail path all agree — and so `out` never itself
  // carries the runId, which is what double-nested `<runId>/<runId>` before.
  const out =
    typeof values.out === 'string'
      ? path.resolve(values.out)
      : resolveTrailBase(gitToplevel(cwd), source.localRepoTrail ?? false);
  const trailDir = reviewDir(out, runId);
  // Scope this run's trail to THIS run. If the run dir already exists — an explicitly
  // REUSED `--run-id` — clear it first, so STALE review files from a prior run with the
  // same id can't be read back into the synthesis (loadVoiceReviewsFromTrail reads
  // whatever `review.<id>.json` is on disk, blind to which run wrote it). A fresh /
  // auto-generated run id has no dir to clear. This is a RECURSIVE delete of a path that
  // carries user-influenced input (`--run-id`), so it is fenced hard — see clearReusedRunTrail.
  clearReusedRunTrail(out, trailDir);
  const ceiling = positiveCeiling(
    typeof values.ceiling === 'string' ? values.ceiling : undefined,
    cmd
  );
  if (typeof ceiling === 'object') return ceiling.code;
  const ceilingBytes = ceiling;

  // The Anthropic seats this command runs AFTER the core: the `claude` producer (default-on) and
  // the `gate`. They are part of the run's evidence INTENT — the gate is an evidence-bearing actor
  // (pin 1), not a neutral judge — so runReviewMode hashes them into the receipt's policy identity
  // even though it never spawns them. `--no-claude` runs neither.
  const peerSeats: EvidenceSeat[] = roster.claude ? [...HARNESS_SEATS] : [];

  let result: ReviewModeResult;
  try {
    result = await runReviewMode({
      allowSensitive: Boolean(values['allow-sensitive']),
      base: typeof values.base === 'string' ? values.base : undefined,
      ceilingBytes,
      conventionPaths,
      conventionReader,
      cwd,
      diffMode: source.diffMode,
      diffText: source.diffText,
      headShaOverride: source.headShaOverride,
      noConventions,
      onProgress: (m) => console.error(`· ${m}`),
      out,
      peerSeats,
      profile,
      reviewers,
      runId,
      sandbox: typeof values.sandbox === 'string' ? values.sandbox : undefined,
      staged: source.staged,
      workingTree: source.workingTree,
      ...(worktree
        ? { worktree: { baseSha: worktree.baseSha, dir: worktree.dir, headSha: worktree.headSha } }
        : {}),
    });
  } catch (e) {
    console.error(`ensemble-ai ${cmd}: ${(e as Error).message}`);
    return 3;
  }

  // The gathered-conventions manifest joins the trail so the receipt's evidence dir
  // records which convention files the reviewers saw (best-effort — never fatal). Written
  // through the hardened trail writer (realpath'd dir + O_NOFOLLOW tmp + atomic rename) so
  // a symlinked trail path can't redirect the write out of the trail dir — never a raw
  // writeFileSync that would follow a pre-planted symlink at the target.
  if (result.conventionManifest) {
    try {
      writeTrailFile(
        out,
        runId,
        'conventions.json',
        JSON.stringify(result.conventionManifest, null, 2)
      );
    } catch {
      /* trail write is best-effort */
    }
  }

  // The SELF-CONTAINED layer: a cold Opus (claude) peer reviewer over the SAME pinned
  // packet + a claude SYNTHESIS pass that reads all three reviewers' trail files. DEFAULT-ON
  // (roster.claude; `--no-claude` opts out). Skipped when the diff was blocked or no packet
  // built (result.prompt absent). REVIEW-ONLY — writes only to the trail. Best-effort: any
  // failure degrades (deterministic fallback), never taking down the review. The Opus
  // reviewer IS a reviewer, so its HIGH findings feed the SAME exit gate below.
  //
  // It is COMPUTED here (before printSummary) but RENDERED after, so the receipt below can
  // reflect the FULL expected roster: the receipt is written only once the Opus reviewer
  // is known to have completed — an incomplete 3-reviewer run must never leave a clean
  // receipt (the codex-review fail-open).
  let claudeLayer: ClaudeLayerResult | null = null;
  let claudeLayerCrashed = false;
  // Hoisted so the `--post-comment` footer can render the resolved gate seat; assigned inside the
  // layer block (the only place the gate runs). Null under `--no-claude`/blocked (no gate ran).
  let gateSeat: GateSeat | null = null;
  // The Opus layer runs iff claude is in the roster, the diff wasn't blocked, and a packet
  // was built. The exit gate below reuses this EXACT condition — a claude that was expected
  // to review but didn't must fail-loud; a claude legitimately not-run (blocked / no packet)
  // has nothing to gate.
  const claudeLayerExpected = roster.claude && !result.blocked && Boolean(result.prompt);
  if (claudeLayerExpected && result.prompt) {
    // The claude REVIEWER seat resolves like the gate below: `--claude-model`/`--claude-effort`
    // → the voices.json `claude` entry → the built-in opus @ max. gate-seat.ts owns the chain
    // and the WHY: a headless seat must never inherit the interactive CLI's saved default (the
    // 2026-07-23 fire inherited a fresh `/model` switch to Fable 5 and the leg died on its cap).
    const claudeSeat = loadClaudeReviewerSeat(
      VOICES_FILE,
      {
        effort: typeof values['claude-effort'] === 'string' ? values['claude-effort'] : undefined,
        model: typeof values['claude-model'] === 'string' ? values['claude-model'] : undefined,
      },
      (m) => console.error(`· ${m}`)
    );
    // The GATE (synthesis) seat resolves INDEPENDENTLY of the `claude` reviewer voice: the
    // voices.json `gate` entry → the `claude` entry (model/effort only) → the built-in Opus
    // default, with `--gate-model`/`--gate-effort` overriding the file. A `cmd` on the gate seat
    // is ignored (the gate is always a read-only `claude -p` spawn); a junk entry warns + falls
    // back. Warnings surface on stderr so a mis-config is loud, never silent.
    gateSeat = loadGateSeat(
      VOICES_FILE,
      {
        effort: typeof values['gate-effort'] === 'string' ? values['gate-effort'] : undefined,
        model: typeof values['gate-model'] === 'string' ? values['gate-model'] : undefined,
      },
      (m) => console.error(`· ${m}`)
    );
    // THE HISTORY PACKET (modes/review/history-packet.ts). The capability fence removed Bash from
    // the Anthropic seats, which took away the `git log`/`git blame` a reviewer genuinely uses. The
    // ENGINE runs those commands instead and seeds each fenced seat's own cwd with the answers as
    // read-only data — restoring the acceptance principle (per seat, engine context >= the manual
    // in-project baseline; the only permitted difference is the sandbox). Worktree runs only: a
    // packet-mode seat has no repo to read a history out of. Best-effort — a git failure costs a
    // file and a line in the packet's README, never the review.
    let historyPacket: HistoryPacket | undefined;
    if (worktree && result.pinnedDiff) {
      const { capBytes, logCommits } = historyPacketConfig(readEnsembleConfig());
      try {
        historyPacket = buildHistoryPacket({
          baseSha: worktree.baseSha,
          capBytes,
          diff: result.pinnedDiff,
          git: execGit(),
          headSha: worktree.headSha,
          logCommits,
          strippedInstructionFiles: worktree.strippedInstructionFiles,
          worktree: worktree.dir,
        });
        console.error(
          historyPacket.shallow
            ? '· history packet: SKIPPED — this checkout is a shallow clone, so its `git log`/`git blame` would be a misleading fragment; the seats are told nothing about a history they do not have'
            : `· history packet: ${historyPacket.files.length - 1} file(s), ${historyPacket.bytes} bytes${historyPacket.truncated ? ' (truncated to the cap)' : ''}`
        );
      } catch (e) {
        console.error(
          `· history packet: could not be built (${(e as Error).message}) — the Anthropic seats review without it`
        );
      }
    }

    // The PR's base SHA when the compare API bound it (a URL PR), else the local diff's. It is
    // the range the worktree seats + the lens are told the change spans — never a receipt field.
    const layerBaseSha = source.prBaseSha ?? result.acquired.baseSha;

    // The layer's own writes/spawn are best-effort internally, but a residual throw (an
    // unexpected FS/spawn error) must DEGRADE the Opus layer, not crash the whole review
    // after the codex/grok core already completed. Catch it here as a backstop; the
    // incompleteness is then reflected in the receipt gate + exit gate below (fail-loud).
    try {
      claudeLayer = await runClaudeReviewLayer({
        baseDir: out,
        baseSha: layerBaseSha,
        claudeConfig: claudeSeat.config,
        // The conventions this run actually gathered — the docs a holistic finding may cite to
        // lift its MED severity cap (the gate re-reads the citation out of the tree regardless).
        conventionPaths: result.conventionManifest?.files.filter((f) => f.included).map((f) => f.path),
        gateConfig: gateSeat.config,
        coreReviews: result.reviews,
        expectedHeadSha: result.acquired.headSha,
        // The `git log`/`git blame` the fence took away, restored as data in each fenced seat's own
        // cwd. Absent on a packet-mode run, and `bytes: 0` on a shallow clone (README only).
        ...(historyPacket ? { historyPacket } : {}),
        // The HOLISTIC lens (spec §4) — off unless asked for, and it runs ONLY with worktree
        // evidence: `--holistic` without `--repo` is a LOUD skip, never a packet-evidence
        // architecture claim (resolveHolisticPlan owns that ruling).
        ...(values.holistic
          ? {
              holistic: {
                baseSha: layerBaseSha,
                config: loadHolisticSeat(VOICES_FILE, (m) => console.error(`· ${m}`)),
              },
            }
          : {}),
        includeClaudeReviewer: true,
        log: (m) => console.error(`· ${m}`),
        // The pinned reviewer-visible diff. Under the capability fence the Anthropic seats have no
        // Bash, so `/code-review` and the lens are HANDED the change instead of deriving it.
        pinnedDiff: result.pinnedDiff,
        // `security --repo` must NOT have its security-auditor prompt replaced by the
        // `/code-review` skill's structural-quality lens (codex-f3).
        profile,
        reviewPrompt: result.prompt,
        runId,
        // The Claude producer + the gate read the SAME worktree the core seats did (spec §3, §5).
        ...(worktree ? { worktree: worktree.dir } : {}),
      });
      try {
        writeTrailFile(out, runId, 'claude-synthesis.json', JSON.stringify(claudeLayer, null, 2));
      } catch {
        /* trail write is best-effort */
      }
    } catch (e) {
      claudeLayerCrashed = true;
      console.error(
        `ensemble-ai ${cmd}: the Opus (claude) review layer crashed — ${(e as Error).message}`
      );
    }
  }

  // Resolve the gate's DISMISS-ONLY exit authority for this run (Phase 2). ON by default for a
  // LOCAL diff (working-tree/--staged/branch — the trusted self-review case), STRICT for FOREIGN
  // provenance (--pr/URL/stdin/--diff-file) unless --gate-dismissals opts in; --strict-high forces
  // STRICT everywhere. `source.localRepoTrail` is the SAME provenance signal the trail-fence keys
  // off (#13). Computed here — before the receipt, the render, and the exit — so all three agree.
  // Pure + safe even when the gate did not run (--no-claude → no records → nothing to dismiss).
  const gateAuthorityInputs: GateAuthorityInputs = {
    gateDismissals: Boolean(values['gate-dismissals']),
    localProvenance: source.localRepoTrail === true,
    strictHigh: Boolean(values['strict-high']),
  };
  const authorityActive = gateAuthorityActive(gateAuthorityInputs);
  const gateRecords = claudeLayer?.gateVerdicts ?? [];
  const highGate = resolveHighGate(
    gateRecords,
    claudeLayer?.gateTrailWritten ?? false,
    authorityActive
  );

  // THE RUN'S REALIZED EVIDENCE (spec §8) — fact, not intent. The core seats' classes come back
  // from the engine (a seat whose sandbox did not qualify, or whose wrapper provably broke, fell
  // back to the packet). The Anthropic seats are harness-controlled: they read the worktree
  // whenever one exists and the seat actually spawned there. `realizedEvidence` is never hashed,
  // so folding the Anthropic seats in here cannot move the receipt key.
  //
  // NEITHER Anthropic seat is spawned unconditionally. The GATE is skipped when no healthy reviewer
  // gave it anything to judge, and its spawn can throw; the claude PRODUCER's spawn can throw too
  // (claude not installed, or a read root the capability fence refuses). A seat that never spawned
  // read NOTHING, so it must not be attested `worktree` — that is an evidence claim the posted
  // footer and the evidence manifest would then carry for a seat that never opened the tree. A seat
  // that DID spawn and then timed out or replied unusably could read the tree, so it is honest.
  // Typed `Record<HarnessSeat, …>`, so a harness seat added to HARNESS_SEATS stops compiling here
  // rather than silently vanishing from the footer, the manifest, and the receipt.
  const harnessRealized: Record<HarnessSeat, EvidenceClass> | null =
    worktree && claudeLayer
      ? {
          claude: claudeLayer.claudeSpawned ? 'worktree' : 'packet',
          gate: claudeLayer.gateSpawned ? 'worktree' : 'packet',
        }
      : null;
  const realizedEvidence: EvidenceMap = {
    ...(result.evidence?.realized ?? {}),
    ...(harnessRealized ?? {}),
  };
  // LOUD (§2, §9 grok-f2): every fallback was already printed as it happened; restate them
  // together so a reader of the summary cannot miss that this run reviewed less than it asked to.
  for (const reason of result.evidence?.fallbacks ?? []) {
    console.error(`⚠ evidence degraded — ${reason}`);
  }
  // The evidence manifest joins the TRAIL (advisory, never hashed): the tracked tree at headSha —
  // the readable SURFACE each worktree seat was given, not a record of what it read. Best-effort,
  // and it inherits the trail fence like every other artifact.
  if (worktree && result.evidence) {
    writeEvidenceManifest(
      out,
      runId,
      buildEvidenceManifest({
        headSha: worktree.headSha,
        intendedEvidence: result.evidence.intended,
        readableSurface: worktree.readableSurface(),
        realizedEvidence,
        sandboxProfiles: result.evidence.sandboxProfiles,
      })
    );
  }
  // The one honest evidence line for the posted review's footer (§8: any fallback surfaces in the
  // receipt AND the footer, never silently). Null in packet mode — nothing new to say.
  const evidenceNote = worktree
    ? formatEvidenceFooter(realizedEvidence, result.evidence?.egressDenials ?? [])
    : null;

  // Persist the receipt ONLY after the full expected roster ran (fail-loud parity with the
  // exit gate): the codex/grok core qualified a candidate, but when the default-on Opus
  // reviewer was EXPECTED it must ALSO have completed — else NO clean receipt is written
  // (a stale 'reviewed' receipt for an incomplete run is the fail-open). When it did
  // complete, the peer reviewer is STAMPED into the receipt so downstream can tell a full
  // N-reviewer pass from a codex/grok-only one.
  if (result.receiptCandidate && result.receiptStore) {
    const claudeReviewed = claudeLayer?.claudeReview?.ok === true;
    const rosterComplete = !claudeLayerExpected || claudeReviewed;
    if (rosterComplete) {
      const peerReviewers: PeerReviewerRecord[] = claudeLayer?.claudeReview
        ? [
            {
              id: 'claude',
              state: claudeLayer.claudeReview.ok ? 'reviewed' : 'failed-reviewer',
              vendor: `anthropic/${claudeLayer.modelLabel}`,
            },
          ]
        : [];
      // Attach the gate-disposition summary whenever the gate ran (claudeLayer present) — verdict
      // counts + honored dismissed HIGH ids + the trail-written marker. Additive: `receipt verify`
      // never reads it (verify semantics unchanged), it is recorded for legibility + retro-scoring.
      const receipt: DiffReviewReceipt = {
        ...result.receiptCandidate,
        ...(peerReviewers.length > 0 ? { peerReviewers } : {}),
        // Stamp the Anthropic seats' realized classes in beside the core's (a v2 receipt only —
        // a packet run's candidate carries no evidence maps at all, and must stay byte-identical
        // to a legacy one). Never hashed, so the receipt key is unchanged.
        ...(worktree ? { realizedEvidence } : {}),
        ...(claudeLayer
          ? {
              gateDisposition: gateDispositionSummary(
                gateRecords,
                highGate.dismissedHighIds,
                claudeLayer.gateTrailWritten
              ),
            }
          : {}),
      };
      try {
        result.receiptPath = writeReceipt(result.receiptStore, receipt);
        result.receipt = receipt;
      } catch (e) {
        result.receiptError = `receipt write failed — ${(e as Error).message}`;
      }
    } else {
      result.receiptError =
        'review INCOMPLETE — the default-on Opus (claude) reviewer was expected but did not complete, so no fully-reviewed receipt was minted';
    }
  }

  printSummary(result, profile);
  // The PINNED review input every reviewer saw — the rendered prompt, written to the
  // trail. It EMBEDS the exact diff under review + the gathered conventions + objective,
  // and is byte-identical across reviewers (one packet, rendered once per run — so the
  // first reviewer's copy is representative). Printed so a synthesizing session-Claude
  // (the /ensemble-ai-review skill) reviews THIS exact input, never a re-derived
  // working-tree diff that could drift from what Codex/Grok reviewed.
  // Emit the pinned path whenever a TRAIL exists (any reviewer persisted its prompt) —
  // not gated on a specific reviews[0] shape. The rendered prompt is byte-identical across
  // reviewers, so the first persisted reviewer's copy is representative. reviewerId is
  // always set by persistReview; the vendor is a defensive fallback.
  if (result.reviews.length > 0) {
    const first = result.reviews[0];
    const pinnedReviewerId = first.reviewerId ?? first.reviewer.vendor;
    console.log(
      `  review input (pinned — what every reviewer saw; read THIS, don't re-derive): ${path.join(trailDir, `prompt.${pinnedReviewerId}.md`)}`
    );
  }
  // Render the self-contained Opus layer (computed above) after the core summary.
  if (claudeLayer) {
    console.log(renderClaudeLayer(claudeLayer).join('\n'));
    // The exit-AUTHORITY block: the resolved mode + any HONORED-dismissed HIGHs rendered LOUDLY
    // (`HIGH (dismissed by gate — reason)`) + the HIGHs that still gate. Empty (unprinted) when
    // there are no HIGH findings at all.
    const highGateLines = renderHighGate(gateRecords, highGate, {
      authorityActive,
      authorityLabel: gateAuthorityLabel(gateAuthorityInputs),
      scrub: clean,
    });
    if (highGateLines.length > 0) console.log(highGateLines.join('\n'));
  }

  // On stdout (with the receipt + pinned-input paths) — the machine-readable trail
  // location, so the doc's "paths on stdout" is accurate.
  console.log(`trail: ${trailDir}`);

  // The review's earned exit code (full precedence 2 > 1 > 4 > 0, incl. blocked → 2 — owned by
  // reviewExitCode). Computed BEFORE the optional --post-comment so posting is GATED on it and
  // provably cannot change it (posting is a side effect of a completed review, never part of the
  // gate contract).
  const exitCode = reviewExitCode({
    claudeLayer,
    claudeLayerCrashed,
    claudeLayerExpected,
    cmd,
    highGate,
    noFailOnHigh: Boolean(values['no-fail-on-high']),
    result,
  });

  // `--post-comment`: ALSO post the rendered review to the PR. COMPLETED runs ONLY — exit 0
  // (clean) or 4 (a gating HIGH; still a finished review worth posting); never a reviewer-
  // incomplete (1) or secret-blocked (2) run. Posting NEVER changes exitCode: the WHOLE
  // render+post is wrapped so even a rendering throw (not just a gh failure, which
  // postReviewComment already swallows) degrades to a loud warning — we always return the SAME
  // code the review already earned + printed. `source.postTarget` is guaranteed non-null here (the
  // upfront refusal caught a non-PR source + --post-comment above).
  if (postComment && source.postTarget && (exitCode === 0 || exitCode === 4)) {
    try {
      const body = capComment(
        renderReviewComment({
          claudeLayer,
          evidenceNote,
          gateSeat: gateSeat ? toCommentGateSeat(gateSeat) : null,
          headSha: result.acquired.headSha,
          headline: oneLineSummary(result),
          profile,
          receipt: {
            completed: result.receipt?.completed ?? [],
            digest: result.receipt ? `${result.receipt.diffDigest.slice(0, 19)}…` : null,
            error: result.receiptError ?? null,
            path: result.receiptPath ?? null,
          },
          repoId: result.acquired.repoId,
          reviews: result.reviews,
          trailDir,
        }),
        trailDir
      );
      postReviewComment(body, source.postTarget, {
        cmd,
        log: (m) => console.error(m),
        run: ghPostRunner(cwd),
      });
    } catch (e) {
      console.error(
        `⚠ --post-comment: could NOT render/post the comment — ${e instanceof Error ? e.message : String(e)}. ` +
          `The review above and its exit code are unaffected (posting never changes the gate contract).`
      );
    }
  }

  // `--stage`: the FOREIGN tail. Everything lands as ONE PENDING review under the user's account —
  // author-private until they submit it on GitHub. COMPLETED runs only (exit 0 or 4), exactly like
  // `--post-comment`, and staging NEVER changes the exit code the review already earned. A single
  // JSON object is printed on the LAST stdout line for thin consumers, whatever the outcome.
  if (stage && source.postTarget) {
    const stagedRun = exitCode === 0 || exitCode === 4;
    const reviewerIds = [
      ...result.reviews.filter((r) => r.terminalState === 'reviewed').map((r) => r.reviewerId ?? r.reviewer.vendor),
      ...(claudeLayer?.claudeReview?.ok ? ['claude'] : []),
    ];
    const plan = planPlacement(gateRecords, {
      posture: loadPostingPosture(profile),
      reviewersRun: reviewerIds.length,
    });
    let stagedReviewUrl: string | null = null;
    let stageError: string | null = stagedRun
      ? null
      : `review did not complete (exit ${exitCode}) — nothing staged`;
    if (stagedRun) {
      try {
        const gh = ghRunner(cwd);
        const target = resolveStageTarget(source.postTarget, gh);
        if (!target) {
          stageError = `could not resolve owner/repo for PR #${source.postTarget.pr} — pass a full PR URL, or run inside the repo`;
        } else {
          const res = stageReview(
            buildStagedReviewPayload({
              ...(evidenceNote ? { evidenceNote } : {}),
              headSha: result.acquired.headSha,
              plan,
              reviewerIds,
            }),
            target,
            { gh, log: (m) => console.error(m), reviewedHeadSha: result.acquired.headSha }
          );
          if (res.ok) {
            stagedReviewUrl = res.url;
            console.error(
              `· staged a PENDING review on ${target.owner}/${target.repo}#${target.pr}${res.replaced ? ' (replaced the prior ensemble-ai pending review)' : ''} — ` +
                'it posts NOTHING until you submit it on GitHub' +
                (res.url ? `: ${res.url}` : '')
            );
          } else {
            stageError = res.error;
          }
        }
      } catch (e) {
        stageError = e instanceof Error ? e.message : String(e);
      }
      if (stageError) {
        console.error(
          `⚠ --stage: could NOT stage the pending review — ${stageError}. ` +
            'The review above and its exit code are unaffected (staging never changes the gate contract).'
        );
      }
    }
    // The CLI contract for thin consumers (spec §7): one JSON object, last line of stdout.
    console.log(
      JSON.stringify({
        counts: plan.counts,
        ...(stageError ? { error: stageError } : {}),
        headSha: result.acquired.headSha,
        receipt: {
          completed: result.receipt?.completed ?? [],
          digest: result.receipt?.diffDigest ?? null,
          path: result.receiptPath ?? null,
        },
        stagedReviewUrl,
      })
    );
  }
  return exitCode;
}

const BRAINSTORM_USAGE = `ensemble-ai brainstorm — convene multiple AI voices on a TOPIC.

Usage:
  ensemble-ai brainstorm "<topic>" [options]

Three rounds: (1) each voice generates ideas INDEPENDENTLY (no anchoring), (2) each
critiques + extends the OTHERS' ideas, (3) one voice synthesizes a ranked,
de-duplicated recommendation. Voices: codex + grok + claude by default (Claude joins
as a voice here — there is no independence concern, unlike review).

Options:
  --file <path>         include a file's contents as shared context for every voice
  --voices <ids>        comma-separated voice ids (default: codex,grok,claude)
  --synthesizer <id>    which voice runs round 3 (default: claude if present)
  --timeout <seconds>   per-voice timeout (default 300)
  --voices-file <path>  voices config json (default ~/.ensemble-ai/voices.json)
  --json                print the full result as JSON instead of formatted text
  --cwd <dir>           working dir for --file resolution (default: cwd)
  -h, --help            this help

Exit codes: 0 = produced ideas (synthesis printed) · 1 = no usable output (every
voice failed) · 3 = usage or an unexpected operational error.`;

// One brainstorm rendered for the terminal: the three rounds, each line passed
// through clean() (reviewer/voice text is untrusted — a crafted reply could carry
// ANSI escapes). Mirrors printSummary's grouped, scannable shape.
function printBrainstorm(r: BrainstormResult): void {
  const out: string[] = [];
  out.push('');
  out.push(`ensemble-ai brainstorm — ${clean(r.topic).slice(0, 200)}`);
  out.push(`  voices: ${r.roster.join(', ')}`);
  out.push('');
  out.push('Round 1 · independent ideas');
  for (const g of r.generate) {
    out.push('');
    out.push(`  ── ${g.voiceId} ──`);
    if (!g.ok) {
      out.push(`     (no ideas — ${clean(g.error ?? 'failed').slice(0, 160)})`);
      continue;
    }
    if (g.summary) out.push(`     ${clean(g.summary).slice(0, 240)}`);
    for (const idea of g.ideas) {
      out.push(`     • [${idea.id}] ${clean(idea.title)}`);
      if (idea.body) out.push(`         ${clean(idea.body).slice(0, 300)}`);
    }
  }
  if (r.critique.length > 0) {
    out.push('');
    out.push('Round 2 · cross-critique');
    for (const c of r.critique) {
      out.push('');
      out.push(`  ── ${c.voiceId} ──`);
      if (!c.ok) {
        out.push(`     (no critique — ${clean(c.error ?? 'failed').slice(0, 160)})`);
        continue;
      }
      for (const cr of c.critiques) {
        out.push(`     [${cr.stance}] ${clean(cr.target)} — ${clean(cr.assessment).slice(0, 260)}`);
      }
      for (const ex of c.extensions) {
        out.push(`     + ${clean(ex.title)}`);
        if (ex.body) out.push(`         ${clean(ex.body).slice(0, 260)}`);
      }
    }
  }
  out.push('');
  const s = r.synthesis;
  out.push(
    `Round 3 · synthesis${s.by ? ` (by ${s.by})` : ''}${s.degraded ? ' — DEGRADED (deterministic fallback)' : ''}`
  );
  if (s.summary) out.push(`  ${clean(s.summary).slice(0, 400)}`);
  for (const ri of s.ranked) {
    out.push('');
    out.push(
      `  ${ri.rank}. ${clean(ri.title)}${ri.contributors.length ? `  [${ri.contributors.map(clean).join(', ')}]` : ''}`
    );
    if (ri.why) out.push(`     why:  ${clean(ri.why).slice(0, 300)}`);
    if (ri.risks) out.push(`     risk: ${clean(ri.risks).slice(0, 240)}`);
  }
  out.push('');
  console.log(out.join('\n'));
}

// Hard cap on a --file read. Only the first FILE_CONTEXT_BUDGET (24k) is ever embedded
// in a prompt, but fs.readFileSync pulls the WHOLE file into the heap first, so an
// unbounded --file is an OOM vector; 10 MiB is generous for any real context file.
const MAX_BRAINSTORM_FILE_BYTES = 10 * 1024 * 1024;

async function brainstormCommand(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        cwd: { type: 'string' },
        file: { type: 'string' },
        help: { short: 'h', type: 'boolean' },
        json: { type: 'boolean' },
        synthesizer: { type: 'string' },
        timeout: { type: 'string' },
        voices: { type: 'string' },
        'voices-file': { type: 'string' },
      },
    });
  } catch (e) {
    console.error(`ensemble-ai brainstorm: ${(e as Error).message}`);
    console.error(BRAINSTORM_USAGE);
    return 3;
  }
  const { positionals, values } = parsed;
  if (values.help) {
    console.log(BRAINSTORM_USAGE);
    return 0;
  }
  const topic = positionals.join(' ').trim();
  if (!topic) {
    console.error(
      'ensemble-ai brainstorm: a topic is required, e.g. ensemble-ai brainstorm "naming options for X"'
    );
    console.error(BRAINSTORM_USAGE);
    return 3;
  }

  const cwd = values.cwd ? path.resolve(String(values.cwd)) : process.cwd();
  let fileContext: string | undefined;
  if (typeof values.file === 'string') {
    const filePath = path.resolve(cwd, values.file);
    try {
      const bytes = fs.statSync(filePath).size;
      if (bytes > MAX_BRAINSTORM_FILE_BYTES) {
        console.error(
          `ensemble-ai brainstorm: --file ${values.file} is too large (${bytes} bytes > ${MAX_BRAINSTORM_FILE_BYTES}-byte cap)`
        );
        return 3;
      }
      fileContext = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      console.error(
        `ensemble-ai brainstorm: cannot read --file ${values.file}: ${(e as Error).message}`
      );
      return 3;
    }
  }

  // --voices: fail CLOSED on an unknown id (a typo must error, never silently run a
  // narrower roster than asked). Absent → undefined → the default roster.
  let voices: VoiceId[] | undefined;
  if (typeof values.voices === 'string') {
    const requested = values.voices.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = requested.filter((id) => !isVoiceId(id));
    if (unknown.length > 0 || requested.length === 0) {
      console.error(
        `ensemble-ai brainstorm: --voices "${values.voices}" ${
          unknown.length ? `has unknown id(s): ${unknown.join(', ')}` : 'is empty'
        } (known: ${VOICE_IDS.join(', ')})`
      );
      return 3;
    }
    voices = parseVoiceIds(requested);
  }

  let synthesizer: VoiceId | undefined;
  if (typeof values.synthesizer === 'string') {
    if (!isVoiceId(values.synthesizer)) {
      console.error(
        `ensemble-ai brainstorm: --synthesizer "${values.synthesizer}" is not a known voice (known: ${VOICE_IDS.join(', ')})`
      );
      return 3;
    }
    synthesizer = values.synthesizer;
  }

  // --synthesizer must be IN the effective roster: pickSynthesizer only honors an
  // in-roster request and SILENTLY falls back to another voice otherwise, so an
  // out-of-roster id would be dropped without a word. Fail closed, exactly like
  // --voices does for an unknown id.
  const roster = voices ?? VOICE_IDS;
  if (synthesizer && !roster.includes(synthesizer)) {
    console.error(
      `ensemble-ai brainstorm: --synthesizer "${synthesizer}" is not in the voices roster (${roster.join(', ')})`
    );
    return 3;
  }

  let timeoutMs: number | undefined;
  if (typeof values.timeout === 'string') {
    const secs = Number(values.timeout);
    if (!Number.isFinite(secs) || secs <= 0) {
      console.error('ensemble-ai brainstorm: --timeout must be a positive number of seconds');
      return 3;
    }
    timeoutMs = Math.round(secs * 1000);
    if (timeoutMs < 1) {
      // A sub-millisecond value rounds to 0, and `timeoutMs ?? DEFAULT` does NOT restore
      // the default for a present-but-falsy 0 — the watchdog would fire at 0ms and kill
      // every voice instantly. Reject it as out of range.
      console.error('ensemble-ai brainstorm: --timeout is too small (rounds to 0ms)');
      return 3;
    }
  }

  let result: BrainstormResult;
  try {
    result = await runBrainstormMode({
      fileContext,
      onProgress: (m) => console.error(`· ${m}`),
      synthesizer,
      timeoutMs,
      topic,
      voices,
      voicesFile:
        typeof values['voices-file'] === 'string' ? values['voices-file'] : undefined,
    });
  } catch (e) {
    // An unexpected orchestration failure is NOT "every voice failed" (exit 1, the
    // graceful all-voices-empty outcome below) — it is an operational error. Exit 3,
    // matching review mode's runReviewMode catch, so the two modes don't drift.
    console.error(`ensemble-ai brainstorm: ${(e as Error).message}`);
    return 3;
  }

  if (values.json) console.log(JSON.stringify(result, null, 2));
  else printBrainstorm(result);

  // 1 = nothing usable came back (every voice failed to produce ideas).
  const anyIdeas = result.generate.some((g) => g.ok && g.ideas.length > 0);
  return anyIdeas ? 0 : 1;
}

const CONSULT_USAGE = `ensemble-ai consult — convene multiple AI voices on a QUESTION.

Usage:
  ensemble-ai consult "<question>" [options]
  ensemble-ai ask "<question>" [options]      (alias)

Each voice answers the question INDEPENDENTLY (no anchoring), then one voice
synthesizes: what the voices AGREE on (the confident core) vs where they DIVERGE
(flagged "look closer", with who took which position) + a bottom-line
recommendation. Voices: codex + grok + claude by default. For decisions + research.

Options:
  --file <path>         include a file's contents as shared context for every voice
  --critique            run an extra round where each voice reviews the others'
                        answers before synthesis (default: off — answer→synthesize)
  --voices <ids>        comma-separated voice ids (default: codex,grok,claude)
  --synthesizer <id>    which voice runs the synthesis (default: claude if present)
  --timeout <seconds>   per-voice timeout (default 300)
  --voices-file <path>  voices config json (default ~/.ensemble-ai/voices.json)
  --json                print the full result as JSON instead of formatted text
  --cwd <dir>           working dir for --file resolution (default: cwd)
  -h, --help            this help

Exit codes: 0 = produced answers (synthesis printed) · 1 = no usable output (every
voice failed) · 3 = usage or an unexpected operational error.`;

// One consult rendered for the terminal: the independent answers, then the
// synthesis split into AGREE / DIVERGE. Every line passed through clean() (voice
// text is untrusted — a crafted reply could carry ANSI escapes).
function printConsult(r: ConsultResult): void {
  const out: string[] = [];
  out.push('');
  out.push(`ensemble-ai consult — ${clean(r.question).slice(0, 200)}`);
  out.push(`  voices: ${r.roster.join(', ')}`);
  out.push('');
  out.push('Independent answers');
  for (const a of r.answers) {
    out.push('');
    out.push(`  ── ${a.voiceId} ──`);
    if (!a.ok) {
      out.push(`     (no answer — ${clean(a.error ?? 'failed').slice(0, 160)})`);
      continue;
    }
    if (a.summary) out.push(`     ${clean(a.summary).slice(0, 240)}`);
    if (a.answer) out.push(`     ${clean(a.answer).slice(0, 400)}`);
    for (const kp of a.keyPoints) out.push(`       · ${clean(kp).slice(0, 200)}`);
  }
  if (r.critique.length > 0) {
    out.push('');
    out.push('Cross-critique');
    for (const c of r.critique) {
      out.push('');
      out.push(`  ── ${c.voiceId} ──`);
      if (!c.ok) {
        out.push(`     (no notes — ${clean(c.error ?? 'failed').slice(0, 160)})`);
        continue;
      }
      for (const n of c.notes) {
        out.push(`     [${n.stance}] ${clean(n.target)} — ${clean(n.assessment).slice(0, 260)}`);
      }
    }
  }
  out.push('');
  const s = r.synthesis;
  out.push(
    `Synthesis${s.by ? ` (by ${s.by})` : ''}${s.degraded ? ' — DEGRADED (deterministic fallback, NOT compared for agreement)' : ''}`
  );
  if (s.summary) out.push(`  ${clean(s.summary).slice(0, 400)}`);
  if (s.agreements.length > 0) {
    out.push('');
    out.push('  ✓ AGREE (confident)');
    for (const a of s.agreements) {
      out.push(`     • ${clean(a.point).slice(0, 300)}${a.voices.length ? `  [${a.voices.map(clean).join(', ')}]` : ''}`);
    }
  }
  if (s.divergences.length > 0) {
    out.push('');
    out.push('  ⚠ DIVERGE (look closer)');
    for (const d of s.divergences) {
      out.push(`     • ${clean(d.point).slice(0, 300)}`);
      for (const p of d.positions) out.push(`         − ${clean(p).slice(0, 240)}`);
    }
  }
  if (s.recommendation) {
    out.push('');
    out.push('  → Recommendation');
    out.push(`     ${clean(s.recommendation).slice(0, 500)}`);
  }
  out.push('');
  console.log(out.join('\n'));
}

async function consultCommand(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        critique: { type: 'boolean' },
        cwd: { type: 'string' },
        file: { type: 'string' },
        help: { short: 'h', type: 'boolean' },
        json: { type: 'boolean' },
        synthesizer: { type: 'string' },
        timeout: { type: 'string' },
        voices: { type: 'string' },
        'voices-file': { type: 'string' },
      },
    });
  } catch (e) {
    console.error(`ensemble-ai consult: ${(e as Error).message}`);
    console.error(CONSULT_USAGE);
    return 3;
  }
  const { positionals, values } = parsed;
  if (values.help) {
    console.log(CONSULT_USAGE);
    return 0;
  }
  const question = positionals.join(' ').trim();
  if (!question) {
    console.error(
      'ensemble-ai consult: a question is required, e.g. ensemble-ai consult "should I use Postgres or SQLite for X?"'
    );
    console.error(CONSULT_USAGE);
    return 3;
  }

  const cwd = values.cwd ? path.resolve(String(values.cwd)) : process.cwd();
  let fileContext: string | undefined;
  if (typeof values.file === 'string') {
    const filePath = path.resolve(cwd, values.file);
    try {
      const bytes = fs.statSync(filePath).size;
      if (bytes > MAX_BRAINSTORM_FILE_BYTES) {
        console.error(
          `ensemble-ai consult: --file ${values.file} is too large (${bytes} bytes > ${MAX_BRAINSTORM_FILE_BYTES}-byte cap)`
        );
        return 3;
      }
      fileContext = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      console.error(
        `ensemble-ai consult: cannot read --file ${values.file}: ${(e as Error).message}`
      );
      return 3;
    }
  }

  // --voices: fail CLOSED on an unknown id (a typo must error, never silently run a
  // narrower roster than asked). Absent → undefined → the default roster.
  let voices: VoiceId[] | undefined;
  if (typeof values.voices === 'string') {
    const requested = values.voices.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = requested.filter((id) => !isVoiceId(id));
    if (unknown.length > 0 || requested.length === 0) {
      console.error(
        `ensemble-ai consult: --voices "${values.voices}" ${
          unknown.length ? `has unknown id(s): ${unknown.join(', ')}` : 'is empty'
        } (known: ${VOICE_IDS.join(', ')})`
      );
      return 3;
    }
    voices = parseVoiceIds(requested);
  }

  let synthesizer: VoiceId | undefined;
  if (typeof values.synthesizer === 'string') {
    if (!isVoiceId(values.synthesizer)) {
      console.error(
        `ensemble-ai consult: --synthesizer "${values.synthesizer}" is not a known voice (known: ${VOICE_IDS.join(', ')})`
      );
      return 3;
    }
    synthesizer = values.synthesizer;
  }

  // --synthesizer must be IN the effective roster: pickSynthesizer only honors an
  // in-roster request and SILENTLY falls back otherwise, so an out-of-roster id would
  // be dropped without a word. Fail closed, exactly like --voices.
  const roster = voices ?? VOICE_IDS;
  if (synthesizer && !roster.includes(synthesizer)) {
    console.error(
      `ensemble-ai consult: --synthesizer "${synthesizer}" is not in the voices roster (${roster.join(', ')})`
    );
    return 3;
  }

  let timeoutMs: number | undefined;
  if (typeof values.timeout === 'string') {
    const secs = Number(values.timeout);
    if (!Number.isFinite(secs) || secs <= 0) {
      console.error('ensemble-ai consult: --timeout must be a positive number of seconds');
      return 3;
    }
    timeoutMs = Math.round(secs * 1000);
    if (timeoutMs < 1) {
      // A sub-millisecond value rounds to 0, and `timeoutMs ?? DEFAULT` does NOT
      // restore the default for a present-but-falsy 0 — the watchdog would fire at
      // 0ms and kill every voice instantly. Reject it as out of range.
      console.error('ensemble-ai consult: --timeout is too small (rounds to 0ms)');
      return 3;
    }
  }

  let result: ConsultResult;
  try {
    result = await runConsultMode({
      critique: Boolean(values.critique),
      fileContext,
      onProgress: (m) => console.error(`· ${m}`),
      question,
      synthesizer,
      timeoutMs,
      voices,
      voicesFile:
        typeof values['voices-file'] === 'string' ? values['voices-file'] : undefined,
    });
  } catch (e) {
    // An unexpected orchestration failure is NOT "every voice failed" (exit 1) — it is
    // an operational error. Exit 3, matching review/brainstorm, so the modes don't drift.
    console.error(`ensemble-ai consult: ${(e as Error).message}`);
    return 3;
  }

  if (values.json) console.log(JSON.stringify(result, null, 2));
  else printConsult(result);

  // 1 = nothing usable came back (every voice failed to answer).
  const anyAnswers = result.answers.some((a) => a.ok);
  return anyAnswers ? 0 : 1;
}

// ── Plumbing commands (no reviewer runs) ─────────────────────────────────────

// Validate an EXPLICIT `--reviewers` token list (split/trim), failing closed if any
// token is unknown or the list is empty — a typo must never silently narrow the
// policy. The fail-closed source of truth for the PLUMBING gate/preview
// (parseRequiredReviewers). Review mode resolves its own roster via resolveReviewRoster
// (which additionally knows the default-on `claude` id). Returns the ids or an error code.
function parseReviewerList(
  raw: string,
  cmd: string
): ReviewerId[] | { code: number } {
  const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = requested.filter((id) => !isReviewerId(id));
  if (unknown.length > 0 || requested.length === 0) {
    console.error(
      `ensemble-ai ${cmd}: --reviewers "${raw}" ${
        unknown.length ? `has unknown id(s): ${unknown.join(', ')}` : 'is empty'
      } (known: ${REVIEWER_IDS.join(', ')})`
    );
    return { code: 3 };
  }
  return parseReviewerIds(requested) as ReviewerId[];
}

// Parse a fail-closed `--reviewers` list. Unlike review mode (where absent → undefined →
// "run all"), the gate/preview need a CONCRETE required set, so the caller supplies the
// default for an absent flag — and the two callers need DIFFERENT defaults. The `receipt`
// path defaults to the receipt-minting CORE (codex/grok — what index.ts keys `completed`/
// `reviewerPolicy` by; claude rides along only as a stamped peerReviewer). Defaulting it to
// the full registry would compute a policyHash over a reviewer no receipt was minted with, so
// a genuinely-reviewed diff reports "no receipt". The `diff` cost-preview defaults to the full
// REVIEWER_IDS registry — an honest 3-seat label, since the claude layer is default-on. `claude`
// is a valid EXPLICIT `--reviewers` id in both.
export function parseRequiredReviewers(
  raw: string | undefined,
  cmd: string,
  defaultIds: readonly ReviewerId[]
): ReviewerId[] | { code: number } {
  return raw === undefined ? [...defaultIds] : parseReviewerList(raw, cmd);
}

// Parse `--conventions a.md,b.md` into an explicit path list (the config lever for
// non-standard layouts) — additive to auto-detection. Empty/absent → undefined.
function parseConventionPaths(
  raw: string | boolean | undefined
): string[] | undefined {
  if (typeof raw !== 'string') return undefined;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

function positiveCeiling(
  raw: string | undefined,
  cmd: string
): number | undefined | { code: number } {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`ensemble-ai ${cmd}: --ceiling must be a positive number`);
    return { code: 3 };
  }
  return n;
}

const RECEIPT_USAGE = `ensemble-ai receipt — the content-tied diff-receipt gate primitive.

Usage:
  ensemble-ai receipt verify [<path>] [options]   check the CURRENT diff is reviewed
  ensemble-ai receipt show   [<path>] [options]   pretty-print a receipt

verify recomputes the current diff's identity (repo · base/head · content digest)
and checks it against the stored (or --path) receipt: exit 0 = reviewed & current;
NON-ZERO (3) = missing / stale (commits since review) / under-policy / under-coverage,
with the reason printed. This is what a pre-PR \`gh pr create\` hook calls.
show prints a receipt's fields (given a <path>, else looked up for the current diff).

TRUST: by default a pass is TRUSTED BY ATTESTATION (the receipt's completed[]), NOT
proven by reviewer artifacts — a hand-written receipt with a matching diff digest
would also pass, so verify prints a loud warning. A pre-PR gate MUST use --strict
(--require-artifacts) with --trail <dir>, which requires the real per-reviewer
artifacts and FAILS CLOSED (non-zero) on an attestation-only receipt. (Cryptographic
receipt signing — proof against a fabricated receipt+artifacts — is a documented v2.)

Options:
  --base <ref>          base ref for the current-branch diff (default: origin/HEAD)
  --staged              use the staged diff (\`git diff --cached\`) as the current state
  --working-tree        use uncommitted tracked changes (\`git diff HEAD\`)
  --repo <dir>          the repo to verify, AND a request for WORKTREE evidence: verify then asks
                        the stronger question "was this reviewed with whole-project evidence?" and
                        FAILS (evidence-degraded) on a receipt whose realized per-seat evidence is
                        weaker, naming the seat. Every receipt minted so far is packet-evidenced.
  --accept-degraded     with --repo: accept a receipt whose realized evidence is weaker than the
                        worktree evidence you asked for. Deliberate, never the default.
  --reviewers <ids>     required reviewer policy (default: all configured)
  --ceiling <bytes>     coverage byte ceiling (default 200000)
  --store <dir>         receipt store dir (default: ~/.ensemble-ai/receipts)
  --trail <dir>         a run trail dir to PROVE the immutable reviewer artifacts
                        (default: trust the receipt's completed[] — see receipt.ts)
  --strict, --require-artifacts
                        REQUIRE the real trail artifacts (use with --trail): an
                        attestation-only receipt FAILS CLOSED. The pre-PR hook's mode.
  --cwd <dir>           repo working dir (default: cwd)
  -h, --help            this help`;

async function receiptCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === '-h' || sub === '--help') {
    console.log(RECEIPT_USAGE);
    return sub ? 0 : 3;
  }
  if (sub !== 'verify' && sub !== 'show') {
    console.error(
      `ensemble-ai receipt: unknown subcommand "${sub}" (expected: verify | show)`
    );
    console.error(RECEIPT_USAGE);
    return 3;
  }
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ positionals, values } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: {
        'accept-degraded': { type: 'boolean' },
        base: { type: 'string' },
        ceiling: { type: 'string' },
        cwd: { type: 'string' },
        help: { short: 'h', type: 'boolean' },
        repo: { type: 'string' },
        'require-artifacts': { type: 'boolean' },
        reviewers: { type: 'string' },
        staged: { type: 'boolean' },
        store: { type: 'string' },
        strict: { type: 'boolean' },
        trail: { type: 'string' },
        'working-tree': { type: 'boolean' },
      },
    }));
  } catch (e) {
    console.error(`ensemble-ai receipt: ${(e as Error).message}`);
    console.error(RECEIPT_USAGE);
    return 3;
  }
  if (values.help) {
    console.log(RECEIPT_USAGE);
    return 0;
  }

  const receiptPathArg =
    typeof positionals[0] === 'string' ? path.resolve(positionals[0]) : undefined;
  // Read + SHAPE-VALIDATE an explicit receipt file (Codex LOW: no blind cast). Returns
  // a discriminated result so the caller can print WHY a malformed/partial file failed
  // — unreadable, non-JSON, or the specific missing/invalid fields — not a blank "cannot
  // read". Not a trust check (a well-formed forged receipt still parses → strict verify).
  const readReceiptFile = (
    p: string
  ): { receipt: DiffReviewReceipt } | { error: string } => {
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      return { error: `cannot read receipt ${p}: ${(e as Error).message}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { error: `receipt ${p} is not valid JSON: ${(e as Error).message}` };
    }
    try {
      return { receipt: validateReceiptShape(parsed) };
    } catch (e) {
      return { error: `receipt ${p}: ${(e as Error).message}` };
    }
  };

  // `show <path>` needs no git — just read + print the receipt file.
  if (sub === 'show' && receiptPathArg) {
    const res = readReceiptFile(receiptPathArg);
    if ('error' in res) {
      console.error(`ensemble-ai receipt show: ${res.error}`);
      return 3;
    }
    console.log(formatReceipt(res.receipt));
    return 0;
  }

  const required = parseRequiredReviewers(
    typeof values.reviewers === 'string' ? values.reviewers : undefined,
    'receipt',
    CORE_REVIEWER_IDS
  );
  if ('code' in required) return required.code;
  const ceiling = positiveCeiling(
    typeof values.ceiling === 'string' ? values.ceiling : undefined,
    'receipt'
  );
  if (typeof ceiling === 'object') return ceiling.code;
  // Resolve the coverage ceiling ONCE so the live diff (acquireDiff) and the receipt
  // key's policyHash are sized under the SAME value — no second `?? DEFAULT` that could
  // silently drift and make a genuinely-reviewed diff report no-receipt.
  const ceilingBytes = ceiling ?? DEFAULT_COVERAGE_CEILING;
  if (typeof values.repo === 'string' && typeof values.cwd === 'string') {
    console.error(`ensemble-ai receipt ${sub}: choose at most one of --repo / --cwd (both name the repo to verify)`);
    return 3;
  }
  const repoLocation = typeof values.repo === 'string' ? path.resolve(values.repo) : undefined;
  const cwd = repoLocation ?? (values.cwd ? path.resolve(String(values.cwd)) : process.cwd());

  // WORKTREE-EVIDENCE INTENT (spec §8, narrowed by gate-r2): passing the repo location IS the
  // request for worktree evidence. So `--repo` makes `verify` ask a strictly stronger question —
  // "was this diff reviewed with whole-project evidence?" — and a receipt whose REALIZED per-seat
  // evidence is weaker fails with `evidence-degraded`, naming the seat. Every receipt on disk today
  // is a legacy (v1) one with no realized map = `unknown` = weaker, so `--repo` fails them all: that
  // is the contract, not a bug. `--accept-degraded` takes the weaker evidence deliberately.
  //
  // Only the REQUIRED reviewer seats are compared — the seats this caller's policy names. The gate's
  // own realized class is recorded in the receipt (pin 1) and readable via `receipt show`; it is not
  // folded in here, because a `--no-claude` run legitimately has no gate and must not read as a gap.
  const intendedEvidence: EvidenceMap | undefined = repoLocation
    ? Object.fromEntries(required.map((id) => [id, 'worktree' as const]))
    : undefined;
  const acceptDegraded = Boolean(values['accept-degraded']);
  if (acceptDegraded && !intendedEvidence) {
    console.error(
      'ensemble-ai receipt: --accept-degraded only means something with --repo (it accepts evidence weaker than the worktree evidence --repo asks for)'
    );
    return 3;
  }

  // At most one explicit source, mirroring selectDiffSource for the review/diff commands
  // — otherwise acquireDiff silently prefers --staged and drops --working-tree, gating
  // the wrong diff identity with no error.
  if (Boolean(values.staged) && Boolean(values['working-tree'])) {
    console.error(
      `ensemble-ai receipt ${sub}: choose at most one of --staged / --working-tree`
    );
    return 3;
  }

  // Both `verify` and `show`-without-path need the LIVE diff identity to derive the
  // receipt key. Fail closed (exit 3) if the base can't be resolved.
  let acquired: AcquiredDiff;
  try {
    acquired = acquireDiff({
      base: typeof values.base === 'string' ? values.base : undefined,
      ceilingBytes,
      cwd,
      staged: Boolean(values.staged),
      workingTree: Boolean(values['working-tree']),
    });
  } catch (e) {
    console.error(`ensemble-ai receipt ${sub}: ${(e as Error).message}`);
    return 3;
  }
  const key: ReceiptKey = {
    baseSha: acquired.baseSha,
    diffDigest: acquired.canonicalDigest,
    headSha: acquired.headSha,
    policyHash: computePolicyHash({
      coveragePolicy: { ceilingBytes },
      diffMode: acquired.mode,
      reviewerPolicy: required,
    }),
    repo: acquired.repoId,
  };
  const store = values.store ? path.resolve(String(values.store)) : defaultReceiptStore();

  if (sub === 'show') {
    const receipt = readReceipt(store, key);
    if (!receipt) {
      console.error(
        `ensemble-ai receipt show: no receipt for the current diff (repo ${key.repo ?? '(none)'}, head ${key.headSha}) in ${store}`
      );
      return 3;
    }
    console.log(formatReceipt(receipt));
    return 0;
  }

  // verify: read the receipt from --path (explicit) or the store (by key), then run
  // the SAME live validation the engine ships (isDiffReviewed via verifyReceipt).
  let explicit: DiffReviewReceipt | null = null;
  if (receiptPathArg) {
    const res = readReceiptFile(receiptPathArg);
    if ('error' in res) {
      console.error(`ensemble-ai receipt verify: ${res.error}`);
      return 3;
    }
    explicit = res.receipt;
  }
  const verifyDeps = {
    acceptDegraded,
    intendedEvidence,
    // NOTE: `key` above is the LEGACY (v1) policy hash, which is also the key every receipt on disk
    // is addressed by. Worktree runs will mint v2-keyed receipts once the seat spawn lands; at that
    // point this must compute the v2 key (which binds the run's sandbox profiles) and pass the v1
    // key as `legacyKey` — resolveReceipt already implements that fallback. Until a v2 receipt can
    // exist, computing a v2 key here would only fail every lookup.
    // An explicit --path receipt must still match the FULL live identity — repo + both
    // SHAs + policyHash — exactly as the store lookup binds it (the store file is
    // addressed by the full-key hash). Without this, `verify <path>` degrades to a
    // digest-only check, a strictly weaker gate than `verify` (store). The digest stays
    // with isDiffReviewed so a digest-only drift still reports `stale`.
    readReceipt: receiptPathArg
      ? (k: ReceiptKey): DiffReviewReceipt | null =>
          explicit && receiptIdentityMatches(explicit, k) ? explicit : null
      : (k: ReceiptKey) => readReceipt(store, k),
    strict: Boolean(values.strict || values['require-artifacts']),
    trailDir: typeof values.trail === 'string' ? path.resolve(values.trail) : undefined,
  };
  const state = verifyReceipt({ coverage: acquired.coverage, key, required }, verifyDeps);
  console.log(formatVerify(state, key));
  // A PASS with no artifact proof (default mode, no --trail) is trusted-by-attestation
  // and thus forgeable — say so LOUDLY so it is never a silent gate. A strict/--trail
  // pass is artifact-proven → no warning.
  if (state.reviewed && isAttestedOnly(verifyDeps)) {
    console.error(
      'WARNING: this PASS is TRUSTED BY ATTESTATION (the receipt\'s completed[]), NOT proven by reviewer artifacts — a hand-written receipt with a matching diff digest would also pass. For an artifact-proven gate (e.g. a pre-PR hook) run with --strict (--require-artifacts) and --trail <run-trail-dir>.'
    );
  }
  return verifyExitCode(state);
}

const REVIEWERS_USAGE = `ensemble-ai reviewers — list the configured cross-vendor registry (read-only).

Usage:
  ensemble-ai reviewers [options]
  ensemble-ai config    [options]      (alias)

Prints the review/security reviewers (from reviewers.json) and the brainstorm/
consult voices (from voices.json) — id · vendor · model · effort · sandbox — plus
which config file each came from (or "baked defaults"). No mutation.

Options:
  --reviewers-file <path>   reviewers config (default ~/.ensemble-ai/reviewers.json)
  --voices-file <path>      voices config (default ~/.ensemble-ai/voices.json)
  --json                    print the resolved registry as JSON
  -h, --help                this help`;

async function reviewersCommand(args: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      options: {
        help: { short: 'h', type: 'boolean' },
        json: { type: 'boolean' },
        'reviewers-file': { type: 'string' },
        'voices-file': { type: 'string' },
      },
    }));
  } catch (e) {
    console.error(`ensemble-ai reviewers: ${(e as Error).message}`);
    console.error(REVIEWERS_USAGE);
    return 3;
  }
  if (values.help) {
    console.log(REVIEWERS_USAGE);
    return 0;
  }
  const reviewersFile =
    typeof values['reviewers-file'] === 'string'
      ? path.resolve(values['reviewers-file'])
      : REVIEWERS_FILE;
  const voicesFile =
    typeof values['voices-file'] === 'string'
      ? path.resolve(values['voices-file'])
      : VOICES_FILE;
  // The gate seat resolves from the SAME voices.json (no run flags here — `config` is a read-only
  // view, so source ∈ {file, default}); a junk/`cmd`-bearing entry warns loudly on stderr.
  const gateSeat = loadGateSeat(voicesFile, {}, (m) => console.error(`· ${m}`));
  const view: RegistryView = {
    gate: {
      effort: gateSeat.config.effort,
      effortSource: gateSeat.effortSource,
      model: gateSeat.config.model,
      modelSource: gateSeat.modelSource,
    },
    reviewers: listReviewers(reviewersFile),
    reviewersFile,
    reviewersFileExists: fs.existsSync(reviewersFile),
    voices: listVoices(voicesFile),
    voicesFile,
    voicesFileExists: fs.existsSync(voicesFile),
  };
  if (values.json) console.log(JSON.stringify(view, null, 2));
  else console.log(renderRegistry(view));
  return 0;
}

const DIFF_USAGE = `ensemble-ai diff — show the assembled review packet WITHOUT running a reviewer.

Usage:
  ensemble-ai diff [<pr-url>] [options]

A cost-preview / debug of the EXACT packet the reviewers would receive: the diff
identity + coverage, the per-section manifest (what the reviewer sees), and the
prompt size — no vendor is called, nothing is spent.

Diff source (give at most ONE; default = current branch, like \`ensemble-ai review\`):
  (default)            <base>...HEAD — the current branch vs origin/HEAD
  <pr-url>             a positional GitHub PR URL — sugar for \`--pr <url>\`
  --pr <N|url>         the diff of a GitHub PR: a bare integer N (\`gh pr diff <N>\` in
                       the cwd) OR a full URL → \`gh pr diff <N> -R <owner>/<repo>\`
  --staged             staged changes (\`git diff --cached\`)
  --working-tree       uncommitted tracked changes vs HEAD
  --diff-file <path>   a raw unified diff from a file
  (stdin)              a piped diff

Options:
  --base <ref>          base ref for the default (commit) mode
  --profile <p>         packet profile: code (default) | security
  --reviewers <ids>     reviewers to size the cost preview against (default: all)
  --conventions <paths> extra convention files to gather (comma-separated, in-repo)
  --no-conventions      do NOT gather the repo's conventions into the packet
  --ceiling <bytes>     coverage byte ceiling (default 200000)
  --full                print the ENTIRE rendered prompt (the literal payload)
  --json                print { packet, prompt } as JSON
  --cwd <dir>           repo working dir (default: cwd)
  -h, --help            this help`;

async function diffCommand(args: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        base: { type: 'string' },
        ceiling: { type: 'string' },
        conventions: { type: 'string' },
        cwd: { type: 'string' },
        'diff-file': { type: 'string' },
        full: { type: 'boolean' },
        help: { short: 'h', type: 'boolean' },
        json: { type: 'boolean' },
        'no-conventions': { type: 'boolean' },
        pr: { type: 'string' },
        profile: { type: 'string' },
        reviewers: { type: 'string' },
        staged: { type: 'boolean' },
        'working-tree': { type: 'boolean' },
      },
    }));
  } catch (e) {
    console.error(`ensemble-ai diff: ${(e as Error).message}`);
    console.error(DIFF_USAGE);
    return 3;
  }
  if (values.help) {
    console.log(DIFF_USAGE);
    return 0;
  }

  let profile: ReviewProfile = 'code';
  if (typeof values.profile === 'string') {
    if (values.profile !== 'code' && values.profile !== 'security') {
      console.error(
        `ensemble-ai diff: --profile must be "code" or "security" (got "${values.profile}")`
      );
      return 3;
    }
    profile = values.profile;
  }
  const reviewers = parseRequiredReviewers(
    typeof values.reviewers === 'string' ? values.reviewers : undefined,
    'diff',
    REVIEWER_IDS
  );
  if ('code' in reviewers) return reviewers.code;
  const ceiling = positiveCeiling(
    typeof values.ceiling === 'string' ? values.ceiling : undefined,
    'diff'
  );
  if (typeof ceiling === 'object') return ceiling.code;
  const cwd = values.cwd ? path.resolve(String(values.cwd)) : process.cwd();

  const source = resolveDiffSourceForCommand(values, positionals, 'diff', cwd);
  if ('code' in source) return source.code;

  let acquired: AcquiredDiff;
  try {
    acquired = acquireDiff({
      base: typeof values.base === 'string' ? values.base : undefined,
      ceilingBytes: ceiling,
      cwd,
      diffMode: source.diffMode,
      diffText: source.diffText,
      headShaOverride: source.headShaOverride,
      staged: source.staged,
      workingTree: source.workingTree,
    });
  } catch (e) {
    console.error(`ensemble-ai diff: ${(e as Error).message}`);
    return 3;
  }

  // Gather the conventions the reviewers WOULD see — through the SAME gatherer the
  // review path uses, so this preview never drifts from the real payload. Off with
  // --no-conventions; fs reader for local sources, gh reader for a `--pr <url>`.
  let agentsMd: string | undefined;
  let conventions: ConventionManifest | undefined;
  // Same rule as the review path: an unresolvable URL PR gathers NOTHING rather than
  // the local (different) repo's conventions — a resolved URL PR still gathers from the
  // PR repo via source.conventionsCtx (the gh reader), so the preview matches the review.
  if (!values['no-conventions'] && !source.noLocalConventions) {
    const reader = buildConventionReader(cwd, source.conventionsCtx);
    if (reader) {
      const changed = acquired.files
        .map((f) => f.path)
        .filter((p) => p && p !== 'unknown');
      const gathered = await gatherConventions(reader, changed, {
        conventions: parseConventionPaths(values.conventions),
      });
      if (gathered.text.trim()) agentsMd = gathered.text;
      conventions = gathered.manifest;
    }
  }

  const preview = buildPacketPreview(acquired, profile, agentsMd);
  if (values.json) {
    console.log(
      JSON.stringify(
        { conventions, packet: preview.packet, prompt: preview.prompt },
        null,
        2
      )
    );
  } else {
    console.log(
      renderPacketPreview(acquired, preview, {
        conventions,
        full: Boolean(values.full),
        profile,
        reviewers,
      })
    );
  }
  return 0;
}

const PUSH_FENCE_USAGE = `ensemble-ai push-fence — may the FIX tail push to this PR's head ref?

Usage:
  ensemble-ai push-fence --pr <N|url> [--cwd <dir>]

The FIX tail (/ensemble-ai-review-fix) fixes findings in your session and pushes to the PR's
head branch. It must never push to a branch you do not own — a contributor's fork branch is
theirs, and rewriting it is not a review action. Run this BEFORE any push.

Exit 0 = you own the head ref, the fix tail may push.
Exit 5 = REFUSED (fork / no push access) — stage a pending review instead:
         ensemble-ai review --pr <url> --stage
Exit 3 = usage / gh error.

This is a FENCE, not a dispatcher: it never chooses a tail for you and never pushes.

Options:
  --pr <N|url>          the pull request to check (required)
  --cwd <dir>           repo working dir (default: cwd)
  -h, --help            this help`;

// The fix-tail push fence as a command the fix skill MUST run before pushing. Reads the PR's head
// provenance + the viewer's push permission on the BASE repo through `gh`, then applies the pure
// fence. Fails CLOSED: any unreadable field refuses.
async function pushFenceCommand(args: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      options: { cwd: { type: 'string' }, help: { short: 'h', type: 'boolean' }, pr: { type: 'string' } },
    }));
  } catch (e) {
    console.error(`ensemble-ai push-fence: ${(e as Error).message}`);
    console.error(PUSH_FENCE_USAGE);
    return 3;
  }
  if (values.help) {
    console.log(PUSH_FENCE_USAGE);
    return 0;
  }
  if (typeof values.pr !== 'string') {
    console.error('ensemble-ai push-fence: --pr <N|url> is required');
    console.error(PUSH_FENCE_USAGE);
    return 3;
  }
  const selection = selectDiffSource({ pr: values.pr });
  if (isDiffSourceError(selection) || selection.kind !== 'pr' || typeof selection.pr !== 'number') {
    console.error(
      `ensemble-ai push-fence: ${isDiffSourceError(selection) ? selection.error : 'not a PR reference'}`
    );
    return 3;
  }
  const cwd = values.cwd ? path.resolve(String(values.cwd)) : process.cwd();
  const gh = ghRunner(cwd);
  const scope = selection.owner && selection.repo ? ['-R', `${selection.owner}/${selection.repo}`] : [];
  // Exactly the three fields parsePushContext reads. `gh pr view --json` rejects an unknown field
  // name outright, so an unused extra would break the command, not merely bloat it.
  const view = gh([
    'pr', 'view', String(selection.pr), ...scope,
    '--json', 'headRefName,headRepositoryOwner,isCrossRepository',
  ]);
  if (!view.ok) {
    console.error(`ensemble-ai push-fence: could not read PR #${selection.pr} — ${view.error}`);
    return 3;
  }
  let prJson: unknown;
  try {
    prJson = JSON.parse(view.text);
  } catch (e) {
    console.error(`ensemble-ai push-fence: could not parse gh output — ${(e as Error).message}`);
    return 3;
  }
  // The BASE repo is where a same-repo PR's head branch lives, so its `permissions.push` IS the
  // "can I push to the head ref?" fact. A cross-repo PR refuses before this matters.
  const base =
    selection.owner && selection.repo ? `${selection.owner}/${selection.repo}` : repoSlugFromCwd(gh);
  const perm = base ? gh(['api', `repos/${base}`, '--jq', '.permissions.push']) : { error: 'no repo', ok: false as const };
  const canPush = perm.ok && perm.text.trim() === 'true';
  const verdict = evaluatePushFence(parsePushContext(prJson, canPush), base || `PR #${selection.pr}`);
  if (verdict.allowed) {
    console.log(`ensemble-ai push-fence: ALLOWED — you own the head ref of ${base}#${selection.pr}; the fix tail may push.`);
    return 0;
  }
  console.error(`ensemble-ai push-fence: ${verdict.reason}`);
  return 5;
}

const PIN_CHECK_USAGE = `ensemble-ai pin-check — is your pinned ensemble-ai current with main?

A consumer that installs ensemble-ai from a specific commit keeps running THAT commit
silently after main advances — the staleness is invisible. pin-check compares the pinned
commit against the tip of main and reports the drift, so a consumer's own doctor / health
check can surface "N commits behind" instead of running stale.

Usage:
  ensemble-ai pin-check [options]

With no flags it checks the ensemble-ai checkout THIS binary runs from: it fetches the
remote and compares HEAD against origin/main.

Options:
  --repo <dir>      the ensemble-ai checkout to check (default: this binary's own checkout)
  --pin <ref>       the pinned commit/ref to check (default: the checkout's HEAD)
  --main-ref <ref>  the ref to compare against (default: origin/main)
  --no-fetch        do not refresh the remote first — compare against the local ref (offline)
  --json            machine output: {pinned, main, behind, ahead, status, fetched, note}
  -h, --help        this help

Exit: 0 = current (or ahead of main); 3 = STALE or DIVERGED; 1 = error. A consumer's doctor
gates on the exit code, or parses --json for a softer "N behind" surface.`;

// Locate the ensemble-ai checkout THIS binary runs from, so `pin-check` with no --repo
// answers "is the ensemble-ai I am current?". Returns null when the binary is not inside a
// git checkout (e.g. a packed `npm i -g`); the CLI then asks for --repo.
function resolveSelfRepo(git: ReturnType<typeof execGit>): string | null {
  const r = git(['rev-parse', '--show-toplevel'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
  });
  return r.ok ? r.text.trim() : null;
}

async function pinCheckCommand(args: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      allowPositionals: false,
      args,
      options: {
        help: { short: 'h', type: 'boolean' },
        json: { type: 'boolean' },
        'main-ref': { type: 'string' },
        'no-fetch': { type: 'boolean' },
        pin: { type: 'string' },
        repo: { type: 'string' },
      },
    }));
  } catch (e) {
    console.error(`ensemble-ai pin-check: ${(e as Error).message}`);
    console.error(PIN_CHECK_USAGE);
    return 3;
  }
  if (values.help) {
    console.log(PIN_CHECK_USAGE);
    return 0;
  }

  const git = execGit();
  const repoDir = (values.repo as string | undefined) ?? resolveSelfRepo(git);
  if (!repoDir) {
    console.error(
      'ensemble-ai pin-check: could not locate an ensemble-ai git checkout (this binary is not inside one). Pass --repo <dir>.'
    );
    return 1;
  }

  const result = checkPinDrift({
    repoDir,
    git,
    pin: values.pin as string | undefined,
    mainRef: values['main-ref'] as string | undefined,
    fetch: !values['no-fetch'],
  });
  if ('error' in result) {
    console.error(`ensemble-ai pin-check: ${result.error}`);
    return 1;
  }

  const stale = result.status === 'stale' || result.status === 'diverged';
  if (values.json) {
    console.log(JSON.stringify(result));
  } else {
    const line = `ensemble-ai pin-check: ${describePinDrift(result)}`;
    if (stale) console.error(line);
    else console.log(line);
    if (result.note) console.error(`  note: ${result.note}`);
  }
  return stale ? 3 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const raw = argv[0];
  if (!raw || raw === '-h' || raw === '--help') {
    console.log(USAGE);
    return raw ? 0 : 1;
  }
  // Plumbing commands (no reviewer runs) dispatch before the mode registry.
  if (raw === 'receipt') return receiptCommand(argv.slice(1));
  if (raw === 'push-fence') return pushFenceCommand(argv.slice(1));
  if (raw === 'reviewers' || raw === 'config') return reviewersCommand(argv.slice(1));
  if (raw === 'diff') return diffCommand(argv.slice(1));
  if (raw === 'pin-check') return pinCheckCommand(argv.slice(1));

  const mode = resolveMode(raw);
  if (mode === 'review') return reviewCommand(argv.slice(1), 'code');
  if (mode === 'security') return reviewCommand(argv.slice(1), 'security');
  if (mode === 'brainstorm') return brainstormCommand(argv.slice(1));
  if (mode === 'consult') return consultCommand(argv.slice(1));
  if (isMode(mode) && !isImplemented(mode)) {
    console.error(`ensemble-ai: mode "${mode}" is planned but not implemented yet.`);
    return 3;
  }
  console.error(`ensemble-ai: unknown mode "${mode}".\n`);
  console.error(USAGE);
  return 3;
}

// Auto-run ONLY when invoked as the actual entry (the `ensemble-ai` bin) — not
// when imported (e.g. by a unit test importing `main`), so tests don't trigger a
// real review against the process's argv.
if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`ensemble-ai: ${(e as Error).stack ?? e}`);
      process.exitCode = 1;
    }
  );
}
