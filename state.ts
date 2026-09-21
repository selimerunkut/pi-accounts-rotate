/**
 * Shared cooldown state for pi-accounts-rotate.
 *
 * A short-lived headless child (`pi --print`, `pi --mode json`) sends exactly one
 * request and then exits, so a cooldown recorded in memory after that failure
 * never reaches the next process: every following child would start from the same
 * exhausted account. Persisting cooldowns lets a parent session and the children
 * it spawns agree on which accounts are currently unusable.
 *
 * Pure parse/serialize helpers only, so they can be unit tested standalone; file
 * I/O lives in extension.ts.
 */

export const STATE_VERSION = 1;

/** `${providerId}/${accountName}` -> exhausted-until timestamp (ms). */
export type RotationState = Map<string, number>;

export function stateKey(providerId: string, accountName: string): string {
	return `${providerId}/${accountName}`;
}

/** Parse persisted cooldowns, dropping entries whose cooldown already expired. */
export function parseState(raw: string | undefined, now: number): RotationState {
	const state: RotationState = new Map();
	if (!raw?.trim()) return state;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return state;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return state;
	const exhausted = (parsed as Record<string, unknown>).exhausted;
	if (!exhausted || typeof exhausted !== "object" || Array.isArray(exhausted)) return state;
	for (const [key, value] of Object.entries(exhausted as Record<string, unknown>)) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= now) continue;
		state.set(key, value);
	}
	return state;
}

/** Serialize cooldowns, omitting expired entries so the file cannot grow forever. */
export function serializeState(state: RotationState, now: number): string {
	const exhausted: Record<string, number> = {};
	for (const [key, until] of [...state.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		if (until > now) exhausted[key] = until;
	}
	return `${JSON.stringify({ version: STATE_VERSION, exhausted }, null, 2)}\n`;
}

/** Cooling-down accounts for one provider, keyed by account name. */
export function providerExhaustions(state: RotationState, providerId: string, now: number): Map<string, number> {
	const prefix = `${providerId}/`;
	const result = new Map<string, number>();
	for (const [key, until] of state) {
		if (key.startsWith(prefix) && until > now) result.set(key.slice(prefix.length), until);
	}
	return result;
}
