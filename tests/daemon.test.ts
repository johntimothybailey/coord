import test from "node:test";
import assert from "node:assert/strict";
import { startDaemon } from "../src/daemon.js";
import type { DaemonDriver, DispatchCandidate, DispatchSnapshot } from "../src/daemon.js";
import { CoordError } from "../src/protocol.js";
import type { CapabilityKey } from "../src/protocol.js";
import { CAPABILITIES, CLIENT_VERSION, REQUIRED_CHECKS } from "../src/protocol.js";
import { BackendFixture } from "./backend.fixture.js";
import { bootstrap, digest } from "../convex/auth.js";
import * as projects from "../convex/projects.js";
import * as goals from "../convex/goals.js";
import * as tasks from "../convex/tasks.js";
import * as machines from "../convex/machines.js";
import { runnable } from "../convex/dispatch.js";

const key: CapabilityKey = { os: "fixture", harness: "codex", harnessVersion: "fixture", adapterVersion: "1", probeVersion: "1", configurationDigest: "fixture-config", gitPolicyDigest: "fixture-policy" };
const candidate = (taskId = "task"): DispatchCandidate => ({ taskId, epoch: 0, goalRevision: 1, mode: "managed", checkpointId: null, executionBase: { sha: "a".repeat(40), revision: 1, remoteRef: "refs/heads/main" } });
const snapshot = (candidates = [candidate()], slots = 1): DispatchSnapshot => ({ candidates, slots, complete: true, policyVersion: 1 });
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function rig(overrides: Partial<DaemonDriver> = {}) {
  const events: string[] = [], notices: Array<{ taskId: string; state: string; code: string }> = [];
  let emit!: (value: DispatchSnapshot) => void, fail!: (error: unknown) => void;
  const driver: DaemonDriver = {
    subscribe(machineId, capability, update, error) { assert.equal(machineId, "machine"); assert.deepEqual(capability, key); emit = update; fail = error; return () => { events.push("unsubscribe"); }; },
    async preflight(task) { events.push(`preflight:${task.taskId}`); return { configurationDigest: "effective-config" }; },
    async claim(task, digest) { events.push(`claim:${task.taskId}`); assert.equal(digest, "effective-config"); return { runId: `run-${task.taskId}` }; },
    async launch(task, admission, digest) { events.push(`launch:${task.taskId}`); assert.deepEqual(admission, { runId: `run-${task.taskId}` }); assert.equal(digest, "effective-config"); },
    notify(taskId, state, code) { notices.push({ taskId, state, code }); },
    ...overrides,
  };
  const daemon = startDaemon("machine", key, driver);
  return { daemon, events, notices, emit: (value: DispatchSnapshot) => { emit(value); }, fail: (error: unknown) => { fail(error); } };
}

test("T14 dispatcher completes effective preflight before any claim and reports missing environment without a slot", async () => {
  const run = rig({ async preflight(task) { if (task.taskId === "missing") throw new CoordError("BLOCKED_ENV", "Missing required local key"); return { configurationDigest: "effective-config" }; } });
  run.emit(snapshot([candidate("missing"), candidate("ready")])); await run.daemon.idle();
  assert.deepEqual(run.events, ["claim:ready", "launch:ready"]);
  assert.deepEqual(run.notices, [{ taskId: "missing", state: "blocked", code: "BLOCKED_ENV" }, { taskId: "ready", state: "launched", code: "AUTHORIZED_LAUNCH" }]);
  run.daemon.stop();
});

test("incomplete snapshots and zero capacity never preflight or reserve; repeated blockers notify once", async () => {
  const run = rig();
  run.emit({ ...snapshot(), complete: false }); await run.daemon.idle();
  run.emit({ ...snapshot(), complete: false }); await run.daemon.idle();
  run.emit(snapshot([candidate()], 0)); await run.daemon.idle();
  assert.deepEqual(run.events, []); assert.deepEqual(run.notices, [{ taskId: "project", state: "blocked", code: "COVERAGE_INCOMPLETE" }]);
  run.daemon.stop();
});

test("a superseding snapshot while preflight runs prevents claiming the stale candidate", async () => {
  const entered = deferred(), proceed = deferred();
  const run = rig({ async preflight(task) { if (task.taskId === "old") { entered.resolve(); await proceed.promise; } return { configurationDigest: "effective-config" }; } });
  run.emit(snapshot([candidate("old")])); await entered.promise;
  run.emit(snapshot([candidate("new")])); proceed.resolve(); await run.daemon.idle();
  assert.deepEqual(run.events, ["claim:new", "launch:new"]); run.daemon.stop();
});

test("T10 successful admission still settles its reservation after a newer empty subscription snapshot", async () => {
  const entered = deferred(), proceed = deferred(), calls: string[] = [];
  const run = rig({ async claim(task) { calls.push(`claimed:${task.taskId}`); entered.resolve(); await proceed.promise; return { runId: `run-${task.taskId}` }; } });
  run.emit(snapshot()); await entered.promise; run.emit(snapshot([], 0)); proceed.resolve(); await run.daemon.idle();
  assert.deepEqual(calls, ["claimed:task"]); assert.deepEqual(run.events, ["preflight:task", "launch:task"]); run.daemon.stop();
});

test("T10 stopping subscription during an admitted claim still settles that reservation exactly once", async () => {
  const entered = deferred(), proceed = deferred();
  const run = rig({ async claim(task) { entered.resolve(); await proceed.promise; return { runId: `run-${task.taskId}` }; } });
  run.emit(snapshot()); await entered.promise; run.daemon.stop(); proceed.resolve(); await run.daemon.idle();
  assert.deepEqual(run.events, ["preflight:task", "unsubscribe", "launch:task"]);
  run.emit(snapshot([candidate("later")])); await run.daemon.idle(); assert(!run.events.includes("claim:later"));
});

test("T3 duplicate subscription delivery during a claim cannot produce a second claim or launch", async () => {
  const entered = deferred(), proceed = deferred(), claims: string[] = [];
  const run = rig({ async claim(task) { claims.push(task.taskId); entered.resolve(); await proceed.promise; return { runId: `run-${task.taskId}` }; } });
  run.emit(snapshot()); await entered.promise; run.emit(snapshot()); proceed.resolve(); await run.daemon.idle();
  run.emit(snapshot()); await run.daemon.idle();
  assert.deepEqual(claims, ["task"]); assert.equal(run.events.filter(value => value === "launch:task").length, 1); run.daemon.stop();
});

test("T10 launch uncertainty consumes the claimed slot and never uses another candidate as an implicit replacement", async () => {
  const launches: string[] = [];
  const run = rig({ async launch(task) { launches.push(task.taskId); throw new CoordError("LAUNCH_UNCERTAIN", "Driver retained the reservation"); } });
  run.emit(snapshot([candidate("uncertain"), candidate("next")], 1)); await run.daemon.idle();
  assert.deepEqual(launches, ["uncertain"]); assert(!run.events.includes("claim:next"));
  run.emit(snapshot([candidate("uncertain")], 1)); await run.daemon.idle(); assert.deepEqual(launches, ["uncertain"]);
  assert.deepEqual(run.notices, [{ taskId: "uncertain", state: "blocked", code: "LAUNCH_UNCERTAIN" }]); run.daemon.stop();
});

test("a fresh backend epoch can dispatch again after the earlier admitted candidate has settled", async () => {
  const run = rig(); run.emit(snapshot()); await run.daemon.idle();
  run.emit(snapshot([{ ...candidate(), epoch: 1 }])); await run.daemon.idle();
  assert.equal(run.events.filter(value => value === "claim:task").length, 2); assert.equal(run.events.filter(value => value === "launch:task").length, 2); run.daemon.stop();
});

async function dispatchFixture() {
  const fixture = new BackendFixture(), humanToken = "1".repeat(64), agentToken = "2".repeat(64);
  let serial = 0;
  const request = (token = agentToken) => ({ token, protocolVersion: 1, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], backendId: "backend", projectId: "project", requestId: `dispatch_${++serial}` });
  await fixture.call(bootstrap, { backendId: "backend", projectId: "project", repository: "github.com/team/fixture", remote: "https://github.com/team/fixture.git", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: [], humanId: "human", humanDigest: await digest(humanToken), agentId: "agent", agentDigest: await digest(agentToken), expiresAt: Date.now() + 3600_000 });
  await fixture.call(projects.configure, { ...request(humanToken), repository: "github.com/team/fixture", remote: "https://github.com/team/fixture.git", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: [], sharingApproved: true, capacity: 2, taskCap: 20 });
  const goal = await fixture.call(goals.propose, { ...request(), goalId: "goal", expectedRevision: 0, content: "Dispatch fixture", taskLimit: 20, runTimeoutMs: 60_000 }) as { revision: number; hash: string };
  await fixture.call(goals.approve, { ...request(humanToken), goalId: "goal", revision: goal.revision, hash: goal.hash });
  await fixture.call(machines.provisionQualification, { backendId: "backend", projectId: "project", memberId: "agent", machineId: "machine", capacity: 1, modes: ["managed"], key, checks: REQUIRED_CHECKS.managed.map(checkId => ({ schemaVersion: 1 as const, checkId, status: "PASS" as const, mode: "managed" as const, observedAt: new Date(Date.now() - 1000).toISOString(), configurationDigest: key.configurationDigest, command: ["synthetic-dispatch-fixture"], summary: "Guard input only, not observed host evidence", evidenceRef: "fixture-only", kind: "real" as const })), evidenceRef: "fixture-only", expiresAt: Date.now() + 3600_000, supervisorId: "supervisor", supervisorToken: "3".repeat(64), artifactVerifierId: "verifier", artifactVerifierToken: "6".repeat(64) });
  const propose = async (taskId: string) => fixture.call(tasks.propose, { ...request(), taskId, goalId: "goal", goalRevision: 1, title: "Dispatch task", scope: [`src/${taskId}.ts`], dependencies: [], executionBase: candidate().executionBase });
  const query = async () => await fixture.call(runnable, { ...request(), machineId: "machine", capabilityKey: key }) as DispatchSnapshot;
  return { fixture, propose, query, request };
}

test("reactive dispatch handler reports authoritative epoch/capacity and omits held, invalid-scope and inactive-goal tasks", async () => {
  const { fixture, propose, query } = await dispatchFixture();
  await propose("eligible"); await propose("held"); await propose("invalid_scope");
  await fixture.context().db.patch(fixture.find("tasks", "held")._id, { dispatchHeld: true });
  await fixture.context().db.patch(fixture.find("tasks", "invalid_scope")._id, { scope: ["outside/repository.ts"] });
  const result = await query();
  assert.equal(result.complete, true); assert.equal(result.slots, 1); assert.deepEqual(result.candidates.map(value => ({ taskId: value.taskId, epoch: value.epoch })), [{ taskId: "eligible", epoch: 0 }]);
  await fixture.context().db.patch(fixture.find("goals", "goal")._id, { state: "paused" }); assert.deepEqual((await query()).candidates, []);
});

test("reactive dispatch handler never reports a free slot for a held reservation or stale machine qualification", async () => {
  const { fixture, propose, query, request } = await dispatchFixture(); await propose("reserved"); await propose("next");
  await fixture.call(tasks.claim, { ...request(), taskId: "reserved", runId: "run", launchId: "launch", grantToken: "4".repeat(64), machineId: "machine", harness: "codex", capabilityKey: key });
  assert.equal((await query()).slots, 0); assert.deepEqual((await query()).candidates, []);
  await fixture.context().db.patch(fixture.find("machines", "machine")._id, { qualificationExpiresAt: 1 });
  await assert.rejects(query(), (error: unknown) => error !== null && typeof error === "object" && "data" in error && (error.data as { code?: string }).code === "UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION");
});

test("T13 failed dependencies produce an admissible bounded replanning candidate without waiting on failed work", async () => {
  const { fixture, propose, query, request } = await dispatchFixture(); await propose("child"); await propose("parent");
  await fixture.context().db.patch(fixture.find("tasks", "child")._id, { state: "failed" });
  await fixture.context().db.patch(fixture.find("tasks", "parent")._id, { state: "waiting_dependencies", dependencies: [{ taskId: "child", mode: "published" }] });
  await fixture.call(tasks.refreshDependencies, request());
  const ready = await query(); assert.equal(ready.candidates.length, 1); assert.equal(ready.candidates[0]?.taskId, "parent"); assert.equal(ready.candidates[0]?.mode, "replan");
  const admission = { ...request(), taskId: "parent", runId: "replan", launchId: "launch-replan", grantToken: "5".repeat(64), machineId: "machine", harness: "codex" as const, capabilityKey: key };
  const result = await fixture.call(tasks.claimReplan, admission);
  assert.equal(fixture.find("runs", "replan").mode, "replan"); assert.equal(fixture.find("runs", "replan").capacityHeld, true);
  assert.equal(fixture.find("tasks", "parent").replanAttempts, 1);
  assert.deepEqual(await fixture.call(tasks.claimReplan, admission), result); assert.equal(fixture.find("tasks", "parent").replanAttempts, 1);
});

test("backend subscription failure cancels stale preflight and emits no launch", async () => {
  const entered = deferred(), proceed = deferred();
  const run = rig({ async preflight() { entered.resolve(); await proceed.promise; return { configurationDigest: "effective-config" }; } });
  run.emit(snapshot()); await entered.promise; run.fail(new Error("Disconnected")); proceed.resolve(); await run.daemon.idle();
  assert.deepEqual(run.events, []); assert.deepEqual(run.notices, [{ taskId: "project", state: "blocked", code: "BACKEND_UNAVAILABLE" }]); run.daemon.stop();
});
