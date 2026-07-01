#!/usr/bin/env node
declare const OVERRIDE_ENV = "ENSEMBLE_AI_GATE_OVERRIDE";
declare const INLINE_OVERRIDE_MARKER = "ensemble-ai:skip-gate";
declare const TRAIL_ENV = "ENSEMBLE_AI_TRAIL_DIR";
interface GateInput {
    command?: string;
    toolName?: string;
}
declare function matchesGuardedCommand(input: GateInput): boolean;
declare function isOverridden(input: GateInput, env: NodeJS.ProcessEnv): boolean;
type VerifyOutcome = {
    code: number;
    output: string;
    ran: true;
} | {
    error: string;
    ran: false;
};
type GateDecision = {
    action: 'allow';
    reason: string;
} | {
    action: 'block';
    reason: string;
};
interface GateDeps {
    overridden: boolean;
    verify: () => VerifyOutcome;
}
declare function decideGate(input: GateInput, deps: GateDeps): GateDecision;
interface HookPayload {
    input: GateInput;
    cwd?: string;
}
declare function parseHookPayload(raw: string): HookPayload;
declare function resolveTrailDir(cwd: string | undefined, env: NodeJS.ProcessEnv, exists?: (p: string) => boolean): string | undefined;
declare function buildVerifyArgs(trailDir: string | undefined): string[];
declare function runVerifyCli(cwd: string | undefined, env: NodeJS.ProcessEnv): VerifyOutcome;
interface HookIO {
    env: NodeJS.ProcessEnv;
    log: (msg: string) => void;
    warn: (msg: string) => void;
}
declare function runHook(raw: string, io: HookIO): number;

export { type GateDecision, type GateDeps, type GateInput, type HookIO, type HookPayload, INLINE_OVERRIDE_MARKER, OVERRIDE_ENV, TRAIL_ENV, type VerifyOutcome, buildVerifyArgs, decideGate, isOverridden, matchesGuardedCommand, parseHookPayload, resolveTrailDir, runHook, runVerifyCli };
