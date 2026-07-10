import fs from 'node:fs';
import path from 'node:path';

// THE ACCEPTANCE FIXTURE (spec §4 · gate-r3 pin 7) — a SUITE, not a single pair: several planted
// reinventions the lens MUST catch, and several near-miss lookalikes (a similar-looking util with
// different semantics) it MUST NOT flag. The negative half is what keeps the lens honest; a wrong
// "use the existing util X" is the most credibility-burning comment a robot can leave.
//
// WHAT IS MECHANIZED AND WHAT IS NOT — stated plainly, because the difference is the whole point:
//
//   · The GATING mechanics (both-sites quoting, the citation-required uncap, agree-only posting)
//     are host code. They are tested deterministically against this tree with a stubbed seat, no
//     live model, in `holistic-gate.test.ts`.
//   · Whether the lens CATCHES a planted reinvention and SPARES a near-miss is a property of the
//     model, not of the host. No stub can prove it. `scoreHolisticFixture` is the scorer a live,
//     model-in-the-loop run is graded by; the deterministic tests grade synthetic finding sets
//     through it, which pins the scorer itself — not the lens's judgment.
//
// So a green test suite means "the machinery is right". It never means "the lens is smart". A
// clean holistic pass is not an architecture certification, and this file will not pretend it is.

export interface FixtureAnchor {
  file: string;
  line: number;
  symbol: string;
}

export interface PlantedPositive {
  // The conventions-doc line that MANDATES the bypassed pattern — the only thing that may lift
  // the lens's MED severity cap, and only when the gate finds it verbatim at headSha.
  conventionsAnchor: FixtureAnchor;
  diffSite: FixtureAnchor;
  id: string;
  patternSite: FixtureAnchor;
  why: string;
}

export interface NearMiss {
  id: string;
  lookalike: FixtureAnchor;
  site: FixtureAnchor;
  why: string;
}

export interface HolisticFixture {
  conventionsDoc: string;
  nearMisses: NearMiss[];
  plantedPositives: PlantedPositive[];
}

function anchor(v: unknown, where: string): FixtureAnchor {
  const e = (v ?? {}) as Record<string, unknown>;
  if (typeof e.file !== 'string' || typeof e.line !== 'number' || typeof e.symbol !== 'string')
    throw new Error(`holistic fixture: ${where} must be {file, line, symbol}`);
  return { file: e.file, line: e.line, symbol: e.symbol };
}

// Load + validate `expectations.json`. THROWS on a malformed file: this is a test/acceptance
// helper, and a silently-degraded fixture would score a broken lens as passing.
export function loadHolisticFixture(dir: string): HolisticFixture {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'expectations.json'), 'utf8')) as Record<string, unknown>;
  const positives = Array.isArray(raw.plantedPositives) ? raw.plantedPositives : [];
  const misses = Array.isArray(raw.nearMisses) ? raw.nearMisses : [];
  if (positives.length === 0 || misses.length === 0)
    throw new Error('holistic fixture: the suite needs SEVERAL planted positives AND several near-miss negatives (gate-r3 pin 7)');
  return {
    conventionsDoc: typeof raw.conventionsDoc === 'string' ? raw.conventionsDoc : 'AGENTS.md',
    nearMisses: misses.map((m) => {
      const e = m as Record<string, unknown>;
      return {
        id: String(e.id),
        lookalike: anchor(e.lookalike, `nearMisses[${String(e.id)}].lookalike`),
        site: anchor(e.site, `nearMisses[${String(e.id)}].site`),
        why: String(e.why ?? ''),
      };
    }),
    plantedPositives: positives.map((p) => {
      const e = p as Record<string, unknown>;
      return {
        conventionsAnchor: anchor(e.conventionsAnchor, `plantedPositives[${String(e.id)}].conventionsAnchor`),
        diffSite: anchor(e.diffSite, `plantedPositives[${String(e.id)}].diffSite`),
        id: String(e.id),
        patternSite: anchor(e.patternSite, `plantedPositives[${String(e.id)}].patternSite`),
        why: String(e.why ?? ''),
      };
    }),
  };
}

// Every anchor the suite names must still sit on the line it names, and that line must still
// contain the symbol. Returns the broken anchors — empty means the fixture has not rotted. This
// is what turns "several planted reinventions" from prose into a checked claim.
export function verifyFixtureAnchors(dir: string, fixture: HolisticFixture): string[] {
  const broken: string[] = [];
  const check = (a: FixtureAnchor, label: string): void => {
    let lines: string[];
    try {
      lines = fs.readFileSync(path.join(dir, a.file), 'utf8').split(/\r?\n/);
    } catch {
      broken.push(`${label}: ${a.file} is unreadable`);
      return;
    }
    const line = lines[a.line - 1];
    if (line === undefined) broken.push(`${label}: ${a.file}:${a.line} does not exist`);
    else if (!line.includes(a.symbol)) broken.push(`${label}: ${a.file}:${a.line} no longer contains "${a.symbol}"`);
  };
  for (const p of fixture.plantedPositives) {
    check(p.diffSite, `${p.id}.diffSite`);
    check(p.patternSite, `${p.id}.patternSite`);
    check(p.conventionsAnchor, `${p.id}.conventionsAnchor`);
  }
  for (const m of fixture.nearMisses) {
    check(m.site, `${m.id}.site`);
    check(m.lookalike, `${m.id}.lookalike`);
  }
  return broken;
}

// A finding as the scorer sees it: WHERE it points, and whether the gate let it post. Only
// POSTABLE findings count — a claim the gate downgraded never reaches the PR, so it is neither a
// catch nor a false flag.
export interface ScoredFinding {
  file: string;
  line: number | null;
  postable: boolean;
}

export interface FixtureScore {
  caught: string[]; // planted positive ids a postable finding landed on
  falseFlags: string[]; // near-miss ids a postable finding landed on — each one is a failure
  missed: string[]; // planted positive ids nothing postable landed on
  passed: boolean; // caught everything, flagged no near-miss
}

// A finding lands on an anchor when it cites the same file and sits within a function's span of
// the planted line (a reviewer citing the body rather than the signature still counts).
const LANDING_WINDOW = 12;

function lands(f: ScoredFinding, a: FixtureAnchor): boolean {
  return f.file === a.file && (f.line === null || Math.abs(f.line - a.line) <= LANDING_WINDOW);
}

// Score a lens run against the suite. Used to grade a LIVE run; the deterministic tests grade
// synthetic sets through it, which is what pins the scorer.
export function scoreHolisticFixture(
  findings: readonly ScoredFinding[],
  fixture: HolisticFixture
): FixtureScore {
  const postable = findings.filter((f) => f.postable);
  const caught: string[] = [];
  const missed: string[] = [];
  for (const p of fixture.plantedPositives) {
    if (postable.some((f) => lands(f, p.diffSite))) caught.push(p.id);
    else missed.push(p.id);
  }
  const falseFlags = fixture.nearMisses
    .filter((m) => postable.some((f) => lands(f, m.site)))
    .map((m) => m.id);
  return { caught, falseFlags, missed, passed: missed.length === 0 && falseFlags.length === 0 };
}
