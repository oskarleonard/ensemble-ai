// Mode-first architecture: the CLI is `ensemble-ai <mode> …`. Each mode is a
// variation of "fan out across vendors → synthesize" — review/security collect
// typed findings; brainstorm diverges + cross-critiques + converges. A new mode is
// a new handler, not a re-architecture.
export const MODES = ['review', 'brainstorm', 'security'] as const;
export type ModeName = (typeof MODES)[number];

export const IMPLEMENTED_MODES: readonly ModeName[] = [
  'review',
  'security',
  'brainstorm',
];

export function isMode(v: string): v is ModeName {
  return (MODES as readonly string[]).includes(v);
}

export function isImplemented(mode: ModeName): boolean {
  return IMPLEMENTED_MODES.includes(mode);
}
