import type { FileDiff } from './diff';

// Lightweight LOCAL dependency-surface flag for the `security` profile. NO network,
// NO external vuln DB — it only reads the DIFF: which dependency-manifest files
// changed (so a supply-chain reviewer's eye is drawn there), and which obviously-
// risky APIs/sinks appear on ADDED lines (eval, child_process, innerHTML, …). It
// draws attention; it does NOT adjudicate. PURE — a pure function of the parsed diff.

interface ManifestPattern {
  label: string;
  lock?: boolean;
  re: RegExp;
}

// Dependency manifests + lockfiles across the common ecosystems. A `lock` file is
// machine-generated → flagged as touched but its lines are NOT enumerated (noise).
const MANIFEST_PATTERNS: ManifestPattern[] = [
  { label: 'npm', re: /(^|\/)package\.json$/ },
  { label: 'npm-lock', lock: true, re: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/ },
  { label: 'yarn-lock', lock: true, re: /(^|\/)yarn\.lock$/ },
  { label: 'pnpm-lock', lock: true, re: /(^|\/)pnpm-lock\.yaml$/ },
  { label: 'bun-lock', lock: true, re: /(^|\/)bun\.lockb$/ },
  { label: 'python-requirements', re: /(^|\/)requirements[^/]*\.txt$/ },
  { label: 'python-pyproject', re: /(^|\/)pyproject\.toml$/ },
  { label: 'python-pipfile', re: /(^|\/)Pipfile$/ },
  { label: 'python-pipfile-lock', lock: true, re: /(^|\/)Pipfile\.lock$/ },
  { label: 'go-mod', re: /(^|\/)go\.mod$/ },
  { label: 'go-sum', lock: true, re: /(^|\/)go\.sum$/ },
  { label: 'rust-cargo', re: /(^|\/)Cargo\.toml$/ },
  { label: 'rust-cargo-lock', lock: true, re: /(^|\/)Cargo\.lock$/ },
  { label: 'ruby-gemfile', re: /(^|\/)Gemfile$/ },
  { label: 'ruby-gemfile-lock', lock: true, re: /(^|\/)Gemfile\.lock$/ },
  { label: 'php-composer', re: /(^|\/)composer\.json$/ },
  { label: 'php-composer-lock', lock: true, re: /(^|\/)composer\.lock$/ },
  { label: 'gradle', re: /(^|\/)build\.gradle(\.kts)?$/ },
  { label: 'maven', re: /(^|\/)pom\.xml$/ },
];

interface RiskyPattern {
  cls: string;
  label: string;
  re: RegExp;
}

// High-precision risky-sink patterns ONLY (like the secret-scan's inline patterns)
// — false-positive noise wastes the reviewer's time. Each maps to a security class.
const RISKY_PATTERNS: RiskyPattern[] = [
  { cls: 'deserialization', label: 'eval()', re: /\beval\s*\(/ },
  { cls: 'deserialization', label: 'new Function()', re: /\bnew\s+Function\s*\(/ },
  { cls: 'deserialization', label: 'vm module', re: /\bvm\.runIn|require\(\s*['"]vm['"]\s*\)|from\s+['"]vm['"]/ },
  { cls: 'deserialization', label: 'pickle.load (py)', re: /\bpickle\.loads?\s*\(/ },
  { cls: 'deserialization', label: 'yaml.load (py, unsafe)', re: /\byaml\.load\s*\(/ },
  { cls: 'deserialization', label: 'unserialize (php)', re: /\bunserialize\s*\(/ },
  { cls: 'injection', label: 'child_process', re: /\bchild_process\b|\bexecSync?\s*\(|\bspawnSync?\s*\(|\bexecFileSync?\s*\(/ },
  { cls: 'injection', label: 'os.system / subprocess (py)', re: /\bos\.system\s*\(|\bsubprocess\.(Popen|call|run|check_output)\s*\(/ },
  { cls: 'xss', label: 'dangerouslySetInnerHTML', re: /dangerouslySetInnerHTML/ },
  { cls: 'xss', label: 'innerHTML assignment', re: /\.innerHTML\s*=/ },
  { cls: 'xss', label: 'document.write', re: /document\.write\s*\(/ },
];

export interface DepManifestHit {
  // Added lines in this manifest (the change surface).
  added: number;
  isLockfile: boolean;
  label: string;
  path: string;
  // A few representative added lines (empty for lockfiles — machine-generated noise).
  samples: string[];
}

export interface RiskyImportHit {
  cls: string;
  label: string;
  line?: number;
  path: string;
}

export interface DepSurfaceResult {
  manifests: DepManifestHit[];
  riskyImports: RiskyImportHit[];
}

// Added content lines of a file's diff section, each carrying its NEW-side line
// number (tracked through the @@ hunk headers) so a risky hit is actionable.
function addedContentLines(section: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let newLine = 0;
  for (const l of section.split('\n')) {
    const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (l.startsWith('+++')) continue;
    if (l.startsWith('+')) {
      out.push({ line: newLine, text: l.slice(1) });
      newLine++;
    } else if (l.startsWith('-') && !l.startsWith('---')) {
      // a removed line: the new-side counter does NOT advance
    } else if (l.startsWith(' ')) {
      newLine++;
    }
  }
  return out;
}

// Scan the parsed file diffs for dependency-manifest changes + risky imports/sinks.
export function scanDependencySurface(files: FileDiff[]): DepSurfaceResult {
  const manifests: DepManifestHit[] = [];
  const riskyImports: RiskyImportHit[] = [];
  for (const f of files) {
    if (f.isBinary) continue;
    const added = addedContentLines(f.raw);
    const m = MANIFEST_PATTERNS.find((p) => p.re.test(f.path));
    if (m) {
      manifests.push({
        added: added.length,
        isLockfile: Boolean(m.lock),
        label: m.label,
        path: f.path,
        samples: m.lock
          ? []
          : added
              .map((a) => a.text.trim())
              .filter(Boolean)
              .slice(0, 5),
      });
    }
    // Risky sinks: SOURCE files only (generated/lock files are noise, not authored).
    if (f.kind !== 'source') continue;
    const seen = new Set<string>();
    for (const a of added) {
      for (const r of RISKY_PATTERNS) {
        if (!seen.has(r.label) && r.re.test(a.text)) {
          seen.add(r.label);
          riskyImports.push({
            cls: r.cls,
            label: r.label,
            line: a.line || undefined,
            path: f.path,
          });
        }
      }
    }
  }
  return { manifests, riskyImports };
}

export function hasDepSurface(r: DepSurfaceResult): boolean {
  return r.manifests.length > 0 || r.riskyImports.length > 0;
}
