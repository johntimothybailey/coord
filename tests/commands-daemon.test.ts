import { test } from "node:test";
import assert from "node:assert/strict";
import { commandsFixture } from "./commands.fixture.js";
import { daemonKernelFixture } from "./commands-daemon.fixture.js";
import { BackendClient } from "../src/client.js";
import { runtimeDigest } from "../src/command-runtime.js";
import { digest } from "../convex/auth.js";
import * as goals from "../convex/goals.js";
import * as tasks from "../convex/tasks.js";

// Direct dispatcher/controller integration under synthetic kernel/IPC/subscription transports only.
test("T10/T19 parsed daemon subscribes, claims durably, authorizes exact wrapper and stops/releases on shutdown", async t => {
  const kernel = await daemonKernelFixture(), f = await commandsFixture();
  try {
    f.runtime.containment = { kind: "linux-cgroup-v2", root: kernel.root };
    const currentDigest = runtimeDigest(f.runtime); f.runtime.capability.key.configurationDigest = currentDigest;
    for (const check of f.runtime.capability.checks) check.configurationDigest = currentDigest;
    await f.saveRuntime();
    await f.backend.context().db.patch(f.backend.find("machines", f.runtime.machineId)._id, { capabilityKey: f.runtime.capability.key, capabilityChecks: f.runtime.capability.checks, capabilityDigest: await digest(JSON.stringify(f.runtime.capability.key)) });
    const subscriptions: string[] = [];
    t.mock.method(BackendClient.prototype, "subscribe", function(this: BackendClient, name: string, payload: Record<string, never>, update: (value: unknown) => void, error: (error: unknown) => void) {
      subscriptions.push(name); let closed = false;
      void this.query(name, payload).then(value => { if (!closed) update(value); }, error);
      return () => { closed = true; };
    });
    const pending = f.cli(f.repo, ["daemon", "--runtime", f.runtimePath]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([kernel.started, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic daemon did not reach authorized wrapper release")), 30_000); })]);
    } finally { if (timer) clearTimeout(timer); }
    assert.ok(subscriptions.includes("dispatch:runnable"));
    assert.equal(f.calls.filter(call => call.path === "tasks:claim").length, 1);
    assert.equal(f.calls.filter(call => call.path === "lifecycle:authorizeLaunch").length, 1);
    const run = [...f.backend.rows.values()].find(row => row._table === "runs")!;
    assert.equal(run.capacityHeld, true);
    assert.deepEqual(kernel.events.slice(0, 4), ["wrapper_spawn_requested", "self_attached", "receipt_synced", "wrapper_released"]);
    await f.backend.context().db.patch(f.backend.find("credentials", "agent")._id, { revokedAt: Date.now() });
    await f.backend.context().db.patch(f.backend.find("credentials", run.grantId as string)._id, { revokedAt: Date.now() });
    process.emit("SIGTERM");
    const result = await pending as { stopped: boolean };
    assert.equal(result.stopped, true);
    assert.ok(kernel.events.includes("kernel_tree_stopped"));
    assert.equal(f.calls.filter(call => call.path === "lifecycle:confirmStopped").length, 1);
    assert.equal(f.backend.find("runs", run.id as string).capacityHeld, false);
    assert.equal(f.backend.find("tasks", "task").ownerRunId, undefined);
  } finally { t.mock.restoreAll(); await f.restore(); await kernel.restore(); }
});

test("T10/T19 parsed daemon keeps an ambiguous stop held; supervisor-only restart reconciles exact lost release receipt", async t => {
  const kernel = await daemonKernelFixture(true), f = await commandsFixture();
  try {
    f.runtime.containment = { kind: "linux-cgroup-v2", root: kernel.root };
    const currentDigest = runtimeDigest(f.runtime); f.runtime.capability.key.configurationDigest = currentDigest;
    for (const check of f.runtime.capability.checks) check.configurationDigest = currentDigest;
    await f.saveRuntime();
    await f.backend.context().db.patch(f.backend.find("machines", f.runtime.machineId)._id, { capabilityKey: f.runtime.capability.key, capabilityChecks: f.runtime.capability.checks, capabilityDigest: await digest(JSON.stringify(f.runtime.capability.key)) });
    t.mock.method(BackendClient.prototype, "subscribe", function(this: BackendClient, name: string, payload: Record<string, never>, update: (value: unknown) => void, error: (error: unknown) => void) { let closed = false; void this.query(name, payload).then(value => { if (!closed) update(value); }, error); return () => { closed = true; }; });
    const pending = f.cli(f.repo, ["daemon", "--runtime", f.runtimePath]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([kernel.started, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic held daemon did not authorize wrapper")), 30_000); })]); } finally { if (timer) clearTimeout(timer); }
    process.emit("SIGTERM"); await pending;
    const run = [...f.backend.rows.values()].find(row => row._table === "runs")!;
    assert.equal(f.backend.find("runs", run.id as string).capacityHeld, true);
    assert.equal(f.backend.find("tasks", "task").state, "launch_uncertain");
    assert.equal(f.calls.filter(call => call.path === "lifecycle:confirmStopped").length, 0);
    kernel.allowStop();
    // Revoking the project-agent does not revoke the independently scoped supervisor.
    await f.backend.context().db.patch(f.backend.find("credentials", "agent")._id, { revokedAt: Date.now() });
    f.loseReply("lifecycle:confirmStopped");
    await assert.rejects(f.cli(f.repo, ["run", "reconcile", run.launchId as string, "--stop", "--runtime", f.runtimePath]));
    assert.equal(f.backend.find("runs", run.id as string).capacityHeld, false);
    const kills = kernel.events.filter(event => event === "kernel_tree_stopped").length;
    const recovered = await f.cli(f.repo, ["run", "reconcile", run.launchId as string, "--runtime", f.runtimePath]) as { state: string };
    assert.equal(recovered.state, "released");
    assert.equal(kernel.events.filter(event => event === "kernel_tree_stopped").length, kills);
    const releases = f.calls.filter(call => call.path === "lifecycle:confirmStopped");
    assert.equal(releases.length, 2); assert.equal(releases[0]!.args.requestId, releases[1]!.args.requestId);
    assert.equal(f.backend.find("tasks", "task").state, "blocked");
  } finally { t.mock.restoreAll(); await f.restore(); await kernel.restore(); }
});

test("T13 parsed daemon uses only fixed read-only Codex replanning with owner-provisioned supplemental proof", async t => {
  const kernel = await daemonKernelFixture(), f = await commandsFixture();
  try {
    f.runtime.containment = { kind: "linux-cgroup-v2", root: kernel.root };
    const currentDigest = runtimeDigest(f.runtime); f.runtime.capability.key.configurationDigest = currentDigest;
    for (const check of f.runtime.capability.checks) check.configurationDigest = currentDigest;
    f.runtime.capability.checks.push({ schemaVersion: 1, checkId: "harness.replan-readonly", status: "PASS", mode: "managed", observedAt: new Date(Date.now() - 1000).toISOString(), configurationDigest: currentDigest, command: ["synthetic-native-readonly-fixture"], summary: "Synthetic transport only; no actual tool permissions qualified", evidenceRef: "fixture-only", kind: "real" });
    await f.saveRuntime();
    await f.backend.context().db.patch(f.backend.find("machines", f.runtime.machineId)._id, { capabilityKey: f.runtime.capability.key, capabilityChecks: f.runtime.capability.checks, capabilityDigest: await digest(JSON.stringify(f.runtime.capability.key)) });
    await f.backend.context().db.patch(f.backend.find("tasks", "task")._id, { state: "replan_requested" });
    t.mock.method(BackendClient.prototype, "subscribe", function(this: BackendClient, name: string, payload: Record<string, never>, update: (value: unknown) => void, error: (error: unknown) => void) { let closed = false; void this.query(name, payload).then(value => { if (!closed) update(value); }, error); return () => { closed = true; }; });
    const pending = f.cli(f.repo, ["daemon", "--runtime", f.runtimePath]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([kernel.started, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic replan daemon did not authorize wrapper")), 30_000); })]); } finally { if (timer) clearTimeout(timer); }
    assert.deepEqual(kernel.wrapperArgv[0]!.slice(kernel.wrapperArgv[0]!.indexOf("exec"), kernel.wrapperArgv[0]!.indexOf("exec") + 5), ["exec", "--json", "--sandbox", "read-only", "--"]);
    assert.match(kernel.wrapperArgv[0]!.at(-1)!, /READ-ONLY REPLANNING/);
    assert.equal(f.calls.filter(call => call.path === "tasks:claimReplan").length, 1);
    assert.equal(f.calls.filter(call => call.path === "checkpoints:prepare" || call.path === "publications:request").length, 0);
    process.emit("SIGTERM"); await pending;
    assert.equal([...f.backend.rows.values()].filter(row => row._table === "runs" && row.capacityHeld).length, 0);
  } finally { t.mock.restoreAll(); await f.restore(); await kernel.restore(); }
});

test("T13 missing owner-provisioned native read-only proof blocks replanning before admission", async t => {
  const kernel = await daemonKernelFixture(), f = await commandsFixture();
  try {
    f.runtime.containment = { kind: "linux-cgroup-v2", root: kernel.root };
    const currentDigest = runtimeDigest(f.runtime); f.runtime.capability.key.configurationDigest = currentDigest;
    for (const check of f.runtime.capability.checks) check.configurationDigest = currentDigest;
    await f.saveRuntime();
    await f.backend.context().db.patch(f.backend.find("machines", f.runtime.machineId)._id, { capabilityKey: f.runtime.capability.key, capabilityChecks: f.runtime.capability.checks, capabilityDigest: await digest(JSON.stringify(f.runtime.capability.key)) });
    await f.backend.context().db.patch(f.backend.find("tasks", "task")._id, { state: "replan_requested" });
    t.mock.method(BackendClient.prototype, "subscribe", function(this: BackendClient, name: string, payload: Record<string, never>, update: (value: unknown) => void, error: (error: unknown) => void) { let closed = false; void this.query(name, payload).then(value => { if (!closed) update(value); }, error); return () => { closed = true; }; });
    const pending = f.cli(f.repo, ["daemon", "--runtime", f.runtimePath]);
    const until = Date.now() + 10_000;
    while (!f.cliOutput.some(value => value.includes('"code":"UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION"')) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(f.cliOutput.some(value => value.includes('"code":"UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION"')));
    assert.equal(f.calls.filter(call => call.path === "tasks:claimReplan" || call.path === "tasks:claim").length, 0);
    assert.equal(kernel.wrapperArgv.length, 0);
    process.emit("SIGTERM"); await pending;
  } finally { t.mock.restoreAll(); await f.restore(); await kernel.restore(); }
});

test("T10/T19 wrapper crash during backend outage still stops owned tree locally and replays later settlement", async t => {
  const kernel = await daemonKernelFixture(), f = await commandsFixture();
  try {
    f.runtime.containment = { kind: "linux-cgroup-v2", root: kernel.root };
    const currentDigest = runtimeDigest(f.runtime); f.runtime.capability.key.configurationDigest = currentDigest;
    for (const check of f.runtime.capability.checks) check.configurationDigest = currentDigest;
    await f.saveRuntime();
    await f.backend.context().db.patch(f.backend.find("machines", f.runtime.machineId)._id, { capabilityKey: f.runtime.capability.key, capabilityChecks: f.runtime.capability.checks, capabilityDigest: await digest(JSON.stringify(f.runtime.capability.key)) });
    t.mock.method(BackendClient.prototype, "subscribe", function(this: BackendClient, name: string, payload: Record<string, never>, update: (value: unknown) => void, error: (error: unknown) => void) { let closed = false; void this.query(name, payload).then(value => { if (!closed) update(value); }, error); return () => { closed = true; }; });
    const pending = f.cli(f.repo, ["daemon", "--runtime", f.runtimePath]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([kernel.started, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic outage daemon did not authorize wrapper")), 30_000); })]); } finally { if (timer) clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, 20));
    f.setOffline(true); await kernel.crashWrapper();
    const until = Date.now() + 10_000;
    while (!kernel.events.includes("kernel_tree_stopped") && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(kernel.events.includes("kernel_tree_stopped"));
    process.emit("SIGTERM"); await pending;
    const run = [...f.backend.rows.values()].find(row => row._table === "runs")!;
    assert.equal(f.backend.find("runs", run.id as string).capacityHeld, true);
    assert.equal(f.calls.filter(call => call.path === "lifecycle:confirmStopped").length, 0);
    const before = kernel.events.filter(event => event === "kernel_tree_stopped").length;
    f.setOffline(false);
    const recovered = await f.cli(f.repo, ["run", "reconcile", run.launchId as string, "--runtime", f.runtimePath]) as { state: string };
    assert.equal(recovered.state, "released");
    assert.equal(f.backend.find("runs", run.id as string).capacityHeld, false);
    assert.equal(kernel.events.filter(event => event === "kernel_tree_stopped").length, before);
    assert.equal(f.calls.filter(call => call.path === "lifecycle:confirmStopped").length, 1);
  } finally { t.mock.restoreAll(); await f.restore(); await kernel.restore(); }
});

test("T10/T19 pause after durable wrapper receipt denies launch but positive failed-start receipt settles only that reservation", async t => {
  const kernel = await daemonKernelFixture(), f = await commandsFixture();
  try {
    f.runtime.containment = { kind: "linux-cgroup-v2", root: kernel.root };
    const currentDigest = runtimeDigest(f.runtime); f.runtime.capability.key.configurationDigest = currentDigest;
    for (const check of f.runtime.capability.checks) check.configurationDigest = currentDigest;
    await f.saveRuntime();
    await f.backend.context().db.patch(f.backend.find("machines", f.runtime.machineId)._id, { capabilityKey: f.runtime.capability.key, capabilityChecks: f.runtime.capability.checks, capabilityDigest: await digest(JSON.stringify(f.runtime.capability.key)) });
    let paused = false;
    f.beforeCall(async path => { if (path === "lifecycle:authorizeLaunch" && !paused) { paused = true; await f.controlGoal("paused"); } });
    t.mock.method(BackendClient.prototype, "subscribe", function(this: BackendClient, name: string, payload: Record<string, never>, update: (value: unknown) => void, error: (error: unknown) => void) { let closed = false; void this.query(name, payload).then(value => { if (!closed) update(value); }, error); return () => { closed = true; }; });
    const pending = f.cli(f.repo, ["daemon", "--runtime", f.runtimePath]);
    const until = Date.now() + 20_000;
    while (!f.cliOutput.some(value => value.includes('"state":"blocked"')) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    process.emit("SIGTERM"); await pending;
    assert.equal(paused, true);
    assert.ok(kernel.events.includes("receipt_synced")); assert.ok(!kernel.events.includes("wrapper_released"));
    assert.ok(kernel.events.includes("kernel_tree_stopped"));
    const run = [...f.backend.rows.values()].find(row => row._table === "runs")!;
    assert.equal(f.backend.find("runs", run.id as string).capacityHeld, false);
    assert.equal(f.backend.find("goals", "goal").state, "paused");
    assert.equal(f.backend.find("tasks", "task").ownerRunId, undefined);
    assert.equal(f.backend.find("tasks", "task").dispatchHeld, true);
    const released = f.calls.filter(call => call.path === "lifecycle:confirmStopped");
    assert.equal(released.length, 1);
    assert.equal((released[0]!.args.launchReceipt as { launchId: string }).launchId, run.launchId);
  } finally { t.mock.restoreAll(); await f.restore(); await kernel.restore(); }
});

test("T14 oversized approved startup context blocks parsed daemon before any epoch or capacity claim", async t => {
  const kernel = await daemonKernelFixture(), f = await commandsFixture();
  let pending: Promise<unknown> | undefined;
  try {
    f.runtime.containment = { kind: "linux-cgroup-v2", root: kernel.root };
    const currentDigest = runtimeDigest(f.runtime); f.runtime.capability.key.configurationDigest = currentDigest;
    for (const check of f.runtime.capability.checks) check.configurationDigest = currentDigest;
    await f.saveRuntime();
    await f.backend.context().db.patch(f.backend.find("machines", f.runtime.machineId)._id, { capabilityKey: f.runtime.capability.key, capabilityChecks: f.runtime.capability.checks, capabilityDigest: await digest(JSON.stringify(f.runtime.capability.key)) });
    const oldTask = f.backend.find("tasks", "task"), content = "Approved bounded-context regression ".repeat(450);
    await f.controlGoal("cancelled");
    // Actual approval handlers with synthetic fixture actors; no live human approval is represented.
    const draft = await f.backend.call(goals.propose, { ...f.identity(), goalId: "large_goal", expectedRevision: 0, content, taskLimit: 20, runTimeoutMs: 1800_000 }) as { goalId: string; revision: number; hash: string };
    await f.approveFixtureGoal(draft);
    await f.backend.call(tasks.propose, { ...f.identity(), taskId: "large_task", goalId: "large_goal", goalRevision: draft.revision, title: "Oversized approved startup must never reserve", scope: ["store.js", "test"], dependencies: [], executionBase: oldTask.executionBase });
    let dispatchUpdate: ((value: unknown) => void) | undefined;
    t.mock.method(BackendClient.prototype, "subscribe", function(this: BackendClient, name: string, payload: Record<string, never>, update: (value: unknown) => void, error: (error: unknown) => void) {
      if (name === "dispatch:runnable") dispatchUpdate = update;
      let closed = false; void this.query(name, payload).then(value => { if (!closed) update(value); }, error); return () => { closed = true; };
    });
    pending = f.cli(f.repo, ["daemon", "--runtime", f.runtimePath]);
    const until = Date.now() + 10_000;
    while (!f.cliOutput.some(value => value.includes('"code":"COVERAGE_INCOMPLETE"')) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(f.cliOutput.some(value => value.includes('"code":"COVERAGE_INCOMPLETE"')));
    assert.ok(f.calls.some(call => call.path === "memories:projectRules"));
    // Repeated delivery of unchanged work must still never create then refund a reservation.
    const snapshot = await (await f.connect(f.repo)).query("dispatch:runnable", { machineId: f.runtime.machineId, capabilityKey: { ...f.runtime.capability.key } });
    dispatchUpdate?.(snapshot); await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(f.calls.filter(call => ["tasks:claim", "tasks:claimReplan", "tasks:registerManual", "lifecycle:confirmStopped"].includes(call.path)).length, 0);
    assert.equal(f.backend.find("tasks", "large_task").epoch, 0);
    assert.equal([...f.backend.rows.values()].filter(row => row._table === "runs").length, 0);
    assert.equal(kernel.wrapperArgv.length, 0);
    process.emit("SIGTERM"); await pending; pending = undefined;
  } finally { if (pending) { process.emit("SIGTERM"); await pending.catch(() => {}); } t.mock.restoreAll(); await f.restore(); await kernel.restore(); }
});
