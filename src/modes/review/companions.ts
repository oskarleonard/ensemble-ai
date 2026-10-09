import fs from 'node:fs';
import path from 'node:path';

import { STRIPPED_INSTRUCTION_PATHS } from './worktree';

// COMPANION REPOS for a worktree review (`--companion <name>=<dir>`, repeatable — hugin spec
// doc-review-evidence §8, 2026-10-09). A PR's other half often lives in a sibling repo (a
// lisk-app backend change whose deployment, subgraph config and env wiring live in lisk-infra).
// The caller exports each companion at a pinned commit (no .git, instruction files already
// stripped) and the engine places it INSIDE the worktree under `.companions/<name>/` after the
// worktree is materialized and before any seat spawns — so every fenced seat reaches it through
// the ONE read root it already has (codex's sandbox root, grok's cwd, claude's `--add-dir`), with
// no second grant and no fence change. Context only: the gate still grounds findings against the
// PR's hunks. The receipt records the companion names.

export interface Companion {
  name: string;
  dir: string;
}

export const COMPANIONS_DIR = '.companions';
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/;

// PURE-ish: `<name>=<dir>` → validated pairs. A bad name, a relative or missing dir, or a repeated
// name throws — the review refuses before any worktree is made.
export function parseCompanionFlags(values: readonly string[] | undefined): Companion[] {
  const out: Companion[] = [];
  for (const raw of values ?? []) {
    const eq = raw.indexOf('=');
    if (eq <= 0) throw new Error(`--companion expects <name>=<dir> (got "${raw}")`);
    const name = raw.slice(0, eq).trim();
    const dir = raw.slice(eq + 1).trim();
    if (!NAME_RE.test(name)) throw new Error(`--companion name "${name}" must match ${NAME_RE}`);
    if (!path.isAbsolute(dir)) throw new Error(`--companion ${name}: dir must be absolute (got "${dir}")`);
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      throw new Error(`--companion ${name}: ${dir} does not exist`);
    }
    if (!fs.statSync(real).isDirectory()) throw new Error(`--companion ${name}: ${dir} is not a directory`);
    if (out.some((c) => c.name === name)) throw new Error(`--companion ${name} given twice`);
    out.push({ name, dir: real });
  }
  return out;
}

export interface InstalledCompanion extends Companion {
  /** Where it landed inside the worktree (absolute). */
  installedAt: string;
  files: number;
  strippedInstructionFiles: string[];
}

const STRIPPED_BASENAMES = new Set(STRIPPED_INSTRUCTION_PATHS.map((p: string) => path.basename(p)));

// Copy each companion into `<worktree>/.companions/<name>/`. Symlinks are dropped (a link could
// point outside the read root); the instruction files the worktree rule strips are stripped
// here too, defensively — the caller normally already did.
export function installCompanions(worktreeDir: string, companions: readonly Companion[]): InstalledCompanion[] {
  const installed: InstalledCompanion[] = [];
  if (companions.length === 0) return installed;
  const base = path.join(worktreeDir, COMPANIONS_DIR);
  fs.mkdirSync(base, { recursive: true });
  for (const c of companions) {
    const dest = path.join(base, c.name);
    fs.cpSync(c.dir, dest, { recursive: true, dereference: false, errorOnExist: false, force: true, filter: (src) => !fs.lstatSync(src).isSymbolicLink() });
    let files = 0;
    const stripped: string[] = [];
    const walk = (d: string, rel: string) => {
      for (const n of fs.readdirSync(d)) {
        const full = path.join(d, n);
        const st = fs.lstatSync(full);
        const r = rel ? `${rel}/${n}` : n;
        if (st.isSymbolicLink()) {
          fs.rmSync(full, { force: true });
          continue;
        }
        if (st.isDirectory()) {
          walk(full, r);
          continue;
        }
        if (STRIPPED_BASENAMES.has(n)) {
          fs.rmSync(full, { force: true });
          stripped.push(r);
          continue;
        }
        files += 1;
      }
    };
    walk(dest, '');
    installed.push({ ...c, installedAt: dest, files, strippedInstructionFiles: stripped });
  }
  setCompanionNames(installed.map((c) => c.name));
  return installed;
}

// The names a review installed — ONE review per process, so the prompt sites read it here
// (the same module-state idiom as the prompt budget behind an evidence root).
let companionNames: string[] = [];
export function setCompanionNames(names: string[]): void {
  companionNames = [...names];
}
export function getCompanionNames(): string[] {
  return [...companionNames];
}

// The clause every worktree seat's prompt carries when companions are installed. Empty otherwise.
export function companionsClause(): string {
  if (companionNames.length === 0) return '';
  return `

## Companion repos — context, not under review

Sibling repos this change may depend on are checked out READ-ONLY inside the worktree under
\`${COMPANIONS_DIR}/<name>/\` at their main commit: ${companionNames.map((n) => `\`${n}\``).join(', ')}. Read them
for context (a deployment, a config, a consumer of this code). Cite a companion file as
\`${COMPANIONS_DIR}/<name>/<path>:<line>\`. They are NOT the change under review: a finding about the
PR must still anchor in the PR's own files; a companion citation supports it.`;
}
