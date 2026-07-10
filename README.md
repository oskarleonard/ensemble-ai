# ensemble-ai

Cross-vendor AI CLI — convene multiple models (Codex, Grok, …) on a task, **read-only**, and collect their output as typed, machine-readable **facts**.

Modes (architected mode-first): **`review`** (a code diff), **`security`** (a code diff, security lens), **`brainstorm`** (a topic), and **`consult`** / **`ask`** (a question) are implemented. Every mode is a variation of "fan out across vendors → synthesize" — their **disagreement is the signal**.

It's the portable engine behind a cross-vendor *code review* workflow: give it a `git diff`, it runs each configured reviewer **read-only in an OS-enforced sandbox**, parses their output into typed findings, and writes a self-describing trail plus a content-tied receipt. It emits **facts** (findings + per-reviewer execution status + coverage + a receipt) — **never a gate verdict**. The gate policy belongs to whatever consumes it (a terminal, a pre-PR hook, a dashboard).

## Commands at a glance

| Command | What it does | Key flags |
| --- | --- | --- |
| `ensemble-ai review [<pr-url>]` | Self-contained cross-vendor code review — Codex + Grok + a cold Opus as blind peers, then a Claude **gate** grounds each finding (`agree`/`partial`/`false`/`unverified`) + a synthesis. | source: `--pr <N\|url>` · `--staged` · `--working-tree` · `--diff-file <p>` · stdin (default: current branch) · `--reviewers <ids>` · `--no-claude` · gate: `--strict-high` · `--gate-dismissals` · `--gate-model`/`--gate-effort` · `--no-fail-on-high` · **`--stage`** (stage a PENDING review; needs a PR **URL**) · `--post-comment` (deprecated) · `--out <dir>` |
| `ensemble-ai security [<pr-url>]` | `review` under a security-auditor lens + a local dependency-surface flag; findings tagged by class. | identical to `review` (same sources, gate flags, `--stage`) |
| `ensemble-ai brainstorm "<topic>"` | Cross-vendor ideation: each voice generates → critiques the others → one synthesizes a ranked, deduped recommendation. | `--file <p>` · `--voices <ids>` · `--synthesizer <id>` · `--timeout <s>` · `--json` |
| `ensemble-ai consult "<q>"` (alias `ask`) | Cross-vendor Q&A: each voice answers independently → one synthesizes AGREE (confident) vs DIVERGE (look closer) + a bottom line. | `--file <p>` · `--critique` · `--voices <ids>` · `--synthesizer <id>` · `--json` |
| `ensemble-ai receipt verify\|show` | The content-tied gate primitive: `verify` exits 0 iff the current diff is reviewed & current; `show` pretty-prints a receipt. | `--strict`/`--require-artifacts` · `--trail <dir>` · `--store <dir>` · `--staged` · `--working-tree` · `--reviewers <ids>` · **`--repo <dir>`** (ask for worktree evidence) · `--accept-degraded` |
| `ensemble-ai push-fence --pr <N\|url>` | The **fix tail's** fence: exit 0 iff you own the PR's head ref; exit 5 = REFUSED (fork / no push access) → stage a pending review instead. Never pushes, never routes. | `--pr <N\|url>` · `--cwd <dir>` |
| `ensemble-ai reviewers` (alias `config`) | Print the **resolved** seats — reviewers (`reviewers.json`) + voices (`voices.json`): id · vendor · model · effort · sandbox + source file. Read-only. | `--json` · `--reviewers-file <p>` · `--voices-file <p>` |
| `ensemble-ai diff [<pr-url>]` | Cost-preview / debug: the exact packet the reviewers WOULD get (identity + coverage + prompt size) — no vendor called. | same diff sources as `review` · `--profile code\|security` · `--full` · `--json` |
| **Claude skills** | Slash wrappers: `/ensemble-ai-review` · `/ensemble-ai-security` · `/ensemble-ai-brainstorm` · `/ensemble-ai-consult` (thin) + **`/ensemble-ai-review-fix`** — the pre-PR ritual (simplify → review → fix the gate verdicts → re-review → offer a PR). | installed per config dir via `entrypoints/install.sh` |
| **Pre-PR gate hook** | A Claude Code `PreToolUse` hook (`ensemble-ai-pre-pr-gate`) that BLOCKS `gh pr create` on a diff with no valid review receipt (fail-open if the CLI is missing; overridable). | runs `receipt verify --strict` under the hood |

Full flags for any command: `ensemble-ai <command> --help`.

## Install

No npm release yet — install from git:

```sh
npm i -g github:oskarleonard/ensemble-ai
# or as a dependency
npm i github:oskarleonard/ensemble-ai
```

The package has **zero runtime dependencies** (node built-ins only) and ships a prebuilt `dist/`, so a git install needs no build step. Reviewers are invoked via their own CLIs (`codex`, `grok`) — install + authenticate those separately.

## Usage

```sh
# review base...HEAD (base auto-resolved the way `gh pr create` resolves it)
ensemble-ai review

# review a specific range
ensemble-ai review --base origin/main

# review uncommitted tracked changes
ensemble-ai review --working-tree

# review a raw diff from a pipe or a file (PR-agnostic)
git diff main...HEAD | ensemble-ai review
ensemble-ai review --diff-file change.diff

# pick reviewers + where the trail goes
ensemble-ai review --reviewers codex,grok --out ./review-trail
```

Options: `--base <ref>` · `--reviewers <ids>` · `--out <dir>` · `--sandbox <profile>` · `--allow-sensitive` · `--ceiling <bytes>` · `--cwd <dir>` · `--run-id <id>`.

The **trail** defaults to a repo-local `.ensemble-ai/reviews/<run-id>/` when you're reviewing the current repo's own diff (it's gitignored, discoverable beside the code); a URL-PR / raw-diff / stdin review, or a non-repo cwd, falls back to an OS temp dir so a diff from a *different* repo never writes into your cwd. Override the base with `--out <dir>`. Trail + receipt files are written owner-only (`0600`). The `review input`, `receipt:`, and `trail:` paths are printed on **stdout**.

**Exit codes** (execution status, not a gate verdict): `0` = the review completed (even *with* findings) · `1` = a reviewer failed (crash / timeout / no parse) · `2` = blocked by the diff secret-scan · `3` = usage / no diff.

### The verified gate — dismiss-only exit authority (exit 4)

The `review` / `security` **CLI** adds one gate on top of the facts above: **exit `4`** when a completed review surfaced a **HIGH** finding. Its cold-Opus **gate reviewer** grounds each finding against the exact diff hunk the reviewers saw and tags it `agree` / `partial` / `false` / `unverified`; a HIGH stops the gate **only** on a citation-validated **`false`** — *dismiss-only*: the gate can drop a hallucinated HIGH from a weak reviewer, but can **never** bless, promote, or soften anything else. Everything else (`agree` / `partial` / `unverified` / missing) still gates, uniformly across Codex, Grok, and the Opus reviewer.

**Grounding is not proof.** The citation only proves the gate *read* the disputed code (a whitespace-normalized, minimum-anchor quote of the finding's own hunk in the pinned packet). The `false` verdict itself is the gate model's **judgment**, not a proof of falsity.

**Provenance-scoped by default** — dismissal authority is trusted for your own local diffs, strict for anything foreign:

| Diff source | Authority | Effect |
| --- | --- | --- |
| `--working-tree` · `--staged` · branch-vs-merge-base (the default) | **ON** | a validated-`false` HIGH is dismissed |
| `--pr <N\|url>` · a PR URL · piped stdin · `--diff-file` | **STRICT** | every HIGH gates (verdicts advisory) |

- **`--strict-high`** forces STRICT **anywhere** — every HIGH gates even one the gate dismissed (use for untrusted diffs / CI, or any run where raw HIGH severity should gate).
- **`--gate-dismissals`** opts a **foreign** diff into the dismiss-only authority (local diffs already have it). Its reader-of-record for a non-git input (stdin / `--diff-file` / a PR) is the run's **pinned packet** (`packet.gate.json` — the reviewer-visible diff at the resolved head SHA), the SAME immutable artifact the local path reads; nothing is re-derived from the working tree.
- **`--no-fail-on-high`** suppresses exit 4 entirely (unchanged).

A **gate failure never opens the gate and never trips exit 1** — a spawn error, a timeout, an unparseable / unknown-schema envelope, a missing / corrupt / SHA-mismatched packet, or a trail-write failure all force every verdict to `unverified`, so a HIGH still gates. Dismissed HIGHs print **loudly** (`HIGH (dismissed by gate — <reason>)`), and the run writes a durable `gate-verdicts.json` trail (raw + effective verdict + a machine-readable downgrade reason per finding). Exit precedence: `2` (secret-scan) > `1` (reviewer failed) > `4` (HIGH) > `0`.

**Feeding a fix-loop:** the **structured verdicts** in `<trail>/gate-verdicts.json` (the `<trail>` path the run prints already includes the per-run id) — *not* the synthesis prose — are authoritative. Point a coding agent at the trail and fix the `agree` / `partial` findings; treat every `unverified` (especially an **unverified HIGH**, which still blocks the gate) as an explicit investigate-or-triage set, never a silent drop. Keep the gate seat at least as capable as your strongest reviewer — a weak gate mostly returns `unverified` (the safe-but-toothless mode), which stdout flags as "gate teeth did not engage".

### Worktree evidence mode — whole-project context, per seat

By default every seat sees the **packet**: the diff, the changed files, and the repo's conventions. That is *diff-local* — a reviewer cannot see that your new helper duplicates one that already lives in an unchanged file. **Worktree evidence mode** fixes that by materializing the PR head as a **detached, read-only worktree** of a repo you already have cloned, and giving qualifying seats read access to the whole project at `headSha`.

> **Status — the engine and the VERIFY side are wired; the review-side seat spawn is not.**
> `receipt verify --repo <dir>` and `--accept-degraded` are parsed and honored today. `review --repo`
> is parsed and **refuses by name**: no seat is spawned against a worktree yet, so reviewing the
> packet while reporting whole-project evidence would be exactly the silent downgrade the realized
> map exists to prevent. Every review run is therefore packet-mode and mints a legacy (v1) receipt,
> as before.

```bash
# WIRED — `--repo` makes verify ask the STRONGER question, and a weaker receipt fails by name:
ensemble-ai receipt verify --repo ~/code/r                     # → EVIDENCE DEGRADED: codex realized unknown, intended worktree…
ensemble-ai receipt verify --repo ~/code/r --accept-degraded   # take the weaker evidence anyway, deliberately

# NOT WIRED — refuses with a message naming what is missing, rather than under-delivering quietly:
ensemble-ai review --pr https://github.com/o/r/pull/7 --repo ~/code/r
```

Because no run has ever minted worktree evidence, `verify --repo` fails **every receipt on disk**
today. That is the contract working, not a bug: a legacy receipt carries no realized map, which
reads as `unknown` = weaker than `worktree`. When the seat spawn lands, `verify` must also compute
the **v2** receipt key (which binds the run's sandbox profiles) and pass the v1 key as `legacyKey`;
`resolveReceipt` already implements that fallback.

**Your checkout is never involved.** The engine fetches `pull/N/head` from the remote's **explicit URL** (never assuming `origin` exposes PR refs), adds a detached worktree, and **asserts `HEAD == headSha` before any seat runs** — a mismatch aborts rather than reviewing wrong-SHA evidence. Materialization is inert by construction: no hooks, no submodule recursion, no LFS smudge (so an in-tree `.lfsconfig` is never honored), tracked files only, no deps installed. It is reaped in a `finally` plus a `git worktree prune` sweeper, and serialized per repo (`git worktree add` writes into the shared `.git`). Pre-flight fails **closed** with a named cause: `wrong-repo` · `no-such-pr` · `network` · `auth` · `not-a-repo` · `disallowed-root` · `sha-mismatch`. An optional `allowedRepoRoots` array in `~/.ensemble-ai/config.json` restricts which repo roots may be materialized at all — consumer policy, never baked into this engine.

**A seat gets the worktree only under a deny-by-default sandbox** — repo-rooted, secret-denied. Fail-closed **per seat**: no qualifying sandbox, that seat keeps the packet, and the fallback is **loud** (receipt, footer, stderr), never silent.

The plan per seat (**"wired" = a seat is actually spawned against a worktree today; none are yet — see the status note above**):

| Seat | Sandbox | Worktree | Wired |
| --- | --- | --- | --- |
| `grok` | `ensemble-review` (Seatbelt/Landlock, `strict` base + secret deny-list), rooted at the worktree | yes | runner accepts `worktree`; no caller passes it |
| `codex` | `ensemble-review-codex` — an ensemble-owned Seatbelt wrapper; codex's internal sandbox is off inside it (nested Seatbelt doesn't compose) | yes, on macOS | no — the runner **rejects** `worktree` rather than silently reviewing the packet |
| `claude` | harness-controlled | yes | prompt + argv only |
| `gate` | harness-controlled | yes | defaults to `packet` |

**Honest containment.** The wrapper denies **exec** of any path inside the worktree, but a shell-capable agent can still read an untrusted file as *data* (`sh worktree/x.sh`). No-exec narrows the vector; it does not close it. The rest of the profile is the real boundary, and it is narrower than "nothing but the worktree" — state it exactly:

- **Reads.** `$HOME` is not readable, so no ssh key, vendor credential, or other repo on disk is reachable — except `~/.codex`, which the seat must read to call its own API. The allowed *system* roots include `/private/var`, which contains the per-user `$TMPDIR`; a secret another process parked in its own temp dir **is** readable. The claim is "no credential in `$HOME`", not "no credential anywhere". A read root that is, or contains, `$HOME` (`~/bin/node` ⇒ `nodePrefix` = `$HOME`) is **refused**: the profile fails to build rather than grant it.
- **Writes.** `~/.codex`, `/private/tmp` (the legacy world-shared `/tmp`, not the per-user `$TMPDIR`), and `/dev`.
- **Network.** Port-scoped, never per-host, and **not 443-only**: outbound `443` **and** `53` (DNS) **and** local unix sockets; inbound on any local port. Port 53 to any address is a usable DNS-exfiltration channel, so combined with the read-as-data vector the seat has an egress path for whatever it can read. Seatbelt cannot express a per-host DNS allowlist, so a true per-host fence needs an egress proxy and is **not** claimed here.

Outside macOS the codex seat falls back to the packet.

**Evidence is part of the receipt's identity.** The receipt records the **intended** per-seat evidence map (policy) and the **realized** one (fact) as separate things, plus each worktree seat's sandbox profile id + version — so a degraded mixed run is never receipt-equivalent to a full-worktree run. A worktree seat **must** bind a sandbox profile: "the seat could read the whole project" is only a safety claim together with "under this profile, at this version", so `buildDiffReceipt` refuses to mint a receipt that claims worktree evidence for a seat with no profile identity. A legacy receipt carries no realized map, which reads as `unknown` — exactly as strong as `packet` (the packet is all that existed when it was issued), and strictly weaker than `worktree`. `policyHash` is **versioned**: an all-packet run hashes under the legacy schema, byte-for-byte as before, so turning worktree mode *off* changes no receipt identity and no existing receipt is staled. The verification contract — `computePolicyHashAt` under the receipt's **own** issued version, then a separate realized-vs-intended comparison in which a legacy receipt's missing realized map reads as `unknown` = *weaker* and fails only when worktree evidence is requested (`acceptDegraded` overrides) — is implemented and tested in `isDiffReviewed` / `verifyReceipt`, and **`receipt verify --repo <dir>` now passes those inputs** (passing the repo location IS the request for worktree evidence, spec §8). Without `--repo` the evidence check is a no-op and v1 semantics are untouched. An `evidence-manifest.json` joins the trail — the tracked tree at `headSha` with blob SHAs, i.e. the **readable surface** each worktree seat was given. It is advisory and never hashed. (Opaque vendor CLIs do not report their file reads, so it is honestly named: what a seat *could* read, not what it *did*.)

**The gate reads the same worktree**, which makes it an evidence-bearing actor in its own right. On worktree evidence it may emit a new downgrade cause, **`reference-not-found`** — "I could not locate what this finding references at `headSha`", the hallucinated-reference red flag — alongside the existing `truncated` / `missing`. The gate is **taught** the cause only when its realized evidence is `worktree`, and the host **honors** it only then: a gate that saw a ±25-line window cannot distinguish "does not exist" from "outside my window", so a packet-fed gate is never told the cause exists, and a cause arriving on packet evidence anyway is dropped with a warning. Teaching and honoring are gated on the same fact. Consumers opt in by keying on the cause; old artifacts keep their meaning.

**The Claude producer** in worktree mode runs the built-in `/code-review` methodology (bugs + structural quality — never style or naming nits) with whole-project context, and maps its findings into the same schema Codex and Grok emit. One Claude producer, not two: same-family corroboration is weak signal and pure dedup load.

### Reviewing someone else's PR — `--stage`

`--post-comment` publishes a comment **immediately** under your account. On a foreign pull request
that is the wrong posture: a robot that posts before you have read it spends your credibility, not
its own. `--stage` is the replacement, and `--post-comment` is **deprecated** (kept, unchanged, for
existing consumers).

```bash
ensemble-ai review --pr https://github.com/o/r/pull/7 --stage
```

`--stage` needs the **full PR URL**, not a bare `--pr <N>`. A staged review is bound to a commit —
its `commit_id` and every inline line anchor are only meaningful at the head SHA the diff was read
at, and the freshness guard compares that SHA against the PR's live head. A URL binds the diff to
the exact head via the compare API; a bare `--pr <N>` fetches it with `gh pr diff`, which reports no
head SHA at all. Rather than invent one (re-reading the head afterwards is a TOCTOU — it can move
between the two calls), `--stage` refuses a review it cannot bind, up front.

Everything lands as **ONE PENDING review** under your account — GitHub's create-review API with
`event` omitted. It is author-private until you read it, edit it, and click Submit in GitHub's own
UI. `event` is **never** sent, so this tool can never Approve or Request-Changes anywhere. A
zero-bug run **still stages a review**, carrying only the friendly summary body: the posting
authority is absolute, and nothing appears under your name without your click — not even "LGTM".

**Placement, not deletion.** Nothing verified is dropped; the tiers decide where it lands:

| Tier | Where | Why |
| --- | --- | --- |
| Verified bug | inline comment on its line | the main event |
| Quality finding (structural simplification) | a **collapsed** `<details>` section of the summary | the author reads or ignores it in one gesture; their AI assistant consumes all of it |
| Gate-verified small replacement | inline ` ```suggestion ` block, **hard-capped at 3** | one-click apply is a gift, not a nag |
| A verified finding with no in-diff anchor, or one citing a **deleted** line | the summary body | dropping a verified bug is never the conservative choice — and GitHub rejects a RIGHT-side comment on a line that only exists on the left, which would fail the whole staged review |

**No model runs in the posting path.** The gate — which already read the diff — assigns each finding
its `class` (`bug` / `quality`) and may attach a `suggestion`, both validated by the host under the
same no-new-entity rule the edit-ops obey: a replacement may introduce no identifier, path, or
number absent from the reviewer's body or its cited hunk. The posting step then reads the stored
`postableBody` and wraps it. Reviewer text is untrusted, so two markup vectors are neutralized on
the way out: `<!--` is escaped (a crafted body cannot forge the machine trailer) and a
reviewer-authored ` ```suggestion ` fence is retagged (only the host may put an apply button on
code). Per-profile thresholds live in `~/.ensemble-ai/config.json`; the caps do not.

```jsonc
{ "posting": { "code": { "suggestionCap": 3, "maxSuggestionLines": 6, "inlineSeverityFloor": "low" } } }
```

**Three hardenings, all fail-closed:**

- **Freshness.** The reviewed `headSha` must still be the PR's live head. A moved head **refuses** —
  every inline anchor would point at code the author already rewrote.
- **Stale pending.** GitHub allows one pending review per user per PR. A pending review that is not
  ours is your own unsubmitted work: we refuse, legibly, and never touch it.
- **Idempotency.** A pending review that *is* ours (it carries our marker) is **replaced**, so a
  re-run updates in place instead of stacking duplicate comments. Each finding carries an invisible
  machine trailer — `{findingId, verdict, severity, anchors, corroborators, fixStatus}` — which is
  also what lets a consuming agent read the review back as data.

Findings are grouped by **issue, never by tool** (the dedup pass already elected one representative
per cluster), each comment states its own provenance (`flagged by 2 of 3 reviewers`), and the review
carries exactly one honest attribution footer.

#### The CLI contract for consumers

With `--stage`, the **last line of stdout is a single JSON object**, whatever the outcome — so a
thin consumer never parses prose:

```json
{"counts":{"inline":2,"quality":3,"reviewersRun":3,"suggestions":1,"unanchored":0},
 "headSha":"…","receipt":{"completed":["codex","grok"],"digest":"…","path":"…"},
 "stagedReviewUrl":"https://github.com/o/r/pull/7#pullrequestreview-123"}
```

On a staging failure the object carries `"error"` and `"stagedReviewUrl": null`. **Staging never
changes the exit code** the review already earned (`2` > `1` > `4` > `0`) — it is a side effect of a
completed review, never part of the gate contract, exactly like `--post-comment`.

**Two tails, picked by the command you invoke — never by an engine predicate.**
`--stage` posts and never pushes. The **fix tail** (`/ensemble-ai-review-fix`) fixes findings in
your session and pushes. Since the stage tail may legitimately run on contributor PRs to repos you
*do* own, the fix tail is fenced:

```bash
ensemble-ai push-fence --pr <N|url>   # exit 0 = you own the head ref · exit 5 = REFUSED
```

It refuses a fork head-ref or a repo you cannot push to, and names `--stage` as the alternative.
It is a **fence, not a dispatcher**: it never reroutes for you and never pushes anything.

#### Consumer-side wiring (documented here, built there)

- **Hugin dashboard** — one primary PR-page action, *"Review & stage"*: run the full pipeline, show
  the `stagedReviewUrl`, and put "posts nothing until you submit on GitHub" in the popover. Existing
  buttons stay à-la-carte. **App-pilot QA is a separate optional step AFTER review**, on the pilot's
  own deps-worktree (existing plumbing) — a different artifact with a different lifecycle from the
  review worktree, and it never touches the main checkout. Figma-compare rides that slot.
- **Munin dashboard** — **no required changes on the do-nothing path.** Its review-button flow (own
  PRs → dispositions → MERGE-CLEAR) has no post tail, and packet-mode runs keep working untouched.
  The moment Munin passes a **repo location** it is *requesting* worktree evidence and must check
  realized-vs-intended on the receipt (`isDiffReviewed` reports `evidence-degraded` and names the
  seat). New `gate-verdicts.json` fields are additive — dashboard validation must keep scoping by
  `meta.kind`. The trail schema is now **v3** (`postableClass`, `postableSuggestion`, `resolved`
  added beside the v2 postable fields); a reader that ignores unknown keys is unaffected.
### The holistic lens — one seat that reads the whole project
`--holistic` (**default off**) adds an Anthropic seat, at its top tier, that reviews the change *against the tree it lands in*: a helper that **reinvents** one already living elsewhere in the project (usually in a file the diff never touches), a **convention** the diff drifts from, a design that collapses to something **simpler**. It is a seat in the registry — configurable under a `holistic` key in `voices.json`, switched by the consumer's review-depth policy — not a parallel pipeline. Its findings flow through the same gate → edit-ops → dedup → posting machinery as everyone else's, and the gate stays a judge: it never generates findings of its own.
Because a wrong *"use the existing util X"* is the most credibility-burning comment a robot can leave on someone else's PR, the lens is fenced by mechanism rather than by instruction:
- **Worktree evidence or it does not run.** No worktree ⇒ no seat, no findings, and it says so on stderr. It never reviews on the packet. (No CLI path supplies a worktree yet — see the status note above — so `--holistic` today resolves to exactly that loud skip. The seat and its guardrails are reachable from the library surface and ship tested.)
- **Both sites, or it does not post.** A holistic `agree` must quote **the reinvention in the diff *and* the existing pattern's home**, each at `file:line@headSha`. The host re-reads both out of the tree and matches the quotes itself; a site it cannot locate becomes `unverified · reference-not-found` — the same hallucinated-reference cause the gate already emits, sound here precisely because the lens only ever runs on worktree evidence. The host verifies that both quotes are **real, and sit where they are claimed to sit**, and that the two do not quote the *same* lines. It does not require the pattern's home to be in an unchanged file: a PR that both edits the canonical util and reinvents it is a finding worth making. Whether the two are genuinely the same thing is the lens's judgment, not a host guarantee.
- **Agree-only.** A `partial` ("a kind-of-similar pattern exists") stays in the trail and never reaches the PR. Findings are framed as suggestions.
- **Severity capped at MED, and only a *citation* lifts it.** The cap is exceeded only when the verdict carries a citation of a **conventions doc** that the host locates verbatim at `headSha`. When the run gathered a conventions manifest, *that manifest is the authority* — a doc it did not gather cannot uncap, so a vendored `node_modules/**/CONTRIBUTING.md` in an untrusted tree is not a back door. (With no manifest at all, the canonical filenames are the fallback; a README is never one.) A model asserting importance never uncaps — the check is code, not a request.
- **One seat, so never corroborated.** Holistic findings are excluded from cross-reviewer clustering: they cannot receive a "flagged by *N* of *M*" count, and cannot inflate anyone else's. They are also excluded from the HIGH gate — a suggestion about architecture never flips the exit code.
- **A clean holistic pass is not an architecture certification.** The search space is the whole tree, so run-to-run variance is expected: the lens finds valuable things when it looks. Silence means it did not find one this time.
**Acceptance fixture** (`fixtures/holistic/`): a small planted tree with **several** reinventions the lens must catch and **several** near-miss lookalikes it must not flag — a util that resembles the canonical one but rounds half-to-even, preserves case, or paces a queue instead of retrying. `scoreHolisticFixture()` grades a live run against it. The vitest suite runs the *gating* mechanics deterministically against that tree with a stubbed seat (both-sites quoting, the citation-required uncap, agree-only posting, the symlink fence) — it does **not** claim to prove the model's judgment, which no stub can. What the host guarantees is that a citation is real; that a *comparison* is sound is the lens's job, and the negative half of the fixture is how you measure it.

### Configuring the seats — `reviewers.json` and `voices.json`

Every seat is **config, not a hardcode** — two JSON files under `~/.ensemble-ai/` (each env-overridable: `ENSEMBLE_REVIEWERS_FILE` / `ENSEMBLE_VOICES_FILE`). Run `ensemble-ai config` (alias of `ensemble-ai reviewers`) to print the **resolved** seats — id · vendor · model · effort · sandbox, plus which file each came from — so what you see is exactly what the modes run. Neither file needs to exist; a missing or junk entry falls back to the baked default (a bad config can never silently disable a seat).

**`~/.ensemble-ai/reviewers.json`** — the cross-vendor **reviewers** (Codex + Grok), the diff-facing lenses:

```json
{
  "codex": { "model": "gpt-5.5", "effort": "xhigh" },
  "grok":  { "model": "grok-build", "effort": "high" }
}
```

**`~/.ensemble-ai/voices.json`** — the Claude **voices** (`claude` = the brainstorm/consult voice **and** the cold-Opus review reviewer) plus the **`gate`** seat (the verified-gate synthesizer). The gate takes **`model` and `effort` only** — it is always a `claude -p` spawn under the read-only plan-mode + write-tool deny-list, so a `cmd` key on the `gate` seat is **ignored + warned** (the read-only posture can't be configured away). This makes "reviewer = Opus @ high, **gate = Fable @ max**" expressible:

```json
{
  "claude": { "model": "opus", "effort": "high" },
  "gate":   { "model": "fable", "effort": "max" }
}
```

- **Gate resolution chain:** the `gate` entry → the `claude` entry (model/effort only) → the built-in default (**Opus**). A `gate` seat with no `voices.json` at all is byte-for-byte today's default gate.
- **Per-run override:** `--gate-model <m>` / `--gate-effort <e>` beat the file for one run (an effort outside `low|medium|high|xhigh|max` is ignored — today's whitelist, kept). Codex/Grok stay per-reviewer-configurable via `reviewers.json`.
- **Capability floor:** keep the gate at least as capable as your strongest reviewer. A weak gate mostly returns `unverified` — *safe but toothless* (it can't dismiss what it can't ground), which the gate summary line flags with **`gate teeth did not engage — consider a stronger gate model`**. That notice is the runtime signal that the seat is under-powered for the diff.

### Brainstorm

`brainstorm` runs ideation on a **topic** (not a diff) across multiple AI voices and synthesizes the result:

```sh
# three rounds: independent ideas → cross-critique → ranked synthesis
ensemble-ai brainstorm "naming options for a cross-vendor AI CLI"

# bring shared context, pick voices, name the synthesizer
ensemble-ai brainstorm "how should we shard this table?" --file schema.sql
ensemble-ai brainstorm "feature ideas" --voices codex,grok --synthesizer codex
```

The three rounds: **(1) generate** — each voice produces ideas *independently* (no anchoring on the others); **(2) critique** — each voice sees the *others'* ideas and critiques + extends them ("they talk to each other"); **(3) synthesize** — one voice de-duplicates, weighs the critiques, and produces a **ranked recommendation** crediting contributors. Default roster: **Codex + Grok + Claude** — Claude joins as a voice here (no independence concern, unlike review). Any voice can fail without taking down the others; if the synthesizer is unavailable it degrades to a deterministic dedupe.

Options: `--file <path>` · `--voices <ids>` · `--synthesizer <id>` · `--timeout <seconds>` · `--voices-file <path>` · `--json` · `--cwd <dir>`.

**Exit codes:** `0` = ideas produced (synthesis printed) · `1` = no usable output (every voice failed) · `3` = usage or an unexpected operational error.

### Consult

`consult` (alias `ask`) poses a **question** to the ensemble and separates signal from noise — where the voices **agree** (confident) vs where they **diverge** (look closer):

```sh
# each voice answers INDEPENDENTLY, then one synthesizes agree vs diverge
ensemble-ai consult "Should I use Postgres or SQLite for a single-user desktop app?"
ensemble-ai ask "Is this migration plan safe?" --file plan.md

# opt into an extra round where the voices review each other before synthesis
ensemble-ai consult "Which caching strategy for this workload?" --critique
```

The rounds: **(1) answer** — each voice answers the question *independently* (no anchoring), so concurrence across voices is a real signal; **(2) critique** *(optional, `--critique`, off by default)* — each voice reviews the *others'* answers; **(3) synthesize** — one voice separates **AGREEMENTS** (the confident core) from **DIVERGENCES** (flagged "look closer", recording who took which position) and gives a bottom-line recommendation. This is consult's difference from brainstorm: brainstorm *generates + ranks ideas*; consult *answers a question* and surfaces the ensemble's consensus vs split. Default roster: **Codex + Grok + Claude**. Fail-closed on bad flags; any voice can fail without taking down the others; an unavailable synthesizer degrades to a clearly-flagged deterministic list that makes **no** agreement claim.

Options: `--file <path>` · `--critique` · `--voices <ids>` · `--synthesizer <id>` · `--timeout <seconds>` · `--voices-file <path>` · `--json` · `--cwd <dir>`.

**Exit codes:** `0` = answers produced (synthesis printed) · `1` = no usable output (every voice failed) · `3` = usage or an unexpected operational error.

## Design

- **Vendor-neutral by construction** — a reviewer is config (`id · model · effort · sandbox`); adding one is a registry entry, not a rewrite.
- **Read-only, OS-enforced** — a reviewer can never mutate the work (kernel-fail-closed, not tool-denial). Grok additionally runs under a *deny-by-default-reads* profile (`ensemble-review`), so it can't read secrets *outside* the diff packet; Codex runs under its own `-s read-only` (writes + network blocked) and the equivalent read-confinement for Codex is tracked as follow-up. The diff-payload secret-scan (below) is the cross-cutting guard for secrets *inside* the payload.
- **Diff-payload secret-scan** — the diff itself is the payload sent to a provider, so a preflight scan default-rejects diffs that carry secrets / sensitive paths (override with `--allow-sensitive`); every match is named in the manifest.
- **Facts, not verdicts** — the engine reports findings + execution status + coverage; the consumer computes the gate.
- **A verifiable trail** — per-reviewer typed findings JSON + a manifest recording base/head, the canonical-diff content digest (distinct from any commit SHA), each reviewer's model/effort + execution status, and **coverage** (omitted paths named — binary / generated / over-limit — never silently dropped).
- **A content-tied receipt** — keyed by the full reviewed identity `(repo, baseSha, headSha, diffDigest, policyHash)`, validated **live** against the immutable per-reviewer artifacts (never a stored boolean), and coverage-qualified (an omitted *source* file does not qualify). A consumer's pre-PR gate can check it without re-running the review.

## Library

The same engine is importable in-process (one engine, no drift):

```ts
import { runReviewMode, isDiffReviewed } from 'ensemble-ai';
```

## CI

Every pull request and every push to `main` runs the project's own gate on Node 20, 22, and 24 (the `engines.node` floor through the `.nvmrc` dev pin) — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

Run exactly the same gate locally before you push:

```bash
npm ci
npm run check   # typecheck → lint → test → build
```

The individual steps are also available on their own: `npm run typecheck`, `npm run lint`, `npm run test` (`npm run test:watch` while iterating), and `npm run build`. CI needs no secrets and calls no vendor CLIs — the reviewer seats are mocked in the test suite.

## License

MIT
