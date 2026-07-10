import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { GateVerdictRecord } from './gate';
import { HOLISTIC_SEAT_ID } from './holistic';
import {
  type FixtureAnchor,
  loadHolisticFixture,
  scoreHolisticFixture,
  type ScoredFinding,
  verifyFixtureAnchors,
} from './holistic-fixture';
import {
  type HolisticEntry,
  applyHolisticPolicy,
  worktreeReader,
} from './holistic-gate';

// THE ACCEPTANCE SUITE (gate-r3 pin 7). The fixture tree is the worktree; the "seat" is a stub
// that emits exactly the finding a competent lens would emit. What is proven here is the
// MACHINERY — that a well-formed catch survives the gate and that the suite would notice both a
// miss and a near-miss flag. Whether a real model catches and spares is scored, not asserted:
// no stub can stand in for the model's judgment, and pretending otherwise would make the suite lie.

const FIXTURE = fileURLToPath(new URL('../../../fixtures/holistic', import.meta.url));
const fixture = loadHolisticFixture(FIXTURE);
const read = worktreeReader(FIXTURE);

// The verbatim line at an anchor — the quote a lens would copy out of the tree at headSha.
function lineAt(a: FixtureAnchor): string {
  return fs.readFileSync(path.join(FIXTURE, a.file), 'utf8').split(/\r?\n/)[a.line - 1];
}

function holisticRecord(file: string, line: number, severity: 'high' | 'medium' = 'high'): GateVerdictRecord {
  return {
    downgradeReason: null,
    effectiveVerdict: 'agree',
    anchorSide: 'new',
    postableClass: 'quality',
    postableSuggestion: null,
    resolved: true,
    file,
    findingId: `${HOLISTIC_SEAT_ID}#1`,
    line,
    postableBody: 'this duplicates an existing pattern',
    postableFix: 'keep',
    postableStatus: 'postable',
    rawVerdict: 'agree',
    reason: 'both sites verified',
    rescoredSeverity: null,
    reviewer: HOLISTIC_SEAT_ID,
    severity,
    title: 'reinvented pattern',
  };
}

// Push one claim through the real host policy against the real tree.
function gateIt(claim: { conventions?: FixtureAnchor; diff: FixtureAnchor; pattern: FixtureAnchor }): GateVerdictRecord {
  const e: HolisticEntry = {
    sites: [
      { file: claim.diff.file, line: claim.diff.line, quote: lineAt(claim.diff), role: 'diff' },
      { file: claim.pattern.file, line: claim.pattern.line, quote: lineAt(claim.pattern), role: 'pattern' },
    ],
    ...(claim.conventions
      ? { conventionCitation: { file: claim.conventions.file, line: claim.conventions.line, quote: lineAt(claim.conventions) } }
      : {}),
  };
  const [out] = applyHolisticPolicy(
    [holisticRecord(claim.diff.file, claim.diff.line)],
    new Map([[`${HOLISTIC_SEAT_ID}#1`, e]]),
    { diffFiles: new Set([claim.diff.file]), readAtHead: read }
  );
  return out;
}

describe('the fixture suite itself', () => {
  it('is a SUITE — several planted positives AND several near-miss negatives (pin 7)', () => {
    expect(fixture.plantedPositives.length).toBeGreaterThanOrEqual(3);
    expect(fixture.nearMisses.length).toBeGreaterThanOrEqual(3);
  });

  it('every anchor it names still sits where it says (the fixture cannot silently rot)', () => {
    expect(verifyFixtureAnchors(FIXTURE, fixture)).toEqual([]);
  });

  it('each near-miss names a DIFFERENT file from its lookalike, and explains the semantic gap', () => {
    for (const m of fixture.nearMisses) {
      expect(m.site.file).not.toBe(m.lookalike.file);
      expect(m.why.length).toBeGreaterThan(20);
    }
  });
});

describe('each planted positive, pushed through the real gate policy against the real tree', () => {
  for (const p of fixture.plantedPositives) {
    it(`${p.id}: a well-formed catch quoting both sites POSTS, capped at MED`, () => {
      const out = gateIt({ diff: p.diffSite, pattern: p.patternSite });
      expect(out.effectiveVerdict).toBe('agree');
      expect(out.postableStatus).toBe('postable');
      expect(out.severity).toBe('medium');
      expect(out.holistic?.cappedFrom).toBe('high');
      expect(out.holistic?.verifiedSites).toHaveLength(2);
    });

    it(`${p.id}: citing the conventions doc that mandates the pattern lifts the cap`, () => {
      const out = gateIt({ conventions: p.conventionsAnchor, diff: p.diffSite, pattern: p.patternSite });
      expect(out.severity).toBe('high');
      expect(out.holistic?.uncapCitation?.file).toBe(fixture.conventionsDoc);
    });

    it(`${p.id}: the same claim with an UNQUOTED pattern home is refused (reference-not-found)`, () => {
      const [out] = applyHolisticPolicy(
        [holisticRecord(p.diffSite.file, p.diffSite.line)],
        new Map([
          [
            `${HOLISTIC_SEAT_ID}#1`,
            {
              sites: [
                { file: p.diffSite.file, line: p.diffSite.line, quote: lineAt(p.diffSite), role: 'diff' as const },
                { file: p.patternSite.file, line: p.patternSite.line, quote: 'export function thisLineWasNeverWritten(): void {', role: 'pattern' as const },
              ],
            },
          ],
        ]),
        { diffFiles: new Set([p.diffSite.file]), readAtHead: read }
      );
      expect(out.effectiveVerdict).toBe('unverified');
      expect(out.downgradeReason).toBe('reference-not-found');
      expect(out.postableStatus).toBe('not-postable');
    });
  }
});

describe('the near-misses — what the host CAN and CANNOT do about them', () => {
  for (const m of fixture.nearMisses) {
    it(`${m.id}: the host cannot refute it (both quotes are real) — the LENS must not file it`, () => {
      // This is the honest boundary. The near-miss claim quotes two lines that genuinely exist, so
      // grounding passes: the host verifies that a citation is REAL, never that a comparison is
      // SOUND. The defense against a wrong "use the existing util X" is the lens prompt's
      // read-the-semantics rule plus this fixture's negative half, scored below — not a check.
      const out = gateIt({ diff: m.site, pattern: m.lookalike });
      expect(out.effectiveVerdict).toBe('agree');
      expect(out.postableStatus).toBe('postable');
      // The MED cap still holds: a near-miss can never reach HIGH, because no conventions doc
      // mandates the util it falsely resembles.
      expect(out.severity).toBe('medium');
    });

    it(`${m.id}: and the SUITE fails a lens that files it`, () => {
      const score = scoreHolisticFixture(
        [{ file: m.site.file, line: m.site.line, postable: true }],
        fixture
      );
      expect(score.falseFlags).toContain(m.id);
      expect(score.passed).toBe(false);
    });
  }
});

describe('scoreHolisticFixture — the grader a live lens run is judged by', () => {
  const catchAll = (): ScoredFinding[] =>
    fixture.plantedPositives.map((p) => ({ file: p.diffSite.file, line: p.diffSite.line, postable: true }));

  it('a perfect run: every positive caught, no near-miss flagged', () => {
    const score = scoreHolisticFixture(catchAll(), fixture);
    expect(score.caught).toEqual(fixture.plantedPositives.map((p) => p.id));
    expect(score.missed).toEqual([]);
    expect(score.falseFlags).toEqual([]);
    expect(score.passed).toBe(true);
  });

  it('a MISSED positive fails the suite and is named', () => {
    const score = scoreHolisticFixture(catchAll().slice(1), fixture);
    expect(score.missed).toEqual([fixture.plantedPositives[0].id]);
    expect(score.passed).toBe(false);
  });

  it('a finding the gate refused (not postable) is neither a catch nor a flag — it never reached the PR', () => {
    const score = scoreHolisticFixture(
      fixture.plantedPositives.map((p) => ({ file: p.diffSite.file, line: p.diffSite.line, postable: false })),
      fixture
    );
    expect(score.caught).toEqual([]);
    expect(score.missed).toHaveLength(fixture.plantedPositives.length);
  });

  it('a catch that lands a few lines into the function still counts; an unrelated file does not', () => {
    const p = fixture.plantedPositives[0];
    expect(scoreHolisticFixture([{ file: p.diffSite.file, line: p.diffSite.line + 5, postable: true }], fixture).caught).toContain(p.id);
    expect(scoreHolisticFixture([{ file: 'src/somewhere/else.ts', line: 1, postable: true }], fixture).caught).toEqual([]);
  });
});
