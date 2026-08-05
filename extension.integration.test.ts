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
		},
	};
}

function createFakeCtx(provider: string) {
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		notifications,
		ctx: {
			model: { provider, id: "test-model" },
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

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-rotate-test-"));
	mkdirSync(agentDir, { recursive: true });
	chmodSync(agentDir, 0o700);
});

describe("accountsRotate extension", () => {
	test("rotates to next account on rate-limit error and retries prompt", async () => {
		const accountsPath = writeAccountsFile("openai-codex", "a", ["a", "b", "c"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		await fake.emit("before_agent_start", { prompt: "write the report" }, createFakeCtx("openai-codex").ctx);
		const { ctx, notifications } = createFakeCtx("openai-codex");
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

		expect(readActive(accountsPath, "openai-codex")).toBe("b");
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

	test("stops retrying once every account was attempted for one prompt", async () => {
		const accountsPath = writeAccountsFile("openai-codex", "a", ["a", "b"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		const ctx = createFakeCtx("openai-codex");
		await fake.emit("before_agent_start", { prompt: "do it" }, ctx.ctx);

		// First failure: a -> b, retry.
		await fake.emit(
			"agent_end",
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit reached" }] },
			ctx.ctx,
		);
		expect(readActive(accountsPath, "openai-codex")).toBe("b");
		expect(fake.sent).toEqual(["do it"]);

		// Second failure on the retried prompt: b also fails; a is cooling down
		// and both are attempted -> no further rotation or resend.
		await fake.emit(
			"agent_end",
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit reached" }] },
			ctx.ctx,
		);
		expect(readActive(accountsPath, "openai-codex")).toBe("b");
		expect(fake.sent).toEqual(["do it"]);
		expect(
			ctx.notifications.some((n) => n.level === "warning" && n.message.includes("unavailable")),
		).toBe(true);
	});

	test("default pi login failure rotates into the first named account", async () => {
		const accountsPath = writeAccountsFile("anthropic", undefined, ["work", "personal"]);
		const { default: accountsRotateExtension } = await import("./extension.ts");
		const fake = createFakePi();
		accountsRotateExtension(fake.pi as never);

		await fake.emit("before_agent_start", { prompt: "hi" }, createFakeCtx("anthropic").ctx);
		await fake.emit(
			"agent_end",
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 too many requests" }] },
			createFakeCtx("anthropic").ctx,
		);

		expect(readActive(accountsPath, "anthropic")).toBe("personal");
		expect(fake.sent).toEqual(["hi"]);
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
});
