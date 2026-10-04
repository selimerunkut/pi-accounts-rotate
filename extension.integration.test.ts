/**
 * Integration test: runs the actual extension factory with a fake pi API and
 * the real pi-accounts AccountStore against a temp agent dir. Verifies the
 * full rotation flow: rate-limit error -> active account switched -> prompt
 * resent, and loop prevention on repeated failures.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
let agentDir = "";

mock.module("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => agentDir,
	ExtensionSelectorComponent: class {},
	LoginDialogComponent: class {},
}));

mock.module("@earendil-works/pi-ai", () => ({
	cleanupSessionResources: () => {},
}));

// pi-accounts imports pi-tui-kit for its /accounts menu, which needs pi's
// bundled TUI. Rotation never touches the menu, so stub the kit.
mock.module("@narumitw/pi-tui-kit", () => ({
	defineMenu: () => ({}),
	runMenu: async () => {},
}));

const refreshCalls: string[] = [];
let refreshFailure: Error | undefined;
mock.module("@earendil-works/pi-ai/providers/all", () => ({
	builtinProviders: () => ["openai-codex", "anthropic", "github-copilot"].map((id) => ({
		id,
		auth: { oauth: {
			toAuth: async (credential: any) => ({ apiKey: credential.access }),
			refresh: async (credential: any) => {
				refreshCalls.push(credential.access);
				if (refreshFailure) throw refreshFailure;
				return { ...credential, access: `${credential.access}-refreshed`, expires: Date.now() + 86_400_000 };
			},
		} },
	})),
}));

type Listener = (event: any, ctx: any) => unknown;

function createFakePi() {
	const listeners = new Map<string, Listener[]>();
	const sent: string[] = [];
	const commands = new Map<string, unknown>();
	const status: Record<string, string | undefined> = {};
	let continuations = 0;
	return {
		get continuations() { return continuations; },
		sent,
		status,
		listeners,
		commands,
		pi: {
			on: (event: string, handler: Listener) => {
				const list = listeners.get(event) ?? [];
				list.push(handler);
				listeners.set(event, list);
			},
			registerCommand: (name: string, command: unknown) => {
				commands.set(name, command);
			},
			sendUserMessage: (content: string) => {
				sent.push(content);
			},
		},
		async emit(event: string, payload: unknown, ctx: unknown) {
			for (const handler of listeners.get(event) ?? []) {
				await handler(payload, ctx);
			}
			if (event === "agent_end") {
				const outcome = (payload as any).messages?.at(-1)?.stopReason === "error" ? "error" : "completed";
				for (const handler of listeners.get("agent_before_settle") ?? []) {
					const result = await handler({ type: "agent_before_settle", outcome, context: { canContinue: true } }, ctx) as any;
					if (result?.continue) continuations++;
				}
			}
		},
	};
}

function createFakeCtx(provider: string) {
	const notifications: Array<{ message: string; level: string }> = [];
	const entries: any[] = [];
	return {
		notifications,
		entries,
		ctx: {
			model: { provider, id: "test-model" },
			sessionManager: {
				getSessionId: () => "test-session",
				getEntries: () => entries,
				appendCustomEntry: (customType: string, data: unknown) => {
					entries.push({ type: "custom", customType, data });
					return `entry-${entries.length}`;
				},
			},
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
				setStatus: (key: string, value: string | undefined) => {
					// recorded by extension via closure-free fake; ignore here
				},
			},
		},
	};
}

function selectAccount(run: { entries: any[] }, account: string | null) {
	run.entries.push({ type: "custom", customType: "pi-accounts-selection", data: {
		version: 1, sessionId: "test-session", providers: { "openai-codex": account },
	} });
}

function createAuthCtx() {
	const run = createFakeCtx("openai-codex");
	const apiKeys = new Map<string, string>();
	let aborted = false;
	return { ...run, apiKeys, get aborted() { return aborted; }, ctx: {
		...run.ctx,
		abort: () => { aborted = true; },
		modelRegistry: {
			runtime: {
				setRuntimeApiKey: (provider: string, key: string) => { apiKeys.set(provider, key); },
				removeRuntimeApiKey: (provider: string) => { apiKeys.delete(provider); },
			},
			getApiKeyForProvider: async (provider: string) => apiKeys.get(provider),
		},
	} };
}

const CREDENTIAL = (token: string) => ({
	type: "oauth",
	access: `access-${token}`,
	refresh: `refresh-${token}`,
	expires: Date.now() + 24 * 60 * 60 * 1000,
});

function writeAccountsFile(provider: string, active: string | undefined, accounts: string[]) {
	const data = {
		version: 1,
		providers: {
			[provider]: {
				...(active ? { active } : {}),
				accounts: Object.fromEntries(accounts.map((name) => [name, CREDENTIAL(name)])),
			},
		},
	};
	const path = join(agentDir, "pi-accounts.json");
	writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

function readActive(path: string, provider: string): string | undefined {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as {
		providers: Record<string, { active?: string }>;
	};
	return parsed.providers[provider]?.active;
}

function statePath(): string {
	return join(agentDir, "pi-accounts-rotate-state.json");
}

/** Simulate cooldowns an earlier Pi process recorded before it exited. */
function writeStateFile(exhausted: Record<string, number>) {
	const path = statePath();
	writeFileSync(path, JSON.stringify({ version: 1, exhausted }, null, 2), { mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

function readStateFile(): Record<string, number> {
	try {
		return (JSON.parse(readFileSync(statePath(), "utf8")) as { exhausted: Record<string, number> })
			.exhausted;
	} catch {
		return {};
	}
}

function readSelected(run: { entries: any[] }, provider: string): string | null | undefined {
	for (let i = run.entries.length - 1; i >= 0; i -= 1) {
		const entry = run.entries[i];
		if (entry?.customType === "pi-accounts-selection") return entry.data.providers[provider];
	}
	return undefined;
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-rotate-test-"));
	mkdirSync(agentDir, { recursive: true });
	chmodSync(agentDir, 0o700);
	delete process.env.PI_ACCOUNTS_PARENT_SELECTION;
	refreshCalls.length = 0;
	refreshFailure = undefined;
});

afterEach(() => {
	delete process.env.PI_ACCOUNTS_PARENT_SELECTION;
});

describe("accountsRotate extension", () => {
	test("rotates to next account on rate-limit error and retries prompt", async () => {
		const accountsPath = writeAccountsFile("openai-codex", "a", ["a", "b", "c"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		const run = createFakeCtx("openai-codex");
		await fake.emit("before_agent_start", { prompt: "write the report" }, run.ctx);
		const { ctx, notifications } = run;
		await fake.emit(
			"agent_end",
			{
				messages: [
					{ role: "user" },
					{ role: "assistant", stopReason: "error", errorMessage: "Rate limit reached for gpt-5.5" },
				],
			},
			ctx,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(readActive(accountsPath, "openai-codex")).toBe("a");
		expect(run.entries.at(-1)?.data.providers["openai-codex"]).toBe("b");
		expect(fake.continuations).toBe(1);
		expect(fake.sent).toEqual([]);
		expect(notifications.some((n) => n.message.includes('switched to "b"'))).toBe(true);
	});

	test("does not rotate on non-rate-limit errors", async () => {
		const accountsPath = writeAccountsFile("openai-codex", "a", ["a", "b"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		await fake.emit("before_agent_start", { prompt: "hello" }, createFakeCtx("openai-codex").ctx);
		await fake.emit(
			"agent_end",
			{
				messages: [
					{ role: "assistant", stopReason: "error", errorMessage: "authentication failed" },
				],
			},
			createFakeCtx("openai-codex").ctx,
		);

		expect(readActive(accountsPath, "openai-codex")).toBe("a");
		expect(fake.sent).toEqual([]);
	});

	test("does not rotate when provider has no named accounts", async () => {
		const accountsPath = writeAccountsFile("openai-codex", undefined, []);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		await fake.emit("before_agent_start", { prompt: "hello" }, createFakeCtx("openai-codex").ctx);
		await fake.emit(
			"agent_end",
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage: "quota exceeded" }] },
			createFakeCtx("openai-codex").ctx,
		);

		expect(readActive(accountsPath, "openai-codex")).toBeUndefined();
		expect(fake.sent).toEqual([]);
	});

	test("uses the current session account instead of the global default", async () => {
		const accountsPath = writeAccountsFile("openai-codex", "c", ["a", "b", "c"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		const run = createFakeCtx("openai-codex");
		run.entries.push({
			type: "custom",
			customType: "pi-accounts-selection",
			data: {
				version: 1,
				sessionId: "test-session",
				providers: { "openai-codex": "a" },
			},
		});
		await fake.emit("before_agent_start", { prompt: "do it" }, run.ctx);
		await fake.emit(
			"agent_end",
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit reached" }] },
			run.ctx,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(readActive(accountsPath, "openai-codex")).toBe("c");
		expect(run.entries.at(-1)?.data.providers["openai-codex"]).toBe("b");
		expect(fake.continuations).toBe(1);
		expect(fake.sent).toEqual([]);
	});

	test("propagates the current session account to a new child session", async () => {
		writeAccountsFile("openai-codex", "c", ["a", "b", "c"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		const parent = createFakeCtx("openai-codex");
		parent.entries.push({
			type: "custom",
			customType: "pi-accounts-selection",
			data: {
				version: 1,
				sessionId: "test-session",
				providers: { "openai-codex": "a" },
			},
		});
		await fake.emit("before_agent_start", { prompt: "launch a reviewer" }, parent.ctx);
		expect(JSON.parse(process.env.PI_ACCOUNTS_PARENT_SELECTION ?? "{}")).toEqual({
			"openai-codex": "a",
		});

		const child = createFakeCtx("openai-codex");
		await fake.emit("session_start", {}, child.ctx);
		expect(child.entries.at(-1)?.data.providers["openai-codex"]).toBe("a");
	});

	test("a fresh child inherits even after pi-accounts initializes its global default", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b"]);
		process.env.PI_ACCOUNTS_PARENT_SELECTION = JSON.stringify({ "openai-codex": "b" });
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);
		const run = createFakeCtx("openai-codex");
		selectAccount(run, "a"); // pi-accounts' earlier session_start handler
		await fake.emit("session_start", { reason: "startup" }, run.ctx);
		expect(readSelected(run, "openai-codex")).toBe("b");
	});

	test("preserves a saved selection over a conflicting parent hint on resume", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b"]);
		process.env.PI_ACCOUNTS_PARENT_SELECTION = JSON.stringify({ "openai-codex": "a" });
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);
		const run = createFakeCtx("openai-codex");
		run.entries.push({ type: "custom", customType: "pi-accounts-selection", data: {
			version: 1, sessionId: "test-session", providers: { "openai-codex": "b" },
		} });
		await fake.emit("session_start", { reason: "resume" }, run.ctx);
		await fake.emit("before_agent_start", { prompt: "continue" }, run.ctx);
		expect(readSelected(run, "openai-codex")).toBe("b");
	});

	test("does not undo a manual switch with its own stale child hint", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);
		const run = createFakeCtx("openai-codex");
		run.entries.push({ type: "custom", customType: "pi-accounts-selection", data: {
			version: 1, sessionId: "test-session", providers: { "openai-codex": "a" },
		} });
		await fake.emit("before_agent_start", { prompt: "first" }, run.ctx);
		expect(JSON.parse(process.env.PI_ACCOUNTS_PARENT_SELECTION!)["openai-codex"]).toBe("a");
		run.entries.push({ type: "custom", customType: "pi-accounts-selection", data: {
			version: 1, sessionId: "test-session", providers: { "openai-codex": "b" },
		} });
		await fake.emit("before_agent_start", { prompt: "continue" }, run.ctx);
		expect(readSelected(run, "openai-codex")).toBe("b");
		expect(JSON.parse(process.env.PI_ACCOUNTS_PARENT_SELECTION!)["openai-codex"]).toBe("b");
	});

	test("preserves an explicit default login instead of adopting a named hint", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b"]);
		process.env.PI_ACCOUNTS_PARENT_SELECTION = JSON.stringify({ "openai-codex": "a" });
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);
		const run = createFakeCtx("openai-codex");
		run.entries.push({ type: "custom", customType: "pi-accounts-selection", data: {
			version: 1, sessionId: "test-session", providers: { "openai-codex": null },
		} });
		await fake.emit("session_start", { reason: "resume" }, run.ctx);
		await fake.emit("before_agent_start", { prompt: "continue" }, run.ctx);
		expect(readSelected(run, "openai-codex")).toBeNull();
	});

	test("stops retrying once every account was attempted for one prompt", async () => {
		const accountsPath = writeAccountsFile("openai-codex", "a", ["a", "b"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		const ctx = createFakeCtx("openai-codex");
		await fake.emit("before_agent_start", { prompt: "do it" }, ctx.ctx);

		// First failure: a -> b, retry. The global default remains unchanged.
		await fake.emit(
			"agent_end",
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit reached" }] },
			ctx.ctx,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(readActive(accountsPath, "openai-codex")).toBe("a");
		expect(fake.continuations).toBe(1);
		expect(fake.sent).toEqual([]);

		// Second failure on the retried prompt: b also fails; a is cooling down
		// and both are attempted -> no further rotation or resend.
		await fake.emit(
			"agent_end",
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit reached" }] },
			ctx.ctx,
		);
		expect(readActive(accountsPath, "openai-codex")).toBe("a");
		expect(fake.continuations).toBe(1);
		expect(fake.sent).toEqual([]);
		expect(
			ctx.notifications.some((n) => n.level === "warning" && n.message.includes("unavailable")),
		).toBe(true);
	});

	test("default pi login failure rotates into the first named account", async () => {
		const accountsPath = writeAccountsFile("anthropic", "work", ["work", "personal"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		const run = createFakeCtx("anthropic");
		run.entries.push({
			type: "custom",
			customType: "pi-accounts-selection",
			data: {
				version: 1,
				sessionId: "test-session",
				providers: { anthropic: null },
			},
		});
		await fake.emit("before_agent_start", { prompt: "hi" }, run.ctx);
		await fake.emit(
			"agent_end",
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 too many requests" }] },
			run.ctx,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(readActive(accountsPath, "anthropic")).toBe("work");
		expect(run.entries.at(-1)?.data.providers.anthropic).toBe("personal");
		expect(fake.continuations).toBe(1);
		expect(fake.sent).toEqual([]);
	});

	test("persists a cooldown so the next process skips the exhausted account", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b", "c"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		const run = createFakeCtx("openai-codex");
		await fake.emit("before_agent_start", { prompt: "pick projects" }, run.ctx);
		expect(readStateFile()).toEqual({});

		await fake.emit(
			"agent_end",
			{
				messages: [
					{ role: "assistant", stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" },
				],
			},
			run.ctx,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const persisted = readStateFile();
		expect(Object.keys(persisted)).toEqual(["openai-codex/a"]);
		expect(persisted["openai-codex/a"]).toBeGreaterThan(Date.now());
	});

	test("a fresh headless child avoids the account an earlier process exhausted", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b", "c"]);
		writeStateFile({ "openai-codex/a": Date.now() + 5 * 60_000 });
		const { default: accountsRotateExtension } = await import("./extension.ts");

		// A new process: new extension instance, new session, no session selection,
		// so pi-accounts would otherwise fall back to the exhausted default "a".
		const child = createFakePi();
		accountsRotateExtension(child.pi as never);
		const run = createFakeCtx("openai-codex");
		await child.emit("before_agent_start", { prompt: "pick projects" }, run.ctx);

		expect(readSelected(run, "openai-codex")).toBe("b");
		expect(JSON.parse(process.env.PI_ACCOUNTS_PARENT_SELECTION ?? "{}")).toEqual({
			"openai-codex": "b",
		});
		// The provider-wide default is left untouched; avoidance is session-scoped.
		expect(readActive(join(agentDir, "pi-accounts.json"), "openai-codex")).toBe("a");
	});

	test("headless avoidance keeps the global default when the selected account is usable", async () => {
		writeAccountsFile("openai-codex", "b", ["a", "b", "c"]);
		writeStateFile({ "openai-codex/a": Date.now() + 5 * 60_000 });
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		const run = createFakeCtx("openai-codex");
		await fake.emit("before_agent_start", { prompt: "pick projects" }, run.ctx);

		expect(readSelected(run, "openai-codex")).toBeUndefined();
	});

	test("expired cooldowns no longer force a headless child off the default account", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b"]);
		writeStateFile({ "openai-codex/a": Date.now() - 1 });
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		const run = createFakeCtx("openai-codex");
		await fake.emit("before_agent_start", { prompt: "pick projects" }, run.ctx);

		expect(readSelected(run, "openai-codex")).toBeUndefined();
	});

	test("reports headless avoidance on stderr because print mode has no UI", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b"]);
		writeStateFile({ "openai-codex/a": Date.now() + 5 * 60_000 });
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		const run = createFakeCtx("openai-codex");
		const headless = { ...run.ctx, hasUI: false };
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (message: string) => {
			errors.push(message);
		};
		try {
			await fake.emit("before_agent_start", { prompt: "pick projects" }, headless);
		} finally {
			console.error = originalError;
		}

		expect(readSelected(run, "openai-codex")).toBe("b");
		expect(run.notifications).toEqual([]);
		expect(errors.some((line) => line.includes('cooling down → using "b"'))).toBe(true);
	});

	test("uses the manually selected credential on continuations that skip before_agent_start", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);
		const run = createAuthCtx();
		selectAccount(run, "a");
		await fake.emit("before_agent_start", { prompt: "continue" }, run.ctx);
		selectAccount(run, "b");
		// Simulate /accounts applying b, then a host continuation with no prompt lifecycle.
		run.apiKeys.set("openai-codex", "access-b");
		await fake.emit("turn_start", {}, run.ctx);
		await fake.emit("before_provider_headers", { headers: {} }, run.ctx);
		expect(run.apiKeys.get("openai-codex")).toBe("access-b");
		expect(run.aborted).toBe(false);
	});

	test("rotates credentials through all accounts and stops without duplicating exhaustion", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b", "c"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);
		const run = createAuthCtx();
		selectAccount(run, "a");
		await fake.emit("before_agent_start", { prompt: "continue" }, run.ctx);
		const requested: string[] = [];
		for (const name of ["a", "b", "c"]) {
			await fake.emit("turn_start", {}, run.ctx);
			requested.push(run.apiKeys.get("openai-codex")!);
			await fake.emit("agent_end", { messages: [{
				role: "assistant", stopReason: "error", errorMessage: "Codex error: The usage limit has been reached",
			}] }, run.ctx);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(requested).toEqual(["access-a", "access-b", "access-c"]);
		expect(Object.keys(readStateFile()).sort()).toEqual(["openai-codex/a", "openai-codex/b", "openai-codex/c"]);
		expect(fake.continuations).toBe(2);
		expect(fake.sent).toEqual([]);
	});

	test("attributes a failed request to its credential, not a later manual selection", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b", "c"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);
		const run = createAuthCtx();
		selectAccount(run, "a");
		await fake.emit("before_agent_start", { prompt: "continue" }, run.ctx);
		await fake.emit("turn_start", {}, run.ctx);
		selectAccount(run, "b");
		await fake.emit("agent_end", { messages: [{
			role: "assistant", stopReason: "error", errorMessage: "usage limit reached",
		}] }, run.ctx);
		expect(Object.keys(readStateFile())).toEqual(["openai-codex/a"]);
		expect(readSelected(run, "openai-codex")).toBe("b");
	});

	test("refreshes an expired credential before applying a rotated account", async () => {
		const path = writeAccountsFile("openai-codex", "a", ["a", "b"]);
		const data = JSON.parse(readFileSync(path, "utf8"));
		data.providers["openai-codex"].accounts.b.expires = Date.now() - 1;
		writeFileSync(path, JSON.stringify(data));
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);
		const run = createAuthCtx();
		selectAccount(run, "b");
		await fake.emit("before_agent_start", { prompt: "continue" }, run.ctx);
		await fake.emit("turn_start", {}, run.ctx);
		expect(run.apiKeys.get("openai-codex")).toBe("access-b-refreshed");
		expect(refreshCalls).toEqual(["access-b"]);
		expect(JSON.parse(readFileSync(path, "utf8")).providers["openai-codex"].accounts.b.access).toBe("access-b-refreshed");
	});

	test("fails closed rather than using the previous account when credential preparation fails", async () => {
		const path = writeAccountsFile("openai-codex", "a", ["a", "b"]);
		const data = JSON.parse(readFileSync(path, "utf8"));
		data.providers["openai-codex"].accounts.b.expires = Date.now() - 1;
		writeFileSync(path, JSON.stringify(data));
		refreshFailure = new Error("refresh rejected access-b");
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);
		const run = createAuthCtx();
		run.apiKeys.set("openai-codex", "access-a");
		selectAccount(run, "b");
		await fake.emit("turn_start", {}, run.ctx);
		expect(run.aborted).toBe(true);
		expect(run.apiKeys.get("openai-codex")).toBe("pi-accounts-auth-failed");
		expect(readStateFile()).toEqual({});
		expect(run.notifications.some((n) => n.message.includes("access-b"))).toBe(false);
	});

	test("an identical new prompt can rotate again after cooldowns expire", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);
		const run = createAuthCtx();
		selectAccount(run, "a");
		const failure = { messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit reached" }] };
		await fake.emit("before_agent_start", { prompt: "continue" }, run.ctx);
		for (let i = 0; i < 2; i++) {
			await fake.emit("turn_start", {}, run.ctx);
			await fake.emit("agent_end", failure, run.ctx);
		}
		writeStateFile({}); // simulate cooldown expiry without resetting the extension
		await fake.emit("before_agent_start", { prompt: "continue" }, run.ctx);
		await fake.emit("turn_start", {}, run.ctx);
		await fake.emit("agent_end", failure, run.ctx);
		expect(readSelected(run, "openai-codex")).toBe("a");
		expect(fake.continuations).toBe(2);
	});

	test("an explicit default login clears the rotation credential instead of reusing it", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);
		const run = createAuthCtx();
		selectAccount(run, "a");
		await fake.emit("turn_start", {}, run.ctx);
		selectAccount(run, null);
		await fake.emit("turn_start", {}, run.ctx);
		expect(run.apiKeys.has("openai-codex")).toBe(false);
	});

	test("aborts if the host fails to retain the selected credential", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);
		const run = createAuthCtx();
		selectAccount(run, "b");
		run.ctx.modelRegistry.getApiKeyForProvider = async () => "access-a";
		await fake.emit("turn_start", {}, run.ctx);
		expect(run.aborted).toBe(true);
		expect(run.apiKeys.get("openai-codex")).toBe("pi-accounts-auth-failed");
		expect(readStateFile()).toEqual({});
	});

	test("registers /rotate command with status and reset", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		const command = fake.commands.get("rotate") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		expect(command).toBeDefined();

		const { ctx, notifications } = createFakeCtx("openai-codex");
		await command.handler("", ctx);
		expect(notifications.some((n) => n.message.includes("enabled: true"))).toBe(true);

		await command.handler("reset", ctx);
		expect(notifications.some((n) => n.message.includes("cooldowns cleared"))).toBe(true);
	});

	test("/rotate reset clears cooldowns persisted by other processes", async () => {
		writeAccountsFile("openai-codex", "a", ["a", "b"]);
		writeStateFile({ "openai-codex/a": Date.now() + 5 * 60_000 });
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		const command = fake.commands.get("rotate") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		const { ctx, notifications } = createFakeCtx("openai-codex");
		await command.handler("status", ctx);
		expect(notifications.some((n) => n.message.includes("openai-codex/a"))).toBe(true);

		await command.handler("reset", ctx);
		expect(readStateFile()).toEqual({});
	});
});
