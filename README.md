# agent-usage

## What it is

A read-only CLI and TypeScript library that observes Codex and Claude Code usage and rate limits in one provider-neutral report. It helps callers observe their accounts; callers decide what to do with the results.

It makes no scheduling, routing or purchasing decisions, changes no account state, handles no credentials, and sends no prompts or model calls. Reset credits are counted, never consumed. It does not scrape either provider's TUI.

## Requirements

- Node.js ≥ 22.
- `codex` installed and logged in with a ChatGPT account.
- `claude` installed and logged in with a claude.ai subscription.

Provider executables normally come from PATH. Override their locations with `AGENT_USAGE_CODEX_BIN` and `AGENT_USAGE_CLAUDE_BIN`, or the library's `binaries` option.

## Install

From the project directory:

```sh
npm ci && npm run build && npm link
```

`npm link` is optional. Without linking, substitute `node dist/cli/main.js` for `agent-usage` in the examples below.

## CLI usage

The help synopsis is:

```text
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

```sh
agent-usage
agent-usage codex
agent-usage claude --json
agent-usage --analytics
agent-usage --timeout 10
```

The default fetches Codex then Claude in report order, concurrently. Selecting providers preserves first-occurrence order and ignores duplicates. Timeouts are per provider.

This sample is the golden test fixture, using UTC and a fixed clock; these are illustrative numbers, not live account data:

```text
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

Human reset times use the caller's local timezone. Piped output has no ANSI colors; `--no-color` or nonempty `NO_COLOR` also disables them. `--watch` and `--raw` are unavailable in v1 and produce usage errors.

## Polling guidance

Each invocation performs one fetch and prints one report. Callers own the interval and **should not poll more often than every 30 seconds**. This loop waits 30 seconds after each completed invocation, so fetches do not overlap:

```sh
while true; do
  agent-usage --json
  sleep 30
done
```

There is no built-in polling or cache in v1.

## JSON contract

`--json` writes one `UsageReport`, indented by two spaces with a trailing newline. Diagnostics go to stderr. Provider failures still produce a complete report.

| Field | Meaning |
|---|---|
| `schemaVersion` | Contract version, currently `1`. |
| `tool` | Tool name and package version. |
| `generatedAt` | UTC report timestamp with millisecond precision. |
| `providers[]` | Requested providers in caller order; each has `provider`, `fetchedAt` and `durationMs`. |
| `providers[].source` | Acquisition method, `stability`, and nullable `providerVersion`. |
| `providers[].account` | Nullable plan and authentication mode only. |
| `providers[].status` | `ok`: core read succeeded and errors are empty. `partial`: core succeeded but a requested secondary read failed. `error`: core failed, limits are empty and availability is unknown. |
| `providers[].availability` | `available`, `limited` or `unknown`; separate from fetch status. Includes `basis`, nullable `reason` and `exhaustedLimitIds`. |
| `providers[].limits[]` | Stable `id`, `kind`, `scope`, display `label`, `usedPercent`, `remainingPercent`, `windowMinutes`, `windowSource`, UTC `resetsAt` and `providerKey`. |
| `providers[].credits[]` | Balance, used and limit as exact decimal strings or null. Units are either opaque `provider_credits` (**not money**) or `currency` with an explicit ISO currency code. |
| `providers[].resetCredits` | Nullable `availableCount`; read-only, never consumed. |
| `providers[].analytics` | Optional Codex token analytics: lifetime, peak daily, turn duration, streaks and daily totals. Null when unavailable or not requested. Claude does not provide these; requesting analytics adds an informational warning. |
| `providers[].errors`, `warnings` | Issues with `code`, redacted `message`, `retryable` and nullable `hint`. Warnings never change fetch status. |

Null means unknown or unavailable, never an inferred zero. Used percentages retain reported values, including values above 100; remaining percentages are clamped to 0–100. `windowSource` is `reported`, `inferred` or `unknown`; Claude's five-hour and seven-day durations are inferred from keys.

Stable limit IDs:

| ID | Meaning |
|---|---|
| `session` | Account-wide short rolling window: Codex's reported 300 minutes or Claude's `five_hour`. |
| `weekly` | Account-wide seven-day window. |
| `weekly:model:<slug>` | Model-scoped weekly limit. |
| `weekly:product:<slug>` | Product-scoped weekly limit. |
| `<kind>:bucket:<limitId>` | Additional Codex buckets. |
| `spend_control` | Codex individual spend control. |
| `other:<providerKey-slug>` | Other unclassified limits. |

Scopes are `account`, `model`, `product` or `bucket`. Slugs lowercase text, replace runs outside `[a-z0-9]` with `_`, and trim leading/trailing underscores. Duplicate IDs gain `#2`, `#3`, etc., plus a warning. Core IDs are present when the provider reports the corresponding windows; do not assume fixed array positions.

The committed [JSON Schema](schema/usage-report.v1.schema.json) is generated from `UsageReportSchema`. Adding fields, enum values or issue codes is non-breaking and does not bump `schemaVersion`. Removing or renaming fields, or changing semantics, bumps it. Consumers must ignore unknown fields and tolerate unknown enum values. The shipped validator describes the currently implemented enum values; forward-compatible consumers should allow future values.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every requested provider has `status` `ok` or `partial`. |
| 1 | Unexpected internal failure of the CLI itself; a stack is printed to stderr only with `--debug`. |
| 2 | Usage error: bad arguments. |
| 3 | At least one requested provider is `error`, and at least one succeeded. |
| 4 | All requested providers are `error`. |
| 130 | Interrupted by SIGINT or SIGTERM. |

`limited` availability never changes the exit code. JSON stdout contains a complete valid report for exit codes 0, 3 and 4. On interruption, the CLI aborts the fetch and cleans up its children.

## Library usage

```ts
import { getUsage, findLimit, UsageReportSchema } from "agent-usage";

const report = await getUsage({ includeAnalytics: true, timeoutMs: 30_000 });
UsageReportSchema.parse(report);

if (report.providers[0] !== undefined) {
  const weekly = findLimit(report.providers[0], "weekly");
  console.log(weekly?.usedPercent, weekly?.resetsAt);
}
```

`getUsage` never rejects for provider failures: each failure is represented in its provider report. Invalid options reject with `TypeError`. Inspect `status` and `errors` before making decisions.

The library also exports `getCodexUsage`, `getClaudeUsage`, `SCHEMA_VERSION` and domain types. Options include provider selection, timeout, analytics, an abort signal, executable overrides, a clock and a debug callback. An optional `env` object is forwarded unchanged by reference.

## How data is obtained, and stability

Codex runs a private `codex app-server` over stdio for each fetch. After `initialize` and the `initialized` notification, it reads `account/read` with `refreshToken:false` and `account/rateLimits/read` with `excludeResetCreditDetails:true`. `account/usage/read` is requested only for analytics. Responses are correlated by request ID, including out-of-order replies; unrelated notifications cannot satisfy requests.

Claude uses the following exact argv, passed as an array without a shell:

```sh
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --no-session-persistence \
  --setting-sources "" \
  --strict-mcp-config \
  --tools ""
```

It sends only the control requests `initialize` and `get_usage` with `skip_behaviors:true`. Initialization data is discarded unparsed. A concurrent `claude --version` helper identifies the provider version; `claude auth status --json` is used only to disambiguate unavailable usage. No prompt, model selection or `--bare` flag is sent.

`/api/oauth/usage` is an **internal, unversioned** claude.ai endpoint, and agent-usage never calls it directly. agent-usage relies on the Claude Code control request `get_usage`, which Anthropic marks **experimental and subject to change**. Claude Code auto-updates. A routine update can therefore change or remove this data source at any time. agent-usage detects this and reports it as an error. It never guesses.

The stability matrix below is reproduced from SPEC §5; its section references refer to [SPEC.md](SPEC.md).

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

Every provider report includes `source.providerVersion` (null if discovery failed) and `source.stability`: Codex is `supported`, Claude is `experimental`. Helper/version warnings do not change status.

## Security and privacy

agent-usage does not open, stat, read or watch credential files, keychains or secret-service entries. Authentication and token refresh belong exclusively to the provider CLIs.

The environment rule below is reproduced verbatim from SPEC §11.1:

- **Environment rule:** agent-usage MUST NOT inspect, log, copy, modify or persist credential-bearing environment variables. Provider child processes may inherit the caller's environment unchanged.
  - Credential-bearing means things like `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `*_TOKEN`.
  - In practice, the environment object (`process.env`, or `GetUsageOptions.env`) is passed to `spawn` **by reference**: it is not cloned, spread, filtered or augmented.
  - agent-usage code never enumerates or serializes the environment, and never includes it in debug output or errors.
  - The only variables agent-usage reads by name are its own non-secret ones: `AGENT_USAGE_CODEX_BIN`, `AGENT_USAGE_CLAUDE_BIN`, `NO_COLOR`, and the test-only `AGENT_USAGE_NOW`. It also reads `TZ` indirectly through `Intl`.

The live test separately reads the nonsecret opt-in `AGENT_USAGE_LIVE`. Children inherit the caller's environment unchanged. In an `ANTHROPIC_API_KEY` environment, Claude Code may use API-key authentication; agent-usage reports `unsupported_auth` rather than stripping credentials or changing authentication.

Email, account IDs, organization IDs/names and routing metadata are dropped and never enter public reports. Claude initialization is discarded unparsed. Only plan and authentication mode are retained as account information.

Errors, stderr tails and debug messages pass through token/email redaction; issue messages are bounded to 300 characters. Debug output contains event descriptions, not payload values or environment contents. The public contract exposes no raw payload.

Codex has a fixed request allowlist: `initialize`, `account/read`, `account/rateLimits/read` and `account/usage/read`. Reset-credit consumption, login, logout and account mutation methods are unreachable. Claude has no writer for user messages, token refresh requests or settings changes.

Children are spawned without a shell and cleaned up by process group on timeout, abort or exit, using SIGTERM then SIGKILL when needed. Claude runs in a fresh temporary directory with no settings sources, MCP, tools or session persistence; that directory is removed afterwards. agent-usage has no settings file, persistent state or cache. Provider CLIs may perform their own token refresh, startup settings writes or auto-update checks.

## Troubleshooting

| Issue code | Action |
|---|---|
| `not_installed` | Install the CLI or correct its executable override/path and permissions. |
| `not_authenticated` | Log in with the provider's CLI. |
| `unsupported_auth` | Use ChatGPT/claude.ai subscription authentication in the caller's environment; API-key or other unsupported auth modes do not supply these subscription limits. |
| `rate_limits_unavailable` | The subscription is authenticated but usage is unavailable; check the provider and retry later. |
| `upstream_unavailable` | The provider reported missing core data; check service availability and retry. |
| `timeout` | Increase `--timeout` if startup/network access is slow, then retry. |
| `incompatible_provider` | A Claude Code update may have changed the experimental API, or Codex lacks a required method; check the provider version and report the incompatibility. |
| `protocol_error` | The protocol or payload no longer matches expectations; record provider versions and report the failure. |

Use `--debug` for redacted diagnostics on stderr. Keep JSON stdout separate when collecting logs.

## Known limitations

- Claude availability is always derived from account-wide limits; scoped exhaustion is listed separately.
- Claude's raw `limits[]` severity and `spend` are not normalized yet.
- No cache: every run spawns provider processes, including Claude's version helper. Startup costs about 1–2 seconds per process on the investigated Pi, with substantial transient memory use; this is not a latency guarantee.
- Codex credits are opaque provider units, not currency.
- Codex availability is also derived when `ordinaryUsageAllowed` is null.
- Experimental Claude data can change during auto-updates. Unknown units become null with warnings, and Codex timestamp heuristics also warn. No fallback silently guesses data.

## Development

```sh
npm ci
npm run typecheck
npm run build
npm test
AGENT_USAGE_LIVE=1 npm run test:live
npm run schema
git diff --exit-code schema/
```

`npm test` runs the deterministic offline suite against fixtures and fake executables and excludes live tests. The live script runs two read-only tests only when `AGENT_USAGE_LIVE=1`; without that gate, both are skipped. It checks library results including Codex analytics, built CLI JSON and human output, and Claude temporary-directory cleanup. Its logs contain only provider IDs/statuses and limit IDs/percentages.

`npm run schema` rebuilds and generates the committed draft-2020-12 JSON Schema. Review schema changes as contract changes.

| Path | Contents |
|---|---|
| `src/domain/` | Provider-neutral types, validation and normalization helpers. |
| `src/process/` | Bounded JSONL transport, deadlines and process cleanup. |
| `src/providers/codex/`, `src/providers/claude/` | Protocol clients and provider normalization. |
| `src/core/`, `src/index.ts` | Concurrent fetch orchestration and public API. |
| `src/cli/` | Arguments, exit codes and human/JSON rendering. |
| `tests/` | Unit, integration, CLI, static and opt-in live tests; fixtures and fakes. |
| `schema/`, `scripts/` | Generated public schema and its generator. |

## Roadmap (v2)

These features are deferred and unavailable in v1:

- `--watch`: non-overlapping polls, minimum 30-second interval, TTY redraw or NDJSON, and abort on interruption.
- `--raw` / `includeRaw`: optional redacted provider payloads, requiring a separate approval and deep PII/credential redaction.
- A persistent Codex app-server, sparse notification merging and an event-driven `watchUsage()` API.
- A short-lived cache or lock to coalesce concurrent callers; a config file for defaults.
- More Claude normalization: severity, active state, spend, seven-day breakdown and behaviors analytics; local token analytics.
- Switching Claude transport to the official Agent SDK if `get_usage` stabilizes there.
- Separate REST, Prometheus and cron/log adapters that consume the library.
- Reset-credit detail rows, always read-only; consumption remains out of scope forever.
- An opt-in Claude fallback if `get_usage` disappears, requiring a new specification decision.
