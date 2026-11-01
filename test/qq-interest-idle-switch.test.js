import assert from "node:assert/strict";
import test from "node:test";
import { createQqInterestIdleSwitch, decideQqInterestIdleProvider } from "../src/qq-interest-idle-switch.js";
import { readHostIdleSeconds } from "../src/infrastructure/host-idle.js";
import { setOllamaModelResidency } from "../src/infrastructure/ollama-residency.js";

const options = { activeProvider: "codex", idleProvider: "ollama", idleAfterSeconds: 300 };

test("uses the active provider while the owner is at the computer and the idle one after the threshold", () => {
  assert.equal(decideQqInterestIdleProvider(2, { ...options, current: "ollama" }), "codex");
  assert.equal(decideQqInterestIdleProvider(2, { ...options, current: "codex" }), null);
  assert.equal(decideQqInterestIdleProvider(300, { ...options, current: "codex" }), "ollama");
  assert.equal(decideQqInterestIdleProvider(300, { ...options, current: "ollama" }), null);
});

test("keeps the current provider in the hysteresis band or when idle time is unknown", () => {
  assert.equal(decideQqInterestIdleProvider(120, { ...options, current: "codex" }), null);
  assert.equal(decideQqInterestIdleProvider(120, { ...options, current: "ollama" }), null);
  assert.equal(decideQqInterestIdleProvider(null, { ...options, current: "ollama" }), null);
  assert.equal(decideQqInterestIdleProvider(Number.NaN, { ...options, current: "codex" }), null);
});

test("quota saver pins the idle provider even while the owner is active", () => {
  assert.equal(decideQqInterestIdleProvider(1, { ...options, current: "codex", pinIdleProvider: true }), "ollama");
  assert.equal(decideQqInterestIdleProvider(null, { ...options, current: "ollama", pinIdleProvider: true }), null);
});

test("the switch polls idle time and applies a change once per decision", async () => {
  let current = "ollama";
  let idle = 1;
  const applied = [];
  const idleSwitch = createQqInterestIdleSwitch({
    readIdleSeconds: async () => idle,
    getOptions: () => ({ ...options, current }),
    apply: async (provider, meta) => {
      applied.push([provider, meta.idleSeconds]);
      current = provider;
    },
    intervalMs: 60_000
  });
  await idleSwitch.refresh();
  await idleSwitch.refresh();
  idle = 900;
  await idleSwitch.refresh();
  assert.deepEqual(applied, [["codex", 1], ["ollama", 900]]);
  await idleSwitch.stop();
});

test("a failed idle read or apply is reported and keeps the provider", async () => {
  const errors = [];
  const idleSwitch = createQqInterestIdleSwitch({
    readIdleSeconds: async () => { throw new Error("ioreg missing"); },
    getOptions: () => ({ ...options, current: "codex" }),
    apply: async () => assert.fail("must not switch"),
    onError: (error) => errors.push(error.message)
  });
  await idleSwitch.refresh();
  assert.deepEqual(errors, ["ioreg missing"]);
});

test("reads macOS HID idle time in seconds and nothing elsewhere", async () => {
  const ioreg = async () => '    | |   "HIDIdleTime" = 557034041\n';
  assert.equal(await readHostIdleSeconds({ platform: "darwin", ioreg }), 0.557034041);
  assert.equal(await readHostIdleSeconds({ platform: "darwin", ioreg: async () => "no idle here" }), null);
  assert.equal(await readHostIdleSeconds({ platform: "linux", ioreg: async () => assert.fail("not on linux") }), null);
});

test("loads or unloads an Ollama model through the native endpoint", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    return new Response("{}", { status: 200 });
  };
  await setOllamaModelResidency({ baseUrl: "http://127.0.0.1:11434/v1/", model: "gemma4:e4b", resident: true, fetch });
  await setOllamaModelResidency({ baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e4b", resident: false, fetch });
  assert.deepEqual(calls, [
    ["http://127.0.0.1:11434/api/generate", { model: "gemma4:e4b", keep_alive: -1 }],
    ["http://127.0.0.1:11434/api/generate", { model: "gemma4:e4b", keep_alive: 0 }]
  ]);
  await assert.rejects(
    setOllamaModelResidency({ baseUrl: "http://x/v1", model: "m", resident: true, fetch: async () => new Response("", { status: 404 }) }),
    /HTTP 404/
  );
});
