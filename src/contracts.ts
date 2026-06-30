// Pure contracts + pure functions — NO node imports, so this entry is safe to
// import from a browser/client bundle. The node engine (the spawn primitive,
// reviewer adapters, artifact persistence, diff acquisition, the receipt, the
// CLI) lives behind the main `ensemble-ai` entry; a client consumer (e.g. a UI
// rendering findings) imports `ensemble-ai/contracts` instead, so a bundler never
// pulls `node:child_process`/`node:fs` into the client.
export * from './core/types';
export * from './core/findings';
export * from './core/packet';
export * from './core/prompt';
