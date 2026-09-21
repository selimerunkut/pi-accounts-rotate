import { describe, expect, test } from "bun:test";
import {
	parseState,
	providerExhaustions,
	serializeState,
	stateKey,
	STATE_VERSION,
} from "./state.ts";

const NOW = 1_700_000_000_000;

describe("stateKey", () => {
	test("namespaces an account by provider", () => {
		expect(stateKey("openai-codex", "work")).toBe("openai-codex/work");
	});
});

describe("parseState", () => {
	test("returns an empty state when missing or invalid", () => {
		expect(parseState(undefined, NOW).size).toBe(0);
		expect(parseState("", NOW).size).toBe(0);
		expect(parseState("not json", NOW).size).toBe(0);
		expect(parseState("[1,2]", NOW).size).toBe(0);
		expect(parseState('{"exhausted": []}', NOW).size).toBe(0);
	});

	test("keeps live cooldowns and drops expired or malformed ones", () => {
		const raw = JSON.stringify({
			version: STATE_VERSION,
			exhausted: {
				"openai-codex/a": NOW + 60_000,
				"openai-codex/b": NOW - 1,
				"openai-codex/c": "soon",
				"openai-codex/d": Number.NaN,
			},
		});
		expect(parseState(raw, NOW)).toEqual(new Map([["openai-codex/a", NOW + 60_000]]));
	});
});

describe("serializeState", () => {
	test("round-trips live cooldowns in stable order and omits expired ones", () => {
		const state = new Map<string, number>([
			["openai-codex/b", NOW + 120_000],
			["openai-codex/a", NOW + 60_000],
			["anthropic/x", NOW - 1],
		]);
		const parsed = JSON.parse(serializeState(state, NOW)) as {
			version: number;
			exhausted: Record<string, number>;
		};
		expect(parsed.version).toBe(STATE_VERSION);
		expect(Object.keys(parsed.exhausted)).toEqual(["openai-codex/a", "openai-codex/b"]);
		expect(parseState(serializeState(state, NOW), NOW)).toEqual(
			new Map([
				["openai-codex/a", NOW + 60_000],
				["openai-codex/b", NOW + 120_000],
			]),
		);
	});
});

describe("providerExhaustions", () => {
	test("returns only the requested provider's live cooldowns, keyed by account", () => {
		const state = new Map<string, number>([
			["openai-codex/a", NOW + 60_000],
			["openai-codex/b", NOW - 1],
			["anthropic/x", NOW + 60_000],
		]);
		expect(providerExhaustions(state, "openai-codex", NOW)).toEqual(new Map([["a", NOW + 60_000]]));
		expect(providerExhaustions(state, "github-copilot", NOW).size).toBe(0);
	});

	test("does not treat another provider's similarly named account as a match", () => {
		const state = new Map<string, number>([["anthropic-codex/a", NOW + 60_000]]);
		expect(providerExhaustions(state, "anthropic", NOW).size).toBe(0);
	});
});
