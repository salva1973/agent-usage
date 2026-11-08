# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.2] - 2026-11-08

### Security

- Require `zod` 4.6.6 or later (4.6.7 in the lockfile) to fix [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): memory exhaustion while validating oversized constrained collections. `zod` is the only runtime dependency.
- Update development tooling to Vitest 5.0.5, which also updates Vite and `fast-uri`. This removes the moderate, high and critical advisories reported by `npm audit` for `vitest`, `@vitest/mocker`, `vite` and `fast-uri`. None of these packages is used at runtime.

### Added

- GitHub Actions CI on Node.js 22, 24 and 26: typecheck, build, tests, JSON Schema drift check and `npm audit --omit=dev --audit-level=high`.
- Dependabot for npm and GitHub Actions, with a 7-day cooldown so newly published versions are not adopted immediately.
- README: how to update an existing installation and how to remove development dependencies (`npm prune --omit=dev`) on a machine that only runs the CLI.

## [0.1.1] - 2026-10-02

### Added

- Demo mode with synthetic data and provider colors in human-readable output.

## [0.1.0] - 2026-10-02

### Added

- First public release: `getUsage()` library API and `agent-usage` CLI for Codex and Claude usage limits, with JSON and human-readable output.

[0.1.2]: https://github.com/salva1973/agent-usage/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/salva1973/agent-usage/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/salva1973/agent-usage/releases/tag/v0.1.0
