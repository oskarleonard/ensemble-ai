// A docs file for the product-seat tests (product-docs.ts, product-gate.ts, product.ts, the stage).
// The docs-file contract, as the host's writer renders it: a header line, then one source per
// `## <key> — <title>` line. Line numbers in the comments are 1-based, as the index reports them.
export const PRODUCT_DOCS: string = [
  '# product docs: Acme billing TDD (rev 2026-10-01, refreshed 09:12Z) · Acme billing PRD (…) · ACME-12 → the product seat', // 1
  '', // 2
  '## engineering/acme-billing-tdd — Acme billing TDD (tdd, rev 2026-10-01)', // 3
  '# Acme billing', // 4
  '', // 5
  '### Decisions', // 6
  '- We keep the 403 declarations in `openapi.yaml` and update their descriptions.', // 7
  '- **Refunds** are issued to the original payment method, not as store credit.', // 8
  '', // 9
  '### Alternatives considered', // 10
  '- Return 404 for a suspended member instead of 403, to hide the account.', // 11
  '', // 12
  '```sh', // 13
  '# not a heading: a comment inside a code block', // 14
  '```', // 15
  'Members on a paused plan keep read access to their invoices.', // 16
  '', // 17
  '## ACME-12 — Suspended members (ticket, rev 2026-10-02)', // 18
  'Acceptance criteria:', // 19
  '1. A suspended member still gets 403 on every billing route.', // 20
  '2. Suspend writes the status “suspended” to the member record.', // 21
  '… [cut at 150 KB of 210 KB]', // 22
  'The audit log keeps every status change for ninety days.', // 23
  '', // 24
  '## product/acme-billing-prd — Acme billing PRD (prd, rev 2026-08-01, mirror as of 2026-08-01 — refresh failed: no access) STALE', // 25
  'Invoices are always issued in the currency of the customer account.', // 26
  '', // 27
].join('\n');
