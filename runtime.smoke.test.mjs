// Real installed Pi + pi-accounts lifecycle. Synthetic credentials, no model/network calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const accountsExtension = process.env.PI_ACCOUNTS_TEST_EXTENSION ??
  require.resolve("@narumitw/pi-accounts/src/index.ts", {
    paths: [join(homedir(), ".pi/agent/npm"), root],
  });

function runPi({ successfulAccount = "c", parentAccount, retry = false, mode = "text", manualSwitch = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-rotate-runtime-"));
  const writeJSON = (name, data) => writeFileSync(join(dir, name), JSON.stringify(data), { mode: 0o600 });
  writeJSON("settings.json", { retry: { enabled: retry, baseDelayMs: 1, maxRetries: 2 }, compaction: { enabled: false }, cacheWarming: "off" });
  writeJSON("pi-accounts.json", { version: 1, providers: { "openai-codex": {
    active: "a",
    accounts: Object.fromEntries(["a", "b", "c"].map((name) => [name, {
      type: "oauth", access: `test-access-${name}`, refresh: `test-refresh-${name}`,
      expires: Date.now() + 86_400_000,
    }])),
  } } });
  const providerPath = join(dir, "fake-provider.ts");
  writeFileSync(providerPath, `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
  if (${JSON.stringify(manualSwitch)}) pi.on("agent_end", (_event, ctx) => {
    ctx.sessionManager.appendCustomEntry("pi-accounts-selection", { version: 1,
      sessionId: ctx.sessionManager.getSessionId(), providers: { "openai-codex": "b" } });
  });
  pi.registerProvider("openai-codex", {
    api: "test-rotation", apiKey: "test-fallback", baseUrl: "https://invalid.local",
    models: [{ id: "test-rotation", name: "test-rotation", reasoning: false,
      input: ["text"], contextWindow: 128000, maxTokens: 64,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const name = options.apiKey.replace("test-access-", "");
      console.error("TEST_REQUEST=" + name);
      const success = ${JSON.stringify(manualSwitch)} || name === ${JSON.stringify(successfulAccount)};
      const message = { role: "assistant", content: success ? [{ type: "text", text: "OK" }] : [],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: success ? "stop" : "error",
        ...(!success ? { errorMessage: "Codex error: The usage limit has been reached" } : {}) };
      stream.push(success ? { type: "done", reason: "stop", message } : { type: "error", reason: "error", error: message });
      stream.end();
      return stream;
    },
  });
}
`);
  const env = { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  delete env.PI_ACCOUNTS_PARENT_SELECTION;
  if (parentAccount) env.PI_ACCOUNTS_PARENT_SELECTION = JSON.stringify({ "openai-codex": parentAccount });
  const result = spawnSync(process.env.PI_TEST_CLI ?? "pi", [
    "--offline", "--no-extensions", "--no-skills", "--no-tools", "--no-context-files",
    "--no-prompt-templates", "--no-session", "--print", "--mode", mode,
    "-e", providerPath, "-e", accountsExtension, "-e", join(root, "extension.ts"),
    "--model", "openai-codex/test-rotation", "Reply OK", ...(manualSwitch ? ["Reply OK again"] : []),
  ], { cwd: dir, env, encoding: "utf8", timeout: 30_000, maxBuffer: 1_000_000 });
  assert.ifError(result.error);
  const requested = [...result.stderr.matchAll(/TEST_REQUEST=([^\n]+)/g)].map((match) => match[1]);
  assert.ok(!result.stderr.includes("Failed to load extension"), result.stderr);
  return { ...result, requested, dir };
}

test("real Pi print mode retries with each account's actual credential", () => {
  const result = runPi();
  assert.deepEqual(result.requested, ["a", "b", "c"], result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test("real fresh child adopts the parent hint despite the pi-accounts startup default", () => {
  const result = runPi({ successfulAccount: "b", parentAccount: "b" });
  assert.deepEqual(result.requested, ["b"], result.stderr);
  assert.equal(result.status, 0, result.stderr);
});

test("real Pi JSON mode retries within the original run", () => {
  const result = runPi({ mode: "json" });
  assert.deepEqual(result.requested, ["a", "b", "c"], result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const users = events.filter((event) => event.type === "message_end" && event.message.role === "user");
  assert.equal(users.length, 1, "rotation must not duplicate the user prompt");
});

test("real Pi host retries cooperate with rotation", () => {
  const result = runPi({ retry: true });
  assert.deepEqual(result.requested, ["a", "b", "c"], result.stderr);
  assert.equal(result.status, 0, result.stderr);
});

test("a manual session switch survives pi-accounts' cached owner and the old parent hint", () => {
  const result = runPi({ manualSwitch: true });
  assert.deepEqual(result.requested, ["a", "b"], result.stderr);
  assert.equal(result.status, 0, result.stderr);
});

test("real Pi stops when every account fails instead of looping", () => {
  const result = runPi({ successfulAccount: "none" });
  assert.deepEqual(result.requested, ["a", "b", "c"], result.stderr);
  const state = JSON.parse(readFileSync(join(result.dir, "pi-accounts-rotate-state.json"), "utf8"));
  assert.deepEqual(Object.keys(state.exhausted).sort(), ["openai-codex/a", "openai-codex/b", "openai-codex/c"]);
});
