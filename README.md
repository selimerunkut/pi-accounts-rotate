# pi-accounts-rotate

Local pi package. Companion to `npm:@narumitw/pi-accounts` that adds
pi-multi-pass-style quota rotation: when an assistant turn ends in a
rate-limit/quota error, switch to the next named pi-accounts account for the
same provider and retry the prompt automatically.

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
5. Apply the new OAuth runtime key immediately, then retry after
   `agent_settled` so the retry runs through `before_agent_start` instead of
   bypassing account synchronization. The runtime key is also re-applied in
   `before_provider_headers` as a safety net for host-level retries.

A per-prompt cascade (`attempted` set) prevents infinite retry loops; a clean
assistant finish resets it. Shared cooldowns are stored in
`~/.pi/agent/pi-accounts-rotate-state.json` with owner-only permissions and
contain account names and expiry timestamps, never OAuth credentials. Expired
entries are removed when the state is read or written.

When this extension launches a child Pi session (for example, through
`pi-subagents`), it passes the current named account as a non-secret environment
hint. The child persists that account into its own session before its first
request. This keeps the parent and child on the same starting account while
retaining independent rotation after a child hits a limit.

This extension requires `@narumitw/pi-accounts` 0.51 or newer because it
persists the per-session account selection.

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

## Development

```bash
npm install --legacy-peer-deps   # deps live in this dir's node_modules
bun test                         # unit + integration tests
```

Tests mock `@earendil-works/pi-coding-agent` / `pi-ai` / `pi-tui-kit`
(bundled by pi at runtime) and run the real extension factory against the
real pi-accounts `AccountStore` over a temp `pi-accounts.json`.
