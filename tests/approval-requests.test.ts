import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { bootstrap, canonical, digest } from "../convex/auth.js";
import * as requests from "../convex/approvalRequests.js";
import { createCoordMcpServer, type CoordBackend, type CoordMcpOptions } from "../src/mcp.js";
import { CAPABILITIES, CLIENT_VERSION, DEFAULTS } from "../src/protocol.js";
import { BackendFixture } from "./backend.fixture.js";

// Exported backend handlers and official MCP transport; all identities and source records are synthetic.
const agent = "a".repeat(64), human = "b".repeat(64), other = "c".repeat(64);
let serial = 0;
const identity = (token = agent, requestId = `request_${++serial}`) => ({ token, protocolVersion: 1, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], backendId: "backend", projectId: "project", requestId });
const isCode = (code: string) => (error: unknown) => (error as { data?: { code?: string } }).data?.code === code;
type RequestView = requests.ApprovalRequestView;
const responseView = async (value: Promise<unknown>): Promise<RequestView> => await value as RequestView;
async function fixture() {
  const f = new BackendFixture();
  await f.call(bootstrap, { backendId: "backend", projectId: "project", repository: "github.com/fixture/approval", remote: "https://github.com/fixture/approval.git", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: ["AGENTS.md"], humanId: "human", humanDigest: await digest(human), agentId: "agent", agentDigest: await digest(agent), expiresAt: Date.now() + 3600_000 });
  const source = { kind: "rule" as const, content: "Use evidence-linked names", sources: [{ taskId: "source_task", revision: "source_revision", evidenceRef: "fixture-evidence" }], applicability: ["src"], confidence: "fixture" };
  const target = { memoryId: "rule", revision: 1, hash: await digest(canonical(source)) };
  await f.context().db.insert("memories", { id: target.memoryId, projectId: "project", ...source, revision: target.revision, hash: target.hash, status: "proposed" });
  return { f, source, target };
}
async function session(options: CoordMcpOptions) {
  const server = createCoordMcpServer(options), client = new Client({ name: "approval-request-fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
function payload(response: unknown): RequestView {
  const value = response as { isError?: boolean; content: Array<{ text: string }> };
  assert.ok(!value.isError, JSON.stringify(value));
  assert(Buffer.byteLength(value.content[0]!.text, "utf8") < DEFAULTS.contextBytes);
  return JSON.parse(value.content[0]!.text) as RequestView;
}
function wire(f: BackendFixture) {
  const calls: string[] = [];
  const client: CoordBackend = {
    query: async (name, args) => { calls.push(name); assert.equal(name, "approvalRequests:get"); return f.call(requests.get, { ...identity(), ...args } as never); },
    mutation: async (name, args, requestId) => {
      calls.push(name);
      assert(["approvalRequests:requestRule", "approvalRequests:cancel"].includes(name), "No approval/check-in/receipt endpoint may be called");
      return name === "approvalRequests:requestRule" ? f.call(requests.requestRule, { ...identity(agent, requestId), ...args } as never) : f.call(requests.cancel, { ...identity(agent, requestId), ...args } as never);
    },
  };
  return { client, calls };
}

test("advisory request binds a bounded exact envelope and never approves or changes policy", async () => {
  const { f, target } = await fixture(), memory = f.find("memories", "rule"), project = f.find("projects", "project");
  const created = await responseView(f.call(requests.requestRule, { ...identity(agent, "intent"), ...target }));
  assert.equal(created.state, "pending"); assert.equal(created.receipt, "pending_request_only"); assert.equal(created.authorityGranted, false); assert.equal(created.approved, false);
  assert.deepEqual(created.envelope, { schemaVersion: 1, id: "intent", action: "approve_rule", backendId: "backend", projectId: "project", repository: project.repository, remote: project.remote, defaultBranch: "main", ...target, requestedBy: "agent", createdAt: created.envelope.createdAt, expiresAt: created.envelope.createdAt + 300_000 });
  assert.equal(created.requestDigest, await digest(canonical(created.envelope)));
  assert(!JSON.stringify(created).includes(agent) && !JSON.stringify(created).includes(human));
  assert.deepEqual(f.find("memories", "rule"), memory); assert.deepEqual(f.find("projects", "project"), project);
  assert(![...f.rows.values()].some(row => row._table === "goals" || row._table === "runs" || row._table === "machines"));
  const before = structuredClone(f.rows);
  assert.deepEqual(await responseView(f.call(requests.get, { ...identity(), approvalRequestId: "intent" })), created);
  assert.deepEqual(f.rows, before, "status queries must not write");
});

test("lost-reply retries preserve expiry/digest and show current cancelled or expired state", async () => {
  const now = Date.now, start = now(); let clock = start;
  Date.now = () => clock;
  try {
    const { f, target } = await fixture(), args = { ...identity(agent, "retry"), ...target };
    const first = await responseView(f.call(requests.requestRule, args)); clock += 30_000;
    const before = structuredClone(f.rows); assert.deepEqual(await responseView(f.call(requests.requestRule, args)), first); assert.deepEqual(f.rows, before);
    await assert.rejects(f.call(requests.requestRule, { ...args, revision: 2 }), isCode("IDEMPOTENCY_CONFLICT"));
    const cancelArgs = { ...identity(agent, "cancel_retry"), approvalRequestId: "retry" };
    const cancelled = await responseView(f.call(requests.cancel, cancelArgs)), afterCancel = structuredClone(f.rows);
    assert.equal(cancelled.state, "cancelled"); assert.deepEqual(await responseView(f.call(requests.cancel, cancelArgs)), cancelled); assert.deepEqual(f.rows, afterCancel);
    assert.equal((await responseView(f.call(requests.requestRule, args))).state, "cancelled");
    const expiryArgs = { ...identity(agent, "expiry"), ...target }, pending = await responseView(f.call(requests.requestRule, expiryArgs));
    clock = pending.envelope.expiresAt;
    const expiredRows = structuredClone(f.rows), expired = await responseView(f.call(requests.requestRule, expiryArgs));
    assert.equal(expired.state, "expired"); assert.equal(expired.requestDigest, pending.requestDigest); assert.deepEqual(expired.envelope, pending.envelope); assert.deepEqual(f.rows, expiredRows);
  } finally { Date.now = now; }
});

test("request roles/project scope and owner-or-human cancellation stay separate from human approval", async () => {
  const { f, target } = await fixture();
  const owned = await responseView(f.call(requests.requestRule, { ...identity(agent, "owned"), ...target }));
  const foreignEnvelope = { ...owned.envelope, id: "foreign_request", projectId: "foreign" };
  await f.context().db.insert("approvalRequests", { ...foreignEnvelope, requestDigest: await digest(canonical(foreignEnvelope)), state: "pending" });
  await f.context().db.insert("credentials", { id: "other", memberId: "other", backendId: "backend", digest: await digest(other), role: "agent", projectIds: ["project"], expiresAt: Date.now() + 3600_000 });
  const before = structuredClone(f.rows);
  await assert.rejects(f.call(requests.cancel, { ...identity(other), approvalRequestId: "owned" }), isCode("FORBIDDEN"));
  await assert.rejects(f.call(requests.get, { ...identity(), projectId: "foreign", approvalRequestId: "owned" }), isCode("UNAUTHORIZED"));
  await assert.rejects(f.call(requests.get, { ...identity(), approvalRequestId: "foreign_request" }), isCode("NOT_FOUND"));
  await assert.rejects(f.call(requests.cancel, { ...identity(), approvalRequestId: "foreign_request" }), isCode("NOT_FOUND"));
  await assert.rejects(f.call(requests.requestRule, { ...identity(other, "owned"), ...target }), isCode("IDEMPOTENCY_CONFLICT"));
  assert.deepEqual(f.rows, before);
  for (const [role, token] of [["run", "d".repeat(64)], ["supervisor", "e".repeat(64)], ["artifact_verifier", "f".repeat(64)]] as const) {
    await f.context().db.insert("credentials", { id: role, memberId: "agent", backendId: "backend", digest: await digest(token), role, projectIds: ["project"], expiresAt: Date.now() + 3600_000 });
    await assert.rejects(f.call(requests.requestRule, { ...identity(token), ...target }), isCode("FORBIDDEN"));
    await assert.rejects(f.call(requests.get, { ...identity(token), approvalRequestId: "owned" }), isCode("FORBIDDEN"));
    await assert.rejects(f.call(requests.cancel, { ...identity(token), approvalRequestId: "owned" }), isCode("FORBIDDEN"));
  }
  assert.equal((await responseView(f.call(requests.cancel, { ...identity(human), approvalRequestId: "owned" }))).state, "cancelled");
  assert.equal(f.find("memories", "rule").status, "proposed");
});

test("changed, corrupt or nonproposed sources cannot create a request or silently rebind an existing one", async () => {
  const { f, source, target } = await fixture(), rule = f.find("memories", "rule");
  for (const patch of [{ revision: 2 }, { hash: "0".repeat(64) }, { memoryId: "missing" }]) await assert.rejects(f.call(requests.requestRule, { ...identity(), ...target, ...patch }), isCode("FORBIDDEN"));
  const created = await responseView(f.call(requests.requestRule, { ...identity(agent, "stale"), ...target }));
  for (const patch of [{ content: "Corrupt source with original hash" }, { status: "active" }, { kind: "lesson" }, { projectId: "foreign" }] as const) {
    await f.context().db.patch(rule._id, patch);
    assert.equal((await responseView(f.call(requests.get, { ...identity(), approvalRequestId: "stale" }))).state, "stale");
    await assert.rejects(f.call(requests.requestRule, { ...identity(), ...target }), isCode("FORBIDDEN"));
    await f.context().db.patch(rule._id, { ...source, status: "proposed", projectId: "project" });
  }
  await f.context().db.patch(f.find("projects", "project")._id, { remote: "https://github.com/fixture/changed.git" });
  const stale = await responseView(f.call(requests.get, { ...identity(), approvalRequestId: "stale" }));
  assert.equal(stale.state, "stale"); assert.deepEqual(stale.envelope, created.envelope);
  await f.context().db.patch(f.find("approvalRequests", "stale")._id, { requestedBy: "changed-member" });
  await assert.rejects(f.call(requests.get, { ...identity(), approvalRequestId: "stale" }), isCode("BLOCKED_ENV"));
});

test("strict conversational request/status/cancel roundtrip needs no registration and accepts no model authority", async () => {
  const { f, target } = await fixture(), backend = wire(f), connection = await session({ client: backend.client });
  try {
    const tools = (await connection.client.listTools()).tools;
    assert.equal(tools.find(tool => tool.name === "coord_approval_request")?.annotations?.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === "coord_request_rule_approval")?.annotations?.readOnlyHint, false);
    for (const [name, args] of [["coord_request_rule_approval", { requestId: "chat", ...target }], ["coord_approval_request", { approvalRequestId: "chat" }], ["coord_cancel_approval_request", { requestId: "cancel", approvalRequestId: "chat" }]] as const) {
      assert.equal((await connection.client.callTool({ name, arguments: { ...args, token: "secret-canary", projectId: "foreign", requestedBy: "human", expiresAt: Date.now() + 1e9, approved: true, operation: "approve" } })).isError, true);
    }
    assert.deepEqual(backend.calls, []);
    const created = payload(await connection.client.callTool({ name: "coord_request_rule_approval", arguments: { requestId: "chat", ...target } }));
    assert.equal(created.state, "pending"); assert.equal(created.authorityGranted, false);
    payload(await connection.client.callTool({ name: "coord_approval_request", arguments: { approvalRequestId: "chat" } }));
    const cancelled = payload(await connection.client.callTool({ name: "coord_cancel_approval_request", arguments: { requestId: "cancel_chat", approvalRequestId: "chat" } }));
    assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.approved, false);
    assert.deepEqual(backend.calls, ["approvalRequests:requestRule", "approvalRequests:get", "approvalRequests:cancel"]);
    assert.equal(f.find("memories", "rule").status, "proposed");
  } finally { await connection.close(); }
});

test("project request tools avoid run receipts and preserve cleanup-only write gates", async () => {
  const { f, target } = await fixture(), backend = wire(f);
  const run = { client: { query: async () => { throw new Error("No check-in allowed"); }, mutation: async () => { throw new Error("No run write allowed"); } }, identity: { taskId: "task", runId: "run", epoch: 1, goalRevision: 1 } };
  const connection = await session({ client: backend.client, run, renewMs: 60_000 });
  try {
    payload(await connection.client.callTool({ name: "coord_request_rule_approval", arguments: { requestId: "attached", ...target } }));
    payload(await connection.client.callTool({ name: "coord_approval_request", arguments: { approvalRequestId: "attached" } }));
    assert.deepEqual(backend.calls, ["approvalRequests:requestRule", "approvalRequests:get"]);
  } finally { await connection.close(); }
  const closed = await session({ client: backend.client, run, cleanupOnly: true, renewMs: 60_000 });
  try {
    const before = structuredClone(f.rows), count = backend.calls.length;
    for (const [name, args] of [["coord_request_rule_approval", { requestId: "closed", ...target }], ["coord_cancel_approval_request", { requestId: "closed_cancel", approvalRequestId: "attached" }]] as const) {
      const denied = await closed.client.callTool({ name, arguments: args }); assert.equal(denied.isError, true); assert.match(JSON.stringify(denied), /LEASE_REVOKED/);
    }
    assert.equal(backend.calls.length, count);
    assert.equal(payload(await closed.client.callTool({ name: "coord_approval_request", arguments: { approvalRequestId: "attached" } })).state, "pending");
    assert.deepEqual(f.rows, before);
  } finally { await closed.close(); }
});
