# pi-accounts-rotate

Companion to `npm:@narumitw/pi-accounts` that adds
pi-multi-pass-style quota rotation: when an assistant turn ends in a
rate-limit/quota error, switch to the next named pi-accounts account for the
same provider and retry the prompt automatically.

See [changelog.md](changelog.md) for release notes and compatibility changes.

## How it works

pi-accounts keeps a per-session account selection and refreshes its OAuth
credentials during `before_agent_start`. Rotation therefore updates the
current session selection and runtime authentication without changing the
user-wide default:

1. `agent_end` fires with `stopReason: "error"` + rate-limit-style message.
2. Mark the current session account exhausted in the shared cooldown file
   (default 5 min).
3. Pick next eligible named account (round-robin; skips cooling-down and
   already-attempted accounts for this prompt). Headless child processes also
   skip persisted cooldowns before their first request.
4. Persist the new selection in the current session. The provider-level
   `active` field is only the default for new sessions and is left unchanged.
5. Refresh expired OAuth credentials under the account-store lock and apply
   the selected key immediately. Re-read and verify authentication on every
   `turn_start`, before the provider captures its credential. Invalidate old
   Codex connections when credentials change.
6. Request a bounded continuation at `agent_before_settle`. This works in
   interactive, print, and JSON modes without resending the user's prompt.
   Failed responses remain in the audit log; an append-only context edit omits
   the failed response from model context so the original request can continue.

Failures are attributed to the account prepared for the request, not to an
account selected later. Authentication-preparation failures abort the request
instead of silently using the previous credential. A new user submission resets
its retry cascade even when the prompt text is unchanged.

A per-prompt cascade (`attempted` set) prevents infinite retry loops; a clean
assistant finish resets it. Shared cooldowns are stored in
`~/.pi/agent/pi-accounts-rotate-state.json` with owner-only permissions and
contain account names and expiry timestamps, never OAuth credentials. Expired
entries are removed when the state is read or written.

When this extension launches a child Pi session (for example, through
`pi-subagents`), it passes the current named account as a non-secret environment
hint. A fresh child adopts it before its first request, including when
pi-accounts has just initialized its global default. Existing selections,
explicit default-login selections, and resumed/reloaded sessions take precedence.
A stale hint never undoes a manual switch. Children still rotate independently.

This extension requires `@narumitw/pi-accounts` 0.52 or newer and a Pi host with
`turn_start`, runtime authentication, and the `agent_before_settle` context-edit
continuation API.

## Config

Optional `~/.pi/agent/pi-accounts-rotate.json`:

```json
{ "enabled": true, "cooldownMinutes": 5 }
```

The shared cooldown state is written separately to
`~/.pi/agent/pi-accounts-rotate-state.json`.

## Commands

- `/rotate` — status (enabled, cooldown, accounts cooling down)
- `/rotate on|off` — enable/disable (persisted)
- `/rotate reset` — clear persisted cooldowns

## Notes / scope

- Same-provider rotation only (like multi-pass pools). No cross-provider
  fallback chains, no quota-first/scheduled strategies (install
  `pi-multi-pass` if you need those — but do not run both on the same
  provider).
- Only reacts to errors matching rate-limit patterns (usage limit, rate
  limit, 429, quota, overloaded, capacity, too many requests).
- Fail-closed auth errors from pi-accounts do NOT trigger rotation.
- A cooldown means a request returned a matching limit error. It is not a live
  quota check and does not prove that an account has no credits. If all eligible
  accounts return limits, rotation stops rather than retrying indefinitely.

## Development

```bash
npm install --legacy-peer-deps   # deps live in this dir's node_modules
npm test                         # unit/integration + real installed Pi smoke tests
```

Unit/integration tests mock the Pi host and run the real extension factory and
pi-accounts `AccountStore` over temporary files. The separate Node smoke suite
starts the installed `pi` CLI with the installed pi-accounts extension, synthetic
credentials, and a local fake provider. It verifies actual credential switching,
child inheritance, print/JSON retries, host retries, manual switches, and bounded
exhaustion. It never reads your real auth files or calls a model service.

For another installation, set `PI_TEST_CLI` and/or `PI_ACCOUNTS_TEST_EXTENSION`.
Temporary test artifacts are retained in the OS temp directory.
