import test from "node:test";
import assert from "node:assert/strict";
import { BackendFixture } from "./backend.fixture.js";
import { bootstrap, canonical, digest } from "../convex/auth.js";
import { authority } from "../convex/checkpoints.js";
import * as projects from "../convex/projects.js";
import * as goals from "../convex/goals.js";
import * as machines from "../convex/machines.js";
import * as tasks from "../convex/tasks.js";
import * as lifecycle from "../convex/lifecycle.js";
import * as memories from "../convex/memories.js";
import { CAPABILITIES, CLIENT_VERSION, REQUIRED_CHECKS } from "../src/protocol.js";

// Synthetic tokens/evidence exercise exported handler guards only. No host or live qualification.
const tokens = { human: "1".repeat(64), agent: "2".repeat(64), supervisor: "3".repeat(64), verifier: "4".repeat(64), run: "5".repeat(64) };
const key = { os: "fixture", harness: "codex" as const, harnessVersion: "fixture", adapterVersion: "1", probeVersion: "1", configurationDigest: "fixture-config", gitPolicyDigest: "fixture-policy" };
const executionBase = { sha: "a".repeat(40), revision: 1, remoteRef: "refs/heads/main" };
const policyDigest = "b".repeat(64);
const progress = '{"completed":["fixture capture"],"next":"verify exact tree","remaining":["fixture publication"]}';
let serial = 0;
const request = (token: string) => ({ token, protocolVersion: 1, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], backendId: "backend", projectId: "project", requestId: `command_${++serial}` });
const identity = (token: string) => ({ ...request(token), taskId: "task", runId: "run", epoch: 1, goalRevision: 1 });
function isCode(code: string) { return (error: unknown) => typeof error === "object" && error !== null && "data" in error && (error.data as { code?: string }).code === code; }

async function authorityFixture(start = true) {
  const fixture = new BackendFixture();
  await fixture.call(bootstrap, { backendId: "backend", projectId: "project", repository: "https://example.test/fixture", remote: "origin", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: [], humanId: "human", humanDigest: await digest(tokens.human), agentId: "agent", agentDigest: await digest(tokens.agent), expiresAt: Date.now() + 3600_000 });
  await fixture.call(projects.configure, { ...request(tokens.human), repository: "https://example.test/fixture", remote: "origin", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: [], sharingApproved: true, capturePolicyDigest: policyDigest, capacity: 2, taskCap: 20 });
  const goal = await fixture.call(goals.propose, { ...request(tokens.agent), goalId: "goal", expectedRevision: 0, content: "Fixture command authority", taskLimit: 20, runTimeoutMs: 1800_000 }) as { hash: string; revision: number };
  await fixture.call(goals.approve, { ...request(tokens.human), goalId: "goal", revision: goal.revision, hash: goal.hash });
  await fixture.call(machines.provisionQualification, { backendId: "backend", projectId: "project", memberId: "agent", machineId: "machine", capacity: 1, modes: ["managed"], key, checks: REQUIRED_CHECKS.managed.map(checkId => ({ schemaVersion: 1 as const, checkId, status: "PASS" as const, mode: "managed" as const, observedAt: new Date(Date.now() - 1000).toISOString(), configurationDigest: key.configurationDigest, command: ["fixture-only"], summary: "Synthetic guard input, no real check ran", evidenceRef: "fixture-only", kind: "real" as const })), evidenceRef: "fixture-only", expiresAt: Date.now() + 1800_000, supervisorId: "supervisor", supervisorToken: tokens.supervisor, artifactVerifierId: "verifier", artifactVerifierToken: tokens.verifier });
  await fixture.call(tasks.propose, { ...request(tokens.agent), taskId: "task", goalId: "goal", goalRevision: 1, title: "Fixture capture", scope: ["src/feature"], dependencies: [], executionBase });
  await fixture.call(tasks.claim, { ...request(tokens.agent), taskId: "task", runId: "run", launchId: "launch", grantToken: tokens.run, machineId: "machine", harness: "codex", capabilityKey: key });
  if (start) {
    await fixture.call(lifecycle.starting, identity(tokens.run));
    await fixture.call(lifecycle.authorizeLaunch, { ...identity(tokens.supervisor), process: { pid: 100, bootId: "fixture-boot", startIdentity: "fixture-start", launchId: "launch" } });
    await fixture.call(tasks.progress, { ...identity(tokens.run), expectedRevision: 0, progress });
  }
  return fixture;
}

test("reserved and starting runs can read startup rules without gaining implementation write authority", async () => {
  const fixture = await authorityFixture(false);
  for (const state of ["reserved", "starting"] as const) {
    if (state === "starting") await fixture.call(lifecycle.starting, identity(tokens.run));
    const before = structuredClone(fixture.rows);
    const result = await fixture.call(memories.rules, identity(tokens.run)) as { rules: unknown[]; complete: boolean };
    assert.equal(result.complete, true); assert.deepEqual(result.rules, []); assert.deepEqual(fixture.rows, before);
    await assert.rejects(fixture.call(tasks.progress, { ...identity(tokens.run), expectedRevision: 0, progress: "not executing yet" }), isCode("LEASE_REVOKED"));
    await assert.rejects(fixture.call(memories.rules, identity(tokens.agent)), isCode("FORBIDDEN"));
  }
  await fixture.context().db.patch(fixture.find("credentials", "grant_run")._id, { revokedAt: Date.now() });
  await assert.rejects(fixture.call(memories.rules, identity(tokens.run)), isCode("UNAUTHORIZED"));
});

test("capture authority gives the independently scoped verifier exact current progress without worker secrets", async () => {
  const fixture = await authorityFixture(), before = structuredClone(fixture.rows);
  const expected = { identity: { taskId: "task", runId: "run", epoch: 1, goalRevision: 1 }, executionBase, progressRevision: 1, progressHash: await digest(canonical(JSON.parse(progress))), policyDigest, progress, taskState: "running", runMode: "managed", conflictBlocked: false };
  for (const token of [tokens.verifier, tokens.human, tokens.run]) assert.deepEqual(await fixture.call(authority, identity(token)), expected);
  assert.deepEqual(fixture.rows, before);
  const serialized = JSON.stringify(expected);
  for (const token of Object.values(tokens)) assert(!serialized.includes(token));
  assert(!serialized.includes("grantId")); assert(!serialized.includes("credentialId"));
});
test("runtime qualification reads owner records without allowing local claims or other identities", async () => {
  const fixture = await authorityFixture(), before = structuredClone(fixture.rows);
  for (const token of [tokens.agent, tokens.human, tokens.supervisor, tokens.verifier]) {
    const value = await fixture.call(machines.runtime, { ...request(token), machineId: "machine" }) as { machineId: string; memberId: string; capabilityKey: typeof key; capabilityChecks: unknown[] };
    assert.equal(value.machineId, "machine"); assert.equal(value.memberId, "agent"); assert.deepEqual(value.capabilityKey, key);
    assert(value.capabilityChecks.length > 0);
    const serialized = JSON.stringify(value); for (const secret of Object.values(tokens)) assert(!serialized.includes(secret));
    assert(!serialized.includes('"token"')); assert(!serialized.includes('"digest"'));
  }
  assert.deepEqual(fixture.rows, before);
  await assert.rejects(fixture.call(machines.runtime, { ...request(tokens.run), machineId: "machine" }), isCode("FORBIDDEN"));
  await assert.rejects(fixture.call(machines.runtime, { ...request(tokens.agent), machineId: "missing" }), isCode("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION"));
  const machine = [...fixture.rows.values()].find(row => row._table === "machines")!;
  await fixture.context().db.patch(machine._id as never, { memberId: "another_member" });
  for (const token of [tokens.agent, tokens.supervisor, tokens.verifier]) await assert.rejects(fixture.call(machines.runtime, { ...request(token), machineId: "machine" }), isCode("FORBIDDEN"));
  await fixture.call(machines.runtime, { ...request(tokens.human), machineId: "machine" });
});

test("capture authority rejects project agents, lifecycle supervisors, and verifiers on another machine/member", async () => {
  const fixture = await authorityFixture();
  for (const token of [tokens.agent, tokens.supervisor]) await assert.rejects(fixture.call(authority, identity(token)), isCode("FORBIDDEN"));
  const verifier = fixture.find("credentials", "verifier");
  await fixture.context().db.patch(verifier._id, { machineId: "other_machine" });
  await assert.rejects(fixture.call(authority, identity(tokens.verifier)), isCode("FORBIDDEN"));
  await fixture.context().db.patch(verifier._id, { machineId: "machine", memberId: "other_member" });
  await assert.rejects(fixture.call(authority, identity(tokens.verifier)), isCode("FORBIDDEN"));
});

test("verifier capture reads reject stale epochs, leases, revoked grants and replanning runs", async () => {
  const fixture = await authorityFixture();
  await assert.rejects(fixture.call(authority, { ...identity(tokens.verifier), epoch: 0 }), isCode("STALE_EPOCH"));
  const run = fixture.find("runs", "run");
  await fixture.context().db.patch(run._id, { leaseUntil: 1 });
  await assert.rejects(fixture.call(authority, identity(tokens.verifier)), isCode("LEASE_REVOKED"));
  await fixture.context().db.patch(run._id, { leaseUntil: run.leaseUntil, mode: "replan" });
  await assert.rejects(fixture.call(authority, identity(tokens.verifier)), isCode("FORBIDDEN"));
  await fixture.context().db.patch(run._id, { mode: "managed" });
  await fixture.context().db.patch(fixture.find("credentials", "grant_run")._id, { revokedAt: Date.now() });
  await assert.rejects(fixture.call(authority, identity(tokens.verifier)), isCode("LEASE_REVOKED"));
});

test("verifier capture reads retain current goal, sharing, scope and configuration guards", async () => {
  for (const patch of [{ sharingApproved: false }, { allowedPaths: ["other"] }, { configVersion: 999 }]) {
    const fixture = await authorityFixture(); await fixture.context().db.patch(fixture.find("projects", "project")._id, patch);
    await assert.rejects(fixture.call(authority, identity(tokens.verifier)), isCode(patch.configVersion ? "UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION" : "FORBIDDEN"));
  }
  const fixture = await authorityFixture(); await fixture.context().db.patch(fixture.find("goals", "goal")._id, { state: "paused" });
  await assert.rejects(fixture.call(authority, identity(tokens.verifier)), isCode("GOAL_NOT_APPROVED"));
});

test("worker reads report conflicts while independent verifier reads remain blocked by unresolved decisions", async () => {
  const fixture = await authorityFixture();
  await fixture.context().db.insert("messages", { id: "conflict", projectId: "project", senderTaskId: "task", senderEpoch: 1, recipientTaskId: "task", recipientEpoch: 1, type: "fixture-conflict", payload: "Unresolved interface decision", state: "queued", conflict: true, attempts: 0 });
  const worker = await fixture.call(authority, identity(tokens.run)) as { conflictBlocked: boolean }; assert.equal(worker.conflictBlocked, true);
  await assert.rejects(fixture.call(authority, identity(tokens.verifier)), isCode("CONFLICT_UNRESOLVED"));
});

test("supervisor status reads factual finalization after worker revocation without changing authority", async () => {
  const fixture = await authorityFixture(), run = fixture.find("runs", "run");
  await fixture.context().db.patch(run._id, { state: "finalizing", resultAccepted: true, requestedOutcome: "succeeded" });
  await fixture.context().db.patch(fixture.find("tasks", "task")._id, { state: "review_ready" });
  await fixture.context().db.patch(fixture.find("credentials", "grant_run")._id, { revokedAt: Date.now() });
  const before = structuredClone(fixture.rows);
  const expected = { taskState: "review_ready", runState: "finalizing", resultAccepted: true, requestedOutcome: "succeeded", leaseUntil: run.leaseUntil, deadline: run.deadline, capacityHeld: true, releaseReceipt: undefined, process: run.process };
  assert.deepEqual(await fixture.call(lifecycle.status, identity(tokens.supervisor)), expected);
  assert.deepEqual(fixture.rows, before);
  const serialized = JSON.stringify(expected); for (const token of Object.values(tokens)) assert(!serialized.includes(token));
  assert(!serialized.includes("grantId")); assert(!serialized.includes("digest"));
  for (const token of [tokens.human, tokens.agent, tokens.verifier]) await assert.rejects(fixture.call(lifecycle.status, identity(token)), isCode("FORBIDDEN"));
  await assert.rejects(fixture.call(lifecycle.status, identity(tokens.run)), isCode("UNAUTHORIZED"));
});

test("supervisor status rejects another machine, member, project or mismatched run identity", async () => {
  const fixture = await authorityFixture();
  await assert.rejects(fixture.call(lifecycle.status, { ...identity(tokens.supervisor), projectId: "other_project" }), isCode("UNAUTHORIZED"));
  await assert.rejects(fixture.call(lifecycle.status, { ...identity(tokens.supervisor), backendId: "other_backend" }), isCode("UNAUTHORIZED"));
  await assert.rejects(fixture.call(lifecycle.status, { ...identity(tokens.supervisor), taskId: "other_task" }), isCode("NOT_FOUND"));
  await assert.rejects(fixture.call(lifecycle.status, { ...identity(tokens.supervisor), epoch: 2 }), isCode("NOT_FOUND"));
  await assert.rejects(fixture.call(lifecycle.status, { ...identity(tokens.supervisor), goalRevision: 2 }), isCode("NOT_FOUND"));
  const supervisor = fixture.find("credentials", "supervisor");
  await fixture.context().db.patch(supervisor._id, { machineId: "other_machine" });
  await assert.rejects(fixture.call(lifecycle.status, identity(tokens.supervisor)), isCode("FORBIDDEN"));
  await fixture.context().db.patch(supervisor._id, { machineId: "machine", memberId: "other_member" });
  await assert.rejects(fixture.call(lifecycle.status, identity(tokens.supervisor)), isCode("FORBIDDEN"));
});

test("reading and settling an old supervised run cannot revive or release the newer task epoch", async () => {
  const fixture = await authorityFixture(), old = fixture.find("runs", "run");
  const { _id: _id, _creationTime: _created, ...runData } = old;
  await fixture.context().db.insert("runs", { ...runData, id: "new_run", grantId: "new_grant", epoch: 2, launchId: "new_launch", process: { pid: 200, bootId: "fixture-boot", startIdentity: "new-start", launchId: "new_launch" } });
  await fixture.context().db.patch(fixture.find("tasks", "task")._id, { epoch: 2, ownerRunId: "new_run", state: "running" });
  await fixture.context().db.patch(old._id, { state: "finalizing", requestedOutcome: "stopped", leaseUntil: 1 });
  await fixture.context().db.patch(fixture.find("credentials", "grant_run")._id, { revokedAt: Date.now() });
  const newerTask = fixture.find("tasks", "task"), newerRun = fixture.find("runs", "new_run"), before = structuredClone(fixture.rows);
  const status = await fixture.call(lifecycle.status, identity(tokens.supervisor)) as { runState: string; leaseUntil: number; capacityHeld: boolean };
  assert.equal(status.runState, "finalizing"); assert.equal(status.leaseUntil, 1); assert.equal(status.capacityHeld, true); assert.deepEqual(fixture.rows, before);
  await fixture.call(lifecycle.confirmStopped, { ...identity(tokens.supervisor), evidence: { kind: "observed_tree_exit", launchId: old.launchId, machineId: old.machineId, process: old.process!, observedAt: new Date().toISOString(), evidenceRef: "old-run-fixture-exit" } });
  assert.deepEqual(fixture.find("tasks", "task"), newerTask); assert.deepEqual(fixture.find("runs", "new_run"), newerRun);
  const settled = await fixture.call(lifecycle.status, identity(tokens.supervisor)) as { runState: string; capacityHeld: boolean; releaseReceipt: string };
  assert.equal(settled.runState, "stopped"); assert.equal(settled.capacityHeld, false); assert.equal(settled.releaseReceipt, "release_run");
});

test("project rules can be read before any claim with the exact approved projection and no mutation", async () => {
  const fresh = new BackendFixture();
  await fresh.call(bootstrap, { backendId: "backend", projectId: "project", repository: "https://example.test/preclaim", remote: "origin", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: ["AGENTS.md"], humanId: "human", humanDigest: await digest(tokens.human), agentId: "agent", agentDigest: await digest(tokens.agent), expiresAt: Date.now() + 3600_000 });
  const untouched = structuredClone(fresh.rows);
  const preclaim = await fresh.call(memories.projectRules, request(tokens.agent)) as { complete: boolean; rules: unknown[]; ruleTargets: string[]; policyVersion: number; bytes: number };
  assert.equal(preclaim.complete, true); assert.deepEqual(preclaim.rules, []); assert.deepEqual(preclaim.ruleTargets, ["AGENTS.md"]); assert.equal(preclaim.policyVersion, 1); assert(preclaim.bytes <= 12 * 1024); assert.deepEqual(fresh.rows, untouched); assert.equal([...fresh.rows.values()].some(row => row._table === "runs"), false);
  const fixture = await authorityFixture(false), content = "Use descriptive control labels", sources = [{ taskId: "task", revision: "fixture", evidenceRef: "synthetic-guidance" }];
  const hash = await digest(canonical({ kind: "rule", content, sources, applicability: ["src"], confidence: "reviewed" }));
  const memory = { id: "approved_rule", projectId: "project", kind: "rule" as const, content, revision: 1, hash, sources, applicability: ["src"], confidence: "reviewed", status: "proposed" as const };
  await fixture.context().db.insert("memories", memory);
  await fixture.call(memories.approveRule, { ...request(tokens.human), memoryId: memory.id, revision: 1, hash });
  await fixture.context().db.insert("memories", { ...memory, id: "ordinary_lesson", kind: "lesson", status: "active" });
  await fixture.context().db.insert("memories", { ...memory, id: "proposed_rule" });
  await fixture.context().db.insert("memories", { ...memory, id: "unapproved_active", status: "active" });
  await fixture.context().db.insert("memories", { ...memory, id: "wrong_hash", status: "active", approvedBy: "human", approvedHash: "mismatch" });
  await fixture.context().db.insert("memories", { ...memory, id: "other_project", projectId: "different_project", status: "active", approvedBy: "human", approvedHash: hash });
  const before = structuredClone(fixture.rows), run = await fixture.call(memories.rules, identity(tokens.run));
  assert.deepEqual(await fixture.call(memories.projectRules, request(tokens.agent)), run); assert.deepEqual(await fixture.call(memories.projectRules, request(tokens.human)), run);
  const projection = run as { rules: Array<{ id: string }>; complete: boolean }; assert.deepEqual(projection.rules.map(rule => rule.id), ["approved_rule"]); assert.equal(projection.complete, true); assert.deepEqual(fixture.rows, before);
});
test("project rules retain project/role/revocation boundaries and explicit incomplete byte coverage", async () => {
  const fixture = await authorityFixture(false);
  for (const credential of [tokens.run, tokens.supervisor, tokens.verifier]) await assert.rejects(fixture.call(memories.projectRules, request(credential)), isCode("FORBIDDEN"));
  await assert.rejects(fixture.call(memories.projectRules, { ...request(tokens.agent), projectId: "different_project" }), isCode("UNAUTHORIZED"));
  await assert.rejects(fixture.call(memories.projectRules, { ...request(tokens.agent), backendId: "different_backend" }), isCode("UNAUTHORIZED"));
  for (let index = 0; index < 5; index++) await fixture.context().db.insert("memories", { id: `large_rule_${index}`, projectId: "project", kind: "rule", content: "x".repeat(4096), revision: 1, hash: "a".repeat(64), sources: [], applicability: ["src"], confidence: "synthetic-legacy-rule-set", status: "active", approvedBy: "human", approvedHash: "a".repeat(64) });
  const before = structuredClone(fixture.rows), projection = await fixture.call(memories.projectRules, request(tokens.agent)) as { complete: boolean; bytes: number; rules: unknown[] };
  assert.equal(projection.complete, false); assert(projection.bytes <= 12 * 1024); assert(projection.rules.length < 5); assert.deepEqual(fixture.rows, before);
  await fixture.context().db.patch(fixture.find("credentials", "agent")._id, { revokedAt: Date.now() });
  await assert.rejects(fixture.call(memories.projectRules, request(tokens.agent)), isCode("UNAUTHORIZED"));
});

// A4 retrieval: the task's declared scope is ["src/feature"]. This asserts the requirement
// (relevant lessons reached, unrelated history excluded) by following nextCursor the way the
// Coord skill instructs an agent to, so it holds whatever page size memories.context uses.
test("A4 relevant lessons are reachable by scope while unrelated history stays excluded", async () => {
  const fixture = await authorityFixture();
  const sources = [{ taskId: "task", revision: "fixture", evidenceRef: "synthetic-lesson" }];
  const base = { projectId: "project", kind: "lesson" as const, revision: 1, hash: "c".repeat(64), sources, confidence: "observed", status: "active" as const };
  const rows = [
    { id: "exact_scope", applicability: ["src/feature"], content: "Focus ring must survive the CSS reset" },
    { id: "parent_scope", applicability: ["src"], content: "Every control needs a descriptive label" },
    { id: "child_scope", applicability: ["src/feature/button"], content: "Buttons need an accessible name" },
    { id: "unrelated_path", applicability: ["docs"], content: "Unrelated history must not be retrieved" },
    { id: "prefix_without_separator", applicability: ["srcfeature"], content: "A bare prefix is not a path overlap" },
    { id: "not_yet_active", applicability: ["src/feature"], content: "Proposed records are not retrievable", status: "proposed" as const },
  ];
  for (const row of rows) await fixture.context().db.insert("memories", { ...base, ...row });

  const before = structuredClone(fixture.rows);
  const seen: string[] = [];
  let cursor: string | undefined, pages = 0, finalComplete = false;
  for (;;) {
    const page = await fixture.call(memories.context, { ...identity(tokens.run), ...(cursor ? { cursor } : {}) }) as
      { memories: Array<{ id: string; untrusted: boolean }>; tasks: unknown[]; nextCursor: string | null; complete: boolean };
    pages++;
    assert(pages <= 50, "context pagination must terminate");
    for (const memory of page.memories) { seen.push(memory.id); assert.equal(memory.untrusted, true, "a lesson is source data, never authoritative policy"); }
    if (!page.nextCursor) { finalComplete = page.complete; break; }
    cursor = page.nextCursor;
  }

  assert.equal(finalComplete, true, "exhausted retrieval must report complete coverage");
  assert.deepEqual(seen.slice().sort(), ["child_scope", "exact_scope", "parent_scope"]);
  assert.deepEqual(fixture.rows, before, "retrieval must not mutate backend state");
  await assert.rejects(fixture.call(memories.context, identity(tokens.agent)), isCode("FORBIDDEN"));
});
