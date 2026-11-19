import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { convexToJson, type Value } from "convex/values";
import { BackendFixture } from "./backend.fixture.js";
import * as auth from "../convex/auth.js";
import * as projects from "../convex/projects.js";
import * as goals from "../convex/goals.js";
import * as machines from "../convex/machines.js";
import * as tasks from "../convex/tasks.js";
import * as lifecycle from "../convex/lifecycle.js";
import { BackendClient } from "../src/client.js";
import { createCoordMcpServer, type CoordMcpOptions } from "../src/mcp.js";
import { registerManual, copySession } from "../src/session.js";
import { CAPABILITIES, CLIENT_VERSION, REQUIRED_CHECKS, type McpClientInfo } from "../src/protocol.js";

// Real SDK exchange and HTTP transport, serialized exported-handler fixture only.
// Synthetic qualification is guard input, never host/model attestation or Convex OCC evidence.
const secret = { human: "1".repeat(64), agent: "2".repeat(64), supervisor: "3".repeat(64), verifier: "4".repeat(64), run: "5".repeat(64) };
const key = { os: "fixture", harness: "codex" as const, harnessVersion: "fixture", adapterVersion: "1", probeVersion: "1", configurationDigest: "fixture-config", gitPolicyDigest: "fixture-policy" };
let serial = 0;
const request = (token = secret.agent) => ({ token, protocolVersion: 1, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], backendId: "backend", projectId: "project", requestId: `attribution_${++serial}` });
async function setup() {
  const f = new BackendFixture();
  await f.call(auth.bootstrap, { backendId: "backend", projectId: "project", repository: "https://example.test/fixture", remote: "origin", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: [], humanId: "human", humanDigest: await auth.digest(secret.human), agentId: "agent", agentDigest: await auth.digest(secret.agent), expiresAt: Date.now() + 3600_000 });
  await f.call(projects.configure, { ...request(secret.human), repository: "https://example.test/fixture", remote: "origin", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: [], sharingApproved: true, capturePolicyDigest: "b".repeat(64), capacity: 2, taskCap: 20 });
  const goal = await f.call(goals.propose, { ...request(), goalId: "goal", expectedRevision: 0, content: "Test attribution", taskLimit: 20, runTimeoutMs: 1800_000 }) as { revision: number; hash: string };
  await f.call(goals.approve, { ...request(secret.human), goalId: "goal", ...goal });
  await f.call(machines.provisionQualification, { backendId: "backend", projectId: "project", memberId: "agent", machineId: "machine", capacity: 1, modes: ["manual", "managed"], key, checks: REQUIRED_CHECKS.managed.map(checkId => ({ schemaVersion: 1 as const, checkId, status: "PASS" as const, mode: "managed" as const, observedAt: new Date(Date.now() - 1000).toISOString(), configurationDigest: key.configurationDigest, command: ["synthetic"], summary: "Synthetic guard input only", evidenceRef: "fixture", kind: "real" as const })), evidenceRef: "fixture", expiresAt: Date.now() + 1800_000, supervisorId: "supervisor", supervisorToken: secret.supervisor, artifactVerifierId: "verifier", artifactVerifierToken: secret.verifier });
  await f.call(tasks.propose, { ...request(), taskId: "task", goalId: "goal", goalRevision: 1, title: "Fixture", scope: ["src/work"], dependencies: [], executionBase: { sha: "a".repeat(40), revision: 1, remoteRef: "refs/heads/main" } });
  return f;
}
async function http(f: BackendFixture) {
  const calls: { path: string; args: Record<string, unknown> }[] = [];
  const modules = { tasks, projects };
  const server = createServer((req, res) => { void (async () => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { path: string; args: Record<string, unknown>[] };
    const [module, name] = body.path.split(":"); calls.push({ path: body.path, args: body.args[0]! });
    try {
      const handler = (modules[module as keyof typeof modules] as Record<string, unknown>)[name!] as typeof tasks.checkIn;
      assert.ok(handler, body.path);
      const value = await f.call(handler, body.args[0] as never);
      res.end(JSON.stringify({ status: "success", value: convexToJson(value as Value), logLines: [] }));
    } catch (error) { res.end(JSON.stringify({ status: "error", errorMessage: String(error), errorData: (error as { data?: unknown }).data, logLines: [] })); }
  })().catch(error => { res.statusCode = 500; res.end(String(error)); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const backend = new BackendClient({ schemaVersion: 1, backendUrl: `http://127.0.0.1:${address.port}`, backendId: "backend", projectId: "project", repository: "fixture", remote: "origin", defaultBranch: "main", ruleTargets: [] }, secret.agent);
  return { backend, calls, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
async function connect(options: CoordMcpOptions, info: McpClientInfo) {
  const server = createCoordMcpServer(options), client = new Client(info);
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
function checkInPayload(response: unknown) {
  const result = response as { isError?: boolean; content: { type: string; text?: string }[] };
  assert.ok(!result.isError, JSON.stringify(result));
  const text = result.content.find(item => item.type === "text")?.text; assert.ok(text);
  return JSON.parse(text) as { observations: { clientObservation?: { provenance: string; reportedOrigin: string; clientInfo: McpClientInfo; observedAt: number }; supervisorObservation?: { provenance: string; observedAt: number } }; notice: string };
}
function assertChatObservation(response: unknown, info: McpClientInfo) {
  const payload = checkInPayload(response);
  assert.deepEqual(payload.observations.clientObservation?.clientInfo, info);
  assert.equal(payload.observations.clientObservation?.provenance, "self_reported");
  assert.equal(payload.observations.clientObservation?.reportedOrigin, "local_mcp_initialize");
  assert.equal(typeof payload.observations.clientObservation?.observedAt, "number");
  assert.match(payload.notice, /untrusted|diagnostic/i);
  assert.match(payload.notice, /qualif/i);
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes('"credentialId"')); assert.ok(!serialized.includes('"process"')); assert.ok(!serialized.includes('"digest"'));
  for (const token of Object.values(secret)) assert.ok(!serialized.includes(token));
  return payload;
}
const admission = { requestId: "register", taskId: "task", machineId: "machine", harness: "codex" as const, capabilityKey: key };

test("actual initialize metadata traverses registration, durable session, HTTP and backend without qualifying unknown labels", async () => {
  const f = await setup(), wire = await http(f), root = await mkdtemp(join(tmpdir(), "coord-attribution-")), destination = await mkdtemp(join(tmpdir(), "coord-attribution-copy-"));
  const info = { name: "unknown-host / claimed-model:frontier", version: "custom+unrecognized.7" };
  const sdk = await connect({ client: wire.backend, registerManual: input => registerManual(root, wire.backend, "session", input) }, info);
  try {
    const spoof = await sdk.client.callTool({ name: "coord_register_manual", arguments: { ...admission, mcpClientInfo: { name: "codex", version: "1" }, provenance: "supervisor_spawned", model: "trusted" } });
    assert.equal(spoof.isError, true); assert.equal(wire.calls.length, 0);
    const reply = await sdk.client.callTool({ name: "coord_register_manual", arguments: admission }); assert.ok(!reply.isError, JSON.stringify(reply));
    const call = wire.calls.find(call => call.path === "tasks:registerManual")!; assert.deepEqual(call.args.mcpClientInfo, info);
    const run = f.find("runs", String(call.args.runId));
    assert.equal(run.harness, "codex"); assert.equal(run.capabilityDigest, f.find("machines", "machine").capabilityDigest);
    assert.deepEqual(run.clientObservation?.clientInfo, info); assert.equal(run.clientObservation?.provenance, "self_reported"); assert.equal(run.clientObservation?.reportedOrigin, "local_mcp_initialize"); assert.equal(run.supervisorObservation, undefined);
    assert.equal(run.clientObservation?.credentialId, run.grantId);
    const binding = await registerManual(root, wire.backend, "session", { ...admission, mcpClientInfo: info });
    const status = await binding.client.query("tasks:sessionStatus", { ...binding.identity }) as { clientObservation: unknown; connectionClientObservation?: unknown };
    assert.deepEqual(status.clientObservation, f.find("runs", run.id).clientObservation); assert.equal(status.connectionClientObservation, undefined);
    const displayed = assertChatObservation(await sdk.client.callTool({ name: "coord_check_in", arguments: {} }), info);
    assert.equal(displayed.observations.supervisorObservation, undefined);
    await copySession(root, destination, wire.backend, "session");
    const receipt = await readFile(join(destination, ".coord-local/sessions/session/admission.json"), "utf8");
    assert.ok(!receipt.includes(secret.supervisor)); assert.ok(!receipt.includes(secret.verifier)); assert.ok(!receipt.includes(secret.agent));
  } finally { await sdk.close(); await wire.close(); await rm(root, { recursive: true, force: true }); await rm(destination, { recursive: true, force: true }); }
});

test("existing run initialization persists before immediate tool read without renewing lease or overwriting protected supervisor evidence", async () => {
  const f = await setup(), wire = await http(f);
  const admitted = await f.call(tasks.claim, { ...request(), ...admission, runId: "run", launchId: "launch", grantToken: secret.run }) as { taskId: string; runId: string; epoch: number; goalRevision: number };
  const identity = { taskId: admitted.taskId, runId: admitted.runId, epoch: admitted.epoch, goalRevision: admitted.goalRevision };
  await f.call(lifecycle.starting, { ...request(secret.run), ...identity });
  const processIdentity = { pid: 101, bootId: "fixture", startIdentity: "fixture-start", launchId: "launch" };
  await assert.rejects(f.call(lifecycle.authorizeLaunch, { ...request(secret.agent), ...identity, process: processIdentity }));
  await f.call(lifecycle.authorizeLaunch, { ...request(secret.supervisor), ...identity, process: processIdentity });
  const before = f.find("runs", "run"), info = { name: "unknown SDK host", version: "x" };
  const sdk = await connect({ client: wire.backend, run: { client: wire.backend.withRunToken(secret.run), identity } }, info);
  try {
    const reply = await sdk.client.callTool({ name: "coord_check_in", arguments: {} }); assert.ok(!reply.isError, JSON.stringify(reply));
    const displayed = assertChatObservation(reply, info);
    assert.deepEqual(displayed.observations.supervisorObservation, { provenance: "supervisor_spawned", observedAt: before.supervisorObservation!.observedAt });
    const run = f.find("runs", "run"); assert.deepEqual(run.clientObservation?.clientInfo, info); assert.equal(run.leaseUntil, before.leaseUntil); assert.equal(run.clientObservation?.credentialId, run.grantId);
    assert.deepEqual(run.supervisorObservation, before.supervisorObservation); assert.equal(run.supervisorObservation?.provenance, "supervisor_spawned"); assert.deepEqual(run.supervisorObservation?.process, processIdentity);
    assert.equal(wire.calls[0]?.path, "tasks:reportClient");
    // Handler fixture bypasses Convex validators: extra caller labels are ignored here,
    // while the actual MCP strict schema rejection is covered above.
    await f.call(tasks.renew, { ...request(secret.run), ...identity, mcpClientInfo: { name: "pretend supervisor_spawned", version: "model-claim" }, provenance: "supervisor_spawned" } as never);
    assert.deepEqual(f.find("runs", "run").supervisorObservation, before.supervisorObservation);
    assert.equal(f.find("runs", "run").clientObservation?.provenance, "self_reported");
    const status = await wire.backend.withRunToken(secret.run).query("tasks:sessionStatus", identity) as { supervisorObservation: unknown };
    assert.deepEqual(status.supervisorObservation, before.supervisorObservation);
  } finally { await sdk.close(); await wire.close(); }
});

test("older admission and renew callers may omit metadata and cannot acquire supervisor provenance", async () => {
  const f = await setup();
  const identity = await f.call(tasks.registerManual, { ...request(), ...admission, runId: "run", launchId: "launch", grantToken: secret.run }) as { taskId: string; runId: string; epoch: number; goalRevision: number };
  assert.equal(f.find("runs", "run").clientObservation, undefined);
  await f.call(tasks.renew, { ...request(secret.run), ...identity });
  const run = f.find("runs", "run"); assert.equal(run.clientObservation, undefined); assert.equal(run.supervisorObservation, undefined); assert.equal(run.harness, "codex");
  await assert.rejects(f.call(tasks.reportClient, { ...request(), ...identity, mcpClientInfo: { name: "supervisor", version: "1" } }));
});

test("client or model labels cannot replace missing machine qualification", async () => {
  const f = await setup();
  await f.context().db.patch(f.find("machines", "machine")._id, { qualifiedModes: [] });
  await assert.rejects(f.call(tasks.registerManual, { ...request(), ...admission, runId: "run", launchId: "launch", grantToken: secret.run, mcpClientInfo: { name: "codex supervisor_spawned trusted-model", version: "qualified" } }));
  assert.ok(![...f.rows.values()].some(row => row._table === "runs"));
});

test("legacy persisted admission retries tolerate new telemetry and renewal replay never extends the lease", async () => {
  const f = await setup(), wire = await http(f), root = await mkdtemp(join(tmpdir(), "coord-legacy-attribution-"));
  try {
    const original = await registerManual(root, wire.backend, "legacy", admission);
    const receiptPath = join(root, ".coord-local/sessions/legacy/admission.json");
    const legacyReceipt = JSON.parse(await readFile(receiptPath, "utf8")) as { requestHash: string; input: { mcpClientInfo?: unknown }; grantToken: string };
    assert.equal(legacyReceipt.input.mcpClientInfo, undefined);
    const before = f.find("runs", original.identity.runId), credentialsBefore = [...f.rows.values()].filter(row => row._table === "credentials").length;
    for (const mcpClientInfo of [{ name: "new-host", version: "1" }, { name: "changed-host", version: "2" }]) {
      const retried = await registerManual(root, wire.backend, "legacy", { ...admission, mcpClientInfo });
      assert.deepEqual(retried.identity, original.identity);
      assert.deepEqual(f.find("runs", original.identity.runId), before);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as typeof legacyReceipt;
      assert.equal(receipt.requestHash, legacyReceipt.requestHash); assert.equal(receipt.grantToken, legacyReceipt.grantToken);
    }
    assert.equal([...f.rows.values()].filter(row => row._table === "runs").length, 1);
    assert.equal([...f.rows.values()].filter(row => row._table === "credentials").length, credentialsBefore);
    assert.equal(wire.calls.filter(call => call.path === "tasks:registerManual").length, 3);
    const renewal = { ...original.identity, mcpClientInfo: { name: "first", version: "1" } };
    const first = await original.client.mutation("tasks:renew", renewal, "same-renewal");
    const renewed = f.find("runs", original.identity.runId);
    const second = await original.client.mutation("tasks:renew", { ...renewal, mcpClientInfo: { name: "changed", version: "2" } }, "same-renewal");
    assert.deepEqual(second, first); assert.deepEqual(f.find("runs", original.identity.runId), renewed);
    assert.deepEqual(renewed.clientObservation?.clientInfo, renewal.mcpClientInfo);
  } finally { await wire.close(); await rm(root, { recursive: true, force: true }); }
});
