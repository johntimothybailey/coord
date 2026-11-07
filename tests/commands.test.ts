import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commandsFixture } from "./commands.fixture.js";
import { connectWorkspace } from "../src/client.js";
import { readSessionBinding } from "../src/session.js";
import { gitText } from "../src/checkpoint.js";
import { parseRuntime, runtimeDigest } from "../src/command-runtime.js";

test("T6/T9 parsed commands checkpoint real taskboard, replay lost prepare and exactly resume older ready progress", async () => {
  const f = await commandsFixture();
  let step = "initial resume";
  try {
    const first = await f.cli(f.repo, ["resume", "task", "--prepare-only", "--runtime", f.runtimePath, "--session", "source_session"]) as { path: string };
    const agent = await connectWorkspace(first.path), run = (await readSessionBinding(first.path, agent, "source_session"))!;
    await writeFile(join(first.path, "store.js"), (await readFile(join(first.path, "store.js"), "utf8")) + "\n// Disposable command integration change\n");
    const progress = JSON.stringify({ completed: ["Updated taskboard store"], remaining: ["Verify publication"], nextStep: "Run exact artifact tests" });
    await run.client.mutation("tasks:progress", { ...run.identity, expectedRevision: 0, progress }, "fixture_progress");
    f.loseReply("checkpoints:prepare");
    step = "lost prepare rehearsal";
    await assert.rejects(f.cli(first.path, ["checkpoint", "cp_source", "--runtime", f.runtimePath, "--session", "source_session"]));
    step = "checkpoint replay";
    const ready = await f.cli(first.path, ["checkpoint", "cp_source", "--runtime", f.runtimePath, "--session", "source_session"]) as { state: string; commit: string };
    assert.equal(ready.state, "ready");
    assert.deepEqual(JSON.parse(f.backend.find("checkpoints", "cp_source").summary), JSON.parse(progress));
    assert.equal(f.calls.filter(call => call.path === "checkpoints:prepare").length, 2);
    await run.client.mutation("tasks:progress", { ...run.identity, expectedRevision: 1, progress: JSON.stringify({ completed: ["UNCAPTURED SOURCE WORK"], nextStep: "Unavailable" }) }, "fixture_later_progress");
    step = "manual finalization";
    await f.cli(first.path, ["run", "finalize", "stopped", "--runtime", f.runtimePath, "--session", "source_session"]);
    await rename(first.path, `${first.path}-offline`);
    step = "ready checkpoint resume";
    const resumed = await f.cli(f.repo, ["resume", "task", "--prepare-only", "--checkpoint", "cp_source", "--runtime", f.runtimePath, "--session", "destination_session"]) as { path: string };
    assert.notEqual(resumed.path, first.path);
    assert.equal(await gitText(resumed.path, ["rev-parse", "HEAD"]), ready.commit);
    assert.match(await readFile(join(resumed.path, "store.js"), "utf8"), /Disposable command integration change/);
    assert.deepEqual(JSON.parse(f.backend.find("tasks", "task").progress), JSON.parse(progress));
    const receipt = JSON.parse(await readFile(join(resumed.path, ".coord-local/resume.json"), "utf8")) as { uncapturedSourceProgressNotRestored: boolean };
    assert.equal(receipt.uncapturedSourceProgressNotRestored, true);
    assert.equal(f.backend.find("runs", run.identity.runId).capacityHeld, false);
  } catch (error) { throw new Error(`Disposable command rehearsal failed at ${step}`, { cause: error }); }
  finally { await f.restore(); }
});

test("T4/T20 out-of-task changes are rejected before any checkpoint Git publication", async () => {
  const f = await commandsFixture();
  try {
    const first = await f.cli(f.repo, ["resume", "task", "--prepare-only", "--runtime", f.runtimePath, "--session", "scope_session"]) as { path: string };
    const agent = await connectWorkspace(first.path), run = (await readSessionBinding(first.path, agent, "scope_session"))!;
    await writeFile(join(first.path, "README.md"), "Out of task scope in disposable fixture\n");
    await run.client.mutation("tasks:progress", { ...run.identity, expectedRevision: 0, progress: "Scope rejection fixture" }, "scope_progress");
    await assert.rejects(f.cli(first.path, ["checkpoint", "cp_denied", "--runtime", f.runtimePath, "--session", "scope_session"]));
    assert.equal(await gitText(f.bare, ["for-each-ref", "--format=%(refname)", "refs/coord/checkpoints"]), "");
    assert.equal(f.calls.filter(call => call.path === "checkpoints:verifyCode").length, 0);
  } finally { await f.restore(); }
});

test("T14 missing effective environment blocks parsed resume before any admission", async () => {
  const f = await commandsFixture();
  try {
    f.runtime.policy.environment = [{ name: "FIXTURE_APPLICATION_VALUE", modes: ["manual"], type: "string" }];
    f.runtime.policy.copyEnvironment = ["FIXTURE_APPLICATION_VALUE"];
    const digest = runtimeDigest(f.runtime); f.runtime.capability.key.configurationDigest = digest;
    for (const check of f.runtime.capability.checks) check.configurationDigest = digest;
    await f.backend.context().db.patch(f.backend.find("machines", f.runtime.machineId)._id, { capabilityKey: f.runtime.capability.key, capabilityChecks: f.runtime.capability.checks });
    await f.saveRuntime();
    await assert.rejects(f.cli(f.repo, ["resume", "task", "--prepare-only", "--runtime", f.runtimePath, "--session", "missing_env"]), { code: "BLOCKED_ENV" });
    assert.equal(f.calls.filter(call => call.path === "tasks:registerManual" || call.path === "tasks:claim").length, 0);
    assert.equal([...f.backend.rows.values()].filter(row => row._table === "runs").length, 0);
    for (const name of ["HOME", "PATH", "COORD_SESSION_ID", "NODE_OPTIONS"]) assert.throws(() => parseRuntime({ ...f.runtime, policy: { ...f.runtime.policy, copyEnvironment: [name] } }));
  } finally { await f.restore(); }
});

test("T10 parsed daemon requires real containment before any reservation; check mode is query-only", async () => {
  const f = await commandsFixture();
  try {
    await assert.rejects(f.cli(f.repo, ["daemon", "--runtime", f.runtimePath]), /containment/);
    assert.equal(f.calls.filter(call => call.path === "tasks:claim").length, 0);
    const snapshot = await f.cli(f.repo, ["daemon", "--runtime", f.runtimePath, "--check"]) as { candidates: unknown[]; slots: number };
    assert.equal(snapshot.candidates.length, 1); assert.equal(snapshot.slots, 1);
    assert.equal([...f.backend.rows.values()].filter(row => row._table === "runs").length, 0);
  } finally { await f.restore(); }
});

test("T6/T20 default parsed resume actually starts a fresh fixture harness with bounded briefing and scoped environment", async () => {
  const f = await commandsFixture();
  try {
    const result = await f.cli(f.repo, ["resume", "task", "--runtime", f.runtimePath, "--session", "fresh_harness"]) as { path: string; exitCode: number; descendantStopProven: boolean };
    assert.equal(result.exitCode, 0); assert.equal(result.descendantStopProven, false);
    const started = JSON.parse(await readFile(join(result.path, ".coord-local/harness-start.json"), "utf8")) as { argv: string[]; cwd: string; environmentNames: string[] };
    assert.equal(started.cwd, result.path);
    assert.deepEqual(started.argv.slice(started.argv.indexOf("exec"), started.argv.indexOf("exec") + 5), ["exec", "--json", "--sandbox", "workspace-write", "--"]);
    assert.match(started.argv.at(-1)!, /fixture validation/);
    assert.ok(started.environmentNames.includes("COORD_SESSION_ID"));
    assert.ok(!started.environmentNames.some(name => /(?:API_KEY|AUTH_TOKEN|SUPERVISOR|APPROVER|VERIFIER|CONVEX|GH_TOKEN|GITHUB_TOKEN)/i.test(name)));
    assert.equal(f.backend.find("tasks", "task").ownerRunId, undefined);
    assert.equal([...f.backend.rows.values()].filter(row => row._table === "runs" && row.capacityHeld).length, 0);
    await assert.rejects(f.cli(f.repo, ["resume", "task", "--runtime", f.runtimePath, "--session", "fresh_harness"]));
  } finally { await f.restore(); }
});

test("runtime parser rejects diagnostic flags on reconciliation and reports missing configuration without any backend request", async () => {
  const f = await commandsFixture();
  try {
    f.calls.length = 0;
    await assert.rejects(f.cli(f.repo, ["run", "reconcile", "unknown_launch", "--check", "--stop", "--runtime", f.runtimePath]), { code: "INVALID_INPUT" });
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.cli(f.repo, ["checkpoint", "not_started", "--runtime", join(f.directory, "operator", "not-configured.json"), "--session", "not_started"]), { code: "BLOCKED_ENV" });
    assert.equal(f.calls.length, 0);
  } finally { await f.restore(); }
});
