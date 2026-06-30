import { describe, expect, it } from 'vitest';

import type { ReviewFinding } from '../../core/types';

import {
  classifySecurityFinding,
  isReviewProfile,
  REVIEW_PROFILES,
  SECURITY_CLASSES,
  securityClassLabel,
  stripSecurityTag,
} from './profile';

function finding(over: Partial<ReviewFinding>): ReviewFinding {
  return {
    body: '',
    confidence: 'high',
    evidence: { file: 'a.ts' },
    id: 'f1',
    severity: 'high',
    title: '',
    ...over,
  };
}

describe('isReviewProfile', () => {
  it('accepts the known profiles, rejects anything else', () => {
    expect(REVIEW_PROFILES).toEqual(['code', 'security']);
    expect(isReviewProfile('code')).toBe(true);
    expect(isReviewProfile('security')).toBe(true);
    expect(isReviewProfile('brainstorm')).toBe(false);
    expect(isReviewProfile('')).toBe(false);
  });
});

describe('classifySecurityFinding', () => {
  it('prefers an explicit leading [tag] from the known set', () => {
    expect(
      classifySecurityFinding(finding({ title: '[authz] missing role check' }))
    ).toBe('authz');
    // case-insensitive + leading whitespace tolerated
    expect(
      classifySecurityFinding(finding({ title: '  [INJECTION] raw SQL' }))
    ).toBe('injection');
  });

  it('ignores an UNKNOWN bracket tag and falls back to keywords', () => {
    // [bug] is not a security class → keyword scan finds "sql injection"
    expect(
      classifySecurityFinding(
        finding({ title: '[bug] sql injection in query builder' })
      )
    ).toBe('injection');
  });

  it('keyword-classifies when there is no tag (title + body)', () => {
    expect(
      classifySecurityFinding(
        finding({ title: 'user html rendered', body: 'uses dangerouslySetInnerHTML' })
      )
    ).toBe('xss');
    expect(
      classifySecurityFinding(finding({ title: 'weak hash', body: 'uses md5 for passwords' }))
    ).toBe('crypto');
  });

  it('defaults to "other" when nothing matches', () => {
    expect(
      classifySecurityFinding(finding({ title: 'rename a variable', body: 'cosmetic' }))
    ).toBe('other');
  });
});

describe('stripSecurityTag', () => {
  it('strips a leading known-class tag, leaves an unknown tag intact', () => {
    expect(stripSecurityTag('[authz] missing check')).toBe('missing check');
    expect(stripSecurityTag('[bug] not a class')).toBe('[bug] not a class');
    expect(stripSecurityTag('no tag at all')).toBe('no tag at all');
  });
});

describe('securityClassLabel', () => {
  it('maps an id to its label, echoes an unknown id', () => {
    expect(securityClassLabel('authz')).toBe('AuthN/AuthZ');
    expect(securityClassLabel('mystery')).toBe('mystery');
  });

  it('every class id is unique', () => {
    const ids = SECURITY_CLASSES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
