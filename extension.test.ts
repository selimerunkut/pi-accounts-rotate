import { describe, expect, test } from "bun:test";
import {
	DEFAULT_CONFIG,
	isRateLimitError,
	parseConfig,
	pickNextAccount,
} from "./logic.ts";

const NOW = 1_700_000_000_000;

describe("isRateLimitError", () => {
	test("matches provider quota/limit phrasing", () => {
		expect(isRateLimitError("You've reached the usage limit for your current plan.")).toBe(true);
		expect(isRateLimitError("Rate limit reached for model")).toBe(true);
		expect(isRateLimitError("429 Too Many Requests")).toBe(true);
		expect(isRateLimitError("Your request exceeded the quota")).toBe(true);
		expect(isRateLimitError("Model is overloaded, please retry")).toBe(true);
		expect(isRateLimitError("capacity has been reached")).toBe(true);
	});

	test("ignores unrelated errors", () => {
		expect(isRateLimitError("authentication failed")).toBe(false);
		expect(isRateLimitError("context length exceeded")).toBe(false);
		expect(isRateLimitError("pi-accounts-auth-failed")).toBe(false);
		expect(isRateLimitError("network timeout")).toBe(false);
	});
});

describe("parseConfig", () => {
	test("defaults when missing or invalid", () => {
		expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
		expect(parseConfig("not json")).toEqual(DEFAULT_CONFIG);
		expect(parseConfig("[1,2]")).toEqual(DEFAULT_CONFIG);
	});

	test("parses valid config and clamps cooldown", () => {
		expect(parseConfig('{"enabled": false, "cooldownMinutes": 10}')).toEqual({
			enabled: false,
			cooldownMinutes: 10,
		});
		expect(parseConfig('{"cooldownMinutes": 99999}')).toEqual({
			enabled: true,
			cooldownMinutes: 24 * 60,
		});
		expect(parseConfig('{"cooldownMinutes": 0.2}')).toEqual({
			enabled: true,
			cooldownMinutes: 1,
		});
	});
});

describe("pickNextAccount", () => {
	const names = ["a", "b", "c"];

	test("rotates round-robin after the failed account", () => {
		const decision = pickNextAccount({
			names,
			failed: "a",
			exhaustedUntil: new Map(),
			attempted: new Set(),
			now: NOW,
		});
		expect(decision).toEqual({ kind: "rotate", next: "b" });
	});

	test("wraps around the sorted list", () => {
		const decision = pickNextAccount({
			names,
			failed: "c",
			exhaustedUntil: new Map(),
			attempted: new Set(),
			now: NOW,
		});
		expect(decision).toEqual({ kind: "rotate", next: "a" });
	});

	test("default login failure rotates into the first named account", () => {
		const decision = pickNextAccount({
			names,
			failed: "default",
			exhaustedUntil: new Map(),
			attempted: new Set(),
			now: NOW,
		});
		expect(decision).toEqual({ kind: "rotate", next: "a" });
	});

	test("skips exhausted accounts and reports earliest availability", () => {
		const decision = pickNextAccount({
			names,
			failed: "a",
			exhaustedUntil: new Map([["b", NOW + 60_000]]),
			attempted: new Set(),
			now: NOW,
		});
		expect(decision).toEqual({ kind: "rotate", next: "c" });

		const allCooling = pickNextAccount({
			names,
			failed: "a",
			exhaustedUntil: new Map([
				["b", NOW + 120_000],
				["c", NOW + 30_000],
			]),
			attempted: new Set(),
			now: NOW,
		});
		expect(allCooling).toEqual({ kind: "exhausted", earliestAvailableAt: NOW + 30_000 });
	});

	test("expired cooldowns are eligible again", () => {
		const decision = pickNextAccount({
			names,
			failed: "c",
			exhaustedUntil: new Map([["a", NOW - 1]]),
			attempted: new Set(),
			now: NOW,
		});
		expect(decision).toEqual({ kind: "rotate", next: "a" });
	});

	test("skips attempted accounts within one prompt cascade", () => {
		const decision = pickNextAccount({
			names,
			failed: "b",
			exhaustedUntil: new Map(),
			attempted: new Set(["c"]),
			now: NOW,
		});
		expect(decision).toEqual({ kind: "rotate", next: "a" });

		const noneLeft = pickNextAccount({
			names,
			failed: "b",
			exhaustedUntil: new Map(),
			attempted: new Set(["a", "c"]),
			now: NOW,
		});
		expect(noneLeft).toEqual({ kind: "exhausted" });
	});

	test("no named accounts means noop", () => {
		expect(
			pickNextAccount({
				names: [],
				failed: "default",
				exhaustedUntil: new Map(),
				attempted: new Set(),
				now: NOW,
			}),
		).toEqual({ kind: "noop" });
	});
});
