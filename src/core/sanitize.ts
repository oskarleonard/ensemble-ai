// Strip C0/DEL control characters from untrusted, reviewer/voice-controlled text before it
// hits the terminal — a crafted diff could induce a reviewer to emit ANSI escapes in a
// finding title/path; printed raw they could rewrite the terminal. Whitespace is collapsed
// so the text stays one tidy line. ONE definition, shared by every terminal renderer (the
// CLI summaries + the self-contained review layer), so this security-relevant scrub can't
// drift between copies.
export function scrubControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
}
