# pi-accounts-rotate

Local pi package. Companion to `npm:@narumitw/pi-accounts` that adds
pi-multi-pass-style quota rotation: when an assistant turn ends in a
rate-limit/quota error, switch to the next named pi-accounts account for the
same provider and retry the prompt automatically.

## How it works

pi-accounts re-reads `pi-accounts.json` on every `before_agent_start` and
applies whichever account is marked `active`. So rotation is:

1. `agent_end` fires with `stopReason: "error"` + rate-limit-style message.
2. Mark the active account exhausted (cooldown, default 5 min).
3. Pick next eligible named account (round-robin; skips cooling-down and
   already-attempted accounts for this prompt).
4. Write it as `active` via pi-accounts' own `AccountStore` (same file/locks).
5. Resend the prompt with `pi.sendUserMessage`; pi-accounts applies the new
   account's credentials on the next turn.

A per-prompt cascade (`attempted` set) prevents infinite retry loops; a clean
assistant finish resets it. Cooldowns are in-memory per session.

## Config

Optional `~/.pi/agent/pi-accounts-rotate.json`:

```json
{ "enabled": true, "cooldownMinutes": 5 }
```

## Commands

- `/rotate` — status (enabled, cooldown, accounts cooling down)
- `/rotate on|off` — enable/disable (persisted)
- `/rotate reset` — clear cooldowns

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
