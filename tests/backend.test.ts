import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { BackendFixture } from "./backend.fixture.js";
import { bootstrap, digest } from "../convex/auth.js";
import * as projects from "../convex/projects.js";
import * as goals from "../convex/goals.js";
import * as tasks from "../convex/tasks.js";
import * as machines from "../convex/machines.js";
import * as lifecycle from "../convex/lifecycle.js";
import { CAPABILITIES, CLIENT_VERSION, REQUIRED_CHECKS } from "../src/protocol.js";
const key = { os: "fixture", harness: "codex" as const, harnessVersion: "fixture-1", adapterVersion: "1", probeVersion: "1", configurationDigest: "fake-canary-config", gitPolicyDigest: "fake-canary-policy" };
const humanToken = randomBytes(32).toString("hex"), agentToken = randomBytes(32).toString("hex"), supervisorToken = randomBytes(32).toString("hex"), artifactVerifierToken = randomBytes(32).toString("hex");
let serial = 0;
const request = (token = agentToken) => ({ token, protocolVersion: 1, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], backendId: "backend", projectId: "project", requestId: `request_${++serial}` });
async function setup() {
  const fixture = new BackendFixture();
  await fixture.call(bootstrap, { backendId: "backend", projectId: "project", repository: "https://example.test/repository", remote: "origin", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: ["src/secrets"], ruleTargets: ["AGENTS.md"], humanId: "human", humanDigest: await digest(humanToken), agentId: "agent", agentDigest: await digest(agentToken), expiresAt: Date.now() + 86400_000 });
  await fixture.call(projects.configure, { ...request(humanToken), repository: "https://example.test/repository", remote: "origin", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: ["src/secrets"], ruleTargets: ["AGENTS.md"], sharingApproved: true, capturePolicyDigest: "d".repeat(64), capacity: 2, taskCap: 20 });
  const draft = await fixture.call(goals.propose, { ...request(), goalId: "goal", expectedRevision: 0, content: "Implement fixture task", taskLimit: 20, runTimeoutMs: 1800_000 }) as { revision: number; hash: string };
  await fixture.call(goals.approve, { ...request(humanToken), goalId: "goal", revision: draft.revision, hash: draft.hash });
  // Synthetic records are deliberately injected through the internal owner-only provisioner.
  // Their 'real' label exercises backend guards; it is NOT evidence these host checks ran.
  await fixture.call(machines.provisionQualification, { backendId: "backend", projectId: "project", memberId: "agent", machineId: "machine", capacity: 1, modes: ["manual", "managed"], key, checks: REQUIRED_CHECKS.managed.map(checkId => ({ schemaVersion: 1 as const, checkId, status: "PASS" as const, mode: "managed" as const, observedAt: new Date(Date.now() - 1000).toISOString(), configurationDigest: key.configurationDigest, command: ["fixture"], summary: "Synthetic guard fixture only", evidenceRef: "fixture-only", kind: "real" as const })), evidenceRef: "fixture-only", expiresAt: Date.now() + 3600_000, supervisorId: "supervisor", supervisorToken, artifactVerifierId: "artifact_verifier", artifactVerifierToken });
  const propose = async (taskId = "task", scope = ["src/work.ts"]) => fixture.call(tasks.propose, { ...request(), taskId, goalId: "goal", goalRevision: 1, title: "Fixture task", scope, dependencies: [], executionBase: { sha: "a".repeat(40), revision: 1, remoteRef: "refs/heads/main" } });
  await propose();
  return { fixture, propose };
}
function claim(taskId = "task", runId = "run", token = randomBytes(32).toString("hex")) { return { ...request(), taskId, runId, launchId: `launch_${runId}`, grantToken: token, machineId: "machine", harness: "codex" as const, capabilityKey: key }; }
function identity(c: ReturnType<typeof claim>, epoch = 1) { return { ...request(c.grantToken), taskId: c.taskId, runId: c.runId, epoch, goalRevision: 1 }; }
function isCode(code: string) { return (error: unknown) => typeof error === "object" && error !== null && "data" in error && (error.data as { code: string }).code === code; }

test("T1 exact human approval and routing roles; only digests persist", async () => {
  const { fixture } = await setup();
  assert.equal(fixture.find("credentials", "agent").digest, await digest(agentToken));
  assert(!JSON.stringify([...fixture.rows.values()]).includes(agentToken));
  await assert.rejects(fixture.call(goals.approve, { ...request(), goalId: "goal", revision: 1, hash: fixture.find("goals", "goal").hash }), isCode("FORBIDDEN"));
  await assert.rejects(fixture.call(tasks.claim, { ...claim(), projectId: "other" }), isCode("UNAUTHORIZED"));
  const draft = await fixture.call(goals.propose, { ...request(), goalId: "draft", expectedRevision: 0, content: "same content", taskLimit: 1, runTimeoutMs: 60_000 }) as { revision: number; hash: string };
  const revised = await fixture.call(goals.propose, { ...request(), goalId: "draft", expectedRevision: 1, content: "same content", taskLimit: 2, runTimeoutMs: 60_000 }) as { revision: number; hash: string };
  assert.notEqual(draft.hash, revised.hash);
  await assert.rejects(fixture.call(goals.approve, { ...request(humanToken), goalId: "draft", revision: 2, hash: draft.hash }), isCode("GOAL_NOT_APPROVED"));
});
test("T3 competing serialized exported handlers accept one owner, authenticated replay is stable", async () => {
  const { fixture } = await setup(); const first = claim(), second = claim("task", "run2");
  const results = await Promise.allSettled([fixture.call(tasks.claim, first), fixture.call(tasks.claim, second)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(fixture.find("tasks", "task").epoch, 1);
  assert.deepEqual(await fixture.call(tasks.claim, first), (results[0] as PromiseFulfilledResult<unknown>).value);
  await assert.rejects(fixture.call(tasks.claim, { ...first, launchId: "changed" }), isCode("IDEMPOTENCY_CONFLICT"));
  const renewal = identity(first); await fixture.call(tasks.renew, renewal);
  await fixture.call((await import("../convex/auth.js")).revoke, { ...request(humanToken), credentialId: "grant_run" });
  await assert.rejects(fixture.call(tasks.renew, renewal), isCode("UNAUTHORIZED"));
});
test("T3 project credential and stale epoch cannot act as a bound run grant", async () => {
  const { fixture } = await setup(); const admission = claim(); await fixture.call(tasks.registerManual, admission);
  await assert.rejects(fixture.call(tasks.progress, { ...identity(admission), token: agentToken, expectedRevision: 0, progress: "Unauthorized" }), isCode("FORBIDDEN"));
  await assert.rejects(fixture.call(tasks.renew, identity(admission, 0)), isCode("STALE_EPOCH"));
  await assert.rejects(fixture.call(tasks.renew, { ...identity(admission), protocolVersion: 999 }), isCode("PROTOCOL_INCOMPATIBLE"));
});
test("current scope restrictions invalidate queued admission and existing run writes", async () => {
  const { fixture } = await setup(); const c = claim(); await fixture.call(tasks.registerManual, c);
  await fixture.call(projects.configure, { ...request(humanToken), repository: "https://example.test/repository", remote: "origin", defaultBranch: "main", allowedPaths: ["src/other"], excludedPaths: [], ruleTargets: ["AGENTS.md"], sharingApproved: true, capturePolicyDigest: "d".repeat(64), capacity: 2, taskCap: 20 });
  await assert.rejects(fixture.call(tasks.progress, { ...identity(c), expectedRevision: 0, progress: "stale scope" }), isCode("FORBIDDEN"));
});
test("T19 result and supervisor stop are independent; missing process evidence preserves reservation", async () => {
  const { fixture } = await setup(); const c = claim(); await fixture.call(tasks.claim, c); await fixture.call(lifecycle.starting, identity(c));
  const process = { pid: 100, bootId: "fixture-boot", startIdentity: "fixture-start", launchId: c.launchId };
  await fixture.call(lifecycle.authorizeLaunch, { ...identity(c), token: supervisorToken, process });
  await fixture.call(lifecycle.requestFinalization, { ...identity(c), outcome: "failed", reason: "fixture failure" });
  assert.equal(fixture.find("runs", c.runId).capacityHeld, true);
  const evidence = { kind: "observed_tree_exit" as const, launchId: c.launchId, machineId: c.machineId, observedAt: new Date().toISOString(), evidenceRef: "fixture-exit" };
  await assert.rejects(fixture.call(lifecycle.confirmStopped, { ...identity(c), token: supervisorToken, evidence }), isCode("LAUNCH_UNCERTAIN"));
  const stop = { ...identity(c), token: supervisorToken, evidence: { ...evidence, process } };
  const receipt = await fixture.call(lifecycle.confirmStopped, stop); assert.equal(fixture.find("runs", c.runId).capacityHeld, false);
  assert.deepEqual(await fixture.call(lifecycle.confirmStopped, stop), receipt);
  assert.equal(fixture.find("tasks", "task").state, "failed");
});
test("T10 uncertain launch expiry never frees capacity or permits replacement", async () => {
  const { fixture } = await setup(); const c = claim(); await fixture.call(tasks.claim, c);
  await fixture.call(lifecycle.reportUncertain, { ...identity(c), token: supervisorToken, reason: "No trusted launch receipt" });
  const run = fixture.find("runs", c.runId); await fixture.context().db.patch(run._id, { leaseUntil: 1 }); await fixture.call(lifecycle.sweep, {});
  assert.equal(fixture.find("runs", c.runId).capacityHeld, true); assert.equal(fixture.find("tasks", "task").state, "launch_uncertain");
  await assert.rejects(fixture.call(tasks.claim, claim("task", "replacement")), isCode("LAUNCH_UNCERTAIN"));
});

test("T4 scan completion requires all bounded chunks and exact totals", async () => {
  const { fixture } = await setup(); await fixture.context().db.patch(fixture.find("tasks", "task")._id, { scope: ["src/files"] }); const c = claim(); await fixture.call(tasks.registerManual, c);
  const { upload } = await import("../convex/scans.js"); const { canonical } = await import("../convex/auth.js");
  const paths0 = Array.from({ length: 500 }, (_, i) => `src/files/file${i}.ts`), paths1 = ["src/files/file500.ts"];
  const first = await fixture.call(upload, { ...identity(c), revision: "scan1", sourceHead: "a".repeat(40), tree: "b".repeat(40), chunk: 0, paths: paths0, digest: await digest(canonical(paths0)), expectedChunks: 2, expectedPaths: 501 }) as { complete: boolean };
  assert.equal(first.complete, false); assert.equal(fixture.find("tasks", "task").coverageComplete, false);
  const second = await fixture.call(upload, { ...identity(c), revision: "scan1", sourceHead: "a".repeat(40), tree: "b".repeat(40), chunk: 1, paths: paths1, digest: await digest(canonical(paths1)), expectedChunks: 2, expectedPaths: 501 }) as { complete: boolean };
  assert.equal(second.complete, true); assert.equal(fixture.find("tasks", "task").coverageComplete, false);
  const { verify } = await import("../convex/scans.js");
  await fixture.call(verify, { ...identity(c), token: artifactVerifierToken, revision: "scan1", sourceHead: "a".repeat(40), tree: "b".repeat(40), pathsDigest: await digest(canonical([...paths0, ...paths1].sort())), expectedPaths: 501, evidenceRef: "trusted-fixture-scan" });
  assert.equal(fixture.find("tasks", "task").coverageComplete, true);
});
test("T5 offered receipts do not acknowledge; declined/escalated and stale decisions block", async () => {
  const { fixture, propose } = await setup(); await propose("other", ["src/other.ts"]);
  const a = claim(), b = claim("other", "other_run"); await fixture.call(tasks.registerManual, a); await fixture.call(tasks.registerManual, b);
  const messages = await import("../convex/messages.js"); const { noConflicts } = await import("../convex/tasks.js");
  await fixture.call(messages.send, { ...identity(a), messageId: "conflict", recipientTaskId: "other", recipientEpoch: 1, type: "overlap", payload: "Agree interface before publication", conflict: true });
  await fixture.call(messages.receipt, { ...identity(b), messageId: "conflict", state: "offered_to_turn" });
  assert.equal(fixture.find("messages", "conflict").state, "offered_to_turn");
  for (const resolution of ["declined", "escalated"] as const) {
    await fixture.call(messages.resolve, { ...identity(b), messageId: "conflict", resolution, decision: "No agreement" });
    await assert.rejects(noConflicts(fixture.context(), fixture.find("tasks", "other")), isCode("CONFLICT_UNRESOLVED"));
  }
  await fixture.call(messages.resolve, { ...identity(b), messageId: "conflict", resolution: "accepted", decision: "Task other consumes the existing helper from task" });
  await noConflicts(fixture.context(), fixture.find("tasks", "other"));
  const sender = fixture.find("tasks", "task"); await fixture.context().db.patch(sender._id, { epoch: 2 });
  await assert.rejects(noConflicts(fixture.context(), fixture.find("tasks", "other")), isCode("CONFLICT_UNRESOLVED"));
});
test("T16 ordinary memory never promotes a mandatory rule; approval binds exact hash", async () => {
  const { fixture } = await setup(); const c = claim(); await fixture.call(tasks.registerManual, c); const memories = await import("../convex/memories.js");
  const result = await fixture.call(memories.record, { ...identity(c), memoryId: "rule", kind: "rule", content: "Use semantic labels", sources: [{ taskId: "task", revision: "abc", evidenceRef: "fixture-test" }], applicability: ["src"], confidence: "tested" }) as { revision: number; hash: string; status: string };
  assert.equal(result.status, "proposed");
  await assert.rejects(fixture.call(memories.approveRule, { ...request(), memoryId: "rule", revision: 1, hash: result.hash }), isCode("FORBIDDEN"));
  await assert.rejects(fixture.call(memories.approveRule, { ...request(humanToken), memoryId: "rule", revision: 1, hash: "wrong" }), isCode("FORBIDDEN"));
  await fixture.call(memories.approveRule, { ...request(humanToken), memoryId: "rule", revision: 1, hash: result.hash });
  assert.equal(fixture.find("memories", "rule").approvedHash, result.hash);
});

test("T19 finalization lost acknowledgment replays after its transition", async () => {
  const { fixture } = await setup(); const c = claim(); await fixture.call(tasks.claim, c); await fixture.call(lifecycle.starting, identity(c));
  await fixture.call(lifecycle.authorizeLaunch, { ...identity(c), token: supervisorToken, process: { pid: 10, bootId: "boot", startIdentity: "start", launchId: c.launchId } });
  const finalization = { ...identity(c), outcome: "failed" as const, reason: "fixture-failure" };
  const first = await fixture.call(lifecycle.requestFinalization, finalization);
  assert.deepEqual(await fixture.call(lifecycle.requestFinalization, finalization), first);
});
test("T19 late supervisor exit after goal pause retains task pause and accepted artifact", async () => {
  const { fixture } = await setup(); const c = claim(); await fixture.call(tasks.claim, c); await fixture.call(lifecycle.starting, identity(c));
  const process = { pid: 10, bootId: "boot", startIdentity: "start", launchId: c.launchId };
  await fixture.call(lifecycle.authorizeLaunch, { ...identity(c), token: supervisorToken, process });
  await fixture.context().db.patch(fixture.find("runs", c.runId)._id, { resultAccepted: true });
  await fixture.context().db.patch(fixture.find("tasks", "task")._id, { state: "review_ready", publicationId: "preserved_artifact" });
  await fixture.call(goals.control, { ...request(humanToken), goalId: "goal", state: "paused" });
  await fixture.call(lifecycle.confirmStopped, { ...identity(c), token: supervisorToken, evidence: { kind: "observed_tree_exit", process, machineId: c.machineId, launchId: c.launchId, observedAt: new Date().toISOString(), evidenceRef: "fixture" } });
  assert.equal(fixture.find("tasks", "task").state, "blocked"); assert.equal(fixture.find("tasks", "task").reason, "goal_paused"); assert.equal(fixture.find("tasks", "task").publicationId, "preserved_artifact");
});
test("T11 bounded sweep progresses past more than100 old terminal reservations", async () => {
  const { fixture } = await setup(); const c = claim(); await fixture.call(tasks.claim, c);
  const original = fixture.find("runs", c.runId);
  const oldRows = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < 120; i++) oldRows.set(`old${i}`, { ...original, id: `old${i}`, _id: `old${i}`, _table: "runs", state: "stopped", capacityHeld: false, leaseUntil: 1, releaseReceipt: `old${i}` });
  fixture.rows = new Map([...oldRows, ...fixture.rows]);
  await fixture.context().db.patch(original._id, { leaseUntil: 1 });
  await fixture.call(lifecycle.sweep, {}); await fixture.call(lifecycle.sweep, {});
  assert.equal(fixture.find("tasks", "task").state, "launch_uncertain"); assert.equal(fixture.find("runs", c.runId).capacityHeld, true);
});
test("queued conflict requires a current human decision before admission", async () => {
  const { fixture, propose } = await setup(); await propose("other", ["src/other.ts"]);
  const a = claim(); await fixture.call(tasks.registerManual, a); const messages = await import("../convex/messages.js");
  await fixture.call(messages.send, { ...identity(a), messageId: "queued_conflict", recipientTaskId: "other", recipientEpoch: 0, type: "overlap", payload: "Need ordering decision", conflict: true });
  const other = claim("other", "other_run"); await assert.rejects(fixture.call(tasks.registerManual, other), isCode("CONFLICT_UNRESOLVED"));
  await assert.rejects(fixture.call(messages.resolveBeforeAdmission, { ...request(), messageId: "queued_conflict", senderEpoch: 1, recipientEpoch: 0, decision: "Agent override" }), isCode("FORBIDDEN"));
  await fixture.call(messages.resolveBeforeAdmission, { ...request(humanToken), messageId: "queued_conflict", senderEpoch: 1, recipientEpoch: 0, decision: "Task other will consume task's interface" });
  await fixture.call(tasks.registerManual, { ...other, requestId: `fresh_${++serial}` });
  assert.equal(fixture.find("tasks", "other").epoch, 1);
});

async function preparedFixture(manual = false) {
  const { fixture } = await setup(); const c = claim();
  if (manual) await fixture.call(tasks.registerManual, c);
  else {
    await fixture.call(tasks.claim, c); await fixture.call(lifecycle.starting, identity(c));
    await fixture.call(lifecycle.authorizeLaunch, { ...identity(c), token: supervisorToken, process: { pid: 10, bootId: "boot", startIdentity: "start", launchId: c.launchId } });
  }
  await fixture.call(tasks.progress, { ...identity(c), expectedRevision: 0, progress: "checkpoint progress" });
  const { canonical } = await import("../convex/auth.js");
  const manifest = { schemaVersion: 1 as const, checkpointId: "checkpoint", identity: { taskId: c.taskId, runId: c.runId, epoch: 1, goalRevision: 1 }, sourceHead: "e".repeat(40), executionBase: { sha: "a".repeat(40), revision: 1, remoteRef: "refs/heads/main" }, remoteParent: "a".repeat(40), tree: "c".repeat(40), commit: "b".repeat(40), ref: "refs/coord/checkpoints/task/e1/checkpoint", files: [{ path: "src/work.ts", mode: "100644", type: "blob" as const, oid: "f".repeat(40) }], exclusions: [], progressHash: await digest(canonical("checkpoint progress")), evidence: [], createdAt: new Date().toISOString(), progressRevision: 1, policyDigest: "d".repeat(64), manifestDigest: "", reusedCommit: false };
  manifest.manifestDigest = await digest(canonical({ identity: manifest.identity, sourceHead: manifest.sourceHead, executionBase: manifest.executionBase, tree: manifest.tree, files: manifest.files, exclusions: manifest.exclusions, progressHash: manifest.progressHash, policyDigest: manifest.policyDigest, progressRevision: manifest.progressRevision }));
  const checkpoints = await import("../convex/checkpoints.js"); await fixture.call(checkpoints.prepare, { ...identity(c), manifest, summary: "Fixture summary" });
  await verifyScanFixture(fixture, c, manifest);
  const readback = { commit: manifest.commit, tree: manifest.tree, parent: manifest.remoteParent, ref: manifest.ref, manifestHash: manifest.manifestDigest, progressHash: manifest.progressHash, policyDigest: manifest.policyDigest, evidenceRef: "synthetic-readback" };
  return { fixture, c, manifest, readback, checkpoints };
}
test("T9/T18 ready acceptance requires independent exact-base verification and current progress", async () => {
  const { fixture, c, manifest, readback, checkpoints } = await preparedFixture();
  await assert.rejects(fixture.call(checkpoints.verifyCode, { ...identity(c), checkpointId: manifest.checkpointId, readback }), isCode("FORBIDDEN"));
  await assert.rejects(fixture.call(checkpoints.verifyCode, { ...identity(c), token: artifactVerifierToken, checkpointId: manifest.checkpointId, readback: { ...readback, parent: "9".repeat(40) } }), isCode("CHECKPOINT_INCOMPLETE"));
  await fixture.call(checkpoints.verifyCode, { ...identity(c), token: artifactVerifierToken, checkpointId: manifest.checkpointId, readback });
  await fixture.call(tasks.progress, { ...identity(c), expectedRevision: 1, progress: "changed after capture" });
  await assert.rejects(fixture.call(checkpoints.ready, { ...identity(c), token: artifactVerifierToken, checkpointId: manifest.checkpointId }), isCode("CHECKPOINT_INCOMPLETE"));
  assert.equal(fixture.find("tasks", "task").latestCheckpointId, undefined);
});
test("T15/T19 accepted verified PR freezes worker writes but retains managed reservation until exit", async () => {
  const { fixture, c, manifest, readback, checkpoints } = await preparedFixture();
  await fixture.call(checkpoints.verifyCode, { ...identity(c), token: artifactVerifierToken, checkpointId: manifest.checkpointId, readback });
  await fixture.call(checkpoints.ready, { ...identity(c), token: artifactVerifierToken, checkpointId: manifest.checkpointId });
  const publications = await import("../convex/publications.js");
  const evidence = { head: manifest.commit, tree: manifest.tree, base: manifest.executionBase.sha, commands: [{ argv: ["fixture-test"], exitCode: 0 }], environmentDigest: "fixture", recordedAt: new Date().toISOString() };
  await fixture.call(publications.request, { ...identity(c), publicationId: "publication", checkpointId: manifest.checkpointId, targetBase: manifest.executionBase.sha, verification: evidence });
  const publication = fixture.find("publications", "publication");
  await fixture.call(publications.verifyBranch, { ...identity(c), token: artifactVerifierToken, publicationId: publication.id, head: manifest.commit, tree: manifest.tree, parent: manifest.executionBase.sha, branch: publication.branch, liveTargetBase: manifest.executionBase.sha, evidenceRef: "fixture-branch" });
  const prArgs = { ...identity(c), token: artifactVerifierToken, publicationId: publication.id, head: manifest.commit, tree: manifest.tree, liveTargetBase: manifest.executionBase.sha, repository: "https://example.test/repository", headBranch: publication.branch, targetBaseRef: "main", prId: "1", prUrl: "https://example.test/pr/1", open: true, evidenceRef: "fixture-pr" };
  await assert.rejects(fixture.call(publications.verifyPR, { ...prArgs, repository: "https://example.test/wrong-repository" }), isCode("PUBLICATION_STALE"));
  const project = fixture.find("projects", "project");
  await fixture.context().db.patch(project._id, { capturePolicyDigest: "8".repeat(64) });
  await assert.rejects(fixture.call(publications.verifyPR, { ...prArgs, requestId: `changed_policy_${++serial}` }), isCode("PUBLICATION_STALE"));
  await fixture.context().db.patch(project._id, { capturePolicyDigest: "d".repeat(64) });
  const scannedTask = fixture.find("tasks", "task");
  await fixture.context().db.patch(scannedTask._id, { scanTree: "6".repeat(40) });
  await assert.rejects(fixture.call(publications.verifyPR, { ...prArgs, requestId: `stale_scan_${++serial}` }), isCode("COVERAGE_INCOMPLETE"));
  await fixture.context().db.patch(scannedTask._id, { scanTree: manifest.tree });
  await fixture.call(publications.verifyPR, prArgs);
  const acceptance = { ...identity(c), token: artifactVerifierToken, publicationId: publication.id, liveTargetBase: manifest.executionBase.sha };
  await fixture.call(publications.accept, acceptance); await fixture.call(publications.accept, acceptance);
  assert.equal(fixture.find("tasks", "task").state, "review_ready"); assert.equal(fixture.find("runs", c.runId).capacityHeld, true);
  await assert.rejects(fixture.call(tasks.progress, { ...identity(c), expectedRevision: 1, progress: "too late" }), isCode("LEASE_REVOKED"));
  await fixture.call(lifecycle.requestFinalization, { ...identity(c), outcome: "succeeded", reason: "verified PR accepted" });
  assert.equal(fixture.find("runs", c.runId).capacityHeld, true);
});

test("T9 unchanged published base records its actual parents, never a self-parent", async () => {
  const { fixture, c, manifest, checkpoints } = await preparedFixture();
  const reused = { ...manifest, checkpointId: "unchanged", commit: manifest.executionBase.sha, reusedCommit: true, ref: "refs/coord/checkpoints/task/e1/unchanged" };
  await fixture.call(checkpoints.prepare, { ...identity(c), manifest: reused, summary: "Unchanged published base" });
  const readback = { commit: reused.commit, tree: reused.tree, parent: "7".repeat(40), parents: ["7".repeat(40)], ref: reused.ref, manifestHash: reused.manifestDigest, progressHash: reused.progressHash, policyDigest: reused.policyDigest, evidenceRef: "fixture-existing-base" };
  await fixture.call(checkpoints.verifyCode, { ...identity(c), token: artifactVerifierToken, checkpointId: reused.checkpointId, readback });
  await fixture.call(checkpoints.ready, { ...identity(c), token: artifactVerifierToken, checkpointId: reused.checkpointId });
  assert.deepEqual(fixture.find("checkpoints", reused.checkpointId).actualParents, ["7".repeat(40)]);
  assert.notEqual(fixture.find("checkpoints", reused.checkpointId).parent, reused.commit);
});
test("T3 membership invite is one-use, scoped, digest-only and revocation precedes join replay", async () => {
  const { fixture } = await setup(), auth = await import("../convex/auth.js"); const inviteToken = randomBytes(32).toString("hex"), newToken = randomBytes(32).toString("hex");
  await fixture.call(auth.invite, { ...request(humanToken), inviteToken, memberId: "brother", projectIds: ["project"], role: "agent", expiresAt: Date.now() + 60_000 });
  const join = { ...request(), inviteToken, newToken, credentialExpiresAt: Date.now() + 3600_000 };
  const result = await fixture.call(auth.redeem, join); assert.deepEqual(await fixture.call(auth.redeem, join), result);
  const duplicate = await fixture.call(auth.redeem, { ...join, requestId: "another_redemption" }) as { joined: boolean }; assert.equal(duplicate.joined, false);
  assert(!JSON.stringify([...fixture.rows.values()]).includes(inviteToken)); assert(!JSON.stringify([...fixture.rows.values()]).includes(newToken));
  await fixture.call(auth.revoke, { ...request(humanToken), credentialId: "brother" });
  const replayAfterRevoke = await fixture.call(auth.redeem, join) as { joined: boolean }; assert.equal(replayAfterRevoke.joined, false);
});
test("T12 child proposal is atomic and yield releases children only after ready checkpoint and positive stop", async () => {
  const { fixture, c, manifest, checkpoints, readback } = await preparedFixture();
  const child = { taskId: "child", title: "Prerequisite", scope: ["src/child.ts"], dependencies: [], executionBase: manifest.executionBase };
  await assert.rejects(fixture.call(tasks.proposeSubtasks, { ...identity(c), rationale: "Needs helper", children: [child, { ...child, taskId: "bad", scope: ["outside.ts"] }] }), isCode("FORBIDDEN"));
  assert.equal([...fixture.rows.values()].some(r => r._table === "tasks" && r.id === "child"), false); assert.equal(fixture.find("tasks", "task").state, "running");
  await fixture.call(tasks.proposeSubtasks, { ...identity(c), rationale: "Needs helper", children: [child] });
  assert.equal(fixture.find("tasks", "child").dispatchHeld, true);
  await assert.rejects(fixture.call(lifecycle.requestYield, { ...identity(c), checkpointId: manifest.checkpointId }), isCode("BLOCKED_CHECKPOINT"));
  const next = { ...manifest, checkpointId: "yield_checkpoint", ref: "refs/coord/checkpoints/task/e1/yield_checkpoint", progressRevision: 2, manifestDigest: "" };
  const { canonical } = await import("../convex/auth.js");
  next.manifestDigest = await digest(canonical({ identity: next.identity, sourceHead: next.sourceHead, executionBase: next.executionBase, tree: next.tree, files: next.files, exclusions: next.exclusions, progressHash: next.progressHash, policyDigest: next.policyDigest, progressRevision: next.progressRevision }));
  await fixture.call(checkpoints.prepare, { ...identity(c), manifest: next, summary: "Parent needs helper" });
  await verifyScanFixture(fixture, c, next);
  await fixture.call(checkpoints.verifyCode, { ...identity(c), token: artifactVerifierToken, checkpointId: next.checkpointId, readback: { ...readback, ref: next.ref, manifestHash: next.manifestDigest } });
  await fixture.call(checkpoints.ready, { ...identity(c), token: artifactVerifierToken, checkpointId: next.checkpointId });
  await fixture.call(lifecycle.requestYield, { ...identity(c), checkpointId: next.checkpointId });
  assert.equal(fixture.find("tasks", "child").dispatchHeld, true); assert.equal(fixture.find("runs", c.runId).capacityHeld, true);
  await fixture.call(lifecycle.confirmStopped, { ...identity(c), token: supervisorToken, evidence: { kind: "observed_tree_exit", process: fixture.find("runs", c.runId).process!, machineId: c.machineId, launchId: c.launchId, observedAt: new Date().toISOString(), evidenceRef: "fixture-parent-exit" } });
  assert.equal(fixture.find("tasks", "task").state, "waiting_dependencies"); assert.equal(fixture.find("tasks", "child").dispatchHeld, false); assert.equal(fixture.find("runs", c.runId).capacityHeld, false);
});

test("T13 replanning bypasses failed prerequisites, persists attempts and finalizes without a dummy PR", async () => {
  const { fixture, propose } = await setup(); await propose("failed_child", ["src/failed.ts"]);
  const parent = fixture.find("tasks", "task"), child = fixture.find("tasks", "failed_child");
  await fixture.context().db.patch(child._id, { state: "failed" }); await fixture.context().db.patch(parent._id, { state: "waiting_dependencies", dependencies: [{ taskId: child.id, mode: "published" }] });
  for (let attempt = 1; attempt <= 2; attempt++) {
    await fixture.call(tasks.refreshDependencies, request()); assert.equal(fixture.find("tasks", "task").state, "replan_requested");
    const c = claim("task", `replan${attempt}`), id = identity(c, attempt);
    await fixture.call(tasks.claimReplan, c); assert.equal(fixture.find("tasks", "task").replanAttempts, attempt);
    await fixture.call(lifecycle.starting, id);
    const process = { pid: 100 + attempt, bootId: "fixture", startIdentity: `start${attempt}`, launchId: c.launchId };
    await fixture.call(lifecycle.authorizeLaunch, { ...id, token: supervisorToken, process });
    const proposal = { ...id, result: "revised" as const, dependencies: [{ taskId: child.id, mode: "published" as const }], rationale: "Fixture requests retry of existing in-scope dependency" };
    const accepted = await fixture.call(tasks.finishReplan, proposal); assert.deepEqual(await fixture.call(tasks.finishReplan, proposal), accepted);
    assert.equal(fixture.find("runs", c.runId).resultAccepted, true); assert.equal(fixture.find("runs", c.runId).capacityHeld, true);
    if (attempt === 1) await fixture.call(lifecycle.reportUncertain, { ...id, token: supervisorToken, reason: "Lost acknowledgment after replan finalization" });
    await fixture.call(lifecycle.confirmStopped, { ...id, token: supervisorToken, evidence: { kind: "observed_tree_exit", process, launchId: c.launchId, machineId: c.machineId, observedAt: new Date().toISOString(), evidenceRef: "fixture-replan-exit" } });
    assert.equal(fixture.find("tasks", "task").state, "waiting_dependencies"); assert.equal(fixture.find("runs", c.runId).capacityHeld, false);
  }
  await fixture.call(tasks.refreshDependencies, request()); assert.equal(fixture.find("tasks", "task").state, "blocked"); assert.match(fixture.find("tasks", "task").reason!, /NEEDS_HUMAN/); assert.equal(fixture.find("tasks", "task").replanAttempts, 2);
});

test("T16 approving a rule keeps current live rules and renewal accessible", async () => {
  const { fixture } = await setup(), c = claim(); await fixture.call(tasks.registerManual, c);
  const memories = await import("../convex/memories.js");
  const proposed = await fixture.call(memories.record, { ...identity(c), memoryId: "new_rule", kind: "rule", content: "Label interactive controls", sources: [{ taskId: c.taskId, revision: "fixture-revision", evidenceRef: "fixture-test" }], applicability: ["src"], confidence: "tested" }) as { hash: string };
  await fixture.call(memories.approveRule, { ...request(humanToken), memoryId: "new_rule", revision: 1, hash: proposed.hash });
  const rules = await fixture.call(memories.rules, identity(c)) as { complete: boolean; ruleTargets: string[]; rules: Array<{ id: string }> };
  assert.equal(rules.complete, true); assert.deepEqual(rules.ruleTargets, ["AGENTS.md"]); assert.equal(rules.rules[0]?.id, "new_rule");
  await fixture.call(tasks.renew, identity(c));
});
test("T5 bounded message pages retain IDs and support complete oversized payload/decision retrieval", async () => {
  const { fixture, propose } = await setup(); await propose("other", ["src/other.ts"]);
  const a = claim(), b = claim("other", "other_run"); await fixture.call(tasks.registerManual, a); await fixture.call(tasks.registerManual, b);
  const messages = await import("../convex/messages.js");
  await fixture.call(messages.send, { ...identity(a), messageId: "large_message", recipientTaskId: "other", recipientEpoch: 1, type: "warning", payload: "x".repeat(1536), conflict: true });
  await fixture.call(messages.resolve, { ...identity(b), messageId: "large_message", resolution: "escalated", decision: "y".repeat(2048) });
  const page = await fixture.call(messages.read, identity(b)) as { messages: Array<{ id: string; requiresExpansion?: boolean }>; bytes: number; complete: boolean };
  assert.equal(page.messages[0]?.id, "large_message"); assert.equal(page.messages[0]?.requiresExpansion, true); assert.equal(page.complete, false); assert(page.bytes <= 2048);
  const decision = await fixture.call(messages.expand, { ...identity(b), messageId: "large_message", offset: 0, section: "decision" }) as { payload: string; nextOffset: number };
  assert.equal(decision.payload.length, 1024); assert.equal(decision.nextOffset, 1024);
});

test("T20 launch rechecks old run configuration even after the machine is requalified", async () => {
  const { fixture } = await setup(), c = claim(); await fixture.call(tasks.claim, c); await fixture.call(lifecycle.starting, identity(c));
  const project = fixture.find("projects", "project"), machine = fixture.find("machines", "machine");
  await fixture.call(projects.configure, { ...request(humanToken), repository: project.repository, remote: project.remote, defaultBranch: project.defaultBranch, allowedPaths: project.allowedPaths, excludedPaths: project.excludedPaths, ruleTargets: project.ruleTargets, sharingApproved: true, capturePolicyDigest: project.capturePolicyDigest, capacity: project.capacity, taskCap: project.taskCap });
  const changed = fixture.find("projects", "project");
  await fixture.context().db.patch(machine._id, { configVersion: changed.configVersion, capabilityDigest: "new-qualified-configuration" });
  await assert.rejects(fixture.call(lifecycle.authorizeLaunch, { ...identity(c), token: supervisorToken, process: { pid: 1, bootId: "fixture", startIdentity: "new", launchId: c.launchId } }), isCode("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION"));
  assert.equal(fixture.find("runs", c.runId).state, "starting"); assert.equal(fixture.find("runs", c.runId).process, undefined);
});
test("T20 removing a machine mode or changing its member revokes existing write eligibility", async () => {
  const { fixture } = await setup(), c = claim(); await fixture.call(tasks.claim, c); const machine = fixture.find("machines", "machine");
  await fixture.context().db.patch(machine._id, { qualifiedModes: ["manual"] });
  await assert.rejects(fixture.call(tasks.renew, identity(c)), isCode("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION"));
  await fixture.context().db.patch(machine._id, { qualifiedModes: ["manual", "managed"], memberId: "another_member" });
  await assert.rejects(fixture.call(tasks.renew, identity(c)), isCode("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION"));
});
test("T11 checkpoint-free recovery requires proven never-started evidence, not missing progress", async () => {
  const { fixture } = await setup(), c = claim(); await fixture.call(tasks.claim, c); await fixture.call(lifecycle.starting, identity(c));
  const process = { pid: 1, bootId: "boot", startIdentity: "native-edits-may-have-occurred", launchId: c.launchId };
  await fixture.call(lifecycle.authorizeLaunch, { ...identity(c), token: supervisorToken, process });
  await fixture.call(lifecycle.requestFinalization, { ...identity(c), outcome: "stopped", reason: "Stopped without reporting progress" });
  await fixture.call(lifecycle.confirmStopped, { ...identity(c), token: supervisorToken, evidence: { kind: "observed_tree_exit", process, launchId: c.launchId, machineId: c.machineId, observedAt: new Date().toISOString(), evidenceRef: "fixture-exit" } });
  assert.equal(fixture.find("tasks", "task").progressRevision, 0);
  await assert.rejects(fixture.call(tasks.requestResume, { ...request(), taskId: "task" }), isCode("BLOCKED_CHECKPOINT"));
  const checkpoints = await import("../convex/checkpoints.js");
  await assert.rejects(fixture.call(checkpoints.getReady, { ...request(), taskId: "task" }), isCode("BLOCKED_CHECKPOINT"));
});
test("ready checkpoint reads are project-scoped; fresh and proven never-started bases are explicit", async () => {
  const { fixture } = await setup(), checkpoints = await import("../convex/checkpoints.js");
  const fresh = await fixture.call(checkpoints.getReady, { ...request(), taskId: "task" }) as { status: string; manifest: null }; assert.equal(fresh.status, "initial_base"); assert.equal(fresh.manifest, null);
  const c = claim(); await fixture.call(tasks.claim, c);
  await fixture.call(lifecycle.confirmStopped, { ...identity(c), token: supervisorToken, evidence: { kind: "proven_never_started", launchId: c.launchId, machineId: c.machineId, observedAt: new Date().toISOString(), evidenceRef: "positive-spawn-failure" } });
  const restarted = await fixture.call(checkpoints.getReady, { ...request(), taskId: "task" }) as { status: string }; assert.equal(restarted.status, "initial_base");
  await assert.rejects(fixture.call(checkpoints.getReady, { ...request(), projectId: "another_project", taskId: "task" }), isCode("UNAUTHORIZED"));
});
test("T13 replan code artifacts are forbidden and newly revised prerequisites release only on positive stop", async () => {
  const { fixture, c, manifest, checkpoints } = await preparedFixture();
  await fixture.context().db.patch(fixture.find("runs", c.runId)._id, { mode: "replan" });
  await assert.rejects(fixture.call(checkpoints.prepare, { ...identity(c), manifest: { ...manifest, checkpointId: "forbidden" }, summary: "No implementation code" }), isCode("FORBIDDEN"));
  await assert.rejects(fixture.call(checkpoints.ready, { ...identity(c), token: artifactVerifierToken, checkpointId: manifest.checkpointId }), isCode("FORBIDDEN"));
  const child = { taskId: "replan_child", title: "Revised prerequisite", scope: ["src/new-prerequisite.ts"], dependencies: [], executionBase: manifest.executionBase };
  await fixture.call(tasks.proposeSubtasks, { ...identity(c), rationale: "New in-scope prerequisite", children: [child] });
  const result = await fixture.call(tasks.finishReplan, { ...identity(c), result: "revised", dependencies: [{ taskId: child.taskId, mode: "published" }], rationale: "Replace failed prerequisite with the new child" }) as { state: string }; assert.equal(result.state, "waiting_dependencies");
  assert.equal(fixture.find("tasks", child.taskId).dispatchHeld, true);
  await fixture.call(lifecycle.confirmStopped, { ...identity(c), token: supervisorToken, evidence: { kind: "observed_tree_exit", process: fixture.find("runs", c.runId).process!, launchId: c.launchId, machineId: c.machineId, observedAt: new Date().toISOString(), evidenceRef: "fixture-replan-stop" } });
  assert.equal(fixture.find("tasks", child.taskId).dispatchHeld, false); assert.equal(fixture.find("tasks", "task").state, "waiting_dependencies"); assert.equal(fixture.find("tasks", "task").latestCheckpointId, undefined);
});


test("manual finalization clears only registration ownership and resumes from an explicit ready checkpoint", async () => {
  const { fixture, c, manifest, readback, checkpoints } = await preparedFixture(true);
  await fixture.call(checkpoints.verifyCode, { ...identity(c), token: humanToken, checkpointId: manifest.checkpointId, readback });
  await fixture.call(checkpoints.ready, { ...identity(c), token: humanToken, checkpointId: manifest.checkpointId });
  await fixture.call(lifecycle.requestFinalization, { ...identity(c), outcome: "stopped", reason: "End this manual registration" });
  const task = fixture.find("tasks", "task"), run = fixture.find("runs", c.runId);
  assert.equal(task.ownerRunId, undefined); assert.equal(task.leaseUntil, undefined); assert.equal(task.state, "blocked");
  assert.equal(run.capacityHeld, false); assert.equal(run.releaseReason, "manual_registration_revoked"); assert.equal(run.stopEvidence, undefined); assert.equal(run.process, undefined);
  await assert.rejects(fixture.call(tasks.requestResume, { ...request(), taskId: task.id }), isCode("BLOCKED_CHECKPOINT"));
  await fixture.call(tasks.requestResume, { ...request(), taskId: task.id, checkpointId: manifest.checkpointId });
  assert.equal(fixture.find("tasks", task.id).state, "queued"); assert.equal(fixture.find("tasks", task.id).latestCheckpointId, manifest.checkpointId);
});

async function verifyScanFixture(fixture: BackendFixture, c: ReturnType<typeof claim>, manifest: { checkpointId: string; sourceHead: string; tree: string }, paths = ["src/work.ts"]) {
  const scans = await import("../convex/scans.js"), { canonical } = await import("../convex/auth.js");
  const revision = `scan_${manifest.checkpointId}`;
  await fixture.call(scans.upload, { ...identity(c), revision, sourceHead: manifest.sourceHead, tree: manifest.tree, chunk: 0, paths, digest: await digest(canonical(paths)), expectedChunks: 1, expectedPaths: paths.length });
  await fixture.call(scans.verify, { ...identity(c), token: artifactVerifierToken, revision, sourceHead: manifest.sourceHead, tree: manifest.tree, pathsDigest: await digest(canonical([...paths].sort())), expectedPaths: paths.length, evidenceRef: "trusted-synthetic-git-scan" });
}

test("supervisor is lifecycle-only and cannot verify scans, checkpoints or publications", async () => {
  const { fixture, c, manifest, readback, checkpoints } = await preparedFixture();
  await assert.rejects(fixture.call(checkpoints.verifyCode, { ...identity(c), token: supervisorToken, checkpointId: manifest.checkpointId, readback }), isCode("FORBIDDEN"));
  await assert.rejects(fixture.call(checkpoints.ready, { ...identity(c), token: supervisorToken, checkpointId: manifest.checkpointId }), isCode("FORBIDDEN"));
  const scans = await import("../convex/scans.js"), publications = await import("../convex/publications.js"), { canonical } = await import("../convex/auth.js");
  await assert.rejects(fixture.call(scans.verify, { ...identity(c), token: supervisorToken, revision: `scan_${manifest.checkpointId}`, sourceHead: manifest.sourceHead, tree: manifest.tree, pathsDigest: await digest(canonical(["src/work.ts"])), expectedPaths: 1, evidenceRef: "supervisor-cannot-attest-code" }), isCode("FORBIDDEN"));
  await assert.rejects(fixture.call(publications.verifyBranch, { ...identity(c), token: supervisorToken, publicationId: "publication", head: manifest.commit, tree: manifest.tree, parent: manifest.remoteParent, branch: "coord/reviews/task/e1/publication", liveTargetBase: manifest.executionBase.sha, evidenceRef: "forbidden" }), isCode("FORBIDDEN"));
  await assert.rejects(fixture.call(publications.verifyPR, { ...identity(c), token: supervisorToken, publicationId: "publication", head: manifest.commit, tree: manifest.tree, liveTargetBase: manifest.executionBase.sha, repository: "https://example.test/repository", headBranch: "coord/reviews/task/e1/publication", targetBaseRef: "main", prId: "1", prUrl: "https://example.test/pr/1", open: true, evidenceRef: "forbidden" }), isCode("FORBIDDEN"));
  await assert.rejects(fixture.call(publications.accept, { ...identity(c), token: supervisorToken, publicationId: "publication", liveTargetBase: manifest.executionBase.sha }), isCode("FORBIDDEN"));
  await assert.rejects(fixture.call(lifecycle.confirmStopped, { ...identity(c), token: artifactVerifierToken, evidence: { kind: "observed_tree_exit", process: fixture.find("runs", c.runId).process!, machineId: c.machineId, launchId: c.launchId, observedAt: new Date().toISOString(), evidenceRef: "artifact-verifier-cannot-release" } }), isCode("FORBIDDEN"));
});
test("scan transmission cannot authorize ready code; trusted exact-path verification and reserved scope are required", async () => {
  const { fixture, c, manifest, readback, checkpoints } = await preparedFixture();
  const scans = await import("../convex/scans.js"), { canonical } = await import("../convex/auth.js");
  const upload = { ...identity(c), revision: "unverified_scan", sourceHead: manifest.sourceHead, tree: manifest.tree, chunk: 0, paths: ["src/work.ts"], digest: await digest(canonical(["src/work.ts"])), expectedChunks: 1, expectedPaths: 1 };
  await fixture.call(scans.upload, upload); assert.equal(fixture.find("tasks", c.taskId).coverageComplete, false);
  await fixture.call(checkpoints.verifyCode, { ...identity(c), token: artifactVerifierToken, checkpointId: manifest.checkpointId, readback });
  await assert.rejects(fixture.call(checkpoints.ready, { ...identity(c), token: artifactVerifierToken, checkpointId: manifest.checkpointId }), isCode("COVERAGE_INCOMPLETE"));
  const verify = { ...identity(c), revision: upload.revision, sourceHead: manifest.sourceHead, tree: manifest.tree, pathsDigest: await digest(canonical(["src/work.ts"])), expectedPaths: 1, evidenceRef: "trusted-git-diff" };
  await assert.rejects(fixture.call(scans.verify, verify), isCode("FORBIDDEN"));
  await assert.rejects(fixture.call(scans.verify, { ...verify, token: artifactVerifierToken, pathsDigest: "0".repeat(64) }), isCode("COVERAGE_INCOMPLETE"));
  await fixture.call(scans.verify, { ...verify, token: artifactVerifierToken });
  await fixture.call(checkpoints.ready, { ...identity(c), token: artifactVerifierToken, checkpointId: manifest.checkpointId });
  assert.equal(fixture.find("tasks", c.taskId).latestCheckpointId, manifest.checkpointId);
  await assert.rejects(fixture.call(scans.upload, { ...upload, requestId: `out_of_scope_${++serial}`, revision: "out_of_scope", paths: ["src/unreserved.ts"], digest: await digest(canonical(["src/unreserved.ts"])) }), isCode("FORBIDDEN"));
});

test("anonymous invite throttle persists unknown denials in one server-chosen deployment bucket", async t => {
  const { fixture } = await setup(), auth = await import("../convex/auth.js");
  const originalNow = Date.now; let now = originalNow(); Date.now = () => now; t.after(() => { Date.now = originalNow; });
  const inviteToken = randomBytes(32).toString("hex"), newToken = randomBytes(32).toString("hex");
  await fixture.call(auth.invite, { ...request(humanToken), inviteToken, memberId: "rate_limited_member", projectIds: ["project"], role: "agent", expiresAt: Date.now() + 120_000 });
  for (let i = 0; i < auth.INVITE_REDEEM_LIMIT; i++) {
    const denial = await fixture.call(auth.redeem, { ...request(), backendId: `attacker_bucket_${i}`, inviteToken: randomBytes(32).toString("hex"), newToken, credentialExpiresAt: Date.now() + 3600_000 }) as { joined: boolean; code: string };
    assert.deepEqual(denial, { joined: false, code: "UNAUTHORIZED" });
  }
  const limited = await fixture.call(auth.redeem, { ...request(), inviteToken, newToken, credentialExpiresAt: Date.now() + 3600_000 }) as { joined: boolean; code: string };
  assert.deepEqual(limited, { joined: false, code: "UNAUTHORIZED" });
  const buckets = [...fixture.rows.values()].filter(row => row._table === "rateLimits"); assert.equal(buckets.length, 1); assert.equal(buckets[0]?.key, "invite-redemption"); assert.equal(buckets[0]?.attempts, 61);
  const invitation = [...fixture.rows.values()].find(row => row._table === "invites"); assert.equal(invitation?.redeemedAt, undefined);
  now += auth.INVITE_REDEEM_WINDOW_MS;
  const allowed = await fixture.call(auth.redeem, { ...request(), inviteToken, newToken, credentialExpiresAt: now + 3600_000 }) as { joined: boolean }; assert.equal(allowed.joined, true);
});

function bootstrapInput() {
  return { backendId: "bootstrap_backend", projectId: "bootstrap_project", repository: "https://example.test/bootstrap", remote: "origin", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: ["src/private"], ruleTargets: ["AGENTS.md"], humanId: "bootstrap_human", humanDigest: "a".repeat(64), agentId: "bootstrap_agent", agentDigest: "b".repeat(64), expiresAt: Date.now() + 3600_000 };
}
test("internal bootstrap accepts only digest fields and stores supplied digests without rehashing", async () => {
  const fixture = new BackendFixture(), input = bootstrapInput();
  const definition = bootstrap as unknown as { isInternal: boolean; exportArgs(): string };
  assert.equal(definition.isInternal, true);
  const fields = (JSON.parse(definition.exportArgs()) as { value: Record<string, unknown> }).value;
  assert("humanDigest" in fields && "agentDigest" in fields); assert(!("humanToken" in fields)); assert(!("agentToken" in fields));
  const result = await fixture.call(bootstrap, input);
  assert.deepEqual(result, { backendId: input.backendId, projectId: input.projectId, humanId: input.humanId, agentId: input.agentId });
  assert.equal(fixture.find("credentials", input.humanId).digest, input.humanDigest);
  assert.equal(fixture.find("credentials", input.agentId).digest, input.agentDigest);
  assert.notEqual(fixture.find("credentials", input.humanId).digest, await digest(input.humanDigest));
});
test("bootstrap rejects equal, malformed and legacy raw-token credential input before writing", async () => {
  const input = bootstrapInput();
  for (const invalid of [{ ...input, agentDigest: input.humanDigest }, { ...input, humanDigest: "A".repeat(64) }, { ...input, humanDigest: "a".repeat(63) }, { ...input, agentDigest: "g".repeat(64) }, { ...input, expiresAt: Number.NaN }]) {
    const fixture = new BackendFixture(); await assert.rejects(fixture.call(bootstrap, invalid), isCode("INVALID_INPUT")); assert.equal(fixture.rows.size, 0);
  }
  const { humanDigest: _humanDigest, agentDigest: _agentDigest, ...legacy } = input;
  const fixture = new BackendFixture();
  await assert.rejects(fixture.call(bootstrap, { ...legacy, humanToken: "c".repeat(64), agentToken: "d".repeat(64) }), isCode("INVALID_INPUT")); assert.equal(fixture.rows.size, 0);
});
test("exact bootstrap replay returns IDs only and rejects changed input, policy, credential authority or revocation", async () => {
  const fixture = new BackendFixture(), input = bootstrapInput();
  const first = await fixture.call(bootstrap, input), before = structuredClone(fixture.rows);
  assert.deepEqual(await fixture.call(bootstrap, input), first); assert.deepEqual(fixture.rows, before);
  for (const changed of [{ ...input, humanDigest: "c".repeat(64) }, { ...input, agentDigest: "c".repeat(64) }, { ...input, projectId: "different_project" }, { ...input, expiresAt: input.expiresAt + 1 }, { ...input, repository: "https://example.test/changed" }]) await assert.rejects(fixture.call(bootstrap, changed), isCode("FORBIDDEN"));
  assert.deepEqual(fixture.rows, before);
  for (const patch of [{ sharingApproved: true }, { policyVersion: 2 }, { capacity: 3 }, { allowedPaths: ["other"] }]) {
    const changed = new BackendFixture(); await changed.call(bootstrap, input); await changed.context().db.patch(changed.find("projects", input.projectId)._id, patch);
    await assert.rejects(changed.call(bootstrap, input), isCode("FORBIDDEN"));
  }
  for (const patch of [{ revokedAt: Date.now() }, { role: "agent" as const }, { memberId: "different_member" }, { projectIds: ["different_project"] }, { expiresAt: 1 }]) {
    const changed = new BackendFixture(); await changed.call(bootstrap, input); await changed.context().db.patch(changed.find("credentials", input.humanId)._id, patch);
    await assert.rejects(changed.call(bootstrap, input), isCode("FORBIDDEN"));
  }
  const changed = new BackendFixture(); await changed.call(bootstrap, input);
  const metadata = (await changed.context().db.query("metadata").take(1))[0]!; await changed.context().db.patch(metadata._id, { writersPaused: true });
  await assert.rejects(changed.call(bootstrap, input), isCode("FORBIDDEN"));
});
