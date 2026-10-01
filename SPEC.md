# agent-usage — Specification v1

Status: **approved architecture, ready for implementation**
Target: Raspberry Pi OS, ARM64, Node.js ≥ 22 (verified: v22.23.2)
Verified against: Codex CLI `0.159.2`, Claude Code `2.1.286` (2026-10-01)

---

## 0. How to read this document

- Sections 1–4 explain *why*: scope, investigation findings and the provider decisions.
- Sections 5–13 describe *what to build*: the domain model, interfaces, protocols, CLI, errors, security and tests.
- Section 14 lists the risks, Section 15 sets the v1/v2 scope and Section 16 gives the project layout.
- The final section, **Implementation Plan for Codex**, lists ordered milestones with acceptance criteria.

Normative words: **MUST** / **MUST NOT** are hard requirements. **SHOULD** is strongly recommended. **MAY** is optional.

### 0.1 Rule for implementation discoveries

The implementer MUST follow this specification. Where something is left open, the spec says so and gives a default, and the implementer uses that default.

If implementation reveals a **concrete technical conflict**, the implementer MUST:
1. **STOP** work on the affected part.
2. Explain the conflict, with evidence such as the observed provider behavior, error output or a failing test.
3. Propose one or more alternatives, with their trade-offs.
4. **Wait for explicit approval** before changing the architecture.

Examples of a concrete conflict: a provider protocol behaves differently from Sections 2, 7 or 8, a required CLI flag is rejected, or two requirements in this document cannot both be met.

Architecture here includes:
- the provider strategies (Sections 3, 4, 7, 8)
- the security boundaries (Section 11)
- the domain model and JSON contract (Section 6, 12.2)
- the public API (Section 10)
- the dependency policy (Section 16)

Local implementation details that don't change any of these (private helper names, internal file splits) are the implementer's call.

---

## 1. Purpose and scope

`agent-usage` is a small standalone tool and library. It **observes** usage and rate-limit state for:

1. OpenAI **Codex** (ChatGPT-authenticated Codex CLI)
2. Anthropic **Claude Code** (claude.ai-subscription-authenticated)

It normalizes that state into one provider-neutral model. It exposes the result through:

- a TypeScript library (`getUsage()`, `getCodexUsage()`, `getClaudeUsage()`), the primary interface
- a CLI (`agent-usage`) that only consumes the library, giving human-readable and JSON output

### 1.1 Non-goals (hard)

- **No decisions.** It never says "switch to Claude", never ranks providers and never recommends an action. Its outputs are observations and clearly labelled derivations of them.
- **No mutations.** It never consumes Codex rate-limit reset credits, never buys credits, never toggles extra usage and never logs in or out.
- **No credential handling.** It never reads, copies, prints or persists OAuth tokens, refresh tokens or API keys. It never inspects credential-bearing environment variables. Provider child processes simply inherit the caller's environment unchanged (Section 11.1).
- **No model calls.** It never sends a prompt to any model and never consumes model quota.
- **No dependency** on Axiom or any orchestrator. It is independent of them.

---

## 2. Investigation findings (verified 2026-10-01)

### 2.1 Environment

| Item | Value |
|---|---|
| Node | v22.23.2, npm 10.9.8 |
| `codex` | `/usr/bin/codex`, `codex-cli 0.159.2`, auth mode `chatgpt`, plan `plus` |
| `claude` | `~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.286`, auth `claude.ai`, subscription `pro` |
| Codex protocol | generated TS and JSON Schema in `~/agents/experiments/codex-protocol/` |

### 2.2 Codex app-server (verified live)

Wire format: newline-delimited JSON over stdio. It uses JSON-RPC-like envelopes **without** a `"jsonrpc"` field:

- request `{"method","id","params"}`
- response `{"id","result"}` or `{"id","error":{"code","message"}}`
- notification `{"method","params"}`

Observed facts:

1. `initialize` responds in about 150 ms with `{userAgent, codexHome, platformFamily, platformOs}`. The client then sends the `{"method":"initialized"}` notification.
2. The server emits unsolicited notifications right away (`configWarning`, `remoteControl/status/changed`, `account/updated`). It also writes log noise to stderr, for example a bubblewrap warning on this Pi.
3. `account/read` → `{account:{type:"chatgpt",email,planType:"plus"}, requiresOpenaiAuth:true, workspaceRouting:{...}}`.
4. `account/rateLimits/read` with `{excludeResetCreditDetails:true}` → about 700 ms. It returns `primary {usedPercent:0, windowDurationMins:300, resetsAt:1790879980}` and `secondary {usedPercent:22, windowDurationMins:10080, resetsAt:1791119347}`.
   - **`resetsAt` is Unix epoch seconds.**
   - `credits {hasCredits:true, unlimited:false, balance:"452.0439000000"}`: **balance is a decimal string**.
   - `rateLimitsByLimitId {"codex": <same snapshot>}`.
   - `rateLimitResetCredits {availableCount:2, credits:null}`.
   - `ordinaryUsageAllowed:true`, `spendControlReached:false`, `rateLimitReachedType:null`.
5. `account/usage/read` → `summary{lifetimeTokens:3103172254,...}` and `dailyUsageBuckets[{startDate:"2026-02-03",tokens:...}]`.
6. **Responses can arrive out of order.** The rate-limits response (id 3) arrived *after* the usage response (id 4). A naive "close after the last request" client lost it. The client MUST track every pending id.
7. **Unauthenticated** (empty `CODEX_HOME`):
   - `account/read` → `{account:null, requiresOpenaiAuth:true}`
   - `account/rateLimits/read` → error `{code:-32600, message:"codex account authentication required to read rate limits"}`
   - `account/usage/read` → error `-32600`, "...to read token usage"
8. Closing stdin makes the server exit with code 0 in about 300 ms.
9. **Dangerous method present:** `account/rateLimitResetCredit/consume`. It MUST be unreachable (Section 11.3).
10. Typing notes from the generated TS:
    - `RateLimitWindow = {usedPercent:number, windowDurationMins:number|null, resetsAt:number|null}`
    - `primary`/`secondary` may be `null`
    - `ordinaryUsageAllowed: boolean|null` (null = unknown; "clients must not infer recovery")
    - `AccountRateLimitsUpdatedNotification` is a *sparse* update to merge into the last snapshot
    - token counts are Rust `u64`/`i64` (TS `bigint`), sent as JSON numbers

### 2.3 Claude Code (verified live and by static inspection)

1. `/usage` → `fetchUtilization()` → `GET /api/oauth/usage` (confirmed by a debug log). Claude Code's internal client:
   - has a 5 s timeout, OAuth refresh on 401, and retries
   - remembers 429/403 per bearer token and won't ask again for up to 5 min (`fetchUtilization: <status> remembered for this bearer`)
2. **Supported programmatic path found:** the SDK control protocol of headless mode. `claude -p --input-format stream-json --output-format stream-json` accepts:
   ```json
   {"type":"control_request","request_id":"<id>","request":{"subtype":"get_usage","skip_behaviors":true}}
   ```
   - The official Agent SDK exposes this as `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors})`.
   - The bundled zod schema describes it as: *"Requests the structured /usage data … Experimental — the response shape may change."*
   - `skip_behaviors` is documented as *"For callers that need only the plan rate limits, such as a usage meter"*.
3. Live result: the response arrives in about 0.9 s and the process exits in about 1.7 s, with **no prompt sent and no tokens consumed**. Response (abridged):
   ```json
   {"subscription_type":"pro","rate_limits_available":true,
    "rate_limits":{"five_hour":{"utilization":2,"resets_at":"2026-10-01T17:30:00.107017+00:00",...},
                   "seven_day":{"utilization":11,"resets_at":"2026-10-06T15:00:00.107042+00:00",...},
                   "seven_day_opus":null,"seven_day_sonnet":null,"seven_day_oauth_apps":null,
                   "seven_day_cowork":null,"tangelo":null, ... ,
                   "extra_usage":{"is_enabled":false,"monthly_limit":24000,"used_credits":0,
                                  "utilization":0,"currency":"EUR","decimal_places":2,
                                  "disabled_reason":"out_of_credits",...},
                   "limits":[{"kind":"session","group":"session","percent":2,...},
                             {"kind":"weekly_all","group":"weekly","percent":11,...}],
                   "model_scoped":[], ...},
    "behaviors":null}
   ```
4. Envelope: `{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{…}}}`. Errors use `{"subtype":"error","request_id":"…","error":"<string>"}`.
5. `initialize` is **not required** before `get_usage` (verified both ways).
6. **Unauthenticated** (empty `CLAUDE_CONFIG_DIR`): `get_usage` *succeeds* with `{subscription_type:null, rate_limits_available:false, rate_limits:null}`. This cannot be told apart from API-key or Bedrock mode, so `claude auth status --json` is used to disambiguate:
   - Logged in: `{loggedIn:true, authMethod:"claude.ai", apiProvider:"firstParty", subscriptionType:"pro", email, orgId, orgName, ...}`, exit 0.
   - Logged out: `{loggedIn:false, authMethod:"none", ...}`, **exit 1**.
7. `--setting-sources ""` (no user, project or local settings, which means no settings hooks and no settings-enabled plugins) still works with OAuth.
8. `--bare` **breaks** OAuth ("OAuth and keychain are never read"), so it MUST NOT be used.
9. `--no-session-persistence` leaves no transcript on disk.
10. Nested invocation works from inside a running Claude Code session.
11. Undocumented response details:
    - `utilization` is 0–100 (schema text: "Percentage of the window used, 0-100"). It matched `/usage`.
    - `resets_at` is ISO-8601 with microseconds and a `+00:00` offset.
    - `extra_usage` amounts are in **minor currency units** with `decimal_places` (24000 + 2 → 240.00 EUR). `decimal_places` is not in the described schema.
    - Several codename keys (`tangelo`, `cedar_ember`, …) appear as `null`.

---

## 3. Codex provider architecture (decision)

**Decision:** spawn a short-lived, private `codex app-server` per fetch and speak its structured protocol. Use only these methods:

| Method | Purpose | Required |
|---|---|---|
| `initialize` + `initialized` | handshake | yes |
| `account/read` (`{refreshToken:false}`) | auth state, plan | yes |
| `account/rateLimits/read` (`{excludeResetCreditDetails:true}`) | **rate limits, credits, reset-credit count** | yes (core) |
| `account/usage/read` (`null`) | token analytics | only with `includeAnalytics` |

Rationale:
- This is the documented integration surface. Its schema can be generated with `codex app-server generate-json-schema` and it is versioned (`v2`).
- Codex itself handles auth and token refresh, so agent-usage never touches `~/.codex/auth.json`.
- No `/status` scraping.

Considered and deferred to v2:
- **Long-lived app-server with `account/rateLimits/updated` notifications.** This only pays off for a daemon or dashboard. It adds lifecycle complexity: crash recovery, sparse-merge semantics, memory on the Pi.
- **Attaching to the existing Codex app-server daemon** (`~/.codex/app-server-daemon`). The protocol for it is undocumented, and it would couple agent-usage to another process's lifecycle.

---

## 4. Claude provider architecture (decision)

### 4.1 Options compared

| | Strategy | Data quality | Credential exposure | Fragility | Side effects | Verdict |
|---|---|---|---|---|---|---|
| **A** | Read `~/.claude/.credentials.json`, call `GET https://api.anthropic.com/api/oauth/usage` directly | full raw | **High.** agent-usage holds the bearer. On expiry it must refresh, and **refresh-token rotation races with live Claude Code sessions and can log the user out**. Writing refreshed tokens back means mutating credentials. | **High.** Internal endpoint. Undocumented required headers or betas. Storage may move (keychain, `CLAUDE_CONFIG_DIR`). | none | **Rejected** |
| **B** | Spawn `claude -p` in stream-json mode, send the SDK control request `get_usage` (`skip_behaviors:true`) | structured, schema-described, same data as `/usage` | **None.** Claude Code uses its own auth, refresh, 401/403/429 handling and backoff memory. | **Medium.** The control subtype is explicitly "experimental, may change", but it is the same channel the official Agent SDK uses, and the CLI flags are documented. | ~1–2 s child process. No prompt, no tokens. No transcript (`--no-session-persistence`). | **Selected** |
| B′ | Same as B, but through the npm `@anthropic-ai/claude-agent-sdk` (`query()` + `usage_EXPERIMENTAL…`) | same | none | Same experimental method. Adds a large dependency that bundles **its own** Claude Code build (version skew with the installed CLI, extra disk on the Pi), and needs a dummy streaming-input prompt iterator. | same | Rejected for v1 (possible v2 swap; the provider interface allows it) |
| C | Run a real prompt and read `rate_limit_event` / `rate_limit_info` from the stream | partial (only the bucket hit), only after a model call | none | medium | **Consumes quota and tokens** | Rejected |
| D | Drive the `/usage` TUI in a PTY and parse the screen | lossy text | none | **Very high.** Layout and ANSI changes, plus a native `node-pty` build on ARM. | interactive session | Rejected. Not even a fallback in v1. |
| E | Passive sink (a statusline command or hook that writes a cache file) | partial, only while sessions run | none | medium | **Modifies the user's Claude config** | Rejected (violates independence and the no-mutation rule) |

### 4.2 Decision

**Strategy B** is the only Claude source in v1. Rationale:
1. Structured data beats scraping.
2. Credentials stay entirely inside Claude Code.
3. It is the exact data `/usage` renders, so semantics match what the user sees.
4. Claude Code's built-in refresh, retry and 429 memory protects the endpoint from over-polling.
5. When it breaks, it fails loudly and machine-detectably (a `get_usage` error or a schema mismatch). It does not return silently wrong numbers.

**There is no automatic fallback** to A or D. If B stops working after a Claude Code update, the provider reports `incompatible_provider` or `protocol_error`, and Codex keeps working. Any future fallback will be a separate provider strategy, added behind an explicit opt-in.

### 4.3 Stability statement (MUST appear in README)

`/api/oauth/usage` is an **internal, unversioned** claude.ai endpoint, and agent-usage never calls it directly. agent-usage relies on the Claude Code control request `get_usage`, which Anthropic marks **experimental and subject to change**. Claude Code auto-updates. A routine update can therefore change or remove this data source at any time. agent-usage detects this and reports it as an error. It never guesses.

---

## 5. Stability matrix

| Dependency | Status | Used for | If it changes |
|---|---|---|---|
| `codex app-server` stdio protocol (`initialize`, `account/read`, `account/rateLimits/read`) | Documented, versioned (v2), schema-generatable. Evolving pre-1.0. | Codex core | Schema validation fails → `protocol_error` |
| `account/usage/read` | In the generated schema, analytics only | `--analytics` | Provider becomes `partial` |
| Codex `resetsAt` unit (seconds) | **Observed**, not stated in the type docs | timestamps | Heuristic plus warning (Section 7.4) |
| `claude -p --input-format/--output-format stream-json`, `--no-session-persistence`, `--setting-sources`, `--strict-mcp-config`, `--tools` | Documented CLI flags | Claude transport | Spawn failure or arg error → `process_error` |
| SDK control envelope (`control_request`/`control_response`) | Used by the official Agent SDK. The wire format is not separately documented. | Claude transport | `protocol_error` |
| `get_usage` subtype and response shape | **Explicitly experimental** | Claude core | `incompatible_provider` / `protocol_error` |
| `extra_usage.decimal_places`, codename limit keys, `limits[]`, `model_scoped[]` | **Undocumented** | Claude extras | Fields become `null` plus a warning |
| `claude auth status --json` | Documented subcommand | Disambiguating "unavailable" | Falls back to `rate_limits_unavailable` |
| `/api/oauth/usage` | Internal | **Not used directly** | n/a |

---

## 6. Normalized domain model (TypeScript)

Location: `src/domain/model.ts`. The output contract is also defined as a zod schema in `src/domain/reportSchema.ts`. The TS types **MUST** be `z.infer` of that schema, so there is a single source of truth. A JSON Schema file is generated from it (Section 8.5).

### 6.1 Principles

1. **Three separate concepts**, never mixed:
   - `limits[]`: rate limits and availability
   - `credits[]`: monetary or provider credits
   - `analytics`: historical token usage
2. **`null` means unknown.** Never fabricate a value. For example, don't invent a window duration without labelling it as inferred, and don't assume a currency.
3. **No raw provider types or payloads leak** into the domain model or the public v1 contract. Raw shapes live only in `src/providers/*/schema.ts`. Raw payloads exist only inside a provider during a fetch, and as test fixtures.
4. **Scoped limits are first-class.** One flat `limits[]` array uses a typed `scope`. There are no provider-specific top-level fields such as `opus`.
5. Timestamps in the contract are ISO-8601 UTC strings with millisecond precision and a `Z` suffix.
6. Percentages are numbers, rounded to at most 2 decimals. Money and credit amounts are **decimal strings**, never floats.

### 6.2 Types

```ts
export type ProviderId = "codex" | "claude";

export interface UsageReport {
  schemaVersion: 1;
  tool: { name: "agent-usage"; version: string };
  generatedAt: string;              // ISO UTC, when getUsage() resolved
  providers: ProviderReport[];      // in requested order; one entry per requested provider, always
}

export type FetchStatus = "ok" | "partial" | "error";

export interface ProviderReport {
  provider: ProviderId;
  status: FetchStatus;
  fetchedAt: string;                // ISO UTC, when provider data was received (or failure time)
  durationMs: number;               // integer
  source: SourceInfo;
  account: AccountInfo | null;      // null when unknown / not authenticated
  availability: Availability;
  limits: RateLimit[];              // [] when status === "error"
  credits: CreditBalance[];         // [] when none / unknown
  resetCredits: ResetCredits | null;// Codex rate-limit reset credits (count only); null for Claude
  analytics: TokenAnalytics | null; // only populated when includeAnalytics; else null
  errors: ProviderIssue[];          // non-empty iff status !== "ok"
  warnings: ProviderIssue[];        // anomalies that did not prevent reporting
  // No `raw` field in v1: raw provider payloads are not part of the public contract (see 15.2).
}

export interface SourceInfo {
  method: "codex-app-server" | "claude-control-get-usage";
  stability: "supported" | "experimental";   // codex: "supported"; claude: "experimental"
  providerVersion: string | null;            // e.g. "0.159.2", "2.1.286"
}

export interface AccountInfo {
  plan: string | null;              // provider-native plan id, lowercased: "plus", "pro", "max", ...
  authMode: string | null;          // provider-native: codex "chatgpt"|"apiKey"|..., claude "claude.ai"|...
  // Deliberately NO email, account id, org id (PII; Section 11).
}

export type AvailabilityState = "available" | "limited" | "unknown";

export interface Availability {
  state: AvailabilityState;
  basis: "provider_flag" | "derived_from_limits" | "none";
  // provider_flag: provider said so explicitly (codex ordinaryUsageAllowed / rateLimitReachedType)
  // derived_from_limits: computed by the rule in Section 7.3/8.3 — documented, mechanical, not a decision
  reason: string | null;            // machine-ish code e.g. "rate_limit_reached", "limit_exhausted:weekly"
  exhaustedLimitIds: string[];      // ids of limits with usedPercent >= 100 (any scope)
}

export type LimitKind = "session" | "weekly" | "spend_control" | "other";

export type LimitScope =
  | { type: "account" }                                   // applies to all usage
  | { type: "model"; model: string }                      // e.g. "opus", "sonnet", "fable"
  | { type: "product"; product: string }                  // e.g. "oauth_apps", "cowork"
  | { type: "bucket"; bucket: string; name: string | null; model: string | null }; // codex limitId buckets / unknown keys

export interface RateLimit {
  id: string;                       // stable id, see 6.3
  kind: LimitKind;
  scope: LimitScope;
  label: string;                    // human label: "5h", "Weekly", "Weekly (Opus)"
  usedPercent: number | null;       // as reported (may exceed 100), rounded to 2 dp
  remainingPercent: number | null;  // clamp(100 - usedPercent, 0, 100); null iff usedPercent null
  windowMinutes: number | null;
  windowSource: "reported" | "inferred" | "unknown";
  resetsAt: string | null;          // ISO UTC
  providerKey: string;              // raw origin, e.g. "rateLimits.primary", "rate_limits.five_hour"
}

export type CreditUnit =
  | { type: "provider_credits" }                // opaque provider credits — NOT money
  | { type: "currency"; currency: string };     // ISO 4217 as reported (upper-cased)

export interface CreditBalance {
  id: string;                       // "codex_credits" | "claude_extra_usage"
  label: string;                    // "Credits" | "Extra usage"
  unit: CreditUnit;
  balance: string | null;           // decimal string (remaining), when provider reports a balance
  used: string | null;              // decimal string
  limit: string | null;             // decimal string
  usedPercent: number | null;
  unlimited: boolean | null;
  hasCredits: boolean | null;
  enabled: boolean | null;          // claude extra usage on/off
  disabledReason: string | null;    // provider code, e.g. "out_of_credits"
  providerKey: string;
}

export interface ResetCredits {
  availableCount: number;           // informational ONLY; agent-usage never consumes these
}

export interface TokenAnalytics {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  daily: { date: string /* YYYY-MM-DD as reported */; tokens: number }[];
}

export type IssueCode =
  | "not_installed"          // binary not found (ENOENT/EACCES)
  | "not_authenticated"      // provider CLI not logged in
  | "unsupported_auth"       // logged in, but via a mode without plan limits (API key, Bedrock, ...)
  | "rate_limits_unavailable"// logged in with subscription but provider reports no rate-limit data (e.g. token lacks scope)
  | "upstream_unavailable"   // provider reached but its backend data fetch failed (network/429/5xx/refresh failure) — retryable
  | "upstream_error"         // provider returned an explicit error we don't map more precisely
  | "timeout"
  | "process_error"          // child exited/crashed before answering, spawn failed, stdin EPIPE
  | "protocol_error"         // malformed line, unexpected envelope, schema validation failure
  | "incompatible_provider"  // provider says method/subtype unsupported (version drift)
  | "aborted"                // caller's AbortSignal fired
  | "internal";              // bug in agent-usage

export interface ProviderIssue {
  code: IssueCode | string;  // consumers MUST tolerate unknown codes
  message: string;           // human readable, redacted, ≤ 300 chars
  retryable: boolean;
  hint: string | null;       // e.g. "Run `codex login`."
}
```

`ProviderIssue` is also used for warnings and for errors on `partial` reports. Additional codes:
- **Warnings:** `unknown_limit_key`, `invalid_window` (a malformed individual window or field that was skipped), `timestamp_unit_heuristic`, `invalid_timestamp`, `invalid_number`, `ambiguous_units`, `precision_loss`, `duplicate_limit_id`, `auth_status_failed`, `analytics_not_supported`.
- **Errors on `partial` reports:** `analytics_failed`.

### 6.3 Limit IDs (stable contract)

| id | meaning |
|---|---|
| `session` | account-wide short rolling window (Codex 300-min window, Claude `five_hour`) |
| `weekly` | account-wide 7-day window |
| `weekly:model:<slug>` | model-scoped weekly window (`opus`, `sonnet`, slug of `model_scoped[].display_name`) |
| `weekly:product:<slug>` | product-scoped weekly window (`oauth_apps`, `cowork`) |
| `<kind>:bucket:<limitId>` | extra Codex buckets from `rateLimitsByLimitId` other than the default |
| `spend_control` | Codex `individualLimit` |
| `other:<providerKey-slug>` | anything not otherwise classifiable |

`slug(s)` means: lowercase, replace every run of `[^a-z0-9]` with `_`, then trim `_`.

If two limits would get the same id, the later one gets the suffix `#2`, `#3`, and so on, plus a `duplicate_limit_id` warning.

Consumers can rely on `session` and `weekly`. An orchestrator does `report.limits.find(l => l.id === "weekly")`. The library also exports a helper, `findLimit(report, id)`.

### 6.4 `status` semantics

- `ok`: the core rate-limit read succeeded and `errors` is empty.
- `partial`: the core rate-limit read succeeded, but a secondary read that the caller asked for failed. Example: `--analytics` was requested and `account/usage/read` failed (error code `analytics_failed`). `errors` is non-empty. Informational helpers such as `claude --version` never affect `status` (Section 8.2).
- `error`: the core rate-limit read failed. `limits` is `[]` and `availability.state` is `"unknown"`.

Warnings never change `status`.

---

## 7. Codex provider — detailed design

Files: `src/providers/codex/{index,appServerClient,schema,normalize}.ts`.

### 7.1 `AppServerClient`

- Spawns `[bin, "app-server"]`.
  - `bin` is `options.binaries.codex ?? env.AGENT_USAGE_CODEX_BIN ?? "codex"`, resolved through PATH by spawn.
  - Uses `src/process/jsonlProcess.ts` (Section 9).
  - `cwd` is `os.tmpdir()`. `env` is inherited unchanged.
- `request(method, params)`:
  - Returns a promise resolved by the matching `id`.
  - Ids are incrementing integers starting at 1.
  - Out-of-order responses MUST be supported.
- **Method allowlist (hard):** `initialize`, `account/read`, `account/rateLimits/read`, `account/usage/read`. Any other method throws `Error("method not allowed")` synchronously, *before* any write. The allowlist is a `const` frozen array in `appServerClient.ts`. There is no API to extend it at runtime.
- Allowed outgoing notifications: only `initialized`.
- Incoming messages:
  - Has `id` and (`result` or `error`), no `method` → response to a pending request.
  - Has `method` and no `id` → notification. Ignore in v1 (debug-log the method name only).
  - Has `method` and `id` → a **server-to-client request** (for example an approval). Reply immediately with `{"id":<same>,"error":{"code":-32601,"message":"agent-usage: client does not handle server requests"}}`.
  - A response with an unknown id → ignore and debug-log.
  - Non-JSON line → `protocol_error` for every pending request.
- stderr: kept in an 8 KiB ring buffer. Never printed (Section 11). It is used only for debug output (`--debug`, redacted) and to classify a `process_error`.

### 7.2 Fetch sequence

```
t0  spawn
    → initialize {clientInfo:{name:"agent-usage",title:"agent-usage",version:<pkg version>}, capabilities:null}
    ← result                     (extract providerVersion: first /\d+\.\d+\.\d+/ match in userAgent, else null)
    → initialized (notification)
    → account/read {refreshToken:false}                         ┐ sent together;
    → account/rateLimits/read {excludeResetCreditDetails:true}  │ awaited with
    → account/usage/read null        (only if includeAnalytics) ┘ Promise.allSettled
    ← responses in any order
    close stdin → wait exit ≤ 2 s → SIGTERM process group → +1 s → SIGKILL
```

All of this runs under one provider deadline (`timeoutMs`, default 20 000). On deadline: kill, then `timeout`.

### 7.3 Interpretation and availability

Auth classification, from `account/read` and the rate-limits error:
- `account === null`, or a rate-limits error whose message matches `/auth(entication)? required/i` → `not_authenticated` (hint: "Run `codex login`.").
- `account.type === "apiKey"` (or any non-`chatgpt` type) and the rate-limits read failed → `unsupported_auth`. If the rate-limits read succeeded anyway, report it normally and set `authMode` from `account.type`.
- If `account/read` itself failed but the rate-limits read succeeded → status `ok`, `account.plan` from `rateLimits.planType`, `authMode: null`.

Other JSON-RPC errors on the rate-limits read:
- code `-32601` (method not found) → `incompatible_provider`.
- Anything else → `upstream_error` with the message redacted and truncated. Mark it `retryable:true` unless the code is `-32600`/`-32602`.

Availability (Codex):
1. `rateLimitReachedType !== null` → `limited`, basis `provider_flag`, reason is the reached type.
2. Otherwise `ordinaryUsageAllowed === false` → `limited`, basis `provider_flag`, reason `ordinary_usage_not_allowed`.
3. Otherwise `spendControlReached === true` → `limited`, basis `provider_flag`, reason `spend_control_reached`.
4. Otherwise `ordinaryUsageAllowed === true` → `available`, basis `provider_flag`.
5. Otherwise (`null`):
   - any `scope.type==="account"` limit with `usedPercent >= 100` → `limited`, basis `derived_from_limits`, reason `limit_exhausted:<id>`
   - else, if at least one limit exists → `available`, basis `derived_from_limits`
   - else → `unknown`, basis `none`.

`exhaustedLimitIds` is always computed from all limits.

### 7.4 Normalization rules

Bucket selection:
- If `rateLimitsByLimitId` is a non-empty object, the **default bucket** is the one whose key equals `rateLimits.limitId`, or else `"codex"`. Its windows get scope `account`.
- Every *other* bucket's windows get scope `{type:"bucket", bucket:key, name:limitName, model:normalModelSlug}`, with ids like `<kind>:bucket:<slug(key)>`.
- If `rateLimitsByLimitId` is null or empty, use `rateLimits` as the default bucket.

Windows (applies to `primary` and `secondary`; `null` → skip):
- `windowDurationMins === 300` → kind `session`, label `5h`.
- `windowDurationMins === 10080` → kind `weekly`, label `Weekly`.
- Any other non-null value → kind `other`, id `other:<providerKey-slug>`, label from `formatDuration(mins)` (`"90m"`, `"8h"`, `"3d"`).
- `null` → kind `other`, label `Primary` or `Secondary`, `windowSource:"unknown"`.
- `windowSource` is `"reported"` when the duration is non-null.
- `providerKey` is `rateLimits.primary`, `rateLimits.secondary` or `rateLimitsByLimitId.<key>.primary`.

Numbers:
- `usedPercent`: must be a finite number, else `null` plus an `invalid_number` warning. Round to 2 dp.
- `remainingPercent = round2(clamp(100 - used, 0, 100))`.

`resetsAt` (number):
- `< 1e11` → seconds.
- `≥ 1e11` → milliseconds, plus a `timestamp_unit_heuristic` warning.
- `≤ 0` or not finite → `null` plus `invalid_timestamp`.
- Output `new Date(ms).toISOString()`.

`individualLimit` (non-null) → a `RateLimit`:
- id `spend_control`, kind `spend_control`, scope `account`, label `Spend cap`
- `usedPercent = round2(100 - remainingPercent)`, `resetsAt` per the rules above
- `windowMinutes:null`, `windowSource:"unknown"`
- Its `limit`/`used` strings are **not** interpreted as money and are not exposed in v1.

`credits` (non-null) → one `CreditBalance`:
- id `codex_credits`, label `Credits`, unit `{type:"provider_credits"}`
- `balance` must match `/^-?\d+(\.\d+)?$/`; it is passed through **verbatim**, trailing zeros included. Otherwise `null` plus `invalid_number`.
- `hasCredits` and `unlimited` copied
- `used`, `limit`, `usedPercent`, `enabled`, `disabledReason` are `null`

Never label Codex credits as currency.

Other fields:
- `rateLimitResetCredits` → `resetCredits = {availableCount: Number(availableCount)}`, or `null`. Credit detail rows are never requested.
- `account = {plan: rateLimits.planType ?? account.planType ?? null, authMode: account?.type ?? null}`.

Analytics (`account/usage/read`):
- Map the summary fields directly. Each must be a safe integer, else `null` plus `precision_loss` / `invalid_number`.
- `daily = dailyUsageBuckets ?? []`, sorted ascending by `date`.
- `threadUsage` is ignored.
- On failure: `analytics:null`, status `partial`, plus an error with code `analytics_failed`, the underlying code in the message, and `retryable` taken from it.

### 7.5 Raw schemas (`schema.ts`)

zod schemas for the `initialize` result, `GetAccountResponse`, `GetAccountRateLimitsResponse` and `GetAccountTokenUsageResponse`, written from `codex-protocol/ts/v2`:
- All objects use `.passthrough()`. Unknown fields are allowed.
- Only fields this spec reads are declared. Every nullable or optional field in the generated TS stays nullable here.
- A validation failure of the **core** rate-limits response → `protocol_error`, with a message listing the first 3 zod issue paths.

---

## 8. Claude provider — detailed design

Files: `src/providers/claude/{index,controlClient,authStatus,schema,normalize}.ts`.

### 8.1 Control client

- `bin` is `options.binaries.claude ?? env.AGENT_USAGE_CLAUDE_BIN ?? "claude"`.
- Exact argv (MUST NOT be changed without updating this spec):
  ```
  claude -p
         --input-format stream-json
         --output-format stream-json
         --verbose
         --no-session-persistence
         --setting-sources ""          (empty string argv element)
         --strict-mcp-config
         --tools ""                    (empty string argv element)
  ```
  The argv is passed as an array, never through a shell.
  - `--bare` MUST NOT be used (it disables OAuth).
  - No `--model` and no prompt argument.
- `cwd`: a fresh directory from `fs.mkdtemp(path.join(os.tmpdir(), "agent-usage-claude-"))`, removed recursively in `finally`. This avoids project `.claude/settings.json` hooks, CLAUDE.md discovery and trust prompts.
- `env`: the caller's environment, inherited unchanged (Section 11.1).
  - agent-usage does not look at or strip `ANTHROPIC_API_KEY` or similar variables.
  - The result is that agent-usage reports what Claude Code *would* use in this environment. An API-key environment correctly shows up as `unsupported_auth`.
  - This behavior MUST be documented in the README.
- Messages written to stdin (both written at once, newline-terminated):
  ```json
  {"type":"control_request","request_id":"agent-usage-init-<uuid>","request":{"subtype":"initialize"}}
  {"type":"control_request","request_id":"agent-usage-usage-<uuid>","request":{"subtype":"get_usage","skip_behaviors":true}}
  ```
  `initialize` mirrors the official SDK handshake for forward compatibility. Its response is **discarded unparsed** because it contains account PII. A failed `initialize` is ignored.
- **Allowlist (hard):** the client can only emit `control_request` with subtype `initialize` or `get_usage`, plus `control_response` errors to server requests. No method exists that writes `{"type":"user",...}`. A unit test enforces this.
- Incoming lines:
  - `control_response` whose `request_id` matches the usage id → done.
  - `control_request` from Claude (for example `can_use_tool`) → reply `{"type":"control_response","response":{"subtype":"error","request_id":<theirs>,"error":"agent-usage does not handle requests"}}`.
  - Anything else (`system`, `commands_changed`, …) → ignore.
  - Non-JSON → `protocol_error`.
- After the usage response: end stdin and wait for exit ≤ 2 s. Then SIGTERM the process group, and SIGKILL 1 s later.

### 8.2 Concurrent helper calls

These run in parallel with the control client, under the same deadline.

**Core-response rule:** once the `get_usage` response has been received, the provider's outcome is decided by that response. This matches the Codex provider, where an analytics read cut off by the deadline yields `partial` and not `timeout`. If the deadline or the caller's signal fires while a helper is still running, the helper is treated as **failed**, never as a provider failure:
- `--version` → `providerVersion: null`
- `auth status` → the "auth status failed" branch of Section 8.3 (`rate_limits_unavailable` plus an `auth_status_failed` warning)

`timeout` / `aborted` are reported only when the signal fires **before** the `get_usage` response arrives.


1. `claude --version`, 5 s timeout. Parse `/^(\d+\.\d+\.\d+)/` into `source.providerVersion`. Failure → `null`. This does not affect `status`.
2. **Only when needed** (`rate_limits_available === false`): `claude auth status --json`, 10 s timeout, same temp `cwd`.
   - Parse stdout as JSON **regardless of exit code** (exit 1 means logged out).
   - Read **only** `loggedIn`, `authMethod`, `apiProvider`, `subscriptionType`. Everything else (email, orgId, orgName, paths) is dropped at parse time and never stored.

### 8.3 Interpretation

`get_usage` error response (`subtype:"error"`):
- `error` matches `/not supported|unknown subtype|unsupported/i` → `incompatible_provider` (hint: "Claude Code version may have changed the experimental get_usage API").
- Otherwise → `upstream_error`.

Success, classified in this order:
1. Schema validation fails → `protocol_error`.
2. `rate_limits_available === false` → consult auth status:
   - `loggedIn === false` → `not_authenticated`, hint "Run `claude` and use /login."
   - `authMethod !== "claude.ai"` or `apiProvider !== "firstParty"` → `unsupported_auth` (message names the authMethod and apiProvider).
   - logged in via claude.ai → `rate_limits_unavailable`, hint "Token may lack the profile scope (e.g. created with setup-token); log in interactively."
   - auth status failed or unparsable → `rate_limits_unavailable`, plus an `auth_status_failed` warning.
3. `rate_limits_available === true && rate_limits === null` → `upstream_unavailable`, `retryable:true`. Hint: "Claude Code could not fetch usage (network, rate limiting, or token refresh failure). If this persists run `claude` and /login."
4. Otherwise → normalize (Section 8.4).

Availability (Claude): Claude reports no explicit allow flag, so `basis` is always `derived_from_limits`:
- any `scope.type==="account"` limit with `usedPercent >= 100` → `limited`, reason `limit_exhausted:<id>`
- otherwise, if limits exist → `available`
- otherwise → `unknown`

Model-scoped exhaustion appears in `exhaustedLimitIds` but **does not** make the provider `limited`. Deciding about that is the consumer's job.

### 8.4 Normalization rules

Known keys in `rate_limits` (an object value that is not null → one `RateLimit`):

| raw key | id | kind | scope | label | windowMinutes (inferred) |
|---|---|---|---|---|---|
| `five_hour` | `session` | session | account | `5h` | 300 |
| `seven_day` | `weekly` | weekly | account | `Weekly` | 10080 |
| `seven_day_opus` | `weekly:model:opus` | weekly | model `opus` | `Weekly (Opus)` | 10080 |
| `seven_day_sonnet` | `weekly:model:sonnet` | weekly | model `sonnet` | `Weekly (Sonnet)` | 10080 |
| `seven_day_oauth_apps` | `weekly:product:oauth_apps` | weekly | product `oauth_apps` | `Weekly (OAuth apps)` | 10080 |
| `seven_day_cowork` | `weekly:product:cowork` | weekly | product `cowork` | `Weekly (Cowork)` | 10080 |

All rows in the table use `windowSource: "inferred"`.

Other sources:
- **`model_scoped[]`** entries → id `weekly:model:<slug(display_name)>`, label `Weekly (<display_name>)`, scope model `<slug>`, 10080 inferred. If the id already exists from a named key, skip the entry (the named key wins).
- **Non-reserved keys** whose value is an object with a numeric-or-null `utilization` and a string-or-null `resets_at` → kind `other`, id `other:<slug(key)>`, scope `{type:"bucket", bucket:key, name:null, model:null}`, label is the key, `windowSource:"unknown"`, plus an `unknown_limit_key` warning (one warning per key).
  - Reserved keys: the table above plus `extra_usage`, `limits`, `spend`, `model_scoped`, `seven_day_breakdown`, `member_dashboard_available`.
  - `null`-valued codename keys are ignored silently.
- `limits[]`, `spend` and `seven_day_breakdown` are **not** normalized or exposed in v1 (see 15.2).

Field rules:
- `utilization`: a finite number → `usedPercent` (0–100 scale as documented; **never rescaled**). `null` → `usedPercent:null`.
- `resets_at`: parse with `Date.parse`. Valid → `toISOString()` (microseconds are truncated to ms, which is fine). Invalid → `null` plus `invalid_timestamp`. `null` → `null`.

`extra_usage` (non-null) → one `CreditBalance`:
- id `claude_extra_usage`, label `Extra usage`
- unit `{type:"currency", currency: upper(currency)}` if `currency` matches `/^[A-Za-z]{3}$/`. Otherwise all amounts are `null` plus `ambiguous_units`, and the unit is `{type:"provider_credits"}`.
- If `decimal_places` is an integer in 0..6 → `used = toDecimal(used_credits, dp)` and `limit = toDecimal(monthly_limit, dp)`, where `toDecimal(24000, 2) === "240.00"` and integer minor units are converted by string math. Otherwise both are `null` plus `ambiguous_units`.
- `balance: null`
- `usedPercent = utilization`
- `enabled = is_enabled`, `disabledReason = disabled_reason ?? null`
- `unlimited: null`, `hasCredits: null`

Other fields:
- `account = {plan: subscription_type ?? null, authMode: rate_limits_available ? "claude.ai" : (authStatus?.authMethod ?? null)}`
- `resetCredits = null`
- `analytics = null`, even with `includeAnalytics`. Claude analytics are out of scope for v1. Add a warning `analytics_not_supported` only when analytics was requested.

### 8.5 Raw schema (`schema.ts`)

zod, all objects `.passthrough()`:

```
GetUsageResponse = {
  subscription_type: string | null (nullish),
  rate_limits_available: boolean,            // REQUIRED — absence ⇒ protocol_error
  rate_limits: RateLimits | null (nullish),
  ...passthrough
}
Window = { utilization: number|null (nullish), resets_at: string|null (nullish), ...passthrough }
RateLimits = { five_hour?, seven_day?, seven_day_opus?, seven_day_sonnet?, seven_day_oauth_apps?,
               seven_day_cowork?: Window|null,
               model_scoped?: {display_name:string, utilization:number|null, resets_at:string|null}[],
               extra_usage?: { is_enabled: boolean, monthly_limit: number|null, used_credits: number|null,
                               utilization: number|null, currency?: string|null,
                               decimal_places?: number, disabled_reason?: string|null } | null,
               ...passthrough }
```

Only `rate_limits_available` is strictly required. A broken *individual* window is converted into a warning and skipped, so one bad field does not fail the provider. A non-object `rate_limits` → `protocol_error`.

---

## 9. Shared process layer

File: `src/process/jsonlProcess.ts`. It is used by both providers. The `runCommand` helper (for `--version` and `auth status`) lives here too.

```ts
interface JsonlProcessOptions {
  bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  signal: AbortSignal;              // combined deadline + caller signal
  maxLineBytes?: number;            // default 16 MiB → protocol_error if exceeded
  stderrRingBytes?: number;         // default 8 KiB
  onLine(obj: unknown): void;       // parsed JSON per line
  onProtocolError(err: Error): void;// non-JSON line
}
interface JsonlProcess {
  write(obj: unknown): void;        // JSON.stringify + "\n"; EPIPE → process_error
  endInput(): void;
  exited: Promise<{ code: number | null; signal: string | null }>;
  terminate(): Promise<void>;       // SIGTERM group, 1 s, SIGKILL group
  stderrTail(): string;
}
```

Requirements:
- Pass `env` to `spawn` by reference, unmodified (Section 11.1).
- Spawn with `detached: true` so the whole process group can be killed with `process.kill(-pid, sig)`, and `stdio: ["pipe","pipe","pipe"]`. Never `shell: true`.
- `ENOENT` / `EACCES` on spawn → `not_installed`. Spawn has to be observed through the `error` event.
- If the child exits before the awaited response → `process_error`, with the exit code and a redacted stderr tail (≤ 200 chars) in the message.
- On `signal` abort → terminate. The deadline produces `timeout`; the caller's signal produces `aborted`.
- Register a `process.on("exit")` hook that SIGKILLs every live child group, so no orphan survives Ctrl-C.
- Line framing uses `readline` over stdout and tolerates `\r\n`. Empty lines are ignored.

`runCommand(bin, args, {cwd, env, timeoutMs})` → `{code, stdout (≤ 1 MiB), stderr tail}`. It uses the same kill semantics.

---

## 10. Library API and provider interface

### 10.1 Provider interface (`src/providers/types.ts`)

```ts
export interface ProviderContext {
  timeoutMs: number;
  signal: AbortSignal;              // already combined (deadline + caller)
  includeAnalytics: boolean;
  env: NodeJS.ProcessEnv;
  bin: string | undefined;          // explicit override, else provider default
  now: () => Date;                  // injectable clock (tests)
  debug: (msg: string) => void;     // no-op unless debug enabled; MUST receive pre-redacted strings
}

export interface UsageProvider {
  readonly id: ProviderId;
  /** Never rejects for provider failures: returns a ProviderReport with status "error". */
  fetch(ctx: ProviderContext): Promise<ProviderReport>;
}
```

Each provider is a pipeline:
1. transport client (raw JSON)
2. `schema.ts` validation
3. `normalize.ts`, a **pure function** `(raw, ctxInfo) → Omit<ProviderReport, timing fields>`
4. `index.ts`, which assembles and times everything

Normalizers MUST be pure and I/O-free, so they can be unit-tested with fixtures alone.

### 10.2 Public API (`src/index.ts`)

```ts
export interface GetUsageOptions {
  providers?: ProviderId[];         // default ["codex","claude"]; order preserved; duplicates removed
  timeoutMs?: number;               // per provider; default 20000; min 1000
  includeAnalytics?: boolean;       // default false
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;          // default process.env; passed to children unchanged, never inspected (11.1)
  binaries?: Partial<Record<ProviderId, string>>;
  now?: () => Date;
  debug?: (msg: string) => void;
}

export function getUsage(opts?: GetUsageOptions): Promise<UsageReport>;   // never rejects for provider failures
export function getCodexUsage(opts?: Omit<GetUsageOptions,"providers">): Promise<ProviderReport>;
export function getClaudeUsage(opts?: Omit<GetUsageOptions,"providers">): Promise<ProviderReport>;
export function findLimit(r: ProviderReport, id: string): RateLimit | undefined;
export { UsageReportSchema } from "./domain/reportSchema.js";  // zod, for consumers who validate
export type { UsageReport, ProviderReport, RateLimit, ... } from "./domain/model.js";
export const SCHEMA_VERSION = 1;
```

`getUsage`:
- Runs providers **concurrently** (`Promise.all` over wrapped calls).
- Each call is wrapped in `try/catch`. A thrown exception becomes an `internal` error report for that provider only.
- Each call has its own `AbortSignal.any([AbortSignal.timeout(timeoutMs), opts.signal])`.
- One provider can never block or fail the other.
- `getUsage` rejects **only** for invalid options (`TypeError`, e.g. an unknown provider id).

The core MUST NOT import anything from `src/cli/`. A test enforces this (Section 13.6).

---

## 11. Security boundaries

### 11.1 Credentials

- agent-usage MUST NOT open, stat, read or watch:
  - `~/.claude/.credentials.json` or any keychain or secret-service entry
  - `~/.codex/auth.json`
- Source under `src/` MUST NOT contain the strings `.credentials.json`, `auth.json`, `api/oauth/usage`, `accessToken`, `refresh_token`. A static test enforces this (Section 13.6).
- **Environment rule:** agent-usage MUST NOT inspect, log, copy, modify or persist credential-bearing environment variables. Provider child processes may inherit the caller's environment unchanged.
  - Credential-bearing means things like `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `*_TOKEN`.
  - In practice, the environment object (`process.env`, or `GetUsageOptions.env`) is passed to `spawn` **by reference**: it is not cloned, spread, filtered or augmented.
  - agent-usage code never enumerates or serializes the environment, and never includes it in debug output or errors.
  - The only variables agent-usage reads by name are its own non-secret ones: `AGENT_USAGE_CODEX_BIN`, `AGENT_USAGE_CLAUDE_BIN`, `NO_COLOR`, and the test-only `AGENT_USAGE_NOW`. It also reads `TZ` indirectly through `Intl`.
- MUST NOT persist anything. v1 has no config file, cache, or state directory. The only filesystem write is the ephemeral Claude temp cwd.
- Token refresh is done exclusively by the provider CLIs inside their own processes.

### 11.2 PII minimization

- Email, account ids, org ids and org names are dropped at parse time:
  - Codex `account.email`, `accountId`, `workspaceRouting`
  - Claude `initialize` (discarded unparsed), `auth status` extra fields
- They never enter `ProviderReport` or any other public output.

### 11.3 No-mutation guarantees

- Codex method allowlist (Section 7.1). In particular, `account/rateLimitResetCredit/consume`, `account/login/*`, `account/logout` and `account/sendAddCreditsNudgeEmail` are unreachable.
- Claude subtype allowlist (Section 8.1). No user messages, no `oauth_token_refresh`, no `update_settings`.
- The CLI has **no** flags that change provider state.

### 11.4 Redaction (`src/redact.ts`)

v1 exposes no raw payloads, so redaction covers only text that leaves the process: error messages, stderr tails and `--debug` diagnostics.

`redactText(s)` replaces substrings matching token-like patterns with `[REDACTED]`:
- `/sk-[A-Za-z0-9_-]{16,}/`
- `/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?/` (JWT)
- `/Bearer\s+\S+/i`
- `/[\w.+-]+@[\w-]+\.[\w.-]+/` (email)
- any `[A-Za-z0-9_-]{40,}`

Rules:
- Every `ProviderIssue.message` derived from provider text (JSON-RPC error messages, `get_usage` error strings, stderr tails) MUST pass through `redactText` and be truncated to 300 chars.
- Debug lines contain only event descriptions (spawn argv, message types and method names, request ids, timings, exit codes). They never contain payload values or environment contents, and are passed through `redactText` as defence in depth.

### 11.5 Process hygiene

- No shell. Argv arrays only.
- Claude runs with no settings sources, no MCP, no tools, no session persistence, and in an empty temp cwd.
- Children are killed by process group on timeout, abort or exit.

---

## 12. CLI

### 12.1 Synopsis

```
agent-usage [codex|claude ...] [options]

Options:
  --json              Print the UsageReport as JSON (schema v1) to stdout
  --analytics         Include token analytics (Codex account/usage/read)
  --timeout <sec>     Per-provider timeout in seconds (default 20, min 1)
  --no-color          Disable ANSI colors (also: NO_COLOR env, non-TTY stdout)
  --debug             Diagnostic log lines to stderr (redacted; never payload values)
  -h, --help
  -V, --version
```

- Positional args choose providers. The default is all, in the order `codex`, `claude`.
- Unknown positional args or flags → usage error.
- Parsing uses `node:util` `parseArgs` (no dependency).
- `--watch` and `--raw` are **not** v1 options (deferred to v2, Section 15.2). Like any unknown flag they produce a usage error (exit 2).

### 12.2 JSON output

- One `UsageReport`, pretty-printed with 2 spaces, plus a trailing newline. Always printed, even when providers fail.
- Nothing else goes to stdout. Diagnostics go to stderr.
- Each invocation performs exactly one fetch and prints exactly one report.
- The report contains only the fields defined in Section 6. There is no `raw` field.

Contract and versioning:
- `schemaVersion` is `1`. Adding fields, enum values or issue codes is **non-breaking** and does not bump the version. Removing or renaming fields, or changing semantics, bumps it.
- Consumers MUST ignore unknown fields and tolerate unknown enum values.
- `schema/usage-report.v1.schema.json` is generated from the zod schema (`npm run schema`) and committed.

Example (`agent-usage --json`, values from 2026-10-01):

```json
{
  "schemaVersion": 1,
  "tool": { "name": "agent-usage", "version": "0.1.0" },
  "generatedAt": "2026-10-01T13:40:02.120Z",
  "providers": [
    {
      "provider": "codex",
      "status": "ok",
      "fetchedAt": "2026-10-01T13:40:01.050Z",
      "durationMs": 1081,
      "source": { "method": "codex-app-server", "stability": "supported", "providerVersion": "0.159.2" },
      "account": { "plan": "plus", "authMode": "chatgpt" },
      "availability": { "state": "available", "basis": "provider_flag", "reason": null, "exhaustedLimitIds": [] },
      "limits": [
        { "id": "session", "kind": "session", "scope": { "type": "account" }, "label": "5h",
          "usedPercent": 0, "remainingPercent": 100, "windowMinutes": 300, "windowSource": "reported",
          "resetsAt": "2026-10-01T18:39:40.000Z", "providerKey": "rateLimits.primary" },
        { "id": "weekly", "kind": "weekly", "scope": { "type": "account" }, "label": "Weekly",
          "usedPercent": 22, "remainingPercent": 78, "windowMinutes": 10080, "windowSource": "reported",
          "resetsAt": "2026-10-04T13:09:07.000Z", "providerKey": "rateLimits.secondary" }
      ],
      "credits": [
        { "id": "codex_credits", "label": "Credits", "unit": { "type": "provider_credits" },
          "balance": "452.0439000000", "used": null, "limit": null, "usedPercent": null,
          "unlimited": false, "hasCredits": true, "enabled": null, "disabledReason": null,
          "providerKey": "rateLimits.credits" }
      ],
      "resetCredits": { "availableCount": 2 },
      "analytics": null,
      "errors": [],
      "warnings": []
    },
    {
      "provider": "claude",
      "status": "ok",
      "fetchedAt": "2026-10-01T13:40:02.110Z",
      "durationMs": 1752,
      "source": { "method": "claude-control-get-usage", "stability": "experimental", "providerVersion": "2.1.286" },
      "account": { "plan": "pro", "authMode": "claude.ai" },
      "availability": { "state": "available", "basis": "derived_from_limits", "reason": null, "exhaustedLimitIds": [] },
      "limits": [
        { "id": "session", "kind": "session", "scope": { "type": "account" }, "label": "5h",
          "usedPercent": 2, "remainingPercent": 98, "windowMinutes": 300, "windowSource": "inferred",
          "resetsAt": "2026-10-01T17:30:00.107Z", "providerKey": "rate_limits.five_hour" },
        { "id": "weekly", "kind": "weekly", "scope": { "type": "account" }, "label": "Weekly",
          "usedPercent": 11, "remainingPercent": 89, "windowMinutes": 10080, "windowSource": "inferred",
          "resetsAt": "2026-10-06T15:00:00.107Z", "providerKey": "rate_limits.seven_day" }
      ],
      "credits": [
        { "id": "claude_extra_usage", "label": "Extra usage", "unit": { "type": "currency", "currency": "EUR" },
          "balance": null, "used": "0.00", "limit": "240.00", "usedPercent": 0,
          "unlimited": null, "hasCredits": null, "enabled": false, "disabledReason": "out_of_credits",
          "providerKey": "rate_limits.extra_usage" }
      ],
      "resetCredits": null,
      "analytics": null,
      "errors": [],
      "warnings": []
    }
  ]
}
```

### 12.3 Human output

Exact layout. `now` is injectable, and tests run with `TZ=UTC` and a fixed `now`. The example uses `now = 2026-10-01T13:40:00Z`:

```
CODEX · plus · available
  5h            0% used   resets today 18:39          (in 4h 59m)
  Weekly       22% used   resets Sun 04 Oct 13:09     (in 2d 23h)
  Credits      452.04 credits
  Resets       2 reset credits available (never used by agent-usage)

CLAUDE · pro · available (derived)
  5h            2% used   resets today 17:30          (in 3h 50m)
  Weekly       11% used   resets Tue 06 Oct 15:00     (in 5d 1h)
  Extra usage  off (out_of_credits) · 0.00 / 240.00 EUR
```

Header: `<PROVIDER UPPER> · <plan or "unknown plan"> · <state>`.
- `state` is `available`, or `LIMITED (<reason>)` in red/bold, or `status unknown` in yellow.
- When `basis === "derived_from_limits"`, append ` (derived)`, dimmed when colors are on. Claude headers always show it.

Limit rows:
- Labels are padded to 12 columns. Percent is right-aligned to 3 characters plus `%`, as an integer when whole, else 1 decimal.
- Reset time:
  - `today HH:MM` if it falls on the same local date
  - `tomorrow HH:MM`
  - otherwise `EEE DD MMM HH:MM` (e.g. `Sun 04 Oct 13:09`) in local TZ, 24 h, assembled from `Intl.DateTimeFormat("en-GB", …).formatToParts()` so locale punctuation is not part of the output
- Relative time is truncated, not rounded: `(in Xd Yh)` when ≥ 1 day, `(in Xh Ym)` when ≥ 1 hour, `(in Ym)` otherwise, `(now)` if past.
- `usedPercent:null` → `  ?% used`.
- Percent color: < 70 default, 70–89 yellow, ≥ 90 red. This is presentation only.

Credit rows:
- Provider credits: balance rounded *for display only* to 2 dp, as `"<n> credits"`. `unlimited` → `unlimited`.
- Currency: `on|off (<disabledReason>) · <used> / <limit> <CUR>`.
- `resetCredits` row appears only when the count > 0.

Scoped limits are listed after `session`/`weekly`, in report order.

Analytics, only with `--analytics`:
```
  Tokens       lifetime 3.10B · peak day 108.43M · last 7 days 12.4M
```

Errors and warnings:
```
CLAUDE · error
  not_authenticated  Claude Code is not logged in.
                     → Run `claude` and use /login.
```
`status: "partial"` adds one `! <code>  <message>` line per error. Warnings show as dimmed `· <code>` lines **only with `--debug`**.

### 12.4 Interruption

On SIGINT or SIGTERM during a fetch, the CLI:
1. aborts the in-flight `getUsage` through its `AbortSignal`, which kills the provider child process groups
2. removes the Claude temp cwd
3. prints nothing further to stdout
4. exits **130**

Repeated polling is the caller's job in v1 (cron, a shell loop, or the library API). Built-in `--watch` is deferred to v2.

### 12.5 Exit codes

| Code | Meaning |
|---|---|
| 0 | Every requested provider has `status` `ok` or `partial` |
| 1 | Unexpected internal failure of the CLI itself (uncaught exception; stack printed to stderr only with `--debug`) |
| 2 | Usage error (bad arguments) |
| 3 | At least one requested provider `error`, at least one succeeded |
| 4 | All requested providers `error` |
| 130 | Interrupted (SIGINT/SIGTERM) |

- Availability (`limited`) **never** affects the exit code. It is an observation, not a failure.
- With `--json`, stdout always contains a complete valid report for codes 0, 3 and 4.

---

## 13. Testing strategy

Tools: `vitest`. Tests MUST run offline and MUST NOT require codex or claude to be installed.

### 13.1 Fixtures (`tests/fixtures/`)

Fixtures are sanitized: ids are replaced with `FIXTURE`, there are no emails, and timestamps are fixed. Create:

| File | Content |
|---|---|
| `codex/initialize.json` | `{"userAgent":"codex_cli_rs/0.159.2 (Linux; aarch64)","codexHome":"/home/u/.codex","platformFamily":"unix","platformOs":"linux"}` |
| `codex/account-chatgpt.json` | `{"account":{"type":"chatgpt","email":"user@example.invalid","planType":"plus"},"requiresOpenaiAuth":true,"workspaceRouting":{"chatgptAccountId":"FIXTURE","backendOrigin":"https://chatgpt.com","accountRoutingOverride":"NO_CONSTRAINT"}}` |
| `codex/account-none.json` | `{"account":null,"requiresOpenaiAuth":true,"workspaceRouting":null}` |
| `codex/account-apikey.json` | `{"account":{"type":"apiKey"},"requiresOpenaiAuth":true,"workspaceRouting":null}` |
| `codex/ratelimits-plus.json` | the real response from Section 2.2.4 (`accountId:"FIXTURE"`, `rateLimitUpsell:null`) |
| `codex/ratelimits-reached.json` | primary `usedPercent:100`, `ordinaryUsageAllowed:false`, `rateLimitReachedType:"rate_limit_reached"` |
| `codex/ratelimits-nullflags.json` | `ordinaryUsageAllowed:null`, secondary 100 % → derived `limited` |
| `codex/ratelimits-multibucket.json` | `rateLimitsByLimitId` with `codex` plus `codex_other` (`limitName:"GPT-5.x-Codex-Spark"`, `normalModelSlug:"gpt-5.x-codex-spark"`) |
| `codex/ratelimits-sparse.json` | `primary:null`, secondary only, `credits:null`, `rateLimitResetCredits:null`, `individualLimit:{limit:"100",used:"25",remainingPercent:75,resetsAt:1791119347}` |
| `codex/ratelimits-ms-timestamps.json` | `resetsAt` in milliseconds |
| `codex/ratelimits-malformed.json` | `rateLimits.primary.usedPercent:"high"`, and the `rateLimits` key missing in a variant |
| `codex/usage.json` | summary plus 5 daily buckets (unsorted) |
| `codex/error-unauth.json` | `{"code":-32600,"message":"codex account authentication required to read rate limits"}` |
| `claude/get-usage-pro.json` | the full real response from Section 2.3.3 (complete, as captured) |
| `claude/get-usage-max-scoped.json` | `seven_day_opus`, `seven_day_sonnet` set, `model_scoped:[{display_name:"Fable",utilization:40,resets_at:"…"}]`, plus a non-null unknown key `"nimbus_quill":{"utilization":5,"resets_at":"…"}` |
| `claude/get-usage-exhausted.json` | `five_hour.utilization:100` |
| `claude/get-usage-unavailable.json` | `{"session":{…},"subscription_type":null,"rate_limits_available":false,"rate_limits":null,"behaviors":null}` |
| `claude/get-usage-fetch-failed.json` | `rate_limits_available:true, rate_limits:null` |
| `claude/get-usage-bad-extra.json` | `extra_usage` without `decimal_places` and `currency:null` |
| `claude/get-usage-malformed.json` | missing `rate_limits_available` |
| `claude/auth-status-loggedin.json`, `auth-status-loggedout.json`, `auth-status-apikey.json` | as observed (email `user@example.invalid`, orgId `FIXTURE`) |
| `claude/initialize-with-pii.json` | an initialize response containing `"account":{"email":"leak@example.invalid","token":"sk-ant-oat01-FAKEFAKEFAKEFAKEFAKE"}` |

### 13.2 Fake provider binaries (`tests/fakes/`)

Two executable Node scripts (`#!/usr/bin/env node`) emulate the stdio protocols. Both read fixtures from `FAKE_FIXTURES_DIR`.

Each fake has its own variables, so one test can combine scenarios (for example Claude `hang` with Codex `ok`):
- the scenario comes from `FAKE_CODEX_SCENARIO` / `FAKE_CLAUDE_SCENARIO`
- every line received, plus the argv and cwd, is appended to `FAKE_CODEX_RECORD_FILE` / `FAKE_CLAUDE_RECORD_FILE`, so tests can assert on what agent-usage *sent*
- each fake writes its own PID (and those of any children it spawns) to the record file, so tests can verify nothing survives

These test-only variables reach the fakes through ordinary environment inheritance. agent-usage itself never reads them.

`fake-codex.mjs` scenarios:
- `ok`
- `ok-out-of-order` (rate-limits response sent last, after a 200 ms delay)
- `notifications-noise` (interleaved notifications plus a server→client request)
- `unauth`
- `hang-after-init`
- `crash-after-init` (exit 1, with stderr containing `Bearer eyJhbGciOiJIUzI1NiJ9.FAKE.FAKE`)
- `garbage-line`
- `method-not-found`
- `analytics-error`
- `stderr-noise`

`fake-claude.mjs` handles `--version`, `auth status --json` and the `-p` stream mode. Scenarios:
- `ok`
- `ok-noise` (system lines plus a `can_use_tool` control_request)
- `unsupported` (`get_usage` → error "get_usage is not supported in this context")
- `unavailable-loggedout`
- `unavailable-apikey`
- `unavailable-loggedin`
- `fetch-failed`
- `hang`
- `exit-early`
- `malformed`
- `pii-initialize`

It records its argv and cwd as described above.

Tests point the library at the fakes through `binaries` / `AGENT_USAGE_*_BIN`.

### 13.3 Unit tests

- `domain`:
  - `round2`, `clamp`
  - `toDecimal` (0 dp, 2 dp, large values, negatives rejected)
  - `slug`
  - `formatDuration`
  - id collision suffixing
  - `epochToIso` heuristic and warning
- `codex/normalize`: every Codex fixture, with `expected` objects asserted in full. Covers:
  - bucket selection
  - window kind by duration
  - verbatim credit balance
  - availability rules 1–5
  - `exhaustedLimitIds`
  - `spend_control`
  - analytics sort and safe-integer handling
- `claude/normalize`: every Claude fixture. Covers:
  - the key table
  - `model_scoped` dedupe
  - unknown keys → warning
  - null codenames ignored
  - extra-usage decimal conversion
  - the `ambiguous_units` path
  - availability derivation (model-scoped exhaustion does *not* make the provider limited)
- `claude/interpret`: the classification matrix in Section 8.3, using auth-status fixtures.
- `redactText`: replaces JWT, `sk-`, `Bearer …`, email and long-opaque-token substrings in stderr and error-message samples, and leaves normal text unchanged.
- `reportSchema`:
  - every normalizer output validates against `UsageReportSchema`
  - no normalizer output has a `raw` key

### 13.4 Integration tests (with fakes)

- Codex:
  - full fetch for each scenario, asserting the resulting `status`, issue code and `retryable`
  - out-of-order responses are handled
  - noise is ignored
  - a server request gets a `-32601` reply (assert the recorded line)
  - timeout fires within `timeoutMs + 1500 ms` and leaves **no child process alive** (check `process.kill(pid, 0)` throws)
- Claude:
  - each scenario
  - recorded argv equals the exact argv in Section 8.1
  - cwd was a temp dir that no longer exists afterwards
  - **no recorded line has `type:"user"`**
- `getUsage`:
  - Claude `hang` plus Codex `ok` → the report has Codex `ok` and Claude `timeout`. Total time is about the Claude timeout (concurrency, not the sum).
  - Missing binary (`/nonexistent/codex`) → `not_installed`, while the other provider is `ok`.
  - The caller's `AbortSignal` → both `aborted`.

### 13.5 CLI tests

Spawn `node dist/cli/main.js` against fakes, with `TZ=UTC` and `AGENT_USAGE_NOW=<ISO>`. `AGENT_USAGE_NOW` is a test-only clock override, read only by the CLI and documented as such.

- Exit-code matrix: 0/2/3/4.
- Exit 130: run against the fake `hang` scenario, send SIGINT, then assert code 130, no surviving fake processes, the Claude temp cwd removed, and nothing written to stdout.
- `--json` output parses and validates against the generated JSON Schema file (use `ajv` as a **dev** dependency).
- Human output snapshot tests: ok, limited, partial, error, analytics, scoped limits.
- PII and token absence: with the `pii-initialize`, `crash-after-init` and auth-status fixtures, run `--json --debug`. Assert that neither stdout nor stderr contains `example.invalid`, `FAKEFAKE`, `eyJ` or the `FIXTURE` account ids.
- `--raw` → exit 2 and `--watch` → exit 2 (unknown options in v1).

### 13.6 Static and architecture tests (`tests/static.test.ts`)

- No file under `src/` contains `.credentials.json`, `auth.json`, `api/oauth/usage`, `refresh_token`, `accessToken`, `rateLimitResetCredit/consume`.
- No file under `src/` except `src/cli/**` imports from `src/cli/`.
- No file under `src/providers/codex/` imports from `src/providers/claude/`, and vice versa.
- `src/domain/**` imports nothing from `src/providers/**`.
- No file under `src/` enumerates, spreads or serializes an environment object. Grep for `Object.keys(`, `Object.entries(` and `Object.values(` applied to `env`/`process.env`, for `...process.env`, `...env` and `JSON.stringify(env`/`JSON.stringify(process.env`.
- No file under `src/` contains the strings `includeRaw` or `--watch`. This guards against v2 scope creep. The absence of a `raw` contract field is checked in Section 13.3.
- `CODEX_ALLOWED_METHODS` deep-equals exactly the four methods. `request("account/rateLimitResetCredit/consume")` throws and writes nothing (recorded by the fake).

### 13.7 Live smoke tests (opt-in)

`npm run test:live`, enabled by `AGENT_USAGE_LIVE=1`, never run in the default `npm test`:
- runs the real `getUsage({includeAnalytics:true})`
- asserts schema validity, `codex.status === "ok"`, `claude.status === "ok"`, and that `session` and `weekly` exist for both
- prints only the ids and percentages

Manual acceptance check: the numbers match Codex `/status` and Claude `/usage`.

---

## 14. Self-challenge: the three biggest technical risks

1. **The Claude data source is explicitly experimental and auto-updated.** `get_usage` carries a "may change, do not rely on" label, and Claude Code updates itself silently. A shape change can break Claude reporting overnight.
   - Mitigations:
     - minimal required fields with passthrough schemas
     - one broken window degrades to a warning, not a failure
     - an explicit `incompatible_provider` code
     - `source.stability:"experimental"` and `providerVersion` in every report, so consumers can see it
     - fixtures captured from 2.1.286 as a regression baseline
     - no silent fallback to riskier strategies
   - Residual risk: accepted. The alternatives (A and D) are strictly worse on security or fragility.
2. **Subprocess orchestration on a Raspberry Pi.** Each invocation spawns `claude` (twice, with `--version`) and `codex app-server`. Each spawn costs roughly 1–2 s of CPU and some hundreds of MB of transient RSS. Hangs, orphans, startup side effects (Codex helper-binary creation, Claude `~/.claude.json` writes and auto-update checks) and EPIPE races are the most likely real-world bugs.
   - Mitigations:
     - process-group kill and an exit hook
     - per-provider deadlines
     - one fetch per invocation in v1. Callers that poll (cron, an orchestrator) own the interval and SHOULD NOT poll more often than every 30 s. The README MUST say so.
     - `--setting-sources ""`, `--strict-mcp-config`, `--tools ""`, `--no-session-persistence` and a temp cwd for Claude
     - integration tests that assert no surviving children
   - v2 option: a long-lived Codex app-server in a daemon.
3. **Silent semantic mis-normalization.** Wrong numbers are worse than no numbers for an orchestrator. Concrete traps:
   - Codex `resetsAt` units are only observed, not specified.
   - Claude's `utilization` scale; window durations inferred from key names.
   - Claude money in minor units with an undocumented `decimal_places`.
   - Codex "credits" that look like money but aren't.
   - Codex windows that might not be 5h/weekly on other plans.
   - Mitigations:
     - classify Codex windows by *reported duration*, not by position
     - `windowSource` makes inference explicit
     - money as decimal strings with an explicit unit, and `null` plus `ambiguous_units` instead of guessing
     - the `provider_credits` unit is never shown as currency
     - the timestamp heuristic emits a warning
     - fixtures assert exact outputs
     - the live acceptance check compares against `/status` and `/usage`

Other known limitations, documented in the README:
- Claude availability is always *derived*.
- Claude `limits[]` severity and `spend` are not normalized yet.
- Codex `ordinaryUsageAllowed:null` yields a derived availability.
- Concurrent agent-usage invocations each spawn their own processes. There is no cache in v1.

---

## 15. Scope

### 15.1 v1 (this spec)

- **Library:** `getUsage`, `getCodexUsage`, `getClaudeUsage`, `findLimit`, `UsageReportSchema`, `SCHEMA_VERSION`.
- **Codex provider:** rate limits, credits, reset-credit count, optional analytics.
- **Claude provider:** `get_usage`.
- **CLI** (one fetch per invocation): human output, `--json`, provider selection, `--analytics`, `--timeout`, `--no-color`, `--debug`, `--help`, `--version`. Exit codes per Section 12.5, including 130 on interruption.
- Redaction of error messages, stderr tails and debug output.
- Generated JSON Schema. Tests per Section 13. README.

Explicitly **not** in v1:
- `--watch`, or any built-in polling or redraw loop
- `--raw`, or any raw provider payload in the public CLI or library contract (no `raw` field, no `includeRaw` option)

### 15.2 Deferred to v2+

- **`--watch`** (the CLI polling mode designed during v1 planning, kept here for v2):
  - re-poll every N seconds (default 60, minimum 30); polls never overlap
  - human TTY output clears and redraws, with an `Updated HH:MM:SS · every 60s · Ctrl-C to quit` footer
  - `--json` emits NDJSON, one compact `UsageReport` per line
  - SIGINT aborts the in-flight fetch and exits 130
  - may later switch to event-driven updates (next item)
- **`--raw` / `includeRaw`:** an optional `raw` field on `ProviderReport` with redacted provider payloads, only with `--json`. It needs a deep `redact()` that removes PII and credential keys (email, account, org and installation ids, tokens, cookies, authorization) and token-like strings. Under the Section 12.2 versioning policy, adding an optional field is non-breaking. It does not require a schema version bump, but it does need its own spec approval.
- Long-lived mode: a persistent Codex app-server with `account/rateLimits/updated` sparse merge, and an event-driven `watchUsage()` library API.
- A short-TTL result cache or lock, to coalesce concurrent callers.
- Claude: normalize `limits[]` severity and `is_active`, `spend`, `seven_day_breakdown`, and the `behaviors` analytics (the `skip_behaviors:false` path).
- Claude local token analytics.
- Swapping the Claude transport to the official Agent SDK if `get_usage` stabilizes there.
- Output adapters: REST server, Prometheus exporter, cron/log sink. These are separate packages or entry points consuming the library.
- Config file (default providers, timeouts).
- Reset-credit detail rows (`excludeResetCreditDetails:false`). They remain **read-only forever**, and consumption is never in scope.
- An opt-in fallback strategy for Claude, if `get_usage` is removed (would need a new spec decision).

---

## 16. Project layout and conventions

```
agent-usage/
  package.json            name "agent-usage", version "0.1.0", type "module", engines node >=22,
                          bin { "agent-usage": "dist/cli/main.js" },
                          exports { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
                          scripts: build (tsc -p tsconfig.build.json), test (vitest run),
                                   test:live, typecheck (tsc --noEmit),
                                   schema (npm run build && node scripts/gen-schema.mjs)
  tsconfig.json           strict, target ES2022, module/moduleResolution NodeNext, declaration, outDir dist
  tsconfig.build.json     includes src only
  vitest.config.ts        excludes tests/live by default
  .gitignore              node_modules, dist
  README.md
  SPEC.md
  schema/usage-report.v1.schema.json   (generated, committed)
  scripts/gen-schema.mjs              (imports UsageReportSchema from dist/, z.toJSONSchema → file)
  src/
    index.ts                          public API
    version.ts                        reads package.json version (createRequire) — single place
    redact.ts                         redactText() only (Section 11.4)
    domain/
      model.ts                        types (z.infer re-exports)
      reportSchema.ts                 zod output contract
      issues.ts                       IssueCode, makeIssue(), retryable defaults
      numbers.ts                      round2, clamp, toDecimal, isDecimalString, safeInt
      time.ts                         epochToIso (heuristic), isoOrNull, formatDuration
      ids.ts                          slug, LimitIdAllocator (collision suffixing)
      availability.ts                 shared derivation from limits
    core/
      getUsage.ts                     concurrency, isolation, deadlines
      registry.ts                     ProviderId → UsageProvider
    process/
      jsonlProcess.ts
      runCommand.ts
      childRegistry.ts                live child groups + exit hook
    providers/
      types.ts
      codex/{index,appServerClient,schema,normalize}.ts
      claude/{index,controlClient,authStatus,schema,normalize}.ts
    cli/
      main.ts                         #!/usr/bin/env node; wires args → getUsage → render → exit; SIGINT/SIGTERM → abort → 130
      args.ts
      exitCodes.ts
      render/json.ts
      render/human.ts
      render/format.ts                percent, relative time, local time, colors (tiny ANSI helper)
  tests/
    fixtures/{codex,claude}/*.json
    fakes/{echo-jsonl.mjs,fake-codex.mjs,fake-claude.mjs}
    unit/**  integration/**  cli/**  static.test.ts  live/**
```

Dependencies:
- Runtime: **only `zod` (^4)**.
- Dev: `typescript`, `vitest`, `@types/node`, `ajv` (+ `ajv-formats`).
- Pin exact versions in the lockfile. No chalk, commander or execa.

Conventions:
- ESM with `.js` import suffixes.
- No default exports in application/library modules. Narrow tooling exception: `vitest.config.ts` uses a default export because Vite requires it for its ESM configuration contract (approved for M0/M1). This exception does not change the architecture or apply to other modules.
- No `any` in `src/` (use `unknown` plus zod).
- Every public function is documented with TSDoc.

---

## Implementation Plan for Codex

General rules for every milestone:
- Keep `npm run typecheck` and `npm test` green.
- Do not touch anything outside `~/agents/agent-usage/`.
- Never run commands that read credential files.
- Live provider calls only in M10's opt-in live test.
- If a concrete technical conflict with this spec appears, follow Section 0.1: stop, explain, propose alternatives, and wait for approval.
- `--watch`, `--raw`/`includeRaw` and anything else in Section 15.2 MUST NOT be implemented in v1.

### M0 — Scaffold

- **Files:** `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore`, `src/index.ts` (placeholder export of `SCHEMA_VERSION`), `src/version.ts`, `tests/unit/smoke.test.ts`.
- **Objective:** a buildable, testable TypeScript ESM package matching Section 16.
- **Acceptance:**
  - `npm install && npm run build && npm test && npm run typecheck` succeed on the Pi.
  - `dist/index.js` exists.
  - `engines.node >=22`.
- **Tests:** a smoke test importing `SCHEMA_VERSION === 1` and a `version` matching `package.json`.

### M1 — Domain model, contract, helpers

- **Files:** `src/domain/*`, `src/redact.ts`, `scripts/gen-schema.mjs`, `schema/usage-report.v1.schema.json`, `tests/unit/domain/*.test.ts`, `tests/unit/redact.test.ts`.
- **Objective:** implement Section 6 exactly as a zod `UsageReportSchema`, with TS types inferred from it, plus all the pure helpers and redaction from Section 11.4.
- **Acceptance:**
  - Types compile.
  - `npm run schema` regenerates an identical committed file.
  - The `IssueCode` list matches Section 6.2.
- **Tests:**
  - `round2`, `clamp`, `toDecimal`, `slug`, `formatDuration`
  - `epochToIso` for seconds, ms (with warning), 0, NaN
  - `LimitIdAllocator` suffixing
  - availability derivation
  - `redactText`: JWT, `sk-`, `Bearer`, email and long-token patterns; normal text unchanged
  - a hand-built full report validates; a report missing `schemaVersion` fails; the JSON Schema has no `raw` property

### M2 — Process layer

- **Files:** `src/process/{jsonlProcess,runCommand,childRegistry}.ts`, `tests/fakes/echo-jsonl.mjs` (a generic scripted fake), `tests/integration/process.test.ts`.
- **Objective:** Section 9.
- **Acceptance:**
  - Spawn errors map to `not_installed`.
  - Abort kills the process group.
  - No orphans remain.
  - The stderr ring is capped.
  - Oversized lines → protocol error.
- **Tests:**
  - ENOENT
  - normal request/response
  - interleaved partial-line writes (chunked stdout)
  - non-JSON line
  - child exits early (exit code captured)
  - timeout kills a child that spawns a grandchild (`sleep 60`): both dead
  - `runCommand` captures non-zero exit with stdout intact

### M3 — Codex app-server client

- **Files:** `src/providers/codex/appServerClient.ts`, `tests/fakes/fake-codex.mjs`, `tests/integration/codex-client.test.ts`.
- **Objective:** Section 7.1 and the handshake of Section 7.2, including the frozen method allowlist.
- **Acceptance:**
  - Handles out-of-order responses, notifications and server requests (`-32601` reply).
  - A disallowed method throws before writing.
  - Clean shutdown: stdin closed, child exits.
- **Tests:**
  - fake scenarios `ok`, `ok-out-of-order`, `notifications-noise`, `garbage-line`, `hang-after-init` (timeout), `crash-after-init`
  - the allowlist test asserts that the recorded lines never contain `rateLimitResetCredit`

### M4 — Codex schemas, normalizer, provider

- **Files:** `src/providers/codex/{schema,normalize,index}.ts`, `src/providers/types.ts`, `tests/fixtures/codex/*`, `tests/unit/codex-normalize.test.ts`, `tests/integration/codex-provider.test.ts`.
- **Objective:** Sections 7.3–7.5. Produces a complete `ProviderReport`.
- **Acceptance:**
  - `ratelimits-plus.json` normalizes to exactly the Codex object in the Section 12.2 example (except timing fields).
  - All fixtures produce schema-valid reports.
  - Unauth → `not_authenticated` with the hint.
  - `-32601` → `incompatible_provider`.
  - Analytics failure → `partial`.
- **Tests:**
  - every fixture listed in Section 13.1 for Codex
  - availability rules 1–5
  - multi-bucket ids
  - verbatim credit balance
  - `providerVersion` parsed from the userAgent
  - the redacted stderr tail in a crash message contains no `eyJ`

### M5 — Claude control client and auth status

- **Files:** `src/providers/claude/{controlClient,authStatus}.ts`, `tests/fakes/fake-claude.mjs`, `tests/integration/claude-client.test.ts`.
- **Objective:** Sections 8.1–8.2: exact argv, temp cwd lifecycle, the two-line handshake, answering control requests, discarding `initialize` unparsed, and PII-dropping auth-status parsing.
- **Acceptance:**
  - Recorded argv equals Section 8.1 exactly, including the two empty-string elements.
  - The temp cwd is deleted afterwards, even on timeout.
  - There are no `type:"user"` lines.
  - Auth status parsed from stdout on exit 1.
- **Tests:**
  - fake scenarios `ok`, `ok-noise`, `unsupported`, `hang`, `exit-early`, `pii-initialize` (assert that the PII strings appear nowhere in the returned value or the debug log)
  - auth status loggedin, loggedout and apikey

### M6 — Claude schema, normalizer, provider

- **Files:** `src/providers/claude/{schema,normalize,index}.ts`, `tests/fixtures/claude/*`, `tests/unit/claude-normalize.test.ts`, `tests/unit/claude-interpret.test.ts`, `tests/integration/claude-provider.test.ts`.
- **Objective:** Sections 8.3–8.5.
- **Acceptance:**
  - `get-usage-pro.json` normalizes to exactly the Claude object in the Section 12.2 example (except timing and version).
  - The Section 8.3 classification matrix is fully covered.
  - `--version` failure leaves status `ok` with `providerVersion:null`.
- **Tests:**
  - every Claude fixture in Section 13.1
  - `model_scoped` dedupe
  - unknown key warning
  - extra usage: `"240.00"` / `"0.00"`, and the `ambiguous_units` path
  - model-scoped exhaustion keeps the state `available` but lists the id

### M7 — Core and public API

- **Files:** `src/core/{getUsage,registry}.ts`, `src/index.ts`, `tests/integration/get-usage.test.ts`, `tests/static.test.ts`.
- **Objective:** Section 10: concurrency, isolation, deadlines, abort, option validation, the public exports.
- **Acceptance:**
  - One provider hanging does not delay the other beyond its own timeout.
  - A thrown provider exception → `internal` for that provider only.
  - Unknown provider id → `TypeError`.
  - Static and architecture tests (Section 13.6) pass.
- **Tests:**
  - the `getUsage` scenarios in Section 13.4
  - the static test suite
  - a `findLimit` helper test

### M8 — CLI: args, JSON output, exit codes

- **Files:** `src/cli/{main,args,exitCodes}.ts`, `src/cli/render/json.ts`, `tests/cli/json.test.ts`, `tests/cli/args.test.ts`.
- **Objective:** Sections 12.1, 12.2, 12.4 and 12.5. There is no human renderer yet, so the CLI temporarily prints JSON in both modes.
- **Acceptance:**
  - The `bin` works through `npm link`.
  - The exit-code matrix is correct, including 130 on SIGINT.
  - `--json` output validates against the committed JSON Schema with ajv.
  - stdout is pure JSON.
  - `--watch` and `--raw` are rejected as unknown options.
- **Tests:**
  - args parsing: providers, duplicates, unknown args → exit 2, `--raw` → 2, `--watch` → 2, `--timeout 0` → 2
  - exit codes 0/3/4 with fakes
  - SIGINT during the fake `hang` scenario → 130, no surviving fake processes, temp cwd removed, empty stdout
  - the `--json --debug` PII and token absence check (Section 13.5)

### M9 — Human renderer

- **Files:** `src/cli/render/{human,format}.ts`, `tests/cli/human.test.ts` (+ snapshots).
- **Objective:** Section 12.3 exactly.
- **Acceptance:**
  - Snapshots under `TZ=UTC` and a fixed `AGENT_USAGE_NOW` match the layout in Section 12.3.
  - Colors are disabled for non-TTY, `NO_COLOR` and `--no-color`.
- **Tests:**
  - snapshots: ok (both providers), Codex limited, Claude derived, partial with analytics error, error states (not_installed, not_authenticated, timeout), scoped Claude limits, analytics row
  - formatters: relative time (past, minutes, hours, days), today/tomorrow/date

### M10 — Docs, live smoke, finish

- **Files:** `README.md`, `tests/live/live.test.ts`, final `schema/usage-report.v1.schema.json`.
- **Objective:** a README covering:
  - install (`npm ci && npm run build && npm link`)
  - CLI usage and examples
  - the JSON contract and versioning policy
  - the exit-code table
  - the library usage example
  - the **stability statement (Section 4.3)** and the matrix (Section 5)
  - the security boundaries (Section 11)
  - the environment rule (Section 11.1) and the env-inheritance note (Section 8.1)
  - polling guidance: one fetch per invocation, callers own the interval, no more often than every 30 s (Section 14)
  - known limitations (Section 14)
  - the v2 roadmap (Section 15.2), explicitly listing `--watch` and `--raw` as not yet available
- **Acceptance:**
  - `AGENT_USAGE_LIVE=1 npm run test:live` passes on this Pi with both providers `ok`.
  - `agent-usage` output numbers match Codex `/status` and Claude `/usage` (manual check, recorded in the PR or commit message).
  - `npm test` (offline) still passes with the `claude` and `codex` binaries hidden from PATH.
- **Tests:** the live smoke test (opt-in).
