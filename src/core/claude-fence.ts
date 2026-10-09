// The claude seat FENCE data: which tools a read-only seat loses, which tools can read a file, and
// the path-scoped deny rules over the home directory. Lifted out of modes/review/claude.ts on
// 2026-10-09 so the brainstorm/consult voice can run behind the same fence over an EVIDENCE ROOT
// without a module cycle. Pure data and pure functions; the probes that justify each entry are
// documented where the data was born (modes/review/claude.ts header).

// The tools REMOVED from every review/synthesis seat. Encoded as data so a unit test pins the exact
// deny-list (a silent drop here is the difference between a fence and a suggestion). `Bash` is the
// load-bearing entry: without it the seat cannot execute anything the untrusted tree asks it to,
// and `WebFetch`/`WebSearch` close the egress side. The write tools were the original belt.
//
// `MultiEdit` no longer exists in the CLI (it warns "matches no known tool" on stderr). It is kept
// deliberately: the deny-list is a fence, and a fence names the tool BEFORE it comes back.
export const CLAUDE_REVIEW_DENIED_TOOLS = [
  'Bash',
  // The fan-out channel: a subagent is a fresh full-context conversation at the seat's own
  // model/effort — at opus@max a skill- or model-initiated fan-out multiplies the operator's
  // subscription burn ~15x (lived: run 2026-08-07-17-16-13 ate ~77% of a Max 5x window). The
  // seat is a cold SINGLE-PASS peer; both tool names are denied ('Task' is the older name —
  // a fence names the tool before it comes back). Fence version bumped: 1 → 2.
  'Agent',
  'Task',
  'WebFetch',
  'WebSearch',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
] as const;

// The read tools that a path-scoped deny rule must cover: every tool that can pull a byte of a file
// (Read, Grep) or enumerate one (Glob) out of a directory.
export const CLAUDE_READ_TOOLS = ['Read', 'Grep', 'Glob'] as const;

// PURE: `Read(//abs/path/**)` — the CLI's absolute-path permission rule (a single `/` prefixed to
// an already-absolute path). Probed 2026-07-10: a matching rule in `--disallowedTools` denies the
// read with "File is in a directory that is denied by your permission settings".
function denyUnder(tool: string, absDir: string): string {
  return `${tool}(/${absDir.replace(/\/+$/, '')}/**)`;
}

// PURE: deny every read tool on the home directory — where vendor auth (`~/.codex`, `~/.grok`),
// ssh keys, and every other repo on the machine live. This is the `secret-denied` half of spec §2's
// predicate, and the mechanical form of §9's "vendor-auth content cannot reach any model input".
export function homeReadDenyRules(homeDir: string): string[] {
  return CLAUDE_READ_TOOLS.map((t) => denyUnder(t, homeDir));
}

