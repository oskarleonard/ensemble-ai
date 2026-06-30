import crypto from 'node:crypto';

// The ONE SHA-256 → lowercase-hex recipe (the digest's encoding + output form),
// so the diff digest, the policy hash, and the receipt-key hash can't drift in
// algorithm or encoding. Callers add the `sha256:` prefix where it's part of the
// wire shape (the digest/policy strings); the bare hex is the path-segment form.
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}
