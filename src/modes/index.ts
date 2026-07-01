// Mode-first architecture: the CLI is `ensemble-ai <mode> …`. Each mode is a
// variation of "fan out across vendors → synthesize" — review/security collect
// typed findings; brainstorm diverges + cross-critiques + converges. A new mode is
// a new handler, not a re-architecture.
export const MODES = ['review', 'brainstorm', 'security', 'consult'] as const;
export type ModeName = (typeof MODES)[number];

export const IMPLEMENTED_MODES: readonly ModeName[] = [
  'review',
  'security',
  'brainstorm',
  'consult',
];

// CLI aliases → canonical mode name. `ask` is the friendly alias for `consult`.
// Applied before mode dispatch so `ensemble-ai ask "…"` runs consult.
export const MODE_ALIASES: Record<string, ModeName> = { ask: 'consult' };

export function resolveMode(v: string): string {
  return MODE_ALIASES[v] ?? v;
}

export function isMode(v: string): v is ModeName {
  return (MODES as readonly string[]).includes(v);
}

export function isImplemented(mode: ModeName): boolean {
  return IMPLEMENTED_MODES.includes(mode);
}
