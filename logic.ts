/**
 * Pure rotation logic for pi-accounts-rotate. No pi or node runtime imports,
 * so it can be unit tested standalone.
 */

const DEFAULT_COOLDOWN_MINUTES = 5;
const MAX_COOLDOWN_MINUTES = 24 * 60;

// Same error patterns pi-multi-pass uses to detect rate limits.
const RATE_LIMIT_PATTERNS = [
	/usage.?limit/i,
	/rate.?limit/i,
	/limit.*reached/i,
	/too many requests/i,
	/overloaded/i,
	/capacity/i,
	/429/,
	/quota/i,
];

export function isRateLimitError(errorMessage: string): boolean {
	return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

export type RotateConfig = {
	enabled: boolean;
	cooldownMinutes: number;
};

export const DEFAULT_CONFIG: RotateConfig = {
	enabled: true,
	cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
};

export function parseConfig(raw: string | undefined): RotateConfig {
	const config = { ...DEFAULT_CONFIG };
	if (!raw?.trim()) return config;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return config;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return config;
	const record = parsed as Record<string, unknown>;
	if (typeof record.enabled === "boolean") config.enabled = record.enabled;
	if (typeof record.cooldownMinutes === "number" && Number.isFinite(record.cooldownMinutes)) {
		config.cooldownMinutes = Math.min(Math.max(record.cooldownMinutes, 1), MAX_COOLDOWN_MINUTES);
	}
	return config;
}

export type RotationDecision =
	| { kind: "rotate"; next: string }
	| { kind: "exhausted"; earliestAvailableAt?: number }
	| { kind: "noop" };

/**
 * Pure rotation decision. Round-robin starting after the failed account in
 * sorted order; skips attempted accounts and accounts cooling down.
 */
export function pickNextAccount(options: {
	names: string[];
	failed: string;
	exhaustedUntil: ReadonlyMap<string, number>;
	attempted: ReadonlySet<string>;
	now: number;
}): RotationDecision {
	const { names, failed, exhaustedUntil, attempted, now } = options;
	if (names.length === 0) return { kind: "noop" };
	const failedIndex = names.indexOf(failed);
	const ordered =
		failedIndex < 0 ? [...names] : [...names.slice(failedIndex + 1), ...names.slice(0, failedIndex)];
	let earliestAvailableAt: number | undefined;
	for (const name of ordered) {
		if (name === failed || attempted.has(name)) continue;
		const until = exhaustedUntil.get(name);
		if (until !== undefined && until > now) {
			if (earliestAvailableAt === undefined || until < earliestAvailableAt) {
				earliestAvailableAt = until;
			}
			continue;
		}
		return { kind: "rotate", next: name };
	}
	return earliestAvailableAt === undefined
		? { kind: "exhausted" }
		: { kind: "exhausted", earliestAvailableAt };
}

type AssistantLike = {
	role: string;
	stopReason?: string;
	errorMessage?: string;
};

/** Returns the errorMessage of a final assistant message that ended in error. */
export function getLastAssistantError(messages: readonly unknown[]): string | undefined {
	const last = messages[messages.length - 1] as AssistantLike | undefined;
	if (!last || last.role !== "assistant") return undefined;
	if (last.stopReason !== "error" || !last.errorMessage) return undefined;
	return last.errorMessage;
}

export function formatMinutesRemaining(until: number, now: number): string {
	const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
	return `~${minutes}m`;
}

export function clipErrorMessage(message: string): string {
	const limit = message.length > 240 ? `${message.slice(0, 240)}…` : message;
	return limit.replace(/\s+/g, " ").trim();
}
