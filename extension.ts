/**
 * pi-accounts-rotate — automatic quota/rate-limit account rotation for
 * @narumitw/pi-accounts (approach modeled on hjanuschka/pi-multi-pass pools).
 *
 * When an agent run ends in a rate-limit/quota-style error, this extension:
 *   1. Marks the current session account for the provider as exhausted
 *      (shared on-disk cooldown, default 5 minutes).
 *   2. Picks the next eligible named account (round-robin, skipping accounts
 *      that are cooling down or already attempted for this prompt).
 *      Headless child processes skip persisted cooldowns before their first request.
 *   3. Persists it as the current session selection without changing the
 *      provider-wide default used by new sessions.
 *   4. Applies the new OAuth credential immediately, then retries after the
 *      agent settles so the normal before_agent_start lifecycle runs.
 *
 * Config (optional): ~/.pi/agent/pi-accounts-rotate.json
 *   { "enabled": true, "cooldownMinutes": 5 }
 *
 * Commands:
 *   /rotate           show status
 *   /rotate on|off    enable/disable rotation (persisted)
 *   /rotate reset     clear cooldowns
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AccountStore } from "@narumitw/pi-accounts/src/accounts.js";
import { createBuiltinProviderAdapters } from "@narumitw/pi-accounts/src/oauth.js";
import {
	ACCOUNT_SELECTION_ENTRY_TYPE,
	createAccountSelectionEntryData,
	restoreAccountSelections,
	setAccountSelection,
} from "@narumitw/pi-accounts/src/session-selection.js";
import {
	clipErrorMessage,
	type RotateConfig,
	DEFAULT_CONFIG,
	formatMinutesRemaining,
	getLastAssistantError,
	isRateLimitError,
	parseConfig,
	pickNextAccount,
} from "./logic.js";
import {
	parseState,
	providerExhaustions,
	serializeState,
	stateKey,
	type RotationState,
} from "./state.js";

// Keep in sync with @narumitw/pi-accounts SUPPORTED_PROVIDER_IDS (src/oauth.ts).
const SUPPORTED_PROVIDER_IDS = ["anthropic", "github-copilot", "openai-codex"] as const;
type RotateProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

const CONFIG_FILE_NAME = "pi-accounts-rotate.json";
// Cooldowns live here so that short-lived headless children (`pi --print`), which
// send one request and exit, skip accounts an earlier process already exhausted.
const STATE_FILE_NAME = "pi-accounts-rotate-state.json";
const STATUS_KEY = "accounts-rotate";
// Child Pi processes start a new session, so pi-accounts would otherwise use
// the provider-wide default instead of the parent's selected account. This
// hint is account names only (never OAuth credentials) and is inherited by
// subagent processes through their environment.
const PARENT_SELECTION_ENV = "PI_ACCOUNTS_PARENT_SELECTION";

// pi-accounts stores the selected account in the session, not only in its
// global accounts file. Keep this extension in sync with that format so a
// rotation affects the current session too.
function persistSessionSelection(
	ctx: ExtensionContext,
	providerId: string,
	accountName: string,
): void {
	const sessionId = ctx.sessionManager.getSessionId();
	const restored = restoreAccountSelections(ctx.sessionManager.getEntries(), sessionId);
	if (restored.status === "invalid") throw new Error(restored.message);
	let selections =
		restored.status === "loaded"
			? restored.selections
			: (Object.create(null) as Record<string, string | null>);
	selections = setAccountSelection(selections, providerId, accountName);
	const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
		appendCustomEntry(customType: string, data?: unknown): string;
	};
	sessionManager.appendCustomEntry(
		ACCOUNT_SELECTION_ENTRY_TYPE,
		createAccountSelectionEntryData(sessionId, selections),
	);
}

function selectedSessionAccount(
	ctx: ExtensionContext,
	providerId: string,
): string | null | undefined {
	const restored = restoreAccountSelections(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getSessionId(),
	);
	if (restored.status === "invalid") throw new Error(restored.message);
	if (restored.status === "missing") return undefined;
	return Object.hasOwn(restored.selections, providerId)
		? restored.selections[providerId]
		: undefined;
}

function readParentSelectionHint(): Record<string, string> {
	const raw = process.env[PARENT_SELECTION_ENV];
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter(
				([providerId, accountName]) =>
					SUPPORTED_PROVIDER_IDS.includes(providerId as RotateProviderId) &&
					typeof accountName === "string" && accountName.length > 0,
			),
		);
	} catch {
		return {};
	}
}

function updateParentSelectionHint(ctx: ExtensionContext): void {
	const restored = restoreAccountSelections(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getSessionId(),
	);
	if (restored.status === "invalid") throw new Error(restored.message);
	const named =
		restored.status === "loaded"
			? Object.fromEntries(
					Object.entries(restored.selections).filter(
						([providerId, accountName]) =>
							SUPPORTED_PROVIDER_IDS.includes(providerId as RotateProviderId) &&
							typeof accountName === "string" && accountName.length > 0,
					),
				)
			: {};
	if (Object.keys(named).length > 0) process.env[PARENT_SELECTION_ENV] = JSON.stringify(named);
	else delete process.env[PARENT_SELECTION_ENV];
}

async function adoptParentSelection(
	ctx: ExtensionContext,
	store: AccountStore,
): Promise<void> {
	const hinted = readParentSelectionHint();
	if (Object.keys(hinted).length === 0) return;
	const restored = restoreAccountSelections(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getSessionId(),
	);
	if (restored.status === "invalid") throw new Error(restored.message);
	let selections =
		restored.status === "loaded"
			? restored.selections
			: (Object.create(null) as Record<string, string | null>);
	let changed = false;
	for (const [providerId, accountName] of Object.entries(hinted)) {
		const state = await store.readProviderAsync(providerId as never);
		if (!Object.hasOwn(state.accounts, accountName)) continue;
		if (selections[providerId] === accountName) continue;
		selections = setAccountSelection(selections, providerId, accountName);
		changed = true;
	}
	if (!changed) return;
	const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
		appendCustomEntry(customType: string, data?: unknown): string;
	};
	sessionManager.appendCustomEntry(
		ACCOUNT_SELECTION_ENTRY_TYPE,
		createAccountSelectionEntryData(ctx.sessionManager.getSessionId(), selections),
	);
}

function toProviderId(value: string | undefined): RotateProviderId | undefined {
	return value && (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value)
		? (value as RotateProviderId)
		: undefined;
}

function loadConfig(path: string): RotateConfig {
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		return parseConfig(readFileSync(path, "utf8"));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(path: string, config: RotateConfig): void {
	const tempPath = `${path}.${randomUUID()}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(tempPath, 0o600);
	renameSync(tempPath, path);
	chmodSync(path, 0o600);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Report a rotation event. Print/JSON mode has no UI and its stdout carries the
 * machine-readable event stream, so diagnostics belong on stderr there.
 */
function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI === false) console.error(message);
	else ctx.ui.notify(message, level);
}

export default function accountsRotateExtension(pi: ExtensionAPI): void {
	const configPath = join(getAgentDir(), CONFIG_FILE_NAME);
	const config = loadConfig(configPath);
	const statePath = join(getAgentDir(), STATE_FILE_NAME);
	const store = new AccountStore();
	const adapters = new Map(
		createBuiltinProviderAdapters().map((adapter) => [adapter.id, adapter] as const),
	);
	// Runtime OAuth keys are cached per provider so they can be applied even
	// when a retry bypasses before_agent_start. The main pi-accounts overlay
	// remains the owner of provider configuration.
	const runtimeApiKeys = new Map<RotateProviderId, string>();
	// Per-prompt cascade state prevents retry loops across rotations.
	let cascade: { prompt: string; attempted: Set<string> } | undefined;
	let lastPrompt: string | undefined;
	// A retry is sent after agent_settled so it starts a fresh prompt lifecycle.
	// This is important because a steer continuation skips before_agent_start.
	let pendingRetry: string | undefined;

	async function refreshSelectedAuth(
		ctx: ExtensionContext,
		providerId: RotateProviderId,
	): Promise<void> {
		if (!ctx.modelRegistry) return;
		const selected = selectedSessionAccount(ctx, providerId);
		if (selected === undefined || selected === null) {
			const runtime = (ctx.modelRegistry as typeof ctx.modelRegistry & {
				runtime?: { removeRuntimeApiKey(provider: string): void | Promise<void> };
			}).runtime;
			if (runtime && runtimeApiKeys.has(providerId)) {
				await runtime.removeRuntimeApiKey(providerId);
			}
			runtimeApiKeys.delete(providerId);
			return;
		}
		const adapter = adapters.get(providerId);
		if (!adapter) return;
		const state = await store.readProviderAsync(providerId as never);
		const credential = state.accounts[selected];
		if (!credential) throw new Error(`account "${selected}" was not found`);
		const auth = await adapter.oauth.toAuth(credential);
		if (!auth.apiKey) throw new Error("OAuth provider returned no API key");
		const runtime = (ctx.modelRegistry as typeof ctx.modelRegistry & {
			runtime?: { setRuntimeApiKey(provider: string, apiKey: string): void | Promise<void> };
		}).runtime;
		if (!runtime) throw new Error("Pi does not expose runtime provider authentication");
		await runtime.setRuntimeApiKey(providerId, auth.apiKey);
		runtimeApiKeys.set(providerId, auth.apiKey);
	}

	function readExhausted(now = Date.now()): RotationState {
		if (!existsSync(statePath)) return new Map();
		try {
			return parseState(readFileSync(statePath, "utf8"), now);
		} catch {
			return new Map();
		}
	}

	function writeState(state: RotationState): boolean {
		const tempPath = `${statePath}.${randomUUID()}.tmp`;
		try {
			writeFileSync(tempPath, serializeState(state, Date.now()), { encoding: "utf8", mode: 0o600 });
			chmodSync(tempPath, 0o600);
			renameSync(tempPath, statePath);
			chmodSync(statePath, 0o600);
			return true;
		} catch {
			try {
				if (existsSync(tempPath)) unlinkSync(tempPath);
			} catch {
				// The temporary file is harmless; never mask the original failure.
			}
			return false;
		}
	}

	/**
	 * Record a cooldown durably. The file is re-read first so a parent session and
	 * the headless children it spawns do not erase each other's cooldowns.
	 */
	function markAccountExhausted(providerId: string, accountName: string, until: number): boolean {
		const state = readExhausted();
		state.set(stateKey(providerId, accountName), until);
		return writeState(state);
	}

	/**
	 * Skip an account that another Pi process already found exhausted.
	 *
	 * Reactive rotation alone cannot help a headless child: it sends one request,
	 * so the failure is discovered only after that request was already spent, and
	 * the queued retry dies with the process. Choosing a usable account before the
	 * first request is what makes rotation work for `pi --print` callers.
	 */
	async function avoidExhaustedAccount(
		ctx: ExtensionContext,
		providerId: RotateProviderId,
	): Promise<void> {
		const now = Date.now();
		const exhaustedUntil = providerExhaustions(readExhausted(now), providerId, now);
		if (exhaustedUntil.size === 0) return;
		const providerState = await store.readProviderAsync(providerId as never);
		const names = Object.keys(providerState.accounts).sort();
		if (names.length === 0) return;
		// pi-accounts falls back to the provider-wide default for a new session,
		// which is exactly what a headless child starts from.
		const selected = selectedSessionAccount(ctx, providerId);
		const current = selected === undefined ? (providerState.active ?? "default") : (selected ?? "default");
		if (!exhaustedUntil.has(current)) return;
		const decision = pickNextAccount({
			names,
			failed: current,
			exhaustedUntil,
			attempted: new Set(),
			now,
		});
		if (decision.kind !== "rotate") return;
		persistSessionSelection(ctx, providerId, decision.next);
		updateParentSelectionHint(ctx);
		await adapters.get(providerId)?.invalidateConnections?.(ctx.sessionManager.getSessionId());
		ctx.ui.setStatus(STATUS_KEY, `${providerId}: ${current}→${decision.next} (cooling down)`);
		notify(
			ctx,
			`[accounts-rotate] ${providerId}: "${current}" is still cooling down → using "${decision.next}" for this run.`,
			"info",
		);
	}

	pi.on("before_agent_start", (event) => {
		lastPrompt = event.prompt;
		if (!cascade || cascade.prompt !== event.prompt) {
			cascade = { prompt: event.prompt, attempted: new Set() };
		}
	});

	// Refresh after pi-accounts' handler so this extension sees the current
	// session selection, including a selection changed by another extension.
	pi.on("session_start", async (_event, ctx) => {
		try {
			await adoptParentSelection(ctx, store);
			updateParentSelectionHint(ctx);
		} catch (error) {
			ctx.ui.notify(
				`[accounts-rotate] could not inherit the parent account selection: ${errorMessage(error)}`,
				"error",
			);
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const providerId = toProviderId(ctx.model?.provider);
		try {
			await adoptParentSelection(ctx, store);
			updateParentSelectionHint(ctx);
		} catch (error) {
			ctx.ui.notify(
				`[accounts-rotate] could not prepare the inherited account selection: ${errorMessage(error)}`,
				"error",
			);
		}
		if (!providerId) return;
		try {
			// Must run before the request is spent: a headless child gets exactly one.
			if (config.enabled) await avoidExhaustedAccount(ctx, providerId);
			await refreshSelectedAuth(ctx, providerId);
		} catch (error) {
			notify(
				ctx,
				`[accounts-rotate] could not prepare ${providerId} account: ${errorMessage(error)}`,
				"error",
			);
		}
	});

	// Host-level retries can skip the agent lifecycle. Re-apply the selected
	// runtime key at the last hook before the provider request as well.
	pi.on("before_provider_headers", async (_event, ctx) => {
		const providerId = toProviderId(ctx.model?.provider);
		const runtimeApiKey = providerId ? runtimeApiKeys.get(providerId) : undefined;
		if (!providerId || !runtimeApiKey) return;
		const runtime = (ctx.modelRegistry as typeof ctx.modelRegistry & {
			runtime?: { setRuntimeApiKey(provider: string, apiKey: string): void | Promise<void> };
		}).runtime;
		await runtime?.setRuntimeApiKey(providerId, runtimeApiKey);
	});

	// Do not queue a steer from agent_end. Steer continuations bypass
	// before_agent_start and Pi's built-in retry may run before the session is
	// idle. A settled retry starts a normal prompt lifecycle instead.
	pi.on("agent_settled", () => {
		const prompt = pendingRetry;
		pendingRetry = undefined;
		if (!prompt) return;
		setTimeout(() => {
			try {
				pi.sendUserMessage(prompt);
			} catch (error) {
				// Headless/print runs and session reloads can leave the captured
				// ctx stale before this timer fires. Dropping the queued retry
				// is correct there; crashing the host process is not.
				if (!errorMessage(error).includes("stale after session replacement")) {
					console.error(`[accounts-rotate] queued retry failed: ${errorMessage(error)}`);
				}
			}
		}, 0);
	});

	pi.on("agent_end", async (event, ctx) => {
		const last = event.messages[event.messages.length - 1] as
			| { role: string; stopReason?: string }
			| undefined;
		// A run that finished without an error resets the rotation cascade.
		if (last && last.role === "assistant" && last.stopReason !== "error") {
			cascade = undefined;
			pendingRetry = undefined;
		}
		if (!config.enabled) return;
		const failure = getLastAssistantError(event.messages);
		if (!failure || !isRateLimitError(failure)) return;
		const providerId = toProviderId(ctx.model?.provider);
		if (!providerId) return;

		let state;
		try {
			state = await store.readProviderAsync(providerId as never);
		} catch {
			return;
		}
		const names = Object.keys(state.accounts).sort();
		if (names.length === 0) return;

		// pi-accounts 0.51+ treats provider.active as the compatibility default
		// for new sessions. The request that just failed is governed by this
		// session's selection, so never rotate from the global default when a
		// session selection is available.
		const sessionAccount = selectedSessionAccount(ctx, providerId);
		const failed =
			sessionAccount === undefined ? (state.active ?? "default") : (sessionAccount ?? "default");
		const now = Date.now();
		const cooldownMs = config.cooldownMinutes * 60_000;
		// Persisted, not in-memory: headless children exit right after this handler,
		// so the next process must be able to see that this account is exhausted.
		if (!markAccountExhausted(providerId, failed, now + cooldownMs)) {
			notify(ctx, `[accounts-rotate] could not persist the ${providerId} cooldown for "${failed}".`, "warning");
		}
		cascade?.attempted.add(failed);

		const exhaustedUntil = providerExhaustions(readExhausted(now), providerId, now);
		const decision = pickNextAccount({
			names,
			failed,
			exhaustedUntil,
			attempted: cascade?.attempted ?? new Set(),
			now,
		});
		if (decision.kind !== "rotate") {
			// There is no useful fresh retry once every account has been tried.
			pendingRetry = undefined;
			const eta =
				decision.kind === "exhausted" && decision.earliestAvailableAt !== undefined
					? `; first account available in ${formatMinutesRemaining(decision.earliestAvailableAt, now)}`
					: "";
			notify(
				ctx,
				`[accounts-rotate] ${providerId}: "${failed}" hit a limit and every other account is unavailable${eta}. ${clipErrorMessage(failure)}`,
				"warning",
			);
			return;
		}

		try {
			// `active` is the user-wide default for new sessions, not the current
			// session account. Rotation must remain session-scoped.
			persistSessionSelection(ctx, providerId, decision.next);
			updateParentSelectionHint(ctx);
			await adapters.get(providerId)?.invalidateConnections?.(ctx.sessionManager.getSessionId());
			// Prepare the new credential before any host-level retry can run.
			await refreshSelectedAuth(ctx, providerId);
		} catch (error) {
			notify(
				ctx,
				`[accounts-rotate] could not switch ${providerId} to "${decision.next}": ${errorMessage(error)}`,
				"error",
			);
			return;
		}
		cascade?.attempted.add(decision.next);
		pendingRetry = lastPrompt;
		ctx.ui.setStatus(STATUS_KEY, `${providerId}: ${failed}→${decision.next}`);
		notify(
			ctx,
			`[accounts-rotate] ${providerId}: "${failed}" hit a limit → switched to "${decision.next}"; retrying prompt. ${clipErrorMessage(failure)}`,
			"info",
		);
	});

	pi.registerCommand("rotate", {
		description: "Manage automatic pi-accounts quota rotation (status | on | off | reset)",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["status", "on", "off", "reset"];
			const filtered = subcommands.filter((entry) => entry.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((entry) => ({ value: entry, label: entry })) : null;
		},
		handler: async (args: string, ctx) => {
			const subcommand = args.trim().toLowerCase();
			if (subcommand === "" || subcommand === "status") {
				const now = Date.now();
				const lines = [
					`enabled: ${config.enabled}`,
					`cooldown: ${config.cooldownMinutes}m`,
					`config: ${configPath}`,
					`state: ${statePath}`,
				];
				// Shared across every Pi process, including headless children.
				const cooling = [...readExhausted(now).entries()].sort((a, b) => a[1] - b[1]);
				if (cooling.length > 0) {
					lines.push("cooling down:");
					for (const [key, until] of cooling) {
						lines.push(`  ${key} (${formatMinutesRemaining(until, now)} left)`);
					}
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (subcommand === "on" || subcommand === "enable") {
				config.enabled = true;
			} else if (subcommand === "off" || subcommand === "disable") {
				config.enabled = false;
			} else if (subcommand === "reset") {
				if (!writeState(new Map())) {
					ctx.ui.notify(`[accounts-rotate] could not clear ${statePath}.`, "error");
					return;
				}
				cascade = undefined;
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("[accounts-rotate] cooldowns cleared.", "info");
				return;
			} else {
				ctx.ui.notify(
					`Unknown /rotate argument: "${subcommand}". Use status | on | off | reset.`,
					"warning",
				);
				return;
			}
			try {
				saveConfig(configPath, config);
			} catch (error) {
				ctx.ui.notify(`[accounts-rotate] could not save config: ${errorMessage(error)}`, "error");
				return;
			}
			ctx.ui.notify(`[accounts-rotate] rotation ${config.enabled ? "enabled" : "disabled"}.`, "info");
		},
	});
}
