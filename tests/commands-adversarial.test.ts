import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commandsFixture } from "./commands.fixture.js";
import { simulatedLinux } from "./commands-sandbox.fixture.js";
import { connectWorkspace } from "../src/client.js";
import { admitSession, copySession, readSessionBinding } from "../src/session.js";
import { captureDigest, git, gitText } from "../src/checkpoint.js";
import { roleClient, runtimeDigest } from "../src/command-runtime.js";
import * as tasks from "../convex/tasks.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCoordMcpServer } from "../src/mcp.js";
import { connectRuntimeBridge } from "../src/commands.js";

type Fixture = Awaited<ReturnType<typeof commandsFixture>>;
const connect = (f: Fixture, cwd: string) => connectWorkspace(cwd, { registryPath: f.runtime.trustedRegistryPath, credentialDirectory: f.runtime.agentCredentialDirectory });
async function updateFixtureQualification(f: Fixture): Promise<void> {
  const digest = runtimeDigest(f.runtime); f.runtime.capability.key.configurationDigest = digest;
  for (const check of f.runtime.capability.checks) check.configurationDigest = digest;
  await f.backend.context().db.patch(f.backend.find("machines", f.runtime.machineId)._id, { capabilityKey: f.runtime.capability.key, capabilityChecks: f.runtime.capability.checks, capabilityDigest: createHash("sha256").update(JSON.stringify(f.runtime.capability.key)).digest("hex") });
  await f.saveRuntime();
}
async function admitted(f: Fixture, sessionId: string) {
  const prepared = await f.cli(f.repo, ["resume", "task", "--prepare-only", "--runtime", f.runtimePath, "--session", sessionId]) as { path: string };
  const run = (await readSessionBinding(prepared.path, await connect(f, prepared.path), sessionId))!;
  return { path: prepared.path, run };
}
async function changed(f: Fixture, sessionId: string) {
  const result = await admitted(f, sessionId);
  await writeFile(join(result.path, "store.js"), `${await readFile(join(result.path, "store.js"), "utf8")}\n// Independent parsed-command checkpoint rehearsal\n`);
  await result.run.client.mutation("tasks:progress", { ...result.run.identity, expectedRevision: 0, progress: JSON.stringify({ completed: ["Changed disposable taskboard"], remaining: ["Publish exact tested tree"], nextStep: "Review snapshot" }) }, `progress_${sessionId}`);
  return result;
}

test("T9 parsed checkpoint reconciles a lost ready acknowledgment without another snapshot or epoch", async () => {
  const f = await commandsFixture();
  try {
    const source = await changed(f, "ready_replay"); f.loseReply("checkpoints:ready");
    const argv = ["checkpoint", "cp_ready_replay", "--runtime", f.runtimePath, "--session", "ready_replay"];
    let lost: unknown;
    try { await f.cli(source.path, argv); } catch (error) { lost = error; }
    assert(lost, "The fixture must lose its successful ready reply");
    const first = f.backend.find("checkpoints", "cp_ready_replay");
    if (first.state !== "ready") throw new Error("Parsed checkpoint failed before its intended lost ready acknowledgment", { cause: lost });
    const result = await f.cli(source.path, argv) as { state: string; commit: string };
    assert.equal(result.state, "ready"); assert.equal(result.commit, first.commit);
    assert.equal(f.backend.find("tasks", "task").epoch, source.run.identity.epoch);
    assert.equal(f.calls.filter(call => call.path === "checkpoints:ready").length, 2);
    assert.equal((await gitText(f.bare, ["for-each-ref", "--format=%(refname)", "refs/coord/checkpoints"])).split("\n").filter(Boolean).length, 1);
    assert.equal([...f.backend.rows.values()].filter(row => row._table === "checkpoints").length, 1);
  } finally { await f.restore(); }
});

test("T3/T20 parsed checkpoint rejects revoked grants or changed project configuration before Git publication", async () => {
  for (const invalidation of ["revoked", "configuration"] as const) {
    const f = await commandsFixture();
    try {
      const source = await changed(f, `stale_${invalidation}`);
      if (invalidation === "revoked") await f.backend.context().db.patch(f.backend.find("credentials", `grant_${source.run.identity.runId}`)._id, { revokedAt: Date.now() });
      else await f.backend.context().db.patch(f.backend.find("projects", f.config.projectId)._id, { configVersion: 999 });
      await assert.rejects(f.cli(source.path, ["checkpoint", "cp_stale", "--runtime", f.runtimePath, "--session", `stale_${invalidation}`]));
      assert.equal(f.calls.filter(call => call.path === "checkpoints:prepare").length, 0);
      assert.equal(await gitText(f.bare, ["for-each-ref", "--format=%(refname)", "refs/coord/checkpoints"]), "");
    } finally { await f.restore(); }
  }
});

test("T20 supplemental local capability claims cannot replace backend-owned evidence before admission", async () => {
  const f = await commandsFixture();
  try {
    const machine = f.backend.find("machines", f.runtime.machineId);
    await f.backend.context().db.patch(machine._id, { capabilityChecks: machine.capabilityChecks!.filter(check => check.checkId !== "verification.sandbox") });
    await assert.rejects(f.cli(f.repo, ["resume", "task", "--prepare-only", "--runtime", f.runtimePath, "--session", "local_only_evidence"]), { code: "UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION" });
    assert.equal(f.calls.filter(call => call.path === "tasks:registerManual" || call.path === "tasks:claim").length, 0);
    assert.equal([...f.backend.rows.values()].filter(row => row._table === "runs").length, 0);
  } finally { await f.restore(); }
});

test("T14 unqualified dependency setup is rejected before reservation or subprocess setup", async () => {
  const f = await commandsFixture();
  try {
    await writeFile(join(f.repo, "package-lock.json"), JSON.stringify({ name: "fixture-only", lockfileVersion: 3 }));
    f.runtime.policy.setupCommands = [["npm", "ci"]];
    await updateFixtureQualification(f);
    await assert.rejects(f.cli(f.repo, ["resume", "task", "--prepare-only", "--runtime", f.runtimePath, "--session", "no_setup"]), /Dependency setup requires an independently qualified isolated setup adapter/);
    assert.equal(f.calls.filter(call => call.path === "tasks:registerManual" || call.path === "tasks:claim").length, 0);
    assert.equal([...f.backend.rows.values()].filter(row => row._table === "runs").length, 0);
  } finally { await f.restore(); }
});

test("T2 resumed ready journal cannot redirect a session into another legitimate task worktree", async () => {
  const f = await commandsFixture();
  try {
    const first = await admitted(f, "exact_destination");
    await f.backend.call(tasks.propose, { ...f.identity(), taskId: "other_task", goalId: "goal", goalRevision: 1, title: "Independent public fixture task", scope: ["public"], dependencies: [], executionBase: f.backend.find("tasks", "task").executionBase });
    const other = await f.cli(f.repo, ["resume", "other_task", "--prepare-only", "--runtime", f.runtimePath, "--session", "other_session"]) as { path: string };
    const journalPath = join(f.runtime.stateDirectory, "resume-exact_destination.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { path: string }; journal.path = other.path;
    await writeFile(journalPath, JSON.stringify(journal));
    await assert.rejects(f.cli(f.repo, ["resume", "task", "--prepare-only", "--runtime", f.runtimePath, "--session", "exact_destination"]));
    assert.notEqual(first.path, other.path);
    assert.equal(f.backend.find("tasks", "task").ownerRunId, first.run.identity.runId);
  } finally { await f.restore(); }
});

test("T14 a known admitted reply remains recoverable when configuration changes before its first check-in", async () => {
  const f = await commandsFixture(), transport = globalThis.fetch;
  try {
    const agent = await connect(f, f.repo), sessionId = "unused_after_claim";
    globalThis.fetch = async (input, init) => {
      const response = await transport(input, init);
      const body = JSON.parse(String(init?.body)) as { path: string };
      if (body.path === "tasks:claim") await f.backend.context().db.patch(f.backend.find("projects", f.config.projectId)._id, { configVersion: 999 });
      return response;
    };
    await assert.rejects(admitSession(f.repo, agent, sessionId, { requestId: "unused_admission", taskId: "task", machineId: f.runtime.machineId, harness: "codex", capabilityKey: f.runtime.capability.key }, "managed"));
    const known = await readSessionBinding(f.repo, agent, sessionId);
    assert(known, "A confirmed admission reply must remain durably recoverable even when current write authority is denied");
    assert.equal(f.backend.find("runs", known.identity.runId).capacityHeld, true);
    assert.equal(f.backend.find("runs", known.identity.runId).process, undefined);
    // This fixture control path never invoked launch/spawn; its explicit unused-reservation proof is not PID absence.
    const supervisor = await roleClient(f.config, f.runtime, "supervisor");
    await supervisor.mutation("lifecycle:confirmStopped", { ...known.identity, evidence: { kind: "proven_never_started", launchId: known.launchId!, machineId: f.runtime.machineId, observedAt: new Date().toISOString(), evidenceRef: "synthetic-known-admission-no-launch-control-path" } }, "settle_unused_admission");
    assert.equal(f.backend.find("runs", known.identity.runId).capacityHeld, false);
  } finally { globalThis.fetch = transport; await f.restore(); }
});

// Genuine exported managed admission and commands; OS/sandbox/host records remain synthetic.
test("T15/T19 parsed managed review retains capacity after lost acceptance until positive supervisor stop evidence", async t => {
  const sandbox = simulatedLinux(t), f = await commandsFixture();
  try {
    const agent = await connect(f, f.repo), sessionId = "managed_publication";
    const run = await admitSession(f.repo, agent, sessionId, { requestId: "managed_admission", taskId: "task", machineId: f.runtime.machineId, harness: "codex", capabilityKey: f.runtime.capability.key }, "managed");
    await run.client.mutation("lifecycle:starting", { ...run.identity }, "managed_starting");
    const supervisor = await roleClient(f.config, f.runtime, "supervisor");
    const processIdentity = { pid: 4242, bootId: "synthetic-boot", startIdentity: "synthetic-start", launchId: run.launchId! };
    await supervisor.mutation("lifecycle:authorizeLaunch", { ...run.identity, process: processIdentity }, "managed_authorize");
    await mkdir(f.runtime.worktreeRoot, { recursive: true, mode: 0o700 });
    const path = join(f.runtime.worktreeRoot, `task-e${run.identity.epoch}-${run.identity.runId}`);
    await git(f.repo, ["worktree", "add", "--quiet", "-b", `coord/tasks/task/e${run.identity.epoch}/${run.identity.runId}`, "--", path, f.backend.find("tasks", "task").executionBase.sha]);
    await mkdir(join(path, ".coord-local"), { mode: 0o700 });
    await writeFile(join(path, ".coord-local/run.json"), JSON.stringify({ projectId: f.config.projectId, commonGitDir: await realpath(join(f.repo, ".git")), ...run.identity }), { mode: 0o600 });
    await copySession(f.repo, path, agent, sessionId);
    await writeFile(join(path, "store.js"), `${await readFile(join(path, "store.js"), "utf8")}\n// Independent managed publication rehearsal\n`);
    await run.client.mutation("tasks:progress", { ...run.identity, expectedRevision: 0, progress: JSON.stringify({ completed: ["Updated taskboard fixture"], remaining: ["Review exact artifact"] }) }, "managed_progress");
    // Actual fixture tests run here; the production isolated-runner syscall transport below is simulated.
    const verificationOutput = execFileSync(process.execPath, ["--test", "--test-reporter=tap", "test/store.test.js"], { cwd: path, env: { HOME: f.runtime.policy.workerHome, PATH: f.runtime.policy.searchPath }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.match(verificationOutput, /(?:pass 3|tests 3)/);
    const ready = await f.cli(path, ["checkpoint", "cp_managed", "--runtime", f.runtimePath, "--session", sessionId]);
    f.loseReply("publications:accept");
    const argv = ["review", "pub_managed", "--checkpoint", "cp_managed", "--runtime", f.runtimePath, "--session", sessionId];
    let lost: unknown;
    try { await f.cli(path, argv); } catch (error) { lost = error; }
    assert(lost, "The fixture must lose its successful acceptance reply");
    if (![...f.backend.rows.values()].some(row => row._table === "publications" && row.id === "pub_managed")) throw new Error("Managed parsed review failed before publication request", { cause: lost });
    assert.equal(f.backend.find("publications", "pub_managed").state, "accepted"); assert.equal(f.backend.find("runs", run.identity.runId).capacityHeld, true);
    const accepted = await f.cli(path, argv) as { state: string; capacityHeld: boolean };
    assert.equal(accepted.state, "review_ready"); assert.equal(accepted.capacityHeld, true);
    assert.equal(f.calls.filter(call => call.path === "lifecycle:confirmStopped").length, 0);
    assert.equal((JSON.parse(await readFile(join(f.runtime.policy.githubHome, "fixture-reviews.json"), "utf8")) as unknown[]).length, 1);
    const finalizing = await f.cli(path, ["run", "finalize", "succeeded", "--runtime", f.runtimePath, "--session", sessionId]);
    assert.equal(f.backend.find("runs", run.identity.runId).capacityHeld, true);
    const evidence = { kind: "observed_tree_exit", launchId: run.launchId!, machineId: f.runtime.machineId, process: processIdentity, observedAt: new Date().toISOString(), evidenceRef: "synthetic-positive-supervisor-stop-not-native-proof" };
    const release = await supervisor.mutation("lifecycle:confirmStopped", { ...run.identity, evidence }, "managed_exit");
    assert.equal(f.backend.find("runs", run.identity.runId).capacityHeld, false);
    assert.deepEqual(await supervisor.mutation("lifecycle:confirmStopped", { ...run.identity, evidence }, "managed_exit"), release);
    const output = JSON.stringify({ ready, accepted, finalizing, release });
    const session = JSON.parse(await readFile(join(f.repo, ".coord-local/sessions", sessionId, "admission.json"), "utf8")) as { grantToken: string };
    const verifier = JSON.parse(await readFile(f.runtime.verifierCredentialFile, "utf8")) as { token: string };
    const supervisorCredential = JSON.parse(await readFile(f.runtime.supervisorCredentialFile!, "utf8")) as { token: string };
    for (const token of [f.identity().token, session.grantToken, verifier.token, supervisorCredential.token]) assert(!output.includes(token));
    assert(sandbox.commands.length > 0); assert.equal(captureDigest(f.backend.find("checkpoints", "cp_managed").tree), captureDigest(f.backend.find("publications", "pub_managed").tree));
  } finally { await f.restore(); sandbox.restore(); }
});

test("T1/T5 SDK runtime actions reject swapped startup receipts and retain the original grant through a later race", async () => {
  const f = await commandsFixture(), transport = globalThis.fetch;
  let server: ReturnType<typeof createCoordMcpServer> | undefined, client: Client | undefined;
  try {
    const source = await changed(f, "mcp_bound");
    await f.backend.call(tasks.propose, { ...f.identity(), taskId: "mcp_other", goalId: "goal", goalRevision: 1, title: "Unrelated admitted public task", scope: ["public"], dependencies: [], executionBase: f.backend.find("tasks", "task").executionBase });
    const other = await f.cli(f.repo, ["resume", "mcp_other", "--prepare-only", "--runtime", f.runtimePath, "--session", "mcp_other_session"]) as { path: string };
    const bridge = await connectRuntimeBridge(source.path, f.runtimePath, "mcp_bound");
    const receiptPath = join(source.path, ".coord-local/sessions/mcp_bound/admission.json"), original = await readFile(receiptPath, "utf8");
    const alternate = JSON.parse(await readFile(join(other.path, ".coord-local/sessions/mcp_other_session/admission.json"), "utf8")) as { sessionId: string; grantToken: string };
    alternate.sessionId = "mcp_bound"; const swapped = JSON.stringify(alternate);
    const openBridge = async () => {
      server = createCoordMcpServer(bridge); client = new Client({ name: "independent-bound-runtime-fixture", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
    };
    await openBridge(); await writeFile(receiptPath, swapped);
    const rejected = await client!.callTool({ name: "coord_checkpoint", arguments: { checkpointId: "cp_mcp_rejected" } });
    assert.equal(rejected.isError, true); assert.match(JSON.stringify(rejected), /STALE_EPOCH/);
    assert.equal(f.calls.filter(call => call.path === "checkpoints:prepare").length, 0);
    await client!.close(); await server!.close(); await writeFile(receiptPath, original); await openBridge();
    let raced = false;
    globalThis.fetch = async (input, init) => {
      const response = await transport(input, init), body = JSON.parse(String(init?.body)) as { path: string; args: Array<{ runId?: string }> };
      if (!raced && body.path === "checkpoints:authority" && body.args[0]?.runId === source.run.identity.runId) { raced = true; await writeFile(receiptPath, swapped); }
      return response;
    };
    const ready = await client!.callTool({ name: "coord_checkpoint", arguments: { checkpointId: "cp_mcp_frozen" } });
    assert(!ready.isError, JSON.stringify(ready)); assert.equal(raced, true);
    const checkpoint = f.backend.find("checkpoints", "cp_mcp_frozen"); assert.equal(checkpoint.state, "ready"); assert.equal(checkpoint.runId, source.run.identity.runId);
    assert(f.calls.filter(call => call.path === "checkpoints:prepare").every(call => call.args.runId === source.run.identity.runId));
    assert.equal(f.backend.find("tasks", "mcp_other").progressRevision, 0);
    for (const token of [f.identity().token, alternate.grantToken, (JSON.parse(original) as { grantToken: string }).grantToken]) assert(!JSON.stringify({ rejected, ready }).includes(token));
  } finally { globalThis.fetch = transport; await client?.close(); await server?.close(); await f.restore(); }
});
