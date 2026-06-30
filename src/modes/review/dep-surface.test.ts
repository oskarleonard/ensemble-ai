import { describe, expect, it } from 'vitest';

import { parseDiffFiles } from './diff';
import { hasDepSurface, scanDependencySurface } from './dep-surface';

// Build FileDiff[] the way the engine does — from a real unified diff — so the scan
// is tested against the same parsed shape it sees in production.
function files(diff: string) {
  return parseDiffFiles(diff);
}

describe('scanDependencySurface — manifests', () => {
  it('flags a package.json change and samples its added lines', () => {
    const diff = `diff --git a/package.json b/package.json
index 111..222 100644
--- a/package.json
+++ b/package.json
@@ -1,4 +1,5 @@
 {
   "dependencies": {
+    "left-pad": "^1.3.0",
     "react": "^18.0.0"
   }
`;
    const r = scanDependencySurface(files(diff));
    expect(r.manifests).toHaveLength(1);
    expect(r.manifests[0]).toMatchObject({
      isLockfile: false,
      label: 'npm',
      path: 'package.json',
    });
    expect(r.manifests[0].samples.join(' ')).toContain('left-pad');
    expect(hasDepSurface(r)).toBe(true);
  });

  it('flags a lockfile as touched but does NOT enumerate its lines (noise)', () => {
    const diff = `diff --git a/package-lock.json b/package-lock.json
index aaa..bbb 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -10,3 +10,4 @@
+    "node_modules/left-pad": { "version": "1.3.0" },
`;
    const r = scanDependencySurface(files(diff));
    expect(r.manifests).toHaveLength(1);
    expect(r.manifests[0].isLockfile).toBe(true);
    expect(r.manifests[0].samples).toEqual([]);
    // it still reports an added-line count
    expect(r.manifests[0].added).toBeGreaterThan(0);
  });

  it('recognizes non-npm ecosystems (requirements.txt, go.mod)', () => {
    const diff = `diff --git a/requirements.txt b/requirements.txt
index 1..2 100644
--- a/requirements.txt
+++ b/requirements.txt
@@ -1,1 +1,2 @@
 flask==2.0.0
+requests==2.31.0
diff --git a/go.mod b/go.mod
index 3..4 100644
--- a/go.mod
+++ b/go.mod
@@ -3,1 +3,2 @@
+	github.com/foo/bar v1.2.3
`;
    const r = scanDependencySurface(files(diff));
    const labels = r.manifests.map((m) => m.label).sort();
    expect(labels).toEqual(['go-mod', 'python-requirements']);
  });
});

describe('scanDependencySurface — risky imports', () => {
  it('flags eval, child_process, and dangerouslySetInnerHTML with line numbers', () => {
    const diff = `diff --git a/src/run.ts b/src/run.ts
index 1..2 100644
--- a/src/run.ts
+++ b/src/run.ts
@@ -10,2 +10,5 @@ export function run() {
   const x = 1;
+  eval(userInput);
+  execSync(cmd);
+  const el = <div dangerouslySetInnerHTML={{ __html: raw }} />;
   return x;
`;
    const r = scanDependencySurface(files(diff));
    const labels = r.riskyImports.map((i) => i.label).sort();
    expect(labels).toContain('eval()');
    expect(labels).toContain('child_process');
    expect(labels).toContain('dangerouslySetInnerHTML');
    // line numbers tracked through the hunk header: new side starts at 10, the
    // context line is 10, so the first added line (eval) is line 11.
    const evalHit = r.riskyImports.find((i) => i.label === 'eval()');
    expect(evalHit?.line).toBe(11);
    expect(evalHit?.cls).toBe('deserialization');
  });

  it('does NOT scan generated/lock files for risky sinks (noise)', () => {
    const diff = `diff --git a/dist/bundle.js b/dist/bundle.js
index 1..2 100644
--- a/dist/bundle.js
+++ b/dist/bundle.js
@@ -1,1 +1,2 @@
+eval(payload);
`;
    const r = scanDependencySurface(files(diff));
    expect(r.riskyImports).toEqual([]);
  });

  it('only matches ADDED lines, not removed or context', () => {
    const diff = `diff --git a/src/safe.ts b/src/safe.ts
index 1..2 100644
--- a/src/safe.ts
+++ b/src/safe.ts
@@ -1,3 +1,3 @@
 const ok = 1;
-eval(removedLine);
+const safe = 2;
`;
    const r = scanDependencySurface(files(diff));
    expect(r.riskyImports).toEqual([]);
  });
});

describe('hasDepSurface', () => {
  it('is false on a clean source diff', () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
index 1..2 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,1 +1,2 @@
 const a = 1;
+const b = 2;
`;
    const r = scanDependencySurface(files(diff));
    expect(hasDepSurface(r)).toBe(false);
  });
});
