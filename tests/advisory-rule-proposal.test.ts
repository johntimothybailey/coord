import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { bootstrap, canonical, digest } from "../convex/auth.js";
import * as memories from "../convex/memories.js";
import * as requests from "../convex/approvalRequests.js";
import { createCoordMcpServer, type CoordBackend, type CoordMcpOptions } from "../src/mcp.js";
import { CAPABILITIES, CLIENT_VERSION } from "../src/protocol.js";
import { BackendFixture } from "./backend.fixture.js";

// Real handlers/official MCP transport with disposable identities; no live Git or backend claim.
const agent = "a".repeat(64), human = "b".repeat(64);
let serial = 0;
const identity = (token = agent, requestId = `proposal_${++serial}`) => ({ token, protocolVersion: 1, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], backendId: "backend", projectId: "project", requestId });
const isCode = (code: string) => (error: unknown) => (error as { data?: { code?: string } }).data?.code === code;
const proposal = () => ({ memoryId: `rule_${++serial}`, content: "Preserve keyboard access in the editor.", sources: [{ kind: "repository" as const, repository: "github.com/fixture/proposal", revision: "c".repeat(40), path: "src/editor.ts", contentHash: "d".repeat(64) }], applicability: ["src/editor.ts"], confidence: "Source inspection; human review required" });
interface ProposalView { memoryId: string; revision: number; hash: string; status: string; receipt: string; authorityGranted: boolean; sourceVerification: string }
async function fixture() {
  const f = new BackendFixture();
  await f.call(bootstrap, { backendId: "backend", projectId: "project", repository: "github.com/fixture/proposal", remote: "https://github.com/fixture/proposal.git", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: ["src/private"], ruleTargets: ["AGENTS.md"], humanId: "human", humanDigest: await digest(human), agentId: "agent", agentDigest: await digest(agent), expiresAt: Date.now() + 3600_000 });
  await f.context().db.patch(f.find("projects", "project")._id, { sharingApproved: true });
  return f;
}
async function session(options: CoordMcpOptions) {
  const server = createCoordMcpServer(options), client = new Client({ name: "advisory-proposal-fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
function payload(response: unknown): Record<string, unknown> {
  const value = response as { isError?: boolean; content: Array<{ text: string }> };
  assert.ok(!value.isError, JSON.stringify(value)); return JSON.parse(value.content[0]!.text) as Record<string, unknown>;
}
function wire(f: BackendFixture) {
  const calls: string[] = [];
  const client: CoordBackend = {
    query: async () => { throw new Error("Proposal cannot check in or adopt a grant"); },
    mutation: async (name, args, requestId) => { calls.push(name); assert.equal(name, "memories:proposeRule"); return f.call(memories.proposeRule, { ...identity(agent, requestId), ...args } as never); },
  };
  return { client, calls };
}

test("project advisory rule proposal binds complete repository provenance without admission or authority", async () => {
  const f = await fixture(), input = proposal(), project = f.find("projects", "project");
  const created = await f.call(memories.proposeRule, { ...identity(), ...input }) as ProposalView;
  assert.equal(created.status, "proposed"); assert.equal(created.authorityGranted, false); assert.equal(created.receipt, "proposal_only"); assert.equal(created.sourceVerification, "declared_not_server_verified");
  const record = f.find("memories", input.memoryId);
  const source = { kind: "rule", content: input.content, sources: input.sources, applicability: input.applicability, confidence: input.confidence };
  assert.equal(record.hash, await digest(canonical(source))); assert.deepEqual(record.sources, input.sources);
  assert.equal(record.approvedBy, undefined); assert.equal(record.approvedHash, undefined); assert.equal(record.approvedAt, undefined);
  assert.deepEqual(f.find("projects", "project"), project);
  assert(![...f.rows.values()].some(row => ["tasks", "goals", "runs", "machines"].includes(row._table as string)));
  const detail = await f.call(memories.reviewDetail, { ...identity(), memoryId: record.id, revision: record.revision, hash: record.hash }) as { complete: boolean; text: string };
  assert.equal(detail.complete, true); assert.deepEqual(JSON.parse(detail.text), source);
  const pending = await f.call(requests.requestRule, { ...identity(), memoryId: record.id, revision: record.revision, hash: record.hash }) as requests.ApprovalRequestView;
  assert.equal(pending.state, "pending"); assert.equal(pending.authorityGranted, false);
  await f.call(memories.approveRule, { ...identity(human), memoryId: record.id, revision: record.revision, hash: record.hash });
  assert.equal(f.find("memories", record.id).approvedHash, record.hash, "existing exact human approval supports repository provenance");
  assert.equal(f.find("projects", "project").policyVersion, project.policyVersion + 1);
});

test("proposal rejects wrong authority, project scope and unchanged run-only memory gate", async () => {
  const f = await fixture(), input = proposal();
  const humanResult = await f.call(memories.proposeRule, { ...identity(human), ...input }) as ProposalView; assert.equal(humanResult.status, "proposed");
  const rows = structuredClone(f.rows);
  await assert.rejects(f.call(memories.proposeRule, { ...identity(), projectId: "foreign", ...proposal() }), isCode("UNAUTHORIZED"));
  await assert.rejects(f.call(memories.record, { ...identity(), ...proposal(), kind: "rule", taskId: "task", runId: "run", epoch: 1, goalRevision: 1, sources: [{ taskId: "task", revision: "revision", evidenceRef: "fixture" }] }), isCode("FORBIDDEN"));
  assert.deepEqual(f.rows, rows);
  for (const [role, token] of [["run", "e".repeat(64)], ["supervisor", "f".repeat(64)], ["artifact_verifier", "1".repeat(64)]] as const) {
    await f.context().db.insert("credentials", { id: role, memberId: "agent", backendId: "backend", digest: await digest(token), role, projectIds: ["project"], expiresAt: Date.now() + 3600_000 });
    await assert.rejects(f.call(memories.proposeRule, { ...identity(token), ...proposal() }), isCode("FORBIDDEN"));
  }
});

test("repository declaration rejects foreign mutable unsafe and oversized source inputs", async () => {
  const f = await fixture(), source = proposal().sources[0]!;
  const invalid = [
    { sources: [{ ...source, repository: "github.com/foreign/repo" }] },
    { sources: [{ ...source, revision: "main" }] },
    { sources: [{ ...source, revision: "c".repeat(41) }] },
    { sources: [{ ...source, contentHash: "d".repeat(63) }] },
    { sources: [{ ...source, path: "src/../secret" }] },
    { sources: [{ ...source, path: "src/.git/config" }] },
    { sources: [{ ...source, path: "src/line\nforged" }] },
    { sources: [] }, { sources: Array.from({ length: 21 }, () => source) },
    { content: " " }, { content: "x".repeat(4097) }, { confidence: " " },
    { applicability: [] }, { applicability: Array.from({ length: 51 }, () => "src") },
    { sources: Array.from({ length: 20 }, (_, i) => ({ ...source, path: `src/${i}/${"a".repeat(1800)}` })) },
  ];
  for (const fields of invalid) {
    const before = structuredClone(f.rows);
    await assert.rejects(f.call(memories.proposeRule, { ...identity(), ...proposal(), ...fields }), isCode("INVALID_INPUT"));
    assert.deepEqual(f.rows, before);
  }
  for (const fields of [{ sources: [{ ...source, path: "src/private/key" }] }, { sources: [{ ...source, path: "outside/editor.ts" }] }, { applicability: ["src"] }, { applicability: ["outside"] }]) {
    await assert.rejects(f.call(memories.proposeRule, { ...identity(), ...proposal(), ...fields }), isCode("FORBIDDEN"));
  }
  await f.context().db.patch(f.find("projects", "project")._id, { sharingApproved: false });
  await assert.rejects(f.call(memories.proposeRule, { ...identity(), ...proposal() }), isCode("FORBIDDEN"));
});

test("stable proposal intent replays exactly and never recycles memory identities or approval state", async () => {
  const f = await fixture(), input = { ...identity(), ...proposal() };
  const first = await f.call(memories.proposeRule, input) as ProposalView, rows = structuredClone(f.rows);
  assert.deepEqual(await f.call(memories.proposeRule, input), first); assert.deepEqual(f.rows, rows);
  await assert.rejects(f.call(memories.proposeRule, { ...input, sources: [{ ...input.sources[0]!, contentHash: "e".repeat(64) }] }), isCode("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(f.call(memories.proposeRule, { ...input, content: "Different rule" }), isCode("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(f.call(memories.proposeRule, { ...input, requestId: "another_intent" }), isCode("IDEMPOTENCY_CONFLICT"));
  await f.call(memories.approveRule, { ...identity(human), memoryId: first.memoryId, revision: first.revision, hash: first.hash });
  const approvedRows = structuredClone(f.rows), replay = await f.call(memories.proposeRule, input) as ProposalView;
  assert.equal(replay.status, "active"); assert.equal(replay.authorityGranted, false); assert.equal(replay.hash, first.hash); assert.deepEqual(f.rows, approvedRows);
});

test("strict advisory MCP routes before admission, rejects forged authority and never checks in", async () => {
  const f = await fixture(), backend = wire(f), connection = await session({ client: backend.client });
  try {
    const input = { requestId: "chat_intent", ...proposal() }, listed = await connection.client.listTools();
    assert.equal(listed.tools.find(tool => tool.name === "coord_propose_rule")?.annotations?.readOnlyHint, false);
    for (const extra of [{ approved: true }, { status: "active" }, { token: "secret" }, { projectId: "foreign" }, { runId: "fake_run" }]) assert.equal((await connection.client.callTool({ name: "coord_propose_rule", arguments: { ...input, ...extra } })).isError, true);
    assert.equal((await connection.client.callTool({ name: "coord_propose_rule", arguments: { ...input, sources: [{ ...input.sources[0]!, taskId: "fabricated" }] } })).isError, true);
    assert.deepEqual(backend.calls, []);
    assert.equal(payload(await connection.client.callTool({ name: "coord_propose_rule", arguments: input })).status, "proposed");
    assert.deepEqual(backend.calls, ["memories:proposeRule"]);
  } finally { await connection.close(); }
  const run = { client: { query: async () => { throw new Error("No check-in allowed"); }, mutation: async () => { throw new Error("No run write allowed"); } }, identity: { taskId: "task", runId: "run", epoch: 1, goalRevision: 1 } };
  const attached = await session({ client: backend.client, run, renewMs: 60_000 });
  try { assert.equal(payload(await attached.client.callTool({ name: "coord_propose_rule", arguments: { requestId: "attached", ...proposal() } })).status, "proposed"); }
  finally { await attached.close(); }
  const closed = await session({ client: backend.client, run, cleanupOnly: true, renewMs: 60_000 });
  try {
    const count = backend.calls.length, before = structuredClone(f.rows);
    const result = await closed.client.callTool({ name: "coord_propose_rule", arguments: { requestId: "closed", ...proposal() } });
    assert.equal(result.isError, true); assert.match(JSON.stringify(result), /LEASE_REVOKED/); assert.equal(backend.calls.length, count); assert.deepEqual(f.rows, before);
  } finally { await closed.close(); }
});
