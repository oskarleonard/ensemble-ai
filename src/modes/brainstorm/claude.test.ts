import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewerExecOpts } from '../../core/spawn';

// runClaudeVoice has no exec seam, so the spawn primitive is mocked: the test reads the exact
// request the voice hands it, and nothing is ever spawned.
const spawned = vi.hoisted(() => [] as ReviewerExecOpts[]);
vi.mock('../../core/spawn', async (importActual) => ({
  ...(await importActual<typeof import('../../core/spawn')>()),
  runReviewerExec: vi.fn((req: ReviewerExecOpts) => {
    spawned.push(req);
    return Promise.resolve({ raw: 'IDEAS', stderrTail: '', timedOut: false });
  }),
}));

import { buildClaudeVoiceArgs, claudeAdvisorArgs, claudeAdvisorEnv, runClaudeVoice } from './claude';
import type { VoiceConfig } from './types';

const cfg = (over: Partial<VoiceConfig> = {}): VoiceConfig => ({
  cmd: 'claude',
  effort: 'default',
  id: 'claude',
  model: 'default',
  vendor: 'anthropic',
  ...over,
});

describe('buildClaudeVoiceArgs', () => {
  it('runs headless single-shot, STREAMING events to stdout (the liveness signal, 2026-10-09), with ALL tools disabled', () => {
    const args = buildClaudeVoiceArgs('brainstorm prompt');
    // `--tools ""` makes the voice provably read-only (ideation needs no tools).
    expect(args).toEqual(['-p', 'brainstorm prompt', '--output-format', 'stream-json', '--verbose', '--tools', '']);
  });
  it('`web: true` opens WebSearch + WebFetch, PRE-APPROVED for the headless spawn, under a turn cap (2026-10-06)', () => {
    const args = buildClaudeVoiceArgs('p', cfg({ web: true }));
    // `--allowedTools` is load-bearing: a `-p` spawn silently denies a permission-gated tool.
    expect(args).toEqual([
      '-p', 'p', '--output-format', 'stream-json', '--verbose',
      '--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch', '--max-turns', '25',
    ]);
  });
  it('without `web` the voice stays tool-less (unchanged)', () => {
    expect(buildClaudeVoiceArgs('p', cfg({ web: false }))).toContain('--tools');
    expect(buildClaudeVoiceArgs('p', cfg({ web: false }))).not.toContain('WebFetch');
  });
  it('passes the prompt verbatim (no shell interpolation)', () => {
    const tricky = 'a "quoted" $VAR & topic';
    expect(buildClaudeVoiceArgs(tricky)[1]).toBe(tricky);
  });
  it('omits --model/--effort for the "default" sentinel config', () => {
    const args = buildClaudeVoiceArgs('p', cfg());
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });
  it('honors a configured model and a valid effort level', () => {
    const args = buildClaudeVoiceArgs('p', cfg({ model: 'claude-opus-4-8', effort: 'high' }));
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-8');
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });
  it('drops an invalid (non-level) effort rather than passing it', () => {
    const args = buildClaudeVoiceArgs('p', cfg({ effort: 'bogus' }));
    expect(args).not.toContain('--effort');
  });
});

// The value of the one `--settings` flag, parsed — never string-matched.
const settingsOf = (args: string[]): unknown => JSON.parse(args[args.indexOf('--settings') + 1]);

describe('claudeAdvisorArgs — the advisor half of every claude invocation', () => {
  it('absent → no flag at all (the seat inherits the operator settings)', () => {
    expect(claudeAdvisorArgs(cfg())).toEqual([]);
    expect(claudeAdvisorArgs(undefined)).toEqual([]);
  });

  it('a model id → --settings {"advisorModel":"<id>"}', () => {
    const args = claudeAdvisorArgs(cfg({ advisor: 'claude-fable-5-1' }));
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('--settings');
    expect(settingsOf(args)).toEqual({ advisorModel: 'claude-fable-5-1' });
  });

  it('"off" → no flag: no --settings value disables the advisor (measured 2026-10-04), so off rides the env', () => {
    expect(claudeAdvisorArgs(cfg({ advisor: 'off' }))).toEqual([]);
  });

  it('a hand-built config with an invalid advisor throws, naming the seat — it never reaches the CLI', () => {
    expect(() => claudeAdvisorArgs(cfg({ advisor: 'x"}, "permissions": {' }))).toThrow(/claude seat: `advisor`/);
  });
});

describe('buildClaudeVoiceArgs — the brainstorm/consult voice carries the advisor', () => {
  it('omits --settings when the advisor is absent', () => {
    expect(buildClaudeVoiceArgs('p', cfg())).not.toContain('--settings');
  });

  it('a model id rides --settings after --model/--effort; "off" adds no flag at all', () => {
    const withModel = buildClaudeVoiceArgs('p', cfg({ advisor: 'claude-opus-5-5', effort: 'high', model: 'opus' }));
    expect(settingsOf(withModel)).toEqual({ advisorModel: 'claude-opus-5-5' });
    expect(withModel.indexOf('--settings')).toBeGreaterThan(withModel.indexOf('--effort'));
    expect(buildClaudeVoiceArgs('p', cfg({ advisor: 'off' }))).toEqual(buildClaudeVoiceArgs('p', cfg()));
    // The tool-less posture is untouched.
    expect(withModel.slice(0, 7)).toEqual(['-p', 'p', '--output-format', 'stream-json', '--verbose', '--tools', '']);
  });
});

describe('claudeAdvisorEnv — the env half: "off" is the CLI kill switch', () => {
  it('"off" → CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1, the one per-run off that holds on any base model', () => {
    expect(claudeAdvisorEnv(cfg({ advisor: 'off' }))).toEqual({ CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' });
  });

  it('a pinned model → {} (the pin rides --settings, which still overrides the operator setting)', () => {
    expect(claudeAdvisorEnv(cfg({ advisor: 'claude-fable-5-1' }))).toEqual({});
  });

  it('absent → {} (the seat inherits the operator settings)', () => {
    expect(claudeAdvisorEnv(cfg())).toEqual({});
    expect(claudeAdvisorEnv(undefined)).toEqual({});
  });

  it('an invalid advisor throws, naming the seat — the same spawn backstop as the argv', () => {
    expect(() => claudeAdvisorEnv(cfg({ advisor: 'Not A Model' }))).toThrow(/claude seat: `advisor`/);
    expect(() => claudeAdvisorEnv({ advisor: null, id: 'gate' })).toThrow(/gate seat: `advisor`/);
  });
});

describe('runClaudeVoice — the advisor "off" reaches the spawned claude as its env', () => {
  beforeAll(() => {
    // Resolution short-circuits to an existing binary; the mocked spawn never runs it.
    vi.stubEnv('CLAUDE_BIN', '/bin/echo');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    spawned.length = 0;
  });

  it('"off" → CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 in the child env, and no --settings', async () => {
    await runClaudeVoice('p', cfg({ advisor: 'off' }));
    expect(spawned).toHaveLength(1);
    expect(spawned[0].env?.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe('1');
    expect(spawned[0].args).not.toContain('--settings');
  });

  it('a pinned model or an absent advisor → the variable is never set', async () => {
    await runClaudeVoice('p', cfg({ advisor: 'claude-opus-5-5' }));
    await runClaudeVoice('p', cfg());
    expect(spawned).toHaveLength(2);
    for (const req of spawned) expect(req.env?.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBeUndefined();
    expect(settingsOf(spawned[0].args)).toEqual({ advisorModel: 'claude-opus-5-5' });
  });
});

describe('buildClaudeEvidenceArgs — the voice behind the capability fence over an evidence root (2026-10-09)', async () => {
  const { buildClaudeEvidenceArgs, CLAUDE_EVIDENCE_MAX_TURNS } = await import('./claude');
  const home = '/Users/nobody';
  const root = '/private/tmp/hugin-evidence/runs/abc';
  it('neutral-cwd fence: plan mode, --add-dir then --strict-mcp-config, every exec/write/egress tool denied, home reads denied', () => {
    const args = buildClaudeEvidenceArgs('p', cfg({ model: 'opus', effort: 'max' }), { evidenceRoot: root, homeDir: home });
    expect(args.slice(0, 7)).toEqual(['-p', 'p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan']);
    expect(args[args.indexOf('--add-dir') + 1]).toBe(root);
    expect(args[args.indexOf('--add-dir') + 2]).toBe('--strict-mcp-config');
    const denied = args.slice(args.indexOf('--disallowedTools') + 1);
    for (const t of ['Bash', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'NotebookEdit']) expect(denied).toContain(t);
    expect(denied).toContain(`Read(/${home}/**)`);
    expect(denied).toContain(`Grep(/${home}/**)`);
    expect(args.indexOf('--disallowedTools')).toBeLessThan(args.indexOf('Bash'));
    expect(args[args.indexOf('--max-turns') + 1]).toBe(String(CLAUDE_EVIDENCE_MAX_TURNS));
    expect(args).not.toContain('--allowedTools');
  });
  it('a `web` voice keeps WebSearch (pre-approved, vendor-side) and still loses WebFetch', () => {
    const args = buildClaudeEvidenceArgs('p', cfg({ web: true }), { evidenceRoot: root, homeDir: home });
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('WebSearch');
    const denied = args.slice(args.indexOf('--disallowedTools') + 1);
    expect(denied).not.toContain('WebSearch');
    expect(denied).toContain('WebFetch');
  });
  it('refuses a root inside the home directory (the deny would deny the root)', () => {
    expect(() => buildClaudeEvidenceArgs('p', cfg(), { evidenceRoot: `${home}/evidence`, homeDir: home })).toThrow(/inside the home directory/);
  });
});
