# ensemble-ai

Cross-vendor AI CLI — convene multiple models (Codex, Grok, …) on a task, **read-only**, and collect their output as typed, machine-readable **facts**.

Modes (architected mode-first): **`review`** (a code diff), **`security`** (a code diff, security lens), **`brainstorm`** (a topic), and **`consult`** / **`ask`** (a question) are implemented. Every mode is a variation of "fan out across vendors → synthesize" — their **disagreement is the signal**.

It's the portable engine behind a cross-vendor *code review* workflow: give it a `git diff`, it runs each configured reviewer **read-only in an OS-enforced sandbox**, parses their output into typed findings, and writes a self-describing trail plus a content-tied receipt. It emits **facts** (findings + per-reviewer execution status + coverage + a receipt) — **never a gate verdict**. The gate policy belongs to whatever consumes it (a terminal, a pre-PR hook, a dashboard).

## Commands at a glance

| Command | What it does | Key flags |
| --- | --- | --- |
| `ensemble-ai review [<pr-url>]` | Self-contained cross-vendor code review — Codex + Grok + a cold Opus as blind peers, then a Claude **gate** grounds each finding (`agree`/`partial`/`false`/`unverified`) + a synthesis. | source: `--pr <N\|url>` · `--staged` · `--working-tree` · `--diff-file <p>` · stdin (default: current branch) · `--reviewers <ids>` · `--no-claude` · gate: `--strict-high` · `--gate-dismissals` · `--gate-model`/`--gate-effort` · `--premise` · `--shadow-gate` (+ `--shadow-gate-effort`) · `--claude-model`/`--claude-effort` · `--holistic` + `--holistic-model`/`--holistic-effort` · `--no-fail-on-high` · `--no-ci-evidence` · **`--stage`** (stage a PENDING review; needs a PR **URL**) · `--post-comment` (deprecated) · `--out <dir>` |
| `ensemble-ai security [<pr-url>]` | `review` under a security-auditor lens + a local dependency-surface flag; findings tagged by class. | identical to `review` (same sources, gate flags, `--stage`) |
| `ensemble-ai brainstorm "<topic>"` | Cross-vendor ideation: each voice generates → critiques the others → one synthesizes a ranked, deduped recommendation. | `--file <p>` · `--voices <ids>` · `--synthesizer <id>` · `--timeout <s>` · `--json` |
| `ensemble-ai consult "<q>"` (alias `ask`) | Cross-vendor Q&A: each voice answers independently → one synthesizes AGREE (confident) vs DIVERGE (look closer) + a bottom line; `--debate` then argues each split with evidence and an independent judge rules. | `--file <p>` · `--critique` · `--debate` · `--debate-rounds <n>` · `--judge <id>` · `--voices <ids>` · `--synthesizer <id>` · `--json` |
| `ensemble-ai receipt verify\|show` | The content-tied gate primitive: `verify` exits 0 iff the current diff is reviewed & current; `show` pretty-prints a receipt. | `--strict`/`--require-artifacts` · `--trail <dir>` · `--store <dir>` · `--staged` · `--working-tree` · `--reviewers <ids>` · **`--repo <dir>`** (ask for worktree evidence) · `--accept-degraded` |
| `ensemble-ai push-fence --pr <N\|url>` | The **fix tail's** fence: exit 0 iff you own the PR's head ref; exit 5 = REFUSED (fork / no push access) → stage a pending review instead. Never pushes, never routes. | `--pr <N\|url>` · `--cwd <dir>` |
| `ensemble-ai reviewers` (alias `config`) | Print the **resolved** seats — reviewers (`reviewers.json`) + voices (`voices.json`): id · vendor · model · effort · advisor · sandbox + source file. Read-only. | `--json` · `--reviewers-file <p>` · `--voices-file <p>` |
| `ensemble-ai diff [<pr-url>]` | Cost-preview / debug: the exact packet the reviewers WOULD get (identity + coverage + prompt size) — no vendor called. | same diff sources as `review` · `--profile code\|security` · `--full` · `--json` |
| `ensemble-ai pin-check` | Is your **pinned** ensemble-ai current with `main`? Compares the checkout's commit against `origin/main` and reports the drift (`current` / `STALE — N behind` / `ahead` / `diverged`), so a consumer's own doctor/health check catches a silently-stale pin instead of running the old engine unnoticed. Exit 0 = current/ahead, 3 = stale/diverged, 1 = error. | `--repo <dir>` · `--pin <ref>` · `--main-ref <ref>` · `--no-fetch` · `--json` |
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

Each vendor CLI is located by its env override when one is set — `CODEX_BIN`, `GROK_BIN`, `CLAUDE_BIN`. **An explicitly set override is authoritative:** if the path exists it is used; if it does not, the seat fails closed with an error naming the variable and the path (`GROK_BIN=/x/y does not exist — unset it to use the default resolution`; a value that resolves elsewhere — relative, or with `..` — also names the path checked: `GROK_BIN=grok (resolved to /cwd/grok) does not exist …`) — it never falls back to another copy. So point an override at a path you control, not one an updater can prune. Unset or empty, resolution tries the default location (`~/.grok/bin/grok` for grok), then the login shell's `PATH`.

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

# claude-only: the Opus reviewer (+ --holistic lens) + the gate, no cross-vendor seat — e.g. while
# every vendor seat is out of credit. Reviewed, but no content-tied receipt is minted.
ensemble-ai review --reviewers claude
```

Options: `--base <ref>` · `--reviewers <ids>` · `--optional-reviewers <ids>` · `--out <dir>` · `--sandbox <profile>` · `--allow-sensitive` · `--ceiling <bytes>` · `--cwd <dir>` · `--run-id <id>`.

The **trail** defaults to a repo-local `.ensemble-ai/reviews/<run-id>/` when you're reviewing the current repo's own diff (it's gitignored, discoverable beside the code); a URL-PR / raw-diff / stdin review, or a non-repo cwd, falls back to an OS temp dir so a diff from a *different* repo never writes into your cwd. Override the base with `--out <dir>`. Trail + receipt files are written owner-only (`0600`). The `review input`, `receipt:`, and `trail:` paths are printed on **stdout**.

**Exit codes** (execution status, not a gate verdict): `0` = the review completed (even *with* findings) · `1` = a **required** reviewer failed (crash / timeout / no parse) · `2` = blocked by the diff secret-scan · `3` = usage / no diff.

**Optional seats — `--optional-reviewers <ids>`.** By default every seat on the roster must complete, or the run is exit `1` and nothing can be staged or posted. A vendor whose usage balance runs dry (incident 2026-09-28) then kills *every* review on that one seat, while the other core seat, the claude producer, the lens and the gate all completed. Listing a core seat (`codex` and/or `grok`) as optional changes exactly one thing: that seat's failure is printed **loudly** on stderr and in the per-seat block, and the run stands on the seats that completed — exit `0`/`4` as earned, `--stage`/`--post-comment` allowed, the gate judging the healthy voices as it already did. What does not change: the claude producer stays required whenever it is on the roster (it is never optional), at least one reviewer must still complete (every optional seat dead with nothing else on the roster is exit `1`), and **no receipt is minted** for a run with a failed seat, listed or not — the receipt is a fact about every required reviewer completing, and a degraded run is not that. `reseat` heals such a run exactly as it heals a failed one.

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

### The premise pass — `--premise` (opt-in, advisory)

`--premise` (**default off**) adds ONE advisory question to the gate's synthesis. When the gate's own findings **cluster** on a single region — two or more `≥medium` findings from **different** reviewers that it grounds to the **same region** (the gate's own proximity rule: same file, within a few lines) — a paragraph naming the clustered findings **by id only** (never a reviewer-derived path) is appended to the gate prompt asking it to add one extra `simplify` line: *name the shared structure the cluster keeps circling, and ask whether removing or simplifying it makes the whole cluster moot.* The line renders under the synthesis (`⤳ simplify (premise pass — advisory)`); it **changes no verdict, no exit code, and is never posted to a PR** — it is a nudge to fix the structure instead of hardening each finding one at a time. It is **opt-in for a public engine** on purpose: it appends a generic instruction (never a rewrite), and with the flag **off** the gate prompt and output are **byte-identical** to a run without it. Consumers that want it (e.g. a dashboard's review seats) pass `--premise` through.

### Worktree evidence mode — whole-project context, per seat

By default every seat sees the **packet**: the diff, the changed files, and the repo's conventions. That is *diff-local* — a reviewer cannot see that your new helper duplicates one that already lives in an unchanged file. **Worktree evidence mode** fixes that by materializing the PR head as a **detached, read-only worktree** of a repo you already have cloned, and giving qualifying seats read access to the whole project at `headSha`.

`review --repo <dir>` is **wired end to end**: it resolves the repo, runs the pre-flight, materializes
one hardened worktree, spawns every qualifying seat inside it — codex, grok, the Claude producer, and
the gate — records what each seat actually got, and reaps the worktree in a `finally`.

```bash
# Review a PR with whole-project evidence, and stage the result as a PENDING review:
ensemble-ai review --pr https://github.com/o/r/pull/7 --repo ~/code/r --stage

# Add the holistic/architecture lens (it runs ONLY with worktree evidence):
ensemble-ai review --pr https://github.com/o/r/pull/7 --repo ~/code/r --holistic

# `--repo` makes `receipt verify` ask the STRONGER question, and a weaker receipt fails by name:
ensemble-ai receipt verify --repo ~/code/r                     # → EVIDENCE DEGRADED: codex realized unknown, intended worktree…
ensemble-ai receipt verify --repo ~/code/r --accept-degraded   # take the weaker evidence anyway, deliberately
```

`review --repo` needs the **full PR URL**. The pre-flight proves your checkout is the PR's base repo
by comparing its remotes' fetch URLs, and materialization asserts `HEAD == headSha` — a bare `--pr <N>`
carries neither, so it is refused upfront rather than reviewing the packet while you believe you asked
for whole-project evidence.

> **Status — `receipt verify --repo` cannot yet FIND a worktree-mode receipt.** Two gaps, both
> pre-existing, neither introduced (nor closed) by the review-side wiring: `verify` computes only the
> **v1** receipt key — it must compute the v2 key, which binds the run's sandbox profiles, and pass
> the v1 key as `legacyKey` (`resolveReceipt` already implements that fallback) — and it derives its
> live diff identity from the **local checkout** (`--staged` / `--working-tree` / a commit range),
> which can never key a `pr`-mode diff. So a `review --repo` receipt and a `verify --repo` query are
> addressed by different keys today. Worktree receipts *are* minted, complete and correct, and
> `receipt show` reads them; teaching `verify` to ask for them is its own change.

**Your checkout is never written.** Each review materializes into its **own private repo** under an owner-only temp parent — a **hardlink clone** of your checkout's object store (`git clone --bare --local`: linked, not copied — instant on one volume — and **self-contained**: a `gc` in your checkout cannot pull objects from under a running review, and the fenced seats can run `git log`/`git blame` over the whole history), `fetch pull/N/head` from the remote's **explicit URL** (never assuming `origin` exposes PR refs), then a detached worktree added **from that private repo**. It **asserts `HEAD == headSha` before any seat runs** — a mismatch aborts rather than reviewing wrong-SHA evidence. Materialization is inert by construction: no hooks, no submodule recursion, no LFS smudge (so an in-tree `.lfsconfig` is never honored), tracked files only, no deps installed. The fetch is **not shallow**, so the history packet's `git log`/`git blame` keep working; the hardlink clone keeps it cheap (a shallow or partial checkout is not cloned — the private repo then starts empty and the fetch brings everything). Repository-selecting env (`GIT_DIR`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_SHALLOW_FILE`, …) is scrubbed from every git the engine spawns, so nothing inherited from a hook or a shell can point the private repo back at your checkout. Your checkout's transport config (`core.sshCommand`, `credential.*`, `http.*`, `url.*` — `includeIf`'d keys included) is handed to the fetch **per command** through git's own `GIT_CONFIG_COUNT` env (git ≥ 2.31): it lives in the fetch process for the seconds it runs and is never written to disk, so no credential is ever parked where a fenced seat could read it. Nothing is written into your shared `.git`, which is byte-identical afterwards — so **N reviews of one repo run in parallel with no lock, no TTL, no waiting**. Reap removes the whole temp parent (worktree + private repo) in a `finally`. Pre-flight fails **closed** with a named cause: `wrong-repo` · `no-such-pr` · `network` · `auth` · `not-a-repo` · `disallowed-root` · `sha-mismatch`. An optional `allowedRepoRoots` array in `~/.ensemble-ai/config.json` restricts which repo roots may be materialized at all — consumer policy, never baked into this engine.

**A seat gets the worktree only under a deny-by-default sandbox** — repo-rooted, secret-denied. Fail-closed **per seat**: no qualifying sandbox, that seat keeps the packet, and the fallback is **loud** (receipt, footer, stderr), never silent.

Per seat:

| Seat | Receipt profile id (`sandboxProfiles`) | What fences it | Worktree | Falls back to the packet when |
| --- | --- | --- | --- | --- |
| `grok` | `ensemble-review-grok+proxy-env-noshell` v4 | **Reads:** `ensemble-review` (Seatbelt/Landlock, `strict` base + secret deny-list), rooted at the worktree via `--cwd` — kernel-enforced. **Egress:** proxy **env vars only** — grok's `sandbox.toml` schema has no network keys, and `strict` does not deny a child process network, so nothing at the kernel denies direct outbound; what bounds an injected tree is that the seat has **no shell** — the **tool fence**: `--tools read_file,list_dir,grep` + `--deny Bash`, **verified at spawn** from the tools grok announces (anything else, or no announcement, kills the seat before its first turn) | yes | it resolves to any other profile (bare `strict` lacks the secret deny-list the receipt attests) |
| `codex` | `ensemble-review-codex+egress-proxy-kernel` v3 | An ensemble-owned Seatbelt wrapper (codex's internal sandbox is off inside it — nested Seatbelt doesn't compose). **Reads and egress are both kernel-enforced:** all outbound is denied except the one loopback port where the engine's CONNECT proxy applies the vendor host allowlist | yes, on macOS | Seatbelt is unavailable · the profile refuses to build (an unsafe read root) · **the wrapped review provably produces nothing** |
| `claude` | `claude-capability-fence` v1 | A **capability** fence, **not** a kernel sandbox: no Bash, no MCP, no network, a neutral spawn cwd (so the tree's `CLAUDE.md` is never loaded as instructions), the worktree as the sole `--add-dir` read root, and `$HOME` denied to every read tool | yes | never (it is the harness's own spawn) |
| `gate` | `claude-capability-fence` v1 | the same capability fence | yes | never |

**v4 is the first `noshell` that holds.** v2/v3 passed `--disallowed-tools bash`, which matched no grok tool — the shell is `run_terminal_command`, and grok's denylist cannot remove it at all — so every v2/v3 grok seat held a working shell (incident 2026-10-01). An allowlist does remove it, but one name grok does not know makes it ignore the whole list and fall back to its full default set; that is why the engine checks the announced tools instead of trusting the flag. Read a v3 receipt as *shell present*.

**The two core seats' ids differ on the MECHANISM, and that is the point.** `codex`'s id says `-kernel` because Seatbelt refuses its every direct connection; `grok`'s says `proxy-env-noshell` because its egress is merely *routed* by `HTTPS_PROXY` and what actually contains it is the absence of a shell. Read a receipt's `sandboxProfiles` and you learn which guarantee you have without reading this file — an id that implied grok held codex's kernel fence would be the exact over-claim this evidence machinery exists to prevent. Versions advance across a rename and never reset, so no `(id, version)` pair is ever reused for two different fences, and receipts issued under an older id stay readable under that id.

The codex **wrapper viability check is the review itself**, not a `--version` smoke: the seat runs
its real prompt under the real profile with a real pty/subprocess, and only a run that produces
nothing usable triggers the fallback. That fallback is **loud** — stderr, the receipt's realized map,
and the posted review's footer all say the seat reviewed the diff-only packet. Accepting a degraded
run is a human's call, never a silent downgrade. A seat that merely *times out* under its sandbox is
not a viability signal, so it is not re-run: it stands as a failed reviewer, and a failed reviewer
cannot qualify a receipt.

**Two watchdogs per core seat, and the liveness one does the real work.** Both `codex` (`--json`) and
`grok` (`--output-format streaming-messages-json --include-partial-messages`) emit a machine-readable
progress stream while they work — grok's carries the model's *reasoning* deltas, so silence really
does mean a wedged seat rather than a long think. **15 min with nothing on that stream** reclaims the
seat, and the trail says so (`timedOutReason: inactivity`, plus a bounded tail of the stream beside
the reply). The absolute cap is then a **runaway backstop** rather than the thing policing honest
work: **60 min** in the worktree for both seats, and on the packet **30 min** for `grok` (whose seats
now legitimately run 10-15 min) against `codex`'s 15. A killed honest seat loses everything already
paid for; a wedge dies in 15 either way.

**Honest containment.** The wrapper denies **exec** of any path inside the worktree, but a shell-capable agent can still read an untrusted file as *data* (`sh worktree/x.sh`). No-exec narrows the vector; it does not close it. The rest of the profile is the real boundary, and it is narrower than "nothing but the worktree" — state it exactly:

- **Reads.** `$HOME` is not readable, so no ssh key, vendor credential, or other repo on disk is reachable — except `~/.codex`, which the seat must read to call its own API. The allowed *system* roots include `/private/var`, which contains the per-user `$TMPDIR`; a secret another process parked in its own temp dir **is** readable. The claim is "no credential in `$HOME`", not "no credential anywhere". A read root that is, or contains, `$HOME` (`~/bin/node` ⇒ `nodePrefix` = `$HOME`) is **refused**: the profile fails to build rather than grant it.
- **Writes.** `~/.codex`, `/private/tmp` (the legacy world-shared `/tmp`, not the per-user `$TMPDIR`), and `/dev`.
- **Network.** Host-scoped, via the engine's egress proxy. The profile denies **all** outbound except one loopback port — the in-process CONNECT proxy this run starts for the seat, which tunnels only to the vendor's host allowlist — plus the single path-scoped `mDNSResponder` unix socket `getaddrinfo` needs. Verified under this exact rule set (2026-07-10): TCP `*:443` EPERM · TCP **and** UDP `*:53` EPERM (the old DNS-exfiltration channel is closed) · the one allowed loopback port connects · a different loopback port EPERM. Inbound stays any local port (codex binds loopback helpers). Seatbelt cannot express a per-host rule itself (`(remote tcp "api.openai.com:443")` is rejected), which is *why* the fence is a proxy the profile pins the seat to rather than an SBPL rule. **Two residues, stated:** the seat sends its own credential to the **allowed** vendor host — irreducible without a token broker, and an allowed host is allowed for arbitrary bytes — and hostname *resolution* survives via `mach-lookup` to `mDNSResponder` (not a `:53` socket), so a low-bandwidth resolver side channel remains. Denials are loud: stderr, `egress-denials.json`, and the posted review's footer. A proxy that cannot start fails the seat **closed**.

Outside macOS the codex seat falls back to the packet.

**Evidence is part of the receipt's identity.** The receipt records the **intended** per-seat evidence map (policy) and the **realized** one (fact) as separate things, plus each worktree seat's sandbox profile id + version — so a degraded mixed run is never receipt-equivalent to a full-worktree run. A worktree seat **must** bind a sandbox profile: "the seat could read the whole project" is only a safety claim together with "under this profile, at this version", so `buildDiffReceipt` refuses to mint a receipt that claims worktree evidence for a seat with no profile identity. A legacy receipt carries no realized map, which reads as `unknown` — exactly as strong as `packet` (the packet is all that existed when it was issued), and strictly weaker than `worktree`. `policyHash` is **versioned**: an all-packet run hashes under the legacy schema, byte-for-byte as before, so turning worktree mode *off* changes no receipt identity and no existing receipt is staled. The verification contract — `computePolicyHashAt` under the receipt's **own** issued version, then a separate realized-vs-intended comparison in which a legacy receipt's missing realized map reads as `unknown` = *weaker* and fails only when worktree evidence is requested (`acceptDegraded` overrides) — is implemented and tested in `isDiffReviewed` / `verifyReceipt`, and **`receipt verify --repo <dir>` now passes those inputs** (passing the repo location IS the request for worktree evidence, spec §8). Without `--repo` the evidence check is a no-op and v1 semantics are untouched. An `evidence-manifest.json` joins the trail — the tracked tree at `headSha` with blob SHAs, i.e. the **readable surface** each worktree seat was given. It is advisory and never hashed. (Opaque vendor CLIs do not report their file reads, so it is honestly named: what a seat *could* read, not what it *did*.)

**The gate reads the same worktree**, which makes it an evidence-bearing actor in its own right. On worktree evidence it may emit a new downgrade cause, **`reference-not-found`** — "I could not locate what this finding references at `headSha`", the hallucinated-reference red flag — alongside the existing `truncated` / `missing`. The gate is **taught** the cause only when its realized evidence is `worktree`, and the host **honors** it only then: a gate that saw a ±25-line window cannot distinguish "does not exist" from "outside my window", so a packet-fed gate is never told the cause exists, and a cause arriving on packet evidence anyway is dropped with a warning. Teaching and honoring are gated on the same fact. Consumers opt in by keying on the cause; old artifacts keep their meaning.

**The Claude producer** in worktree mode runs the built-in `/code-review` methodology (bugs + structural quality — never style or naming nits) with whole-project context, and maps its findings into the same schema Codex and Grok emit. One Claude producer, not two: same-family corroboration is weak signal and pure dedup load.

### CI evidence — the checks' own output, in the packet

On the PR path the engine fetches the head commit's **check runs, their annotations, and its commit
statuses** through `gh` and hands them to every seat as a budgeted **"CI evidence"** packet section
(after the changed files, before the conventions). The reviewer ask carries a standing clause: a
check's *conclusion* is not the evidence — its annotations and output are — and a **warning or
notice annotation whose text is an error is a downgraded failure**, i.e. a finding candidate.

Why (incident 2026-08-10): the worst defect of a reviewed change — a migration the database
refused — was printed verbatim in a *green* job whose validation step downgraded the error to a
`::warning`. Every reader reviewed the SQL as text; the machine's own result sat unread.

- Default **on** for `--pr`/URL sources; `--no-ci-evidence` opts out. A local diff has no checks.
- Best-effort: a `gh` failure renders a loud **UNAVAILABLE** section with the reason and one stderr
  line — it never blocks a review.
- Same trust class as the diff and the PR description (repo-CI text the seats already receive).
  Scanned **twice**: every untrusted field before truncation (a hit renders `[redacted: <kind>]` in
  place, keeping the rest of the evidence), then the whole rendered text (a hit there **withholds**
  the section). Check output is leakier than a diff — machine-printed, so it echoes headers and
  exported tokens — so it is scanned with extra patterns the diff scan never uses.
- Unlike the diff, check output can carry text from installed apps and bots (not the repo owner or
  the PR author) and URLs pointing at internal CI hosts — the section is hedged as untrusted data in
  every prompt, a URL is rendered only as `http(s)` without query, fragment, or userinfo, and
  `--no-ci-evidence` opts out per run.
- Caps: 10 annotated checks × 25 annotations, ~14k chars structurally, 16k in the packet budget.
- The rendered body also lands in the trail as `ci-evidence.md`.

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
`--holistic` (**default off**) adds an Anthropic seat (default **`opus @ high`** — a single MED-capped seat needs less than the producer bar; pin it per fire with `--holistic-model`/`--holistic-effort`, or per machine under a `holistic` key in `voices.json`) that reviews the change *against the tree it lands in*: a helper that **reinvents** one already living elsewhere in the project (usually in a file the diff never touches), a **convention** the diff drifts from, a design that collapses to something **simpler**. It is a seat in the registry — switched by the consumer's review-depth policy — not a parallel pipeline. Its findings flow through the same gate → edit-ops → dedup → posting machinery as everyone else's, and the gate stays a judge: it never generates findings of its own.
Because a wrong *"use the existing util X"* is the most credibility-burning comment a robot can leave on someone else's PR, the lens is fenced by mechanism rather than by instruction:
- **Worktree evidence or it does not run.** No worktree ⇒ no seat, no findings, and it says so on stderr. It never reviews on the packet. (`review --repo <dir>` is what supplies the worktree; `--holistic` without `--repo` resolves to exactly that loud skip.)
- **Both sites, or it does not post.** A holistic `agree` must quote **the reinvention in the diff *and* the existing pattern's home**, each at `file:line@headSha`. The host re-reads both out of the tree and matches the quotes itself; a site it cannot locate becomes `unverified · reference-not-found` — the same hallucinated-reference cause the gate already emits, sound here precisely because the lens only ever runs on worktree evidence. The host verifies that both quotes are **real, and sit where they are claimed to sit**, and that the two do not quote the *same* lines. It does not require the pattern's home to be in an unchanged file: a PR that both edits the canonical util and reinvents it is a finding worth making. Whether the two are genuinely the same thing is the lens's judgment, not a host guarantee.
- **Agree-only.** A `partial` ("a kind-of-similar pattern exists") stays in the trail and never reaches the PR. Findings are framed as suggestions.
- **Severity capped at MED, and only a *citation* lifts it.** The cap is exceeded only when the verdict carries a citation of a **conventions doc** that the host locates verbatim at `headSha`. When the run gathered a conventions manifest, *that manifest is the authority* — a doc it did not gather cannot uncap, so a vendored `node_modules/**/CONTRIBUTING.md` in an untrusted tree is not a back door. (With no manifest at all, the canonical filenames are the fallback; a README is never one.) A model asserting importance never uncaps — the check is code, not a request.
- **One seat, so never corroborated.** Holistic findings are excluded from cross-reviewer clustering: they cannot receive a "flagged by *N* of *M*" count, and cannot inflate anyone else's. They are also excluded from the HIGH gate — a suggestion about architecture never flips the exit code.
- **A clean holistic pass is not an architecture certification.** The search space is the whole tree, so run-to-run variance is expected: the lens finds valuable things when it looks. Silence means it did not find one this time.
**Acceptance fixture** (`fixtures/holistic/`): a small planted tree with **several** reinventions the lens must catch and **several** near-miss lookalikes it must not flag — a util that resembles the canonical one but rounds half-to-even, preserves case, or paces a queue instead of retrying. `scoreHolisticFixture()` grades a live run against it. The vitest suite runs the *gating* mechanics deterministically against that tree with a stubbed seat (both-sites quoting, the citation-required uncap, agree-only posting, the symlink fence) — it does **not** claim to prove the model's judgment, which no stub can. What the host guarantees is that a citation is real; that a *comparison* is sound is the lens's job, and the negative half of the fixture is how you measure it.

### Healing a run — `regate` and `reseat`

Two plumbing commands rehydrate an existing run's **trail** instead of re-running the review:

- **`ensemble-ai regate --out <dir> --run-id <id> [<pr-url> --repo <path>]`** — the synthesis gate died
  (timeout, quota) and fail-closed every verdict to `unverified` while the reviewer work sat complete
  on disk. Re-spawns ONE gate seat over the persisted reviews + pinned packet and rewrites
  `gate-verdicts.json` + `claude-synthesis.json` in place. No reviewer re-runs.
- **`ensemble-ai reseat --out <dir> --run-id <id> --seat <codex|grok> [<pr-url> --repo <path>]`** — one
  core seat died (incident 2026-09-02b: a vendor CLI's self-update broke its sandbox twice in a day)
  while every other seat and the gate completed. Re-runs JUST that seat against the run's own
  `prompt.<seat>.md` — byte-identical to what every seat saw, with the worktree preamble re-issued for
  the freshly re-materialized head — then regates the union. A preamble written by **another engine
  version** (the suffix's prose changed after the run was persisted — a reworded header line or
  read-only clause is still refused) is **re-rendered, not refused**: the pinned packet before its
  header is what stays byte-identical, and the `reseats[]` entry says so with
  `preambleRerendered: true`. A seat that completed is refused
  (re-running a healthy seat is a new review); `claude` is not supported yet. Without `--repo` (or when
  the worktree cannot be made) the seat **and the regate of the whole run** fall to packet evidence —
  reference-not-found + holistic verification OFF. **A packet-mode retry is PERMANENT for that seat** —
  it overwrites the seat's persisted prompt and a reviewed seat is never retried — so pass `--repo`
  whenever the run had worktree evidence. The attempt is stamped into `claude-synthesis.json`
  (`reseats[]` — including *why* a worktree was not used, so a lost `--repo` is distinguishable from a
  deliberate packet retry) and the manifest is updated best-effort (when the run wrote one): the seat's
  realized-evidence entry is rewritten, and its `sandboxProfiles` entry is rewritten by a worktree
  retry or **dropped** by a packet one — a packet retry ran behind no fence, and the manifest must not
  attest one it never entered.

Neither re-runs the execution settler, the shadow gate, or the receipt — a healed run keeps the receipt
its original roster earned. Exit `0` healed · `1` failed again (for `reseat`, also anything that fails
after the seat was spawned) · `3` a pre-spawn refusal — usage, a missing trail, a healthy seat, a
malformed or incomplete seat packet, a worktree at a different head, a persisted prompt pinned at a
different head than the run's gate packet, another reseat already running on the same run (they are
serialized by an `O_EXCL` `reseat.lock` in the trail dir) — where nothing was billed.

### Configuring the seats — `reviewers.json` and `voices.json`

Every seat is **config, not a hardcode** — two JSON files under `~/.ensemble-ai/` (each env-overridable: `ENSEMBLE_REVIEWERS_FILE` / `ENSEMBLE_VOICES_FILE`). Run `ensemble-ai config` (alias of `ensemble-ai reviewers`) to print the **resolved** seats — id · vendor · model · effort · advisor · sandbox, plus which file each came from — so what you see is exactly what the modes run. Neither file needs to exist; a missing or junk entry falls back to the baked default (a bad config can never silently disable a seat). A Claude seat's invalid `advisor` is the one value that does not fall back: the file read keeps it as-is, `config` shows it marked invalid, and only a command that runs that seat refuses it (below).

**`~/.ensemble-ai/reviewers.json`** — the cross-vendor **reviewers** (Codex + Grok), the diff-facing lenses:

```json
{
  "codex": { "model": "gpt-5.6-sol", "effort": "max" },
  "grok":  { "model": "grok-4.5", "effort": "high" }
}
```

- **Switching a seat OFF** — two independent fields, the one case where config may *subtract* a
  seat. `"enabled": false` is the **indefinite** switch (off until an operator edits the file back);
  `"disabledUntil": "2026-09-29T00:00:00Z"` is a **quota window** — the seat is off while `now <
  disabledUntil` and comes back **by itself** once it passes, so losing a vendor to a usage limit is
  one date and no restore step. A seat is off when either applies. Both are read STRICTLY — a
  literal boolean, and an ISO 8601 date-time **carrying its zone** (`Z` or `±HH:MM`). Anything else
  drops the field and the seat stays **on**: the junk-can-never-disable-a-seat rule above, extended
  to the forms `Date.parse` would otherwise wave through (`2027`, `9/29/2026`, the impossible
  `2027-02-30`, and a zone-less `2026-09-29T00:00:00`, which would mean two different moments on two
  hosts). `enabledReviewerIds(config, now)` is the ONE owner of "which seats are on" — on **both**
  entries (`ensemble-ai` and the browser-safe `ensemble-ai/contracts`, since it is pure), so a UI
  greys a seat with the same rule a fan-out drops it by. Switch every seat off and it returns `[]`:
  that is the FACT that no seat is on, and a consumer must read it **fail-closed** (nobody reviewed
  the diff), never as a vacuously satisfied required-seat set. The `ensemble-ai` CLI's own fan-out
  does not read it yet, so `ensemble-ai review` still runs every seat you name. `ensemble-ai config`
  prints every seat and marks the off ones (`· OFF until <instant>` / `· OFF (enabled: false)`), and
  **`config --json` carries `enabledReviewerIds`** (resolved at print time by that one owner) plus
  **`offSeats`** (`[{ id, until }]`, `until` null for an indefinite `enabled: false`) — so a consumer
  that fans out through the CLI reads the roster there and passes `--reviewers` with the seats that
  are on, instead of re-deriving the rule from the file. With every cross-vendor seat off, that is
  `--reviewers claude` — the **claude-only** review (since 2026-10-02): the Opus reviewer, the
  holistic lens and the gate run as usual, the run stands on them exactly as it already did when
  every optional core seat died (incident 2026-09-28), and **no content-tied receipt is minted**
  (`buildDiffReceipt` refuses an empty core — codex/grok are what tie a receipt to a second vendor).

**`~/.ensemble-ai/voices.json`** — the Claude **voices** (`claude` = the brainstorm/consult voice **and** the cold-Opus review reviewer) plus the **`gate`** seat (the verified-gate synthesizer). The gate takes **`model`, `effort`, and `vendor` only** — the spawn is always one of the two FENCED runners, picked by `vendor` (anthropic = `claude -p` under plan-mode + write-tool deny, the default; codex = the sandboxed, egress-fenced codex runner), so a `cmd` key on the `gate` seat is **ignored + warned** (the read-only posture can't be configured away). This makes "reviewer = Opus @ high, **gate = Fable @ max**" expressible:

```json
{
  "claude": { "model": "opus", "effort": "high" },
  "gate":   { "model": "fable", "effort": "max" }
}
```

- **Gate resolution chain:** the `gate` entry → the `claude` entry (model/effort only) → the built-in default (**Opus**). A `gate` seat with no `voices.json` at all is byte-for-byte today's default gate.
- **Gate VENDOR (the sol-gate axis):** `--gate-vendor <anthropic|codex>` → the `gate.vendor` file key → `anthropic`. `codex` puts the shadow-proven judge in the seat — the SAME fenced codex runner the shadow trial used (baked seat **`gpt-5.6-sol @ xhigh`**; codex validates its own effort ladder, `low..xhigh|max|ultra`). An entry's model/effort are SCOPED to the vendor it declares: re-vendoring by flag never carries `gpt-5.6-sol` into a claude spawn (or `fable` into a codex one) — skipped loudly, falling to the resolved vendor's defaults. With `--shadow-gate` the shadow REVERSES automatically: a codex gate is shadowed by the anthropic champion (resolved through the claude chain), and vice versa. The runner binding is CODE, never config — no file can point the gate at an unfenced spawn. (`regate`/`reseat`/`probe` pin anthropic for now — their paths bind only the claude runner.)
- **Per-run override:** `--gate-model <m>` / `--gate-effort <e>` beat the file for one run (an effort outside `low|medium|high|xhigh|max` is ignored — today's whitelist, kept). Codex/Grok stay per-reviewer-configurable via `reviewers.json`.
- **Claude REVIEWER seat:** `--claude-model <m>` / `--claude-effort <e>` → the `claude` entry → the **baked `opus @ max`**. Unlike the gate, this chain never ends at the `'default'` sentinel: a headless seat must not inherit the operator's interactive CLI default (a `/model` switch to Fable minutes before a fire once burned the Fable cap and failed the leg as "review INCOMPLETE").
- **Holistic lens seat:** `--holistic-model <m>` / `--holistic-effort <e>` → the `holistic` entry → the baked **`opus @ high`** (the lens is single-seat, MED-capped, and runs a bounded three-class search — max bought little over high). Read only when `--holistic` is on and the run has a `--repo` worktree (the only runs the lens spawns on); same junk-config-never-disables-a-seat posture as the gate.
- **Shadow gate (audit-only):** `--shadow-gate` runs the **codex seat's model** (default effort `xhigh`, `--shadow-gate-effort` overrides) over the *identical* rendered gate prompt — champion/challenger for a possible cross-vendor gate. Its verdicts go through the same host reconcile + clustering and land in `shadow-gate-codex-verdicts.json` (+ raw transcript) with a per-finding comparison vs the authoritative gate; `authoritative: false` is stamped in. Synthesis, posting, dismissals, and the exit code never read it, a shadow failure never touches the run, and a comparison is computed only when the primary actually judged (a fail-closed primary's host-forced verdicts are not a judgment). On a packet-fail run the shadow is skipped loudly — nothing can be grounded for either judge.
- **A Claude seat's ADVISOR — explicit, never inherited by accident.** Without it, every headless `claude -p` seat silently uses whatever `advisorModel` the operator's `~/.claude/settings.json` sets. An optional **`advisor`** key on a Claude seat states it instead — on the `claude`, `gate`, and `holistic` entries of `voices.json`, where every CLI Claude seat resolves from. `reviewers.json` carries no advisor: no CLI spawn reads its `claude` entry, so a library consumer that runs the claude adapter sets `ReviewerConfig.advisor` itself.

  ```json
  {
    "claude":   { "model": "opus", "effort": "max", "advisor": "claude-fable-5-1" },
    "gate":     { "model": "fable", "effort": "max", "advisor": "off" },
    "holistic": { "model": "opus", "effort": "high" }
  }
  ```

  | `advisor` | the seat's `claude` invocation gets | effect |
  |---|---|---|
  | a model id (`claude-opus-5-5`, `fable`, …) | `--settings '{"advisorModel":"<id>"}'` | that advisor, overriding the operator's setting |
  | `"off"` | no flag; `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` in its env | **no advisor**, even when the operator's settings enable one — the CLI's kill switch, because no `--settings` value disables the advisor (measured 2026-10-04 on Claude Code 2.1.289: `""` enables a default advisor) |
  | key absent | no flag | inherits the operator's settings (the behavior before this field) |

  Each seat reads its **own** entry only — there is no gate → claude inheritance for `advisor` (unlike model/effort), so "inherit the operator's setting" stays spellable on every seat. **One exception:** a `gate` entry scoped to codex (`"vendor": "codex"`) that a run re-vendors to an anthropic gate — `--gate-vendor anthropic`, or `regate` / `reseat` / `probe`, which always run an anthropic gate — is not a Claude seat's entry, so its `advisor` is ignored (with a warning) and that gate takes the **`claude` entry's** advisor instead: the one advisor home for Claude spawns. Without it those spawns could only inherit. It applies to every `claude` invocation the engine builds: the review seat, the brainstorm/consult voice, and the execution seat (settler · prober). **Validated once, where it is used:** at the up-front resolution of the seats a command will actually spawn — the claude reviewer, the gate (when it is anthropic; from the `claude` entry in the codex-scoped case above), the holistic lens (with `--holistic` on a `--repo` run — without a worktree the lens never spawns, so its advisor is not read), the brainstorm/consult roster — before any seat runs. The rule: `"off"` or a model id matching `^[a-z0-9][a-z0-9.-]*$`. Anything else — including `null` (omit the key to inherit) — refuses **that command** with exit 3 and an error naming the seat, never a silent fallback, because the only fallback would be the inheritance the field exists to end. A seat the command can never run is never checked: a typo on the `claude` entry does not break `review --no-claude` or `brainstorm --voices codex,grok`, and a codex gate ignores its `advisor` with a warning. A seat the command *may* run is checked up front even when it ends up not spawning: `probe` resolves its gate before the prober runs, though the gate spawns only when the prober reports a `broke` finding — so an invalid gate advisor refuses a probe that would not have needed it. The config read never throws: `ensemble-ai config` shows a stated advisor on its row (`· advisor <x>`) and a rejected value marked `(INVALID — …)` — on the claude voice, the gate and the holistic lens alike, each row keeping the seat's resolved vendor, model and effort; `config --json` carries the `voices` advisors, `gate.advisor` and `holistic.advisor` as written (absent = inherits). **The trail records it beside the model it advised:** `advisor` on `review.claude.json` / `review.holistic.json`, `· advisor <x>` on the posted gate seat line and on `probe`'s seat line, `prober.advisor` / `gate.advisor` on `probe-report.json` (beside each seat's `model` and `effort`), and `seat.advisor` on the shadow gate's verdicts — absent = the seat inherited, so `"off"` and inherit stay distinguishable. Library consumers that launch `claude` themselves use the same exports: `parseSeatAdvisor` / `isSeatAdvisor` (the rule, also on `ensemble-ai/contracts`), `claudeAdvisorArgs` (the argv) and `claudeAdvisorEnv` (the env to merge over the parent's — `"off"` lives only there); both re-check the value, the backstop for a config no resolver saw.
- **Web for a VOICE — `web: true` (brainstorm / consult only).** On the `claude` entry, the voice runs with `WebSearch` + `WebFetch` available AND pre-approved for the headless spawn (`--tools WebSearch,WebFetch --allowedTools WebSearch,WebFetch`; without `--allowedTools` a `-p` spawn silently denies the permission-gated fetch), under a `--max-turns 25` cap. On the `codex` entry it is the vendor's own live search (`codex exec --search`, the Responses `web_search` tool run behind `api.openai.com`); on the `grok` entry grok's `web_search` joins the tool allowlist (`--disable-web-search` dropped) and the tool fence expects exactly that one extra name — the init line still refuses anything else. The progress line and `config` show ` · web`. Off by default, and never read by the review seats: the vendor-side searches add no local egress, but claude's WebFetch is the local CLI fetching an arbitrary URL — a prompt-injected topic or `--file` can carry text out in a URL. A voice sees only the prompt and that file, which is why the opt-in lives here and not on a review seat with a worktree behind it.
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

Options: `--file <path>` · `--evidence-root <dir>` · `--voices <ids>` · `--synthesizer <id>` · `--timeout <seconds>` · `--voices-file <path>` · `--json` · `--cwd <dir>`.

**Liveness (2026-10-09).** The claude voice runs `--output-format stream-json`, so the engine sees it work: a voice is reclaimed only after **10 minutes of total silence** (the same inactivity watchdog as the review seats; codex and grok already stream), and `--timeout` is a per-call **runaway backstop**, not a deadline — size it in hours and a working voice is never the thing it kills. A reclaimed voice's result carries `timedOutReason` (`inactivity` = it wedged · `absolute` = still working when the backstop cut it, give it budget), a named `error`, and `tail` — what it was doing last (`assistant: WebSearch`).

**`--evidence-root <dir>` (2026-10-09).** A sealed directory of RAW evidence beside the file under review — its linked pages, the ticket, the discussion, prior reviews, the code pinned at a commit — that **every voice reads on every call** (answer, critique, synthesis, debate, judge) behind the review seats' fences: codex in its kernel sandbox with the root as the read root, grok behind its tool fence + egress proxy, claude behind the capability fence (neutral cwd, `--add-dir`, no MCP, no Bash, no WebFetch, the home-read deny — `WebSearch` stays for a `web` voice). The prompt carries the file **in full** (the 24,000-char cap is lifted to 120,000 behind a root) plus the root's `INDEX.md` and the citation contract: every point names the section and the evidence path it checked, `settled: <path>` when the evidence already settles it. The root must live **outside `$HOME`** (the fence denies every read under it) — the CLI refuses otherwise.

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

The rounds: **(1) answer** — each voice answers the question *independently* (no anchoring), so concurrence across voices is a real signal; **(2) critique** *(optional, `--critique`, off by default)* — each voice reviews the *others'* answers; **(3) synthesize** — one voice separates **AGREEMENTS** (the confident core) from **DIVERGENCES** (flagged "look closer", recording who took which position) and gives a bottom-line recommendation.

**`--debate` — argue the divergences with evidence, then an independent judge rules.** The synthesis is one voice's reading, and when that voice also answered, it is a party judging its own case (on a two-voice run it sides with itself more often than not). `--debate` adds rounds after the synthesis: every diverging voice argues *its* side of each split with **proof** — a quote from the shared `--file` (`doc §3.2`), a web source (`web <url>`, with `web: true` on the voice), or a mechanism argument marked `reasoning` — answers the other side's *evidence*, and ends each split as `hold`, `move` or `concede`. Two guards against the known failure modes of model debate: a voice may move or concede **only by naming the evidence that moved it** (an ungrounded move is parsed back to a hold — agreeing to be agreeable is the failure, so is holding without proof), and a split goes to another round **only while new evidence is on the table** (a voice moved → closed; nobody brought evidence → another round would be rhetoric → closed). At most `--debate-rounds <n>` rounds (default 2, max 4). Then a **judge** that took no part rules every split **by the evidence**: `settled` (the evidence decides — the position that stands, citing it; a "settled" that cites nothing is parsed to a judgement call), `converged` (a voice moved, for a stated reason), `judgement` (both reasonable, the evidence does not decide — the trade-off and a default, never a winner picked on taste), or `unverified` (it turns on a fact nobody checked — what would settle it, and a default), and writes the **final recommendation** in light of the rulings; the synthesizer's draft stays on `synthesis.recommendation`. The judge is a seat of its own: `--judge <id>` picks the voice it runs through and **voices.json `"judge": { "voice": "claude", "model": "…", "effort": "…" }`** pins its model, so the seat that rules is not the model that argued; the result records `debate.judge.independent` (a different model of the same vendor counts, the identical model that argued does not) and the progress line says `independent` or `ALSO ARGUED A SIDE`. Needs ≥2 healthy voices and ≥1 divergence, else it is skipped with a reason; a failed judge leaves the rounds in the result with no rulings. Cost: one call per voice per round plus one judge call, all with the voice's own tools (so a web-enabled voice can actually check a claim). This is consult's difference from brainstorm: brainstorm *generates + ranks ideas*; consult *answers a question* and surfaces the ensemble's consensus vs split. Default roster: **Codex + Grok + Claude**. Fail-closed on bad flags; any voice can fail without taking down the others; an unavailable synthesizer degrades to a clearly-flagged deterministic list that makes **no** agreement claim.

Options: `--file <path>` · `--evidence-root <dir>` · `--critique` · `--voices <ids>` · `--synthesizer <id>` · `--timeout <seconds>` · `--voices-file <path>` · `--json` · `--cwd <dir>`.

**Liveness (2026-10-09).** The claude voice runs `--output-format stream-json`, so the engine sees it work: a voice is reclaimed only after **10 minutes of total silence** (the same inactivity watchdog as the review seats; codex and grok already stream), and `--timeout` is a per-call **runaway backstop**, not a deadline — size it in hours and a working voice is never the thing it kills. A reclaimed voice's result carries `timedOutReason` (`inactivity` = it wedged · `absolute` = still working when the backstop cut it, give it budget), a named `error`, and `tail` — what it was doing last (`assistant: WebSearch`).

**`--evidence-root <dir>` (2026-10-09).** A sealed directory of RAW evidence beside the file under review — its linked pages, the ticket, the discussion, prior reviews, the code pinned at a commit — that **every voice reads on every call** (answer, critique, synthesis, debate, judge) behind the review seats' fences: codex in its kernel sandbox with the root as the read root, grok behind its tool fence + egress proxy, claude behind the capability fence (neutral cwd, `--add-dir`, no MCP, no Bash, no WebFetch, the home-read deny — `WebSearch` stays for a `web` voice). The prompt carries the file **in full** (the 24,000-char cap is lifted to 120,000 behind a root) plus the root's `INDEX.md` and the citation contract: every point names the section and the evidence path it checked, `settled: <path>` when the evidence already settles it. The root must live **outside `$HOME`** (the fence denies every read under it) — the CLI refuses otherwise.

**Exit codes:** `0` = answers produced (synthesis printed) · `1` = no usable output (every voice failed) · `3` = usage or an unexpected operational error.

## Design

- **Vendor-neutral by construction** — a reviewer is config (`id · model · effort · sandbox`); adding one is a registry entry, not a rewrite.
- **Read-only, OS-enforced** — a reviewer can never mutate the work (kernel-fail-closed, not tool-denial). Grok additionally runs under a *deny-by-default-reads* profile (`ensemble-review`), so it can't read secrets *outside* the diff packet; Codex runs under its own `-s read-only` (writes + network blocked) and the equivalent read-confinement for Codex is tracked as follow-up. The diff-payload secret-scan (below) is the cross-cutting guard for secrets *inside* the payload.
- **Diff-payload secret-scan** — the diff itself is the payload sent to a provider, so a preflight scan default-rejects diffs that carry secrets / sensitive paths (override with `--allow-sensitive`); every match is named in the manifest. Committed dotenv templates (`.env.template` / `.env.example` / `.env.sample`) are exempt from the path rule — their contents are still scanned for inline credentials.
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
