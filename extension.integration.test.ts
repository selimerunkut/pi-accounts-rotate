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

type Listener = (event: any, ctx: any) => unknown;

function createFakePi() {
	const listeners = new Map<string, Listener[]>();
	const sent: string[] = [];
	const commands = new Map<string, unknown>();
	const status: Record<string, string | undefined> = {};
	return {
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
				for (const handler of listeners.get("agent_settled") ?? []) {
					await handler({ type: "agent_settled" }, ctx);
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
		expect(fake.sent).toEqual(["write the report"]);
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
		expect(fake.sent).toEqual(["do it"]);
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
		expect(fake.sent).toEqual(["do it"]);

		// Second failure on the retried prompt: b also fails; a is cooling down
		// and both are attempted -> no further rotation or resend.
		await fake.emit(
			"agent_end",
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit reached" }] },
			ctx.ctx,
		);
		expect(readActive(accountsPath, "openai-codex")).toBe("a");
		expect(fake.sent).toEqual(["do it"]);
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
		expect(fake.sent).toEqual(["hi"]);
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
