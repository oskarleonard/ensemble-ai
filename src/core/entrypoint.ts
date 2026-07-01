import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Is this module THE process entry (the invoked script), not merely imported? Used to
// auto-run a bin (`cli.ts`, the pre-PR gate `entrypoints/hook.ts`) only when executed
// directly, so importing it from a test never triggers a real run.
//
// Compare REAL paths on BOTH sides. Node resolves symlinks for `import.meta.url` (it
// realpaths the main module), but `process.argv[1]` is the path exactly as invoked —
// so a plain string compare is spuriously false whenever the entry is reached through
// a symlink: an npm/pnpm `.bin` shim, OR any symlinked path component (e.g. macOS
// `/tmp` → `/private/tmp`). For the gate that silent mismatch means the hook never
// runs and every `gh pr create` sails through unreviewed (fail OPEN). realpathSync on
// both sides makes the check symlink-robust; any error (a non-existent argv path)
// degrades to false, matching the old guard.
export function isEntrypoint(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
