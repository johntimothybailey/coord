import test from "node:test";
import assert from "node:assert/strict";
import { BackendFixture } from "./backend.fixture.js";
import { bootstrap, canonical, digest } from "../convex/auth.js";
import * as projects from "../convex/projects.js";
import * as goals from "../convex/goals.js";
import * as machines from "../convex/machines.js";
import * as tasks from "../convex/tasks.js";
import * as publications from "../convex/publications.js";
import * as checkpoints from "../convex/checkpoints.js";
import * as scans from "../convex/scans.js";
import * as lifecycle from "../convex/lifecycle.js";
import { runnable } from "../convex/dispatch.js";
import type { MutationCtx } from "../convex/server.js";
import { CAPABILITIES, CLIENT_VERSION, REQUIRED_CHECKS } from "../src/protocol.js";

// Real exported handlers over a serialized fixture. Synthetic qualification/artifacts are not live proof.
const token = { human: "1".repeat(64), agent: "2".repeat(64), supervisor: "3".repeat(64), verifier: "4".repeat(64) };
const key = { os: "fixture", harness: "codex" as const, harnessVersion: "fixture", adapterVersion: "fixture", probeVersion: "1", configurationDigest: "fixture-config", gitPolicyDigest: "fixture-policy" };
const base = { sha: "a".repeat(40), revision: 1, remoteRef: "refs/heads/main" };
let serial = 0;
function request(credential = token.agent) { return { token: credential, protocolVersion: 1, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], backendId: "backend", projectId: "project", requestId: `dependency_${++serial}` }; }
class ScheduledFixture extends BackendFixture {
  scheduled: Array<{ cursor?: string; state?: "waiting_dependencies" | "queued" }> = [];
  override context(): MutationCtx {
    return { ...super.context(), scheduler: { runAfter: async (_delay: number, _fn: unknown, args: { cursor?: string; state?: "waiting_dependencies" | "queued" }) => { this.scheduled.push(structuredClone(args)); return "scheduled-fixture"; } } as unknown as MutationCtx["scheduler"] };
  }
}
async function setup() {
  const fixture = new ScheduledFixture();
  await fixture.call(bootstrap, { backendId: "backend", projectId: "project", repository: "https://example.test/dependencies", remote: "origin", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: [], humanId: "human", humanDigest: await digest(token.human), agentId: "agent", agentDigest: await digest(token.agent), expiresAt: Date.now() + 3600_000 });
  await fixture.call(projects.configure, { ...request(token.human), repository: "https://example.test/dependencies", remote: "origin", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: [], sharingApproved: true, capturePolicyDigest: "d".repeat(64), capacity: 2, taskCap: 100 });
  const goal = await fixture.call(goals.propose, { ...request(), goalId: "goal", expectedRevision: 0, content: "Fixture initial DAG", taskLimit: 80, runTimeoutMs: 1800_000 }) as { hash: string; revision: number };
  await fixture.call(goals.approve, { ...request(token.human), goalId: "goal", revision: goal.revision, hash: goal.hash });
  await fixture.call(machines.provisionQualification, { backendId: "backend", projectId: "project", memberId: "agent", machineId: "machine", capacity: 1, modes: ["manual", "managed"], key, checks: REQUIRED_CHECKS.managed.map(checkId => ({ schemaVersion: 1 as const, checkId, status: "PASS" as const, mode: "managed" as const, observedAt: new Date(Date.now() - 1000).toISOString(), configurationDigest: key.configurationDigest, command: ["synthetic-dependency-fixture"], summary: "Synthetic input only, not host qualification", evidenceRef: "fixture-only", kind: "real" as const })), evidenceRef: "fixture-only", expiresAt: Date.now() + 1800_000, supervisorId: "supervisor", supervisorToken: token.supervisor, artifactVerifierId: "verifier", artifactVerifierToken: token.verifier });
  const propose = (taskId: string, dependencies: Array<{ taskId: string; mode: "published" | "merged"; artifact?: string }> = []) => fixture.call(tasks.propose, { ...request(), taskId, goalId: "goal", goalRevision: 1, title: `Fixture ${taskId}`, scope: [`src/${taskId}.ts`], dependencies, executionBase: base });
  const candidates = async () => (await fixture.call(runnable, { ...request(), machineId: "machine", capabilityKey: key }) as { candidates: Array<{ taskId: string; mode: string }> }).candidates;
  return { fixture, propose, candidates };
}
async function publishChild(fixture: BackendFixture, taskId: string, checkpointId: string, additionalFiles = 0, mode: "manual" | "managed" = "manual") {
  let task = fixture.find("tasks", taskId);
  const grant = await digest(`synthetic-grant:${taskId}`), runId = `${taskId}_run`;
  const identity = { taskId, runId, epoch: 1, goalRevision: 1 };
  if (!task.ownerRunId) {
    const admission = { ...request(), taskId, runId, launchId: `${taskId}_launch`, grantToken: grant, machineId: "machine", harness: "codex" as const, capabilityKey: key };
    if (mode === "manual") await fixture.call(tasks.registerManual, admission);
    else {
      await fixture.call(tasks.claim, admission); await fixture.call(lifecycle.starting, { ...request(grant), ...identity });
      await fixture.call(lifecycle.authorizeLaunch, { ...request(token.supervisor), ...identity, process: { pid: 100, bootId: "fixture-boot", startIdentity: "fixture-start", launchId: admission.launchId } });
    }
  }
  task = fixture.find("tasks", taskId);
  const progress = JSON.stringify({ fixtureCheckpoint: checkpointId });
  await fixture.call(tasks.progress, { ...request(grant), ...identity, expectedRevision: task.progressRevision, progress });
  const manifest = { schemaVersion: 1 as const, checkpointId, identity, sourceHead: "c".repeat(40), executionBase: base, remoteParent: base.sha, tree: "e".repeat(40), commit: "b".repeat(40), ref: `refs/coord/checkpoints/${taskId}/e1/${checkpointId}`, files: [{ path: task.scope[0]!, mode: "100644", type: "blob" as const, oid: "f".repeat(40) }, ...Array.from({ length: additionalFiles }, (_, index) => ({ path: `src/baseline/file_${index}.ts`, mode: "100644", type: "blob" as const, oid: "f".repeat(40) }))], exclusions: [], progressHash: await digest(canonical(JSON.parse(progress))), evidence: [], createdAt: new Date().toISOString(), progressRevision: task.progressRevision + 1, policyDigest: fixture.find("projects", "project").capturePolicyDigest ?? "", manifestDigest: "", reusedCommit: false };
  manifest.manifestDigest = await digest(canonical({ identity, sourceHead: manifest.sourceHead, executionBase: base, tree: manifest.tree, files: manifest.files, exclusions: [], progressHash: manifest.progressHash, policyDigest: manifest.policyDigest, progressRevision: manifest.progressRevision }));
  await fixture.call(checkpoints.prepare, { ...request(grant), ...identity, manifest, summary: progress });
  const paths = [task.scope[0]!], revision = `${checkpointId}_scan`;
  await fixture.call(scans.upload, { ...request(grant), ...identity, revision, sourceHead: manifest.sourceHead, tree: manifest.tree, chunk: 0, paths, digest: await digest(canonical(paths)), expectedChunks: 1, expectedPaths: 1 });
  await fixture.call(scans.verify, { ...request(token.verifier), ...identity, revision, sourceHead: manifest.sourceHead, tree: manifest.tree, pathsDigest: await digest(canonical(paths)), expectedPaths: 1, evidenceRef: "synthetic-actual-paths" });
  await fixture.call(checkpoints.verifyCode, { ...request(token.verifier), ...identity, checkpointId, readback: { commit: manifest.commit, tree: manifest.tree, parent: base.sha, ref: manifest.ref, manifestHash: manifest.manifestDigest, progressHash: manifest.progressHash, policyDigest: manifest.policyDigest, evidenceRef: "synthetic-remote-readback" } });
  await fixture.call(checkpoints.ready, { ...request(token.verifier), ...identity, checkpointId });
}

test("initial proposed queued DAG resolves future published artifact IDs and admits the parent", async () => {
  const { fixture, propose, candidates } = await setup(); await propose("child"); await propose("parent", [{ taskId: "child", mode: "published" }]);
  assert.equal(fixture.find("tasks", "parent").state, "queued"); assert.deepEqual((await candidates()).map(candidate => candidate.taskId), ["child"]);
  await publishChild(fixture, "child", "child_ready");
  const refresh = await fixture.call(lifecycle.sweepDependencies, { state: "queued" }) as { changed: Array<{ taskId: string; state: string }> };
  assert.deepEqual(refresh.changed, [{ taskId: "parent", state: "queued" }]); assert.equal(fixture.find("tasks", "parent").dependencies[0]?.artifact, "child_ready");
  const before = fixture.find("tasks", "parent"), again = await fixture.call(tasks.refreshDependencies, request()) as { changed: unknown[] };
  assert.deepEqual(again.changed, []); assert.deepEqual(fixture.find("tasks", "parent"), before); assert.deepEqual((await candidates()).map(candidate => candidate.taskId), ["parent"]);
  await fixture.call(tasks.claim, { ...request(), taskId: "parent", runId: "parent_run", launchId: "parent_launch", grantToken: "5".repeat(64), machineId: "machine", harness: "codex", capabilityKey: key });
  assert.equal(fixture.find("tasks", "parent").state, "reserved");
});
test("queued child failure causes one bounded replan transition without resetting attempts", async () => {
  const { fixture, propose, candidates } = await setup(); await propose("child"); await propose("parent", [{ taskId: "child", mode: "published" }]);
  await fixture.context().db.patch(fixture.find("tasks", "child")._id, { state: "failed" }); await fixture.context().db.patch(fixture.find("tasks", "parent")._id, { replanAttempts: 1 });
  const result = await fixture.call(tasks.refreshDependencies, request()) as { changed: Array<{ taskId: string; state: string }> };
  assert.deepEqual(result.changed, [{ taskId: "parent", state: "replan_requested" }]); assert.equal(fixture.find("tasks", "parent").replanAttempts, 1);
  const again = await fixture.call(tasks.refreshDependencies, request()) as { changed: unknown[] }; assert.deepEqual(again.changed, []); assert.equal(fixture.find("tasks", "parent").replanAttempts, 1);
  assert.deepEqual(await candidates(), [{ taskId: "parent", epoch: 0, goalRevision: 1, mode: "replan", executionBase: base, checkpointId: null }]);
});
test("partial resolution pins only absent artifacts and never swaps an agreed older ready checkpoint", async () => {
  const { fixture, propose, candidates } = await setup(); await propose("first"); await propose("second"); await propose("parent", [{ taskId: "first", mode: "published" }, { taskId: "second", mode: "published" }]);
  await publishChild(fixture, "first", "first_v1"); await fixture.call(tasks.refreshDependencies, request());
  assert.equal(fixture.find("tasks", "parent").dependencies[0]?.artifact, "first_v1"); assert.equal(fixture.find("tasks", "parent").dependencies[1]?.artifact, undefined);
  await publishChild(fixture, "first", "first_v2"); await publishChild(fixture, "second", "second_v1");
  await fixture.call(tasks.refreshDependencies, request()); const parent = fixture.find("tasks", "parent");
  assert.equal(fixture.find("tasks", "first").latestCheckpointId, "first_v2"); assert.deepEqual(parent.dependencies.map(dep => dep.artifact), ["first_v1", "second_v1"]);
  await tasks.dependenciesReady(fixture.context(), parent); assert.deepEqual((await candidates()).map(candidate => candidate.taskId), ["parent"]);
});
test("dependency refresh preserves active, held, paused and cancelled guards", async () => {
  for (const patch of [{ ownerRunId: "active_owner" }, { holdRunId: "uncertain_owner" }, { dispatchHeld: true }, { state: "running" }, { state: "cancelled" }]) {
    const { fixture, propose } = await setup(); await propose("child"); await propose("parent", [{ taskId: "child", mode: "published" }]); await fixture.context().db.patch(fixture.find("tasks", "child")._id, { state: "failed" });
    await fixture.context().db.patch(fixture.find("tasks", "parent")._id, patch); const parent = fixture.find("tasks", "parent");
    await tasks.refreshWaiting(fixture.context(), [parent]); assert.deepEqual(fixture.find("tasks", "parent"), parent);
  }
  const { fixture, propose } = await setup(); await propose("child"); await propose("parent", [{ taskId: "child", mode: "published" }]); await fixture.context().db.patch(fixture.find("tasks", "child")._id, { state: "cancelled" }); await fixture.context().db.patch(fixture.find("goals", "goal")._id, { state: "paused" });
  const parent = fixture.find("tasks", "parent"); await fixture.call(tasks.refreshDependencies, request()); assert.deepEqual(fixture.find("tasks", "parent"), parent);
});
test("bounded dependency cron traverses waiting and queued phases without repeatedly writing unchanged queued tasks", async () => {
  const { fixture, propose } = await setup(); for (let index = 0; index < 30; index++) await propose(`queued_${index}`);
  const before = structuredClone(fixture.rows);
  const waiting = await fixture.call(lifecycle.sweepDependencies, {}) as { complete: boolean; state: string }; assert.equal(waiting.state, "waiting_dependencies"); assert.equal(waiting.complete, false); assert.deepEqual(fixture.scheduled.shift(), { state: "queued" });
  const first = await fixture.call(lifecycle.sweepDependencies, { state: "queued" }) as { complete: boolean }; assert.equal(first.complete, false);
  const continuation = fixture.scheduled.shift()!; assert.equal(continuation.state, "queued"); assert.equal(typeof continuation.cursor, "string");
  const last = await fixture.call(lifecycle.sweepDependencies, continuation) as { complete: boolean }; assert.equal(last.complete, true); assert.equal(fixture.scheduled.length, 0); assert.deepEqual(fixture.rows, before);
});

test("terminal cancelled children respect the persistent replan limit while temporary blockers do not replan", async () => {
  for (const attempts of [0, 2]) {
    const { fixture, propose } = await setup(); await propose("child"); await propose("parent", [{ taskId: "child", mode: "published" }]);
    await fixture.context().db.patch(fixture.find("tasks", "child")._id, { state: "cancelled" }); await fixture.context().db.patch(fixture.find("tasks", "parent")._id, { replanAttempts: attempts });
    await fixture.call(tasks.refreshDependencies, request()); const parent = fixture.find("tasks", "parent");
    assert.equal(parent.state, attempts === 2 ? "blocked" : "replan_requested"); assert.equal(parent.replanAttempts, attempts); assert.equal(parent.dispatchHeld, attempts === 2);
    await fixture.call(tasks.refreshDependencies, request()); assert.deepEqual(fixture.find("tasks", "parent"), parent);
  }
  const { fixture, propose } = await setup(); await propose("child"); await propose("parent", [{ taskId: "child", mode: "published" }]); await fixture.context().db.patch(fixture.find("tasks", "child")._id, { state: "blocked", reason: "temporary_environment_requirement" });
  const before = fixture.find("tasks", "parent"); const result = await fixture.call(tasks.refreshDependencies, request()) as { changed: unknown[] }; assert.deepEqual(result.changed, []); assert.deepEqual(fixture.find("tasks", "parent"), before);
});


function isCode(expected: string) { return (error: unknown) => error !== null && typeof error === "object" && "data" in error && (error.data as { code?: string }).code === expected; }
test("a terminal child with a still-ready pin cannot be claimed before the dependency sweep", async () => {
  const { fixture, propose } = await setup(); await propose("child"); await propose("parent", [{ taskId: "child", mode: "published" }]); await publishChild(fixture, "child", "pinned_ready"); await fixture.call(tasks.refreshDependencies, request());
  await fixture.call(lifecycle.requestFinalization, { ...request(await digest("synthetic-grant:child")), taskId: "child", runId: "child_run", epoch: 1, goalRevision: 1, outcome: "failed", reason: "Terminal dependency failure after a ready milestone" });
  assert.equal(fixture.find("tasks", "parent").state, "queued"); assert.equal(fixture.find("checkpoints", "pinned_ready").state, "ready");
  const before = structuredClone(fixture.rows);
  await assert.rejects(fixture.call(tasks.claim, { ...request(), taskId: "parent", runId: "must_not_claim", launchId: "bad_launch", grantToken: "7".repeat(64), machineId: "machine", harness: "codex", capabilityKey: key }), isCode("BLOCKED_CHECKPOINT")); assert.deepEqual(fixture.rows, before);
  await fixture.call(tasks.refreshDependencies, request());
  await fixture.call(tasks.claimReplan, { ...request(), taskId: "parent", runId: "replan_run", launchId: "replan_launch", grantToken: "8".repeat(64), machineId: "machine", harness: "codex", capabilityKey: key });
  const historical = await fixture.call(checkpoints.getInput, { ...request("8".repeat(64)), taskId: "parent", dependencyTaskId: "child", includeManifest: true }) as { availability: string; task: { state: string }; code: { checkpointId: string } };
  assert.equal(historical.task.state, "failed"); assert.equal(historical.availability, "published"); assert.equal(historical.code.checkpointId, "pinned_ready");
});
test("declared dependency reads return the exact historical pin with opt-in immutable progress and no latest substitution", async () => {
  const { fixture, propose } = await setup(); await propose("child"); await propose("unrelated"); await propose("parent", [{ taskId: "child", mode: "published" }]); await publishChild(fixture, "child", "old_ready");
  const missing = await fixture.call(checkpoints.getInput, { ...request(), taskId: "parent", dependencyTaskId: "child" }) as { availability: string; code: unknown }; assert.equal(missing.availability, "unavailable"); assert.equal(missing.code, null);
  await fixture.call(tasks.refreshDependencies, request()); await publishChild(fixture, "child", "new_ready");
  const before = structuredClone(fixture.rows);
  const compact = await fixture.call(checkpoints.getInput, { ...request(), taskId: "parent", dependencyTaskId: "child" }) as { availability: string; code: Record<string, unknown> };
  assert.equal(compact.availability, "published"); assert.equal(compact.code.checkpointId, "old_ready"); assert(!("manifest" in compact.code)); assert(!("summary" in compact.code));
  const full = await fixture.call(checkpoints.getInput, { ...request(token.human), taskId: "parent", dependencyTaskId: "child", includeManifest: true }) as { code: { checkpointId: string; summary: string; manifest: { checkpointId: string; progressHash: string } } };
  assert.equal(full.code.checkpointId, "old_ready"); assert.equal(full.code.manifest.checkpointId, "old_ready"); assert.equal(full.code.summary, JSON.stringify({ fixtureCheckpoint: "old_ready" })); assert.equal(full.code.manifest.progressHash, await digest(canonical(JSON.parse(full.code.summary))));
  await assert.rejects(fixture.call(checkpoints.getInput, { ...request(), taskId: "parent", dependencyTaskId: "unrelated" }), isCode("FORBIDDEN"));
  for (const credential of [token.supervisor, token.verifier]) await assert.rejects(fixture.call(checkpoints.getInput, { ...request(credential), taskId: "parent", dependencyTaskId: "child" }), isCode("FORBIDDEN"));
  assert.deepEqual(fixture.rows, before);
  const source = await fixture.call(checkpoints.getReady, { ...request(), taskId: "parent" }) as { inputs: Array<{ code: Record<string, unknown> }> }; assert.equal(source.inputs[0]?.code.checkpointId, "old_ready"); assert(!("manifest" in source.inputs[0]!.code));
});
test("run dependency reads derive identity from the credential and retain reserved/starting/current-epoch guards", async () => {
  const { fixture, propose } = await setup(); await propose("child"); await propose("parent", [{ taskId: "child", mode: "published" }]); await publishChild(fixture, "child", "child_ready"); await fixture.call(tasks.refreshDependencies, request());
  const credential = "6".repeat(64), bound = { taskId: "parent", runId: "parent_run", epoch: 1, goalRevision: 1 };
  await fixture.call(tasks.claim, { ...request(), ...bound, launchId: "parent_launch", grantToken: credential, machineId: "machine", harness: "codex", capabilityKey: key });
  const read = () => fixture.call(checkpoints.getInput, { ...request(credential), taskId: "parent", dependencyTaskId: "child" });
  await read(); await fixture.call(lifecycle.starting, { ...request(credential), ...bound }); await read();
  await assert.rejects(fixture.call(checkpoints.getInput, { ...request(credential), taskId: "child", dependencyTaskId: "parent" }), isCode("FORBIDDEN"));
  await fixture.context().db.patch(fixture.find("tasks", "parent")._id, { epoch: 2 }); await assert.rejects(read(), isCode("STALE_EPOCH"));
});
test("dependency read and ordinary admission share current policy, scope and immutable summary checks", async () => {
  const { fixture, propose } = await setup(); await propose("child"); await propose("parent", [{ taskId: "child", mode: "published" }]); await publishChild(fixture, "child", "ready"); await fixture.call(tasks.refreshDependencies, request());
  const parent = fixture.find("tasks", "parent"), checkpoint = fixture.find("checkpoints", "ready"), project = fixture.find("projects", "project");
  const read = () => fixture.call(checkpoints.getInput, { ...request(), taskId: "parent", dependencyTaskId: "child", includeManifest: true });
  await fixture.context().db.patch(checkpoint._id, { summary: "Unrelated mutable text" });
  await assert.rejects(read(), isCode("BLOCKED_CHECKPOINT")); await assert.rejects(tasks.dependenciesReady(fixture.context(), parent), isCode("BLOCKED_CHECKPOINT"));
  await fixture.context().db.patch(checkpoint._id, { summary: checkpoint.summary }); await fixture.context().db.patch(project._id, { capturePolicyDigest: "f".repeat(64) });
  await assert.rejects(read(), isCode("BLOCKED_CHECKPOINT")); await assert.rejects(tasks.dependenciesReady(fixture.context(), parent), isCode("BLOCKED_CHECKPOINT"));
  await fixture.context().db.patch(project._id, { capturePolicyDigest: project.capturePolicyDigest, allowedPaths: ["src/parent.ts"] });
  await assert.rejects(read(), isCode("FORBIDDEN")); await assert.rejects(tasks.dependenciesReady(fixture.context(), parent), isCode("FORBIDDEN"));
});
test("incomplete, foreign and merged inputs remain explicit and never become published code", async () => {
  const { fixture, propose } = await setup(); await propose("child"); await publishChild(fixture, "child", "ready"); await propose("parent", [{ taskId: "child", mode: "published", artifact: "ready" }]);
  const checkpoint = fixture.find("checkpoints", "ready");
  for (const patch of [{ state: "prepared" as const }, { projectId: "other_project" }, { taskId: "different_task" }]) {
    await fixture.context().db.patch(checkpoint._id, patch);
    const result = await fixture.call(checkpoints.getInput, { ...request(), taskId: "parent", dependencyTaskId: "child" }) as { availability: string; code: unknown }; assert.equal(result.availability, "unavailable"); assert.equal(result.code, null);
    await fixture.context().db.patch(checkpoint._id, { state: "ready", projectId: checkpoint.projectId, taskId: checkpoint.taskId });
  }
  await propose("merged_parent", [{ taskId: "child", mode: "merged", artifact: "ready" }]);
  const merged = await fixture.call(checkpoints.getInput, { ...request(), taskId: "merged_parent", dependencyTaskId: "child" }) as { availability: string; code: unknown }; assert.equal(merged.availability, "unverified_merge"); assert.equal(merged.code, null);
});
test("large accepted checkpoints retain existing getReady detail while added dependency metadata stays compact", async () => {
  const { fixture, propose } = await setup(); await propose("child"); await publishChild(fixture, "child", "large_ready", 600); await propose("parent", [{ taskId: "child", mode: "published", artifact: "large_ready" }]);
  const child = await fixture.call(checkpoints.getReady, { ...request(), taskId: "child", checkpointId: "large_ready" }) as { manifest: { files: unknown[] } }; assert.equal(child.manifest.files.length, 601); assert(Buffer.byteLength(JSON.stringify(child)) > 64 * 1024);
  const parent = await fixture.call(checkpoints.getReady, { ...request(), taskId: "parent" }) as { inputs: Array<{ code: Record<string, unknown> }> }; assert(Buffer.byteLength(JSON.stringify(parent.inputs)) < 64 * 1024); assert(!("manifest" in parent.inputs[0]!.code));
  const detail = await fixture.call(checkpoints.getInput, { ...request(), taskId: "parent", dependencyTaskId: "child", includeManifest: true }) as { code: { manifest: { files: unknown[] } } }; assert.equal(detail.code.manifest.files.length, 601); assert(Buffer.byteLength(JSON.stringify(detail)) < 600 * 1024);
});


async function acceptFixturePublication(fixture: BackendFixture, taskId: string, checkpointId: string) {
  const checkpoint = fixture.find("checkpoints", checkpointId), identity = { taskId, runId: `${taskId}_run`, epoch: 1, goalRevision: 1 }, publicationId = `${taskId}_publication`;
  await fixture.call(publications.request, { ...request(await digest(`synthetic-grant:${taskId}`)), ...identity, publicationId, checkpointId, targetBase: base.sha, verification: { head: checkpoint.commit, tree: checkpoint.tree, base: base.sha, commands: [{ argv: ["synthetic-verification"], exitCode: 0 }], environmentDigest: "fixture-only", recordedAt: new Date().toISOString() } });
  const publication = fixture.find("publications", publicationId);
  await fixture.call(publications.verifyBranch, { ...request(token.verifier), ...identity, publicationId, head: checkpoint.commit, tree: checkpoint.tree, parent: checkpoint.parent, parents: checkpoint.actualParents, branch: publication.branch, liveTargetBase: base.sha, evidenceRef: "synthetic-branch-readback" });
  await fixture.call(publications.verifyPR, { ...request(token.verifier), ...identity, publicationId, head: checkpoint.commit, tree: checkpoint.tree, liveTargetBase: base.sha, repository: "https://example.test/dependencies", headBranch: publication.branch, targetBaseRef: "main", prId: "fixture-pr", prUrl: "https://example.test/dependencies/pr/fixture", open: true, evidenceRef: "synthetic-pr-readback" });
  await fixture.call(publications.accept, { ...request(token.verifier), ...identity, publicationId, liveTargetBase: base.sha });
  return publicationId;
}
test("manual accepted publication remains review-ready when execution finalizes failed or stopped", async () => {
  for (const outcome of ["failed", "stopped"] as const) {
    const { fixture, propose } = await setup(); await propose("task"); await publishChild(fixture, "task", "ready"); const publicationId = await acceptFixturePublication(fixture, "task", "ready");
    const identity = { taskId: "task", runId: "task_run", epoch: 1, goalRevision: 1 }, grant = await digest("synthetic-grant:task");
    const status = await fixture.call(tasks.sessionStatus, { ...request(grant), ...identity }) as { taskState: string; resultAccepted: boolean; currentOwner: boolean };
    assert.equal(status.taskState, "review_ready"); assert.equal(status.resultAccepted, true); assert.equal(status.currentOwner, true);
    await assert.rejects(fixture.call(tasks.checkIn, { ...request(grant), ...identity }), isCode("LEASE_REVOKED"));
    await fixture.call(lifecycle.requestFinalization, { ...request(grant), ...identity, outcome, reason: "Execution ended after accepted result" });
    const task = fixture.find("tasks", "task"), run = fixture.find("runs", "task_run");
    assert.equal(task.state, "review_ready"); assert.equal(task.publicationId, publicationId); assert.equal(task.ownerRunId, undefined); assert.equal(run.resultAccepted, true); assert.equal(run.state, outcome); assert.equal(run.capacityHeld, false); assert.equal(run.stopEvidence, undefined);
    await assert.rejects(fixture.call(tasks.sessionStatus, { ...request(grant), ...identity }), isCode("UNAUTHORIZED"));
  }
});
test("managed accepted result survives failed finalization while capacity stays held until positive exit", async () => {
  const { fixture, propose } = await setup(); await propose("task"); await publishChild(fixture, "task", "ready", 0, "managed"); const publicationId = await acceptFixturePublication(fixture, "task", "ready");
  const identity = { taskId: "task", runId: "task_run", epoch: 1, goalRevision: 1 }, grant = await digest("synthetic-grant:task");
  await fixture.call(lifecycle.requestFinalization, { ...request(grant), ...identity, outcome: "failed", reason: "Shutdown failure after accepted result" });
  assert.equal(fixture.find("tasks", "task").state, "review_ready"); assert.equal(fixture.find("tasks", "task").publicationId, publicationId); assert.equal(fixture.find("runs", "task_run").capacityHeld, true);
  const status = await fixture.call(tasks.sessionStatus, { ...request(grant), ...identity }) as { taskState: string; runState: string; requestedOutcome?: string; resultAccepted: boolean };
  assert.equal(status.taskState, "review_ready"); assert.equal(status.runState, "finalizing"); assert.equal(status.requestedOutcome, "failed"); assert.equal(status.resultAccepted, true);
  const run = fixture.find("runs", "task_run"); await fixture.call(lifecycle.confirmStopped, { ...request(token.supervisor), ...identity, evidence: { kind: "observed_tree_exit", process: run.process!, launchId: run.launchId, machineId: run.machineId, observedAt: new Date().toISOString(), evidenceRef: "synthetic-owned-tree-exit" } });
  assert.equal(fixture.find("tasks", "task").state, "review_ready"); assert.equal(fixture.find("runs", "task_run").state, "failed"); assert.equal(fixture.find("runs", "task_run").capacityHeld, false);
});
test("session-status read is bound to current owner identity and never grants new lease or cross-run access", async () => {
  const { fixture, propose } = await setup(); await propose("first"); await propose("second"); await publishChild(fixture, "first", "first_ready"); await publishChild(fixture, "second", "second_ready");
  const grant = await digest("synthetic-grant:first"), identity = { taskId: "first", runId: "first_run", epoch: 1, goalRevision: 1 };
  const before = structuredClone(fixture.rows); const result = await fixture.call(tasks.sessionStatus, { ...request(grant), ...identity }) as Record<string, unknown>; assert.deepEqual(fixture.rows, before);
  assert.deepEqual(Object.keys(result).sort(), ["taskState", "runState", "resultAccepted", "requestedOutcome", "leaseUntil", "deadline", "currentOwner"].sort());
  await assert.rejects(fixture.call(tasks.sessionStatus, { ...request(grant), taskId: "second", runId: "second_run", epoch: 1, goalRevision: 1 }), isCode("FORBIDDEN"));
  await assert.rejects(fixture.call(tasks.sessionStatus, { ...request(grant), ...identity, epoch: 0 }), isCode("STALE_EPOCH"));
  for (const credential of Object.values(token)) await assert.rejects(fixture.call(tasks.sessionStatus, { ...request(credential), ...identity }), isCode("FORBIDDEN"));
  await fixture.context().db.patch(fixture.find("runs", "first_run")._id, { leaseUntil: 1 });
  const expired = await fixture.call(tasks.sessionStatus, { ...request(grant), ...identity }) as { leaseUntil: number }; assert.equal(expired.leaseUntil, 1);
  await assert.rejects(fixture.call(tasks.renew, { ...request(grant), ...identity }), isCode("LEASE_REVOKED"));
});

async function unacknowledgedLaunchFixture() {
  const { fixture, propose } = await setup(); await propose("task");
  const identity = { taskId: "task", runId: "unacknowledged_run", epoch: 1, goalRevision: 1 }, grant = "9".repeat(64), launchId = "unacknowledged_launch";
  await fixture.call(tasks.claim, { ...request(), ...identity, launchId, grantToken: grant, machineId: "machine", harness: "codex", capabilityKey: key });
  await fixture.call(lifecycle.starting, { ...request(grant), ...identity });
  const receipt = { schemaVersion: 1 as const, identity, launchId, machineId: "machine", workspace: "/fixture/worktrees/task-e1-unacknowledged", process: { pid: 321, bootId: "fixture-boot", startIdentity: "durable-before-authorization", launchId }, recordedAt: new Date(Date.now() - 1).toISOString() };
  return { fixture, identity, grant, receipt };
}
test("a durable pre-authorization receipt can settle only terminal exit after pause/revocation", async () => {
  const { fixture, identity, grant, receipt } = await unacknowledgedLaunchFixture();
  await fixture.call(goals.control, { ...request(token.human), goalId: "goal", state: "paused" });
  await assert.rejects(fixture.call(lifecycle.authorizeLaunch, { ...request(token.supervisor), ...identity, process: receipt.process }), isCode("LEASE_REVOKED"));
  const evidence = { kind: "observed_tree_exit" as const, launchId: receipt.launchId, machineId: receipt.machineId, process: receipt.process, observedAt: new Date().toISOString(), evidenceRef: "synthetic-positive-owned-tree-exit" };
  await assert.rejects(fixture.call(lifecycle.confirmStopped, { ...request(token.supervisor), ...identity, evidence }), isCode("LAUNCH_UNCERTAIN"));
  const stop = { ...request(token.supervisor), ...identity, evidence, launchReceipt: receipt };
  const first = await fixture.call(lifecycle.confirmStopped, stop), settled = structuredClone(fixture.rows);
  assert.deepEqual(await fixture.call(lifecycle.confirmStopped, stop), first); assert.deepEqual(fixture.rows, settled);
  const run = fixture.find("runs", identity.runId), task = fixture.find("tasks", "task");
  assert.equal(run.state, "stopped"); assert.equal(run.capacityHeld, false); assert.deepEqual(run.process, receipt.process); assert.deepEqual(run.stopEvidence, evidence); assert.equal(run.processReceiptHash, await digest(canonical(receipt)));
  assert.equal(task.state, "blocked"); assert.equal(task.reason, "goal_paused"); assert.equal(task.dispatchHeld, true); assert.equal(task.ownerRunId, undefined); assert.equal(task.epoch, 1); assert.equal(fixture.find("goals", "goal").state, "paused");
  assert(!JSON.stringify([...fixture.rows.values()]).includes(receipt.workspace));
  await assert.rejects(fixture.call(tasks.renew, { ...request(grant), ...identity }), isCode("UNAUTHORIZED"));
  for (const changed of [{ ...receipt, workspace: "/fixture/different-workspace" }, { ...receipt, recordedAt: new Date(Date.parse(receipt.recordedAt) - 1).toISOString() }]) {
    await assert.rejects(fixture.call(lifecycle.confirmStopped, { ...stop, requestId: `changed_receipt_${++serial}`, launchReceipt: changed }), isCode("LAUNCH_UNCERTAIN"));
  }
  await assert.rejects(fixture.call(lifecycle.confirmStopped, { ...stop, launchReceipt: { ...receipt, workspace: "/fixture/changed-same-request" } }), isCode("IDEMPOTENCY_CONFLICT"));
});
test("terminal receipt identity, future timestamps and never-started contradictions cannot release a reservation", async () => {
  const { fixture, identity, receipt } = await unacknowledgedLaunchFixture();
  const evidence = { kind: "observed_tree_exit" as const, launchId: receipt.launchId, machineId: receipt.machineId, process: receipt.process, observedAt: new Date().toISOString(), evidenceRef: "synthetic-exit" };
  for (const launchReceipt of [{ ...receipt, schemaVersion: 2 }, { ...receipt, identity: { ...identity, runId: "other_run" } }, { ...receipt, identity: { ...identity, epoch: 2 } }, { ...receipt, machineId: "other_machine" }, { ...receipt, launchId: "other_launch" }, { ...receipt, process: { ...receipt.process, launchId: "other_launch" } }, { ...receipt, process: { ...receipt.process, pid: 0 } }, { ...receipt, workspace: "relative-workspace" }, { ...receipt, recordedAt: new Date(Date.now() + 60_000).toISOString() }]) {
    const before = structuredClone(fixture.rows); await assert.rejects(fixture.call(lifecycle.confirmStopped, { ...request(token.supervisor), ...identity, evidence, launchReceipt }), isCode("INVALID_INPUT")); assert.deepEqual(fixture.rows, before);
  }
  await assert.rejects(fixture.call(lifecycle.confirmStopped, { ...request(token.supervisor), ...identity, launchReceipt: receipt, evidence: { ...evidence, kind: "proven_never_started" } }), isCode("LAUNCH_UNCERTAIN"));
  await fixture.context().db.patch(fixture.find("runs", identity.runId)._id, { state: "running" });
  await assert.rejects(fixture.call(lifecycle.confirmStopped, { ...request(token.supervisor), ...identity, evidence, launchReceipt: receipt }), isCode("LAUNCH_UNCERTAIN"));
  assert.equal(fixture.find("runs", identity.runId).capacityHeld, true); assert.equal(fixture.find("runs", identity.runId).process, undefined);
});
test("registered process identity and durable receipt must match even with positive stop evidence", async () => {
  const { fixture, identity, grant, receipt } = await unacknowledgedLaunchFixture();
  await fixture.call(lifecycle.authorizeLaunch, { ...request(token.supervisor), ...identity, process: receipt.process });
  const changed = { ...receipt, process: { ...receipt.process, startIdentity: "different-start" } };
  await assert.rejects(fixture.call(lifecycle.confirmStopped, { ...request(token.supervisor), ...identity, launchReceipt: changed, evidence: { kind: "observed_tree_exit", launchId: receipt.launchId, machineId: receipt.machineId, process: changed.process, observedAt: new Date().toISOString(), evidenceRef: "wrong-process-exit" } }), isCode("LAUNCH_UNCERTAIN"));
  assert.equal(fixture.find("runs", identity.runId).capacityHeld, true);
  const stop = { ...request(token.supervisor), ...identity, launchReceipt: receipt, evidence: { kind: "observed_tree_exit" as const, launchId: receipt.launchId, machineId: receipt.machineId, process: receipt.process, observedAt: new Date().toISOString(), evidenceRef: "matching-process-exit" } };
  await fixture.call(lifecycle.confirmStopped, stop); assert.equal(fixture.find("runs", identity.runId).capacityHeld, false);
  await assert.rejects(fixture.call(tasks.renew, { ...request(grant), ...identity }), isCode("UNAUTHORIZED"));
});
test("receipt-only verified reboot settles the old boot without authorizing execution", async () => {
  const { fixture, identity, receipt } = await unacknowledgedLaunchFixture();
  const evidence = { kind: "verified_reboot" as const, launchId: receipt.launchId, machineId: receipt.machineId, process: { ...receipt.process, bootId: "verified-new-boot" }, observedAt: new Date().toISOString(), evidenceRef: "synthetic-positive-reboot-proof" };
  await fixture.call(lifecycle.confirmStopped, { ...request(token.supervisor), ...identity, evidence, launchReceipt: receipt });
  const run = fixture.find("runs", identity.runId); assert.deepEqual(run.process, receipt.process); assert.equal(run.state, "stopped"); assert.equal(run.capacityHeld, false); assert.equal(fixture.find("tasks", "task").state, "blocked");
});

test("terminal receipt binding survives supervisor rotation and excludes local-only receipt fields", async () => {
  const definition = lifecycle.confirmStopped as unknown as { exportArgs(): string };
  const schema = JSON.parse(definition.exportArgs()) as { value: { launchReceipt: { fieldType: { value: Record<string, unknown> } } } };
  assert.deepEqual(Object.keys(schema.value.launchReceipt.fieldType.value).sort(), ["schemaVersion", "identity", "launchId", "machineId", "workspace", "process", "recordedAt"].sort());
  const { fixture, identity, receipt } = await unacknowledgedLaunchFixture();
  const evidence = { kind: "observed_tree_exit" as const, launchId: receipt.launchId, machineId: receipt.machineId, process: receipt.process, observedAt: new Date().toISOString(), evidenceRef: "synthetic-rotation-proof" };
  const first = await fixture.call(lifecycle.confirmStopped, { ...request(token.supervisor), ...identity, evidence, launchReceipt: receipt });
  const credential = "5".repeat(64); await fixture.context().db.insert("credentials", { id: "rotated_supervisor", backendId: "backend", memberId: "agent", digest: await digest(credential), role: "supervisor", projectIds: ["project"], machineId: "machine", expiresAt: Date.now() + 60_000 });
  const run = fixture.find("runs", identity.runId), task = fixture.find("tasks", "task");
  assert.deepEqual(await fixture.call(lifecycle.confirmStopped, { ...request(credential), ...identity, evidence, launchReceipt: receipt }), first); assert.deepEqual(fixture.find("runs", identity.runId), run); assert.deepEqual(fixture.find("tasks", "task"), task);
  await assert.rejects(fixture.call(lifecycle.confirmStopped, { ...request(credential), ...identity, evidence, launchReceipt: { ...receipt, workspace: "/fixture/changed-after-rotation" } }), isCode("LAUNCH_UNCERTAIN"));
});

test("policy drift leaves a missing dependency pin open until a current valid latest artifact exists", async () => {
  const { fixture, propose, candidates } = await setup(); await propose("child"); await propose("parent", [{ taskId: "child", mode: "published" }]); await publishChild(fixture, "child", "policy_a");
  await propose("explicit_parent", [{ taskId: "child", mode: "published", artifact: "policy_a" }]);
  // Controlled policy drift only; these are synthetic records, not a real qualification/migration.
  await fixture.context().db.patch(fixture.find("projects", "project")._id, { capturePolicyDigest: "e".repeat(64) });
  const pending = fixture.find("tasks", "parent"), explicit = fixture.find("tasks", "explicit_parent");
  const invalid = await fixture.call(tasks.refreshDependencies, request()) as { changed: unknown[] }; assert.deepEqual(invalid.changed, []); assert.deepEqual(fixture.find("tasks", "parent"), pending); assert.equal(fixture.find("tasks", "parent").dependencies[0]?.artifact, undefined);
  await publishChild(fixture, "child", "policy_b"); await fixture.call(tasks.refreshDependencies, request());
  assert.equal(fixture.find("tasks", "parent").dependencies[0]?.artifact, "policy_b"); assert.deepEqual(fixture.find("tasks", "explicit_parent"), explicit); assert.deepEqual((await candidates()).map(candidate => candidate.taskId), ["parent"]);
});
