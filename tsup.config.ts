import { defineConfig } from 'tsup';

// Two entries: the library surface (`index`, imported by consumers like the
// munin-dashboard) and the CLI (`cli`, the `ensemble-ai` bin). ESM output for
// node 20+. `dist/` is committed so a `github:` git-dependency installs with
// ZERO build step and ZERO transitive deps (the engine is node-built-ins only) —
// the most robust shape for a consumer's `npm ci`. Rebuild with `npm run build`.
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/cli.ts',
    'src/contracts.ts',
    // The pre-PR review-gate hook (a Claude Code PreToolUse hook bin) — built with
    // a shebang so it runs standalone as `ensemble-ai-pre-pr-gate` / node dist path.
    'src/entrypoints/hook.ts',
  ],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: false,
  shims: false,
});
