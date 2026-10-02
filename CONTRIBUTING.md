# Contributing to agent-usage

Thanks for your interest. agent-usage is deliberately small: it **observes** Codex and Claude Code usage and rate limits, and reports them in one provider-neutral `UsageReport`. Before proposing a change, read the [README](README.md). Read [SPEC.md](SPEC.md) as well; it is the authoritative design document.

## Scope

In scope:
- bug fixes
- protocol-compatibility updates when a provider CLI changes
- normalization improvements
- tests
- documentation

Intentionally **out of scope** (pull requests adding them will be declined):
- **Decisions.** No routing, ranking, "switch provider" logic or recommendations. That belongs to consumers of the report.
- **Mutations of any kind.** In particular:
  - **Consuming Codex rate-limit reset credits.** The Codex client has a fixed method allowlist, and `account/rateLimitResetCredit/consume` must stay unreachable.
  - **Paid extra-usage features.** No enabling, toggling or purchasing of Claude extra usage, and no buying of Codex credits. agent-usage may only *report* these values.
- **Credential handling.** No reading of provider credential files or keychains, no calling of provider usage endpoints directly with a user's token, and no inspecting or copying of credential-bearing environment variables (see "Security and privacy" in the README).
- **Model calls.** agent-usage never sends a prompt or consumes model quota.
- **Scraping provider TUIs.**

Larger changes, such as anything in the README's v2 roadmap, a new provider, or a change to the JSON contract, should start as an issue so the design can be agreed first.

## Claude `get_usage` is experimental

The Claude provider relies on the Claude Code control request `get_usage`, which Anthropic marks **experimental and subject to change**. Claude Code auto-updates, so this interface can change or disappear without notice.

When it does, agent-usage must keep failing **loudly and precisely**, reporting `incompatible_provider` or `protocol_error` and never guessing. Compatibility fixes are welcome. Please include:
- the Claude Code version (`claude --version`)
- a **sanitized** description of the new response shape (see below)
- updated fixtures and tests

Do not add fallbacks that read credentials or scrape `/usage`.

## Local development

Requirements: Node.js ≥ 22. The provider CLIs are needed **only** for live tests.

```sh
npm ci
npm run typecheck
npm run build
npm test
```

Project layout and the JSON contract are described in the README. The JSON Schema in `schema/usage-report.v1.schema.json` is generated from `UsageReportSchema`. After changing the domain model, run `npm run schema` and treat the resulting diff as a contract change (see "JSON contract" in the README for the versioning policy).

## Tests

**Deterministic offline tests (`npm test`).**
- These use fixtures in `tests/fixtures/` and fake provider executables in `tests/fakes/`. They never invoke the real `codex` or `claude`, never use the network, and must pass on a machine where neither CLI is installed.
- Every behavior change needs offline tests.
- Static tests also enforce some boundaries, such as no credential-file paths in `src/`, no environment enumeration, and import boundaries between providers, core and CLI. Don't weaken them.

**Opt-in live tests (`AGENT_USAGE_LIVE=1 npm run test:live`).**
- These run read-only against your own logged-in `codex` and `claude`. Without `AGENT_USAGE_LIVE=1` they are skipped.
- They are for local verification only and are not required for contributions. Never paste their output, or any `--json` output from your own account, into issues or pull requests without removing account-specific values.

**Every contribution must pass:**

```sh
npm run typecheck
npm run build
npm test
```

## Never commit personal data

Do **not** commit, or paste into issues or pull requests:
- credentials of any kind: OAuth access or refresh tokens, API keys, session cookies, bearer headers, or the contents of `~/.claude/.credentials.json` or `~/.codex/auth.json`
- account identifiers: emails, account, organization, workspace or installation ids, and organization names
- **raw provider payloads** captured from your account, such as Codex `initialize`/`account/read` responses, Claude `initialize` responses or `claude auth status` output, which contain personal data
- personal data such as home-directory paths, hostnames or usernames

Fixtures must be **sanitized**:
- use `FIXTURE` for ids, `user@example.invalid` for emails and `/home/user` for paths
- keep only the fields a test needs, plus the response *structure* (key names) when fidelity to a provider shape matters

`--debug` output is redacted, but review it before sharing anyway.

## Pull requests

- Keep changes focused, and describe what changed and why.
- Note any change to the JSON contract or to provider behavior explicitly.
- Follow the existing style: TypeScript strict mode, ESM, no `any` in `src/`, named exports, and TSDoc on public functions.
- Runtime dependencies are limited to `zod`. Avoid new dependencies unless there's a strong reason, and discuss it first.

By contributing, you agree that your contributions are licensed under the MIT License (see [LICENSE](LICENSE)).
