# Conventions — holistic-lens fixture repo

A tiny, fake project whose ONLY job is to be an acceptance fixture for the holistic lens
(`src/modes/review/holistic.ts`). It is never built, never imported, never shipped.

This file is also the fixture's **conventions doc**: the only kind of source a holistic finding
may cite to lift its MED severity cap. The gate re-verifies the quote at `headSha`; an assertion
that "the conventions say so" never uncaps by itself.

## Money

All currency rendering MUST go through `formatCents` in `src/util/money.ts`. A hand-rolled
divide-by-100 drifts on negative amounts and skips the currency suffix.

## Retries

Network retries MUST use `withRetry` from `src/util/retry.ts`. A hand-rolled loop skips the
jittered backoff and will retry non-idempotent calls.

## HTTP

Every outbound request MUST go through `request` in `src/util/http.ts`, which attaches the auth
header, the timeout, and the trace id.
