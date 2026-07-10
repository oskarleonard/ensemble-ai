// NEAR-MISS #1 — reads like `slugify` (src/util/slug.ts) and is NOT it. An import key is a
// stable identity: it PRESERVES case and dots (`Acme.Corp` and `acme-corp` are different rows),
// and it must not strip diacritics (`Åström` is a distinct customer from `Astrom`). Replacing it
// with slugify would silently merge records. The lens MUST NOT flag this.
export function toKey(input: string): string {
  return input.trim().replace(/[^A-Za-z0-9.À-ɏ]+/g, '-').replace(/^-+|-+$/g, '');
}
