import { SEVERITIES } from '../../core/types';

import type { GateVerdictRecord } from './gate';
import { isHolisticRecord } from './holistic-gate';

// ── Cross-reviewer dedup by SELECTION (A+) ─────────────────────────────────────────────
//
// Three reviewers independently flag the same issue → three near-identical PR comments. This
// pass clusters overlapping POSTABLE findings and elects ONE representative per cluster; the
// others are kept in the trail (provenance) but not posted. It NEVER writes or merges prose —
// it only SELECTS an already-grounded body and records who else corroborated it, so the
// deterministic, LLM-free posting guarantee is preserved.
//
// Bias is toward UNDER-merging: a wrong merge silently drops a real, distinct finding, whereas
// a missed merge merely leaves a duplicate. So two findings cluster only when they share a file,
// sit within a few lines of each other, AND their grounded text overlaps strongly.

export interface ClusterInfo {
  clusterId: string; // the primary finding's id — stable within the cluster
  corroboration: number; // distinct reviewers across the cluster (a confidence signal)
  corroborators: string[]; // the OTHER findingIds in this cluster (only populated on the primary)
  primary: boolean; // the elected representative — the only member that posts
}

// Findings this close on the same file are candidate duplicates. ~A function's span: reviewers
// citing one defect often land on DIFFERENT lines of the same hook/function (a real run cited
// the same localStorage-PII defect at lines 112 and 122). The text-overlap bar below — not this
// window — is the real guard against merging two different defects that share a file.
const LINE_WINDOW = 12;
// Minimum token overlap for two proximate findings to be "the same issue". Uses the overlap
// COEFFICIENT (|A∩B| / min|A|,|B|), not Jaccard: three reviewers describe one defect in very
// different amounts of prose, so Jaccard (which the longer body drags down) systematically
// undershot — real dups scored 0.17–0.30 and never merged. Overlap coefficient scores those
// same real dups 0.38–0.51 while non-issues stay well below, so 0.35 separates cleanly. The
// proximity gate above still does most of the work; this only guards against merging two
// genuinely-different defects that happen to sit within a few lines.
const MIN_TOKEN_OVERLAP = 0.35;

function tokens(r: GateVerdictRecord): Set<string> {
  const text = `${r.title} ${r.postableBody ?? ''}`.toLowerCase();
  return new Set((text.match(/[a-z0-9_$.]{4,}/g) ?? []));
}

function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
}

function proximate(a: GateVerdictRecord, b: GateVerdictRecord): boolean {
  if (a.file !== b.file) return false;
  if (a.line === null || b.line === null) return a.line === null && b.line === null; // both file-level
  return Math.abs(a.line - b.line) <= LINE_WINDOW;
}

// Elect the best-grounded representative: an `agree` outranks a `partial` (fully grounded), then
// higher severity, then the more specific (longer) body, then stable id order for determinism.
function better(a: GateVerdictRecord, b: GateVerdictRecord): GateVerdictRecord {
  const verdictRank = (r: GateVerdictRecord): number => (r.effectiveVerdict === 'agree' ? 0 : 1);
  const cmp =
    verdictRank(a) - verdictRank(b) ||
    SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
    (b.postableBody?.length ?? 0) - (a.postableBody?.length ?? 0) ||
    (a.findingId < b.findingId ? -1 : 1);
  return cmp <= 0 ? a : b;
}

// Enrich postable records with cluster info; non-postable records pass through untouched. Pure
// and deterministic (stable input order in → stable clusters out). Returns a NEW array.
export function clusterPostable(records: GateVerdictRecord[]): GateVerdictRecord[] {
  // The HOLISTIC lens is excluded from clustering entirely (spec §4): it is ONE seat, so it must
  // never receive a corroboration count, and it must never inflate another cluster's — "flagged by
  // 2 of 4" would be a lie assembled from a diff-local reviewer and a whole-tree lens that agreed
  // by coincidence of proximity. Its findings post on their own single-seat provenance or not at all.
  const postable = records.filter((r) => r.postableStatus === 'postable' && !isHolisticRecord(r));
  const tok = new Map(postable.map((r) => [r.findingId, tokens(r)]));

  // Union-find over the postable set: link every pair that is proximate AND text-similar.
  const parent = new Map(postable.map((r) => [r.findingId, r.findingId]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(x) !== root) {
      const next = parent.get(x)!;
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); // lower id wins → deterministic root
  };
  for (let i = 0; i < postable.length; i++) {
    for (let j = i + 1; j < postable.length; j++) {
      const a = postable[i];
      const b = postable[j];
      if (proximate(a, b) && overlapCoefficient(tok.get(a.findingId)!, tok.get(b.findingId)!) >= MIN_TOKEN_OVERLAP) {
        union(a.findingId, b.findingId);
      }
    }
  }

  // Bucket by root, elect a primary per cluster.
  const clusters = new Map<string, GateVerdictRecord[]>();
  for (const r of postable) {
    const root = find(r.findingId);
    (clusters.get(root) ?? clusters.set(root, []).get(root)!).push(r);
  }
  const clusterOf = new Map<string, ClusterInfo>();
  for (const members of clusters.values()) {
    const primary = members.reduce(better);
    const reviewers = new Set(members.map((m) => m.reviewer));
    const corroborators = members.filter((m) => m.findingId !== primary.findingId).map((m) => m.findingId);
    for (const m of members) {
      clusterOf.set(m.findingId, {
        clusterId: primary.findingId,
        corroboration: reviewers.size,
        corroborators: m.findingId === primary.findingId ? corroborators : [],
        primary: m.findingId === primary.findingId,
      });
    }
  }

  return records.map((r) => {
    const cluster = clusterOf.get(r.findingId);
    return cluster ? { ...r, cluster } : r;
  });
}
