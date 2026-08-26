// The codex SOURCE-LEVEL fence: the argv that stops a seat from loading the operator's
// ~/.codex/config.toml (above all its `[mcp_servers]`) and from shipping the prompt — which carries
// the untrusted diff — to a telemetry backend. ONE list, spread into BOTH codex argv builders
// (packet: reviewers/codex.ts, worktree: reviewers/codex-sandbox.ts), so the two cannot drift: a
// flag added here fences every codex seat, and a flag dropped here is a visible diff on one line.
// The rationale for each flag lives on buildCodexReviewArgs, where the fence was first proved.
export const CODEX_SOURCE_FENCE_ARGS: readonly string[] = [
  // Load none of the operator's ~/.codex/config.toml — above all its [mcp_servers]. Auth still
  // uses $CODEX_HOME; the model/effort arrive via -m/-c (an override layer), not that file.
  '--ignore-user-config',
  // FAIL CLOSED on config drift: reject any `-c` key this codex version does not recognize, so a
  // renamed/typo'd otel.* key hard-fails the review instead of silently using the default exporter.
  '--strict-config',
  // Every OpenTelemetry exporter OFF (metrics defaults to `statsig`, so ignoring the file is not
  // enough), and never ship the prompt — which carries the untrusted diff — to a telemetry backend.
  '-c',
  'otel.exporter="none"',
  '-c',
  'otel.metrics_exporter="none"',
  '-c',
  'otel.trace_exporter="none"',
  '-c',
  'otel.log_user_prompt=false',
];
