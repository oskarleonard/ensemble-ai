import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// THE CONSUMER CONFIG FILE — one reader, so the path and the tolerate-anything contract live in
// ONE place. Every key is read by a PURE selector over what this returns (`posting.<profile>` →
// posting-config.ts, `allowedRepoRoots` → worktree.ts), which keeps those selectors testable
// without touching the filesystem.
//
// Absent / unreadable / malformed ⇒ `{}`, exactly as if no file existed: a consumer who never
// wrote a config must still be able to run every command. This file is a preference surface, never
// a security boundary — the engine's hard caps are clamped in code, not read from here.
export const ENSEMBLE_CONFIG_PATH = path.join(os.homedir(), '.ensemble-ai', 'config.json');

// Narrow an untrusted value to a plain object, else null. Arrays are NOT records — a config key
// that arrived as `[]` must fall back to its default, not index to `undefined` silently.
export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function readEnsembleConfig(configPath = ENSEMBLE_CONFIG_PATH): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown) ?? {};
  } catch {
    return {};
  }
}
