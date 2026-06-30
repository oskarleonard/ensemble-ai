// Mode-first architecture: the CLI is `ensemble-ai <mode> …`. `review` is the
// first mode end-to-end; `brainstorm` and `security` are reserved so the dispatch
// + usage already know about them (and report "planned, not yet implemented"
// rather than "unknown") — adding one later is a new handler, not a re-architecture.
export const MODES = ['review', 'brainstorm', 'security'] as const;
export type ModeName = (typeof MODES)[number];

export const IMPLEMENTED_MODES: readonly ModeName[] = ['review', 'security'];

export function isMode(v: string): v is ModeName {
  return (MODES as readonly string[]).includes(v);
}

export function isImplemented(mode: ModeName): boolean {
  return IMPLEMENTED_MODES.includes(mode);
}
