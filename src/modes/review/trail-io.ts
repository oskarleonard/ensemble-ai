import fs from 'node:fs';
import path from 'node:path';

import { reviewDir } from '../../core/artifacts';
import { CONFIDENCES, type ReviewFinding, SEVERITIES } from '../../core/types';

import type { VoiceReview } from './synthesis';

// Read a persisted VoiceReview back from a trail file (e.g. the Opus reviewer's
// `review.claude.json`) so the synthesizer's input is exactly what was written to disk.
// Defensive: a missing/malformed file → null (the voice simply drops out of the synthesis),
// never a throw. Findings are shape-checked at element granularity — a junk entry is dropped
// rather than trusted, so a corrupted trail can't smuggle a malformed finding into the gate.
export function reviewJsonFromTrail(
  baseDir: string,
  runId: string,
  name: string
): VoiceReview | null {
  let obj: unknown;
  try {
    obj = JSON.parse(fs.readFileSync(path.join(reviewDir(baseDir, runId), name), 'utf8'));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const voiceId = typeof o.voiceId === 'string' && o.voiceId.trim() ? o.voiceId.trim() : null;
  if (!voiceId) return null;
  return {
    findings: Array.isArray(o.findings) ? (o.findings.filter(isFinding) as ReviewFinding[]) : [],
    ok: o.ok === true,
    summary: typeof o.summary === 'string' ? o.summary : '',
    voiceId,
  };
}

// A structural check on a persisted finding — enough that a corrupted / hand-edited trail
// file can't inject an INCOMPLETE shape the renderer/gate would mis-handle. The full typed
// parse happened at review time (parseFindings, which always assigns id + a valid
// severity/confidence), so a legitimate round-trip passes; this rejects the rest. In
// particular `severity` and `confidence` must be VALID enum members (not just any string):
// the HIGH gate keys on `severity === 'high'` and the renderers print `[severity/confidence]`
// and group by severity, so a junk value must not slip a finding past the gate or into a
// group that never renders. `id` must be present (the disposition/round-trip key), and
// title/body must be strings.
function isFinding(v: unknown): v is ReviewFinding {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.id === 'string' &&
    f.id.trim() !== '' &&
    typeof f.title === 'string' &&
    typeof f.body === 'string' &&
    typeof f.severity === 'string' &&
    (SEVERITIES as readonly string[]).includes(f.severity) &&
    typeof f.confidence === 'string' &&
    (CONFIDENCES as readonly string[]).includes(f.confidence) &&
    typeof f.evidence === 'object' &&
    f.evidence !== null
  );
}
