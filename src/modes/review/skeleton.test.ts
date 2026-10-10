import { describe, expect, it } from 'vitest';

import { planChunks } from './chunks';
import { computeCoverage, parseDiffFiles } from './diff';
import { computeSeams, renderSkeleton, skeletonOf } from './skeleton';

const GO_HANDLER = `diff --git a/backend/handler/recipient.go b/backend/handler/recipient.go
--- a/backend/handler/recipient.go
+++ b/backend/handler/recipient.go
@@ -10,6 +10,12 @@ import (
 	"net/http"
 )
 
+// CreateRecipientRequest is the new shape.
+type CreateRecipientRequest struct {
+	Network string
+}
+
+func (h *Handler) CreateRecipient(w http.ResponseWriter, r *http.Request) {
+	var req CreateRecipientRequest
 	_ = r
 }
-func oldHelper() {}
`;
const TS_CLIENT = `diff --git a/web/src/api/recipients.ts b/web/src/api/recipients.ts
--- a/web/src/api/recipients.ts
+++ b/web/src/api/recipients.ts
@@ -1,4 +1,8 @@
 import { http } from './http';
+export interface CreateRecipientRequest {
+  network: string;
+}
+export async function createRecipient(req: CreateRecipientRequest): Promise<void> {
+  await http.post('/recipients', req);
+}
 export const x = 1;
`;
const PY = `diff --git a/svc/jobs.py b/svc/jobs.py
--- a/svc/jobs.py
+++ b/svc/jobs.py
@@ -1,3 +1,5 @@
 import os
+def run_backfill(country: str) -> None:
+    pass
 class Job:
     pass
`;

describe('skeletonOf — declarations a file’s hunks add or remove, with line numbers at the head', () => {
  it('reads Go types and methods, and removed declarations on the old side', () => {
    const sk = skeletonOf(parseDiffFiles(GO_HANDLER)[0]);
    expect(sk.hunks).toEqual(['@@ -10,6 +10,12 @@ import (']);
    expect(sk.added.map((d) => [d.name, d.lineNo])).toEqual([
      ['CreateRecipientRequest', 14],
      ['CreateRecipient', 18],
    ]);
    expect(sk.removed.map((d) => [d.name, d.lineNo])).toEqual([['oldHelper', 15]]);
  });
  it('reads TS exports and Python defs', () => {
    expect(skeletonOf(parseDiffFiles(TS_CLIENT)[0]).added.map((d) => d.name)).toEqual(['CreateRecipientRequest', 'createRecipient']);
    expect(skeletonOf(parseDiffFiles(PY)[0]).added.map((d) => d.name)).toEqual(['run_backfill']);
  });
});

describe('renderSkeleton — the whole change at signature resolution', () => {
  it('lists every file with its part or omission reason, hunk headers and declarations', () => {
    const files = parseDiffFiles(GO_HANDLER + TS_CLIENT);
    const { coverage, plan } = computeCoverage(files, 300);
    const md = renderSkeleton(files, coverage, plan);
    expect(md).toContain('### backend/handler/recipient.go (+7/-1) — part 1');
    expect(md).toContain('### web/src/api/recipients.ts (+6/-0) — part 2');
    expect(md).toContain('hunks: @@ -10,6 +10,12 @@ import (');
    expect(md).toContain('+ 18: func (h *Handler) CreateRecipient(w http.ResponseWriter, r *http.Request) {');
    expect(md).toContain('− 15: func oldHelper() {}');
  });
});

describe('computeSeams — the lines in the other parts that touch what this part declares', () => {
  it('names both directions with path:line, and stays silent for a part with no seams', () => {
    const files = parseDiffFiles(GO_HANDLER + TS_CLIENT + PY);
    const plan = planChunks(files, 300, 8); // one file per part (each ~300 bytes)
    expect(plan.chunks).toHaveLength(3);
    const seams = computeSeams(plan);
    const p1 = seams.get(1) ?? '';
    // part 1 (go) declares CreateRecipientRequest; part 2 (ts) declares a same-named interface AND uses it
    expect(p1).toContain('Other parts use what THIS part declares:');
    expect(p1).toContain('CreateRecipientRequest (declared in backend/handler/recipient.go) ← part 2 web/src/api/recipients.ts:5');
    expect(p1).toContain('THIS part uses what other parts declare:');
    expect(p1).toContain('backend/handler/recipient.go:19');
    // the python part shares no symbol with anyone
    expect(seams.get(3)).toBe('');
  });
});
