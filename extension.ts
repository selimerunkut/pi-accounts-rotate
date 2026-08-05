/**
 * pi-accounts-rotate — automatic quota/rate-limit account rotation for
 * @narumitw/pi-accounts (approach modeled on hjanuschka/pi-multi-pass pools).
 *
 * When an agent run ends in a rate-limit/quota-style error, this extension:
 *   1. Marks the active account for the current provider as exhausted
 *      (in-memory cooldown, default 5 minutes).
 *   2. Picks the next eligible named account (round-robin, skipping accounts
 *      that are cooling down or already attempted for this prompt).
 *   3. Writes it as the active account through pi-accounts' own AccountStore
 *      (same file + locking protocol).
 *   4. Resends the last prompt. pi-accounts re-reads pi-accounts.json in its
 *      before_agent_start sync and applies the new account's credentials.
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
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AccountStore } from "@narumitw/pi-accounts/src/accounts.js";
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

// Keep in sync with @narumitw/pi-accounts SUPPORTED_PROVIDER_IDS (src/oauth.ts).
const SUPPORTED_PROVIDER_IDS = ["anthropic", "github-copilot", "openai-codex"] as const;
type RotateProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

const CONFIG_FILE_NAME = "pi-accounts-rotate.json";
const STATUS_KEY = "accounts-rotate";

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

export default function accountsRotateExtension(pi: ExtensionAPI): void {
	const configPath = join(getAgentDir(), CONFIG_FILE_NAME);
	const config = loadConfig(configPath);
	const store = new AccountStore();
	// `${provider}/${account}` -> exhausted-until timestamp (ms). In-memory only.
	const exhausted = new Map<string, number>();
	// Per-prompt cascade state prevents retry loops across rotations.
	let cascade: { prompt: string; attempted: Set<string> } | undefined;
	let lastPrompt: string | undefined;

	pi.on("before_agent_start", (event) => {
		lastPrompt = event.prompt;
		if (!cascade || cascade.prompt !== event.prompt) {
			cascade = { prompt: event.prompt, attempted: new Set() };
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const last = event.messages[event.messages.length - 1] as
			| { role: string; stopReason?: string }
			| undefined;
		// A run that finished without an error resets the rotation cascade.
		if (last && last.role === "assistant" && last.stopReason !== "error") {
			cascade = undefined;
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

		const failed = state.active ?? "default";
		const now = Date.now();
		const cooldownMs = config.cooldownMinutes * 60_000;
		exhausted.set(`${providerId}/${failed}`, now + cooldownMs);
		cascade?.attempted.add(failed);

		const exhaustedUntil = new Map<string, number>();
		for (const name of names) {
			const until = exhausted.get(`${providerId}/${name}`);
			if (until !== undefined) exhaustedUntil.set(name, until);
		}
		const decision = pickNextAccount({
			names,
			failed,
			exhaustedUntil,
			attempted: cascade?.attempted ?? new Set(),
			now,
		});
		if (decision.kind !== "rotate") {
			const eta =
				decision.kind === "exhausted" && decision.earliestAvailableAt !== undefined
					? `; first account available in ${formatMinutesRemaining(decision.earliestAvailableAt, now)}`
					: "";
			ctx.ui.notify(
				`[accounts-rotate] ${providerId}: "${failed}" hit a limit and every other account is unavailable${eta}. ${clipErrorMessage(failure)}`,
				"warning",
			);
			return;
		}

		try {
			await store.updateProvider(providerId as never, (providerState) => ({
				...providerState,
				active: decision.next,
			}));
		} catch (error) {
			ctx.ui.notify(
				`[accounts-rotate] could not switch ${providerId} to "${decision.next}": ${errorMessage(error)}`,
				"error",
			);
			return;
		}
		cascade?.attempted.add(decision.next);
		ctx.ui.setStatus(STATUS_KEY, `${providerId}: ${failed}→${decision.next}`);
		ctx.ui.notify(
			`[accounts-rotate] ${providerId}: "${failed}" hit a limit → switched to "${decision.next}"; retrying prompt. ${clipErrorMessage(failure)}`,
			"info",
		);
		if (lastPrompt) pi.sendUserMessage(lastPrompt, { deliverAs: "steer" });
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
				];
				const cooling = [...exhausted.entries()]
					.filter(([, until]) => until > now)
					.sort((a, b) => a[1] - b[1]);
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
				exhausted.clear();
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
