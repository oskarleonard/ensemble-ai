import os from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  enforceTrailBoundary,
  isUnderWorkPath,
  trailBoundaryViolation,
} from './trail-boundary';

describe('trail boundary guard — a _work repo\'s trail is fenced out of the brain', () => {
  const brainRoots = ['/home/o/brain', '/home/o/programming/projects/_personal/my-brain'];

  it('isUnderWorkPath detects the _work fence', () => {
    expect(isUnderWorkPath('/home/o/programming/projects/_work/lisk-app')).toBe(true);
    expect(isUnderWorkPath('/home/o/programming/projects/_personal/levmeup')).toBe(false);
  });

  it('violation only when a _work repo would write INTO a brain root', () => {
    expect(trailBoundaryViolation('/x/_work/repo', '/home/o/brain/journal/runs', brainRoots)).toBe(true);
    expect(trailBoundaryViolation('/x/_work/repo', '/tmp/ensemble-ai/r', brainRoots)).toBe(false);
    expect(trailBoundaryViolation('/x/_personal/repo', '/home/o/brain/x', brainRoots)).toBe(false);
  });

  it('enforceTrailBoundary overrides a brain-bound _work trail to a local temp dir', () => {
    const forced = enforceTrailBoundary('/x/_work/repo', '/home/o/brain/x', 'run7', brainRoots);
    expect(forced.overridden).toBe(true);
    expect(forced.out.startsWith(os.tmpdir())).toBe(true);
    const kept = enforceTrailBoundary('/x/_personal/repo', '/home/o/brain/x', 'run7', brainRoots);
    expect(kept).toEqual({ out: '/home/o/brain/x', overridden: false });
  });
});
