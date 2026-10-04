# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-04

### Fixed

- Prevent stale parent-account hints from overriding manual selections, saved
  selections, or an explicit default login in resumed or reloaded sessions.
- Let fresh child sessions inherit the parent's account even when pi-accounts
  has already initialized the global default.
- Re-read and verify the selected account's credential before each request,
  including host retries and continuations, rather than reusing a stale key.
- Refresh expiring OAuth credentials under the account-store lock and invalidate
  cached provider connections when credentials change.
- Attribute limit errors and cooldowns to the account prepared for the failed
  request, not an account selected while that request was running.
- Abort when authentication preparation fails instead of silently sending a
  request with the previous account's credential.
- Retry before settlement so print and JSON mode can rotate accounts without
  exiting early or duplicating the user's prompt. Keep failed responses in the
  audit log while omitting them from the continuation's model context.
- Reset the retry cascade for each new user submission, even when its text is
  identical, and stop when all eligible accounts have been attempted.

### Added

- Regression tests for selection precedence, credential switching, OAuth refresh,
  failure attribution, authentication failures, and bounded retries.
- Real-Pi smoke tests for print and JSON mode, child inheritance, host retries,
  manual switches, and account exhaustion using synthetic credentials and a
  local fake provider. No live model calls or real auth files are used.
- An `npm test` command that runs the regression and runtime smoke suites.

### Changed

- Document the requirement for pi-accounts 0.52 or newer and a Pi host supporting
  `turn_start`, runtime authentication, and `agent_before_settle` context-edit
  continuations. Older hosts are not supported by this release.
- Clarify that cooldowns record matching limit errors; they are not live quota or
  credit checks.

## [0.1.0] - 2026-09-21

### Added

- Initial npm release of same-provider, round-robin account rotation for
  pi-accounts, with bounded retries and shared cooldown state.
- Per-session account selection, parent-account hints for child sessions, and
  proactive avoidance of cooling-down accounts in headless children.
- `/rotate` status, enable/disable, and cooldown-reset commands.

[Unreleased]: https://github.com/selimerunkut/pi-accounts-rotate/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/selimerunkut/pi-accounts-rotate/compare/5530653...v0.1.1
[0.1.0]: https://github.com/selimerunkut/pi-accounts-rotate/tree/5530653
