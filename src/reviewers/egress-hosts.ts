import type { ReviewerId } from '../core/types';

// THE PER-VENDOR EGRESS ALLOWLIST (codex-f3) — which hosts each seat's proxy will tunnel to.
//
// PER-VENDOR, and NOT user-overridable. Both halves are deliberate:
//
//   Per-vendor, because there is no such thing as a global allowlist here: codex's hosts are an
//   exfil channel for grok and vice versa. The record is EXHAUSTIVE over ReviewerId, like
//   SEAT_QUALIFIERS and RETRIES_ON_PACKET — TS errors if a new reviewer joins REVIEWER_IDS without
//   an explicit ruling on where it may talk. A default branch here would be fail-OPEN.
//
//   Not user-overridable, because the seat's sandbox profile id (`…+egress-proxy-kernel` for codex,
//   `…+proxy-env-noshell` for grok) is what a receipt attests, and that id does not carry the host
//   list. If `~/.ensemble-ai` could widen the allowlist, two runs could mint receipts under the same
//   profile id having been fenced very differently — precisely the equivalence the sandbox profile
//   version exists to forbid. Hosts are code, so a change to them is a diff, a review, and a
//   `version` bump.
//
// EVERY HOST IS EVIDENCED. "It might need it" is not a reason to open a hole.

// codex — auth_mode `chatgpt` (Oskar's ChatGPT subscription).
//   chatgpt.com       OBSERVED (2026-07-10, 21 CONNECTs in a 5s run). The API base: the binary
//                     carries `https://chatgpt.com/backend-api/codex`. Without it, no review.
//   ab.chatgpt.com    OBSERVED (1 CONNECT per run). An A/B config fetch. Allowed because it is an
//                     OpenAI host — it widens the trust boundary by nothing the API base does not
//                     already grant — and denying it earns a retry storm for no gain.
//   auth.openai.com   NOT observed in the probe (the access token was fresh). Evidenced instead by
//                     the binary's `https://auth.openai.com/oauth/token` +
//                     `CODEX_REFRESH_TOKEN_URL_OVERRIDE`, and by `~/.codex/auth.json` carrying a
//                     `last_refresh` stamp: the silent-refresh path is real, and a 12-minute review
//                     that straddles an expiry would die without it.
//   api.openai.com    NOT observed under this auth mode. It is codex's API base under `apikey` auth
//                     (present in the binary's host set). Allowed so an API-key operator is not
//                     silently broken by a fence tuned to one machine's login mode.
//
// DENIED, and observed being denied with no ill effect: `mcp.supabase.com` / `api.supabase.com` —
// a remote MCP server from the OPERATOR's `~/.codex/config.toml` that a review seat loads and never
// needs. It retried and gave up; codex completed in 5s. That an unrelated MCP credential channel
// was open to a seat running untrusted PR content is exactly the class of hole this fence closes.
const CODEX_EGRESS_HOSTS = [
  'ab.chatgpt.com',
  'api.openai.com',
  'auth.openai.com',
  'chatgpt.com',
] as const;

// grok — TWO hosts, both xAI-owned, and ONE review needs BOTH: the chat proxy carries the request,
// the auth endpoint mints the bearer token that request must carry. Allow one without the other and
// the seat has a reachable API it cannot authenticate to.
//   cli-chat-proxy.grok.com  OBSERVED (2026-07-10, through a logging proxy). The API base: the
//                            review prompt goes here and the findings come back. Without it, no
//                            review.
//   auth.x.ai                OBSERVED BEING DENIED, in production — the first worktree-mode review
//                            munin ever ran (run `2026-07-10-14-49-44-5f601154`). The seat's
//                            `evidence.egressDenials` recorded NINE refused CONNECTs to
//                            `auth.x.ai:443` ("host is not on this vendor's egress allowlist"),
//                            after which `cli-chat-proxy.grok.com` answered `401 Unauthorized —
//                            "Invalid or expired credentials (auth_kind=bearer,
//                            x_xai_token_auth=xai-grok-cli, upstream=PermissionDenied, reason=no
//                            auth context)"`. The seat then failed closed to the packet, where a
//                            retry with the SAME credentials succeeded: the credentials were always
//                            valid, and the fence blocking the vendor's own bearer-auth host was the
//                            whole cause. A one-host allowlist is a half-fence — it made worktree
//                            mode unreachable for grok on every review.
//
// Denied and harmless, both observed refused while grok completed in 5s: `api.mixpanel.com`
// (telemetry) and `grok.com`. Neither grok host appears on codex's list, nor codex's here: an
// intersection would hand either seat the other's API as an exfil host (the fence's own test pins
// the empty intersection).
//
// OPERATIONAL RISK, stated: grok does not fail fast when its API host is unreachable. With
// `cli-chat-proxy.grok.com` denied it retried and then HUNG silently (a 5-minute probe produced no
// output and no error). If xAI moves that host, the grok seat will hang until the 12-minute review
// watchdog kills it, and the seat will be scored `failed-reviewer` rather than erroring quickly.
// That is fail-closed, but it is slow — a hung grok seat is the signal to re-probe this list. Losing
// `auth.x.ai` fails differently and better: `cli-chat-proxy.grok.com` is still reachable, so it
// answers a FAST 401 instead of hanging, loudly recorded in `evidence.egressDenials`, and the seat is
// scored `failed-reviewer`. grok does NOT then fall back to the packet — `RETRIES_ON_PACKET.grok` is
// false (unlike codex), so a failed grok worktree attempt fails the run rather than re-running on the
// diff-only packet (see runCoreSeat in ../modes/review/seat-run.ts).
const GROK_EGRESS_HOSTS = ['auth.x.ai', 'cli-chat-proxy.grok.com'] as const;

// claude — NO egress proxy is ever started for this seat: its fence removes the
// network tools themselves (WebFetch/WebSearch/Bash gone, --strict-mcp-config), so
// there is no channel to allowlist. The entry exists because this Record is
// exhaustive by design; empty means "if a proxy were ever started, allow nothing".
export const VENDOR_EGRESS_HOSTS: Record<ReviewerId, readonly string[]> = {
  claude: [],
  codex: CODEX_EGRESS_HOSTS,
  grok: GROK_EGRESS_HOSTS,
};

export function egressHostsFor(id: ReviewerId): readonly string[] {
  return VENDOR_EGRESS_HOSTS[id];
}
