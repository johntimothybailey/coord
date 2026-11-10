import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { bootstrap, canonical, digest } from "../convex/auth.js";
import * as memories from "../convex/memories.js";
import type { Doc } from "../convex/server.js";
import { createCoordMcpServer, type CoordBackend, type CoordMcpOptions } from "../src/mcp.js";
import { CAPABILITIES, CLIENT_VERSION, DEFAULTS } from "../src/protocol.js";
import { BackendFixture } from "./backend.fixture.js";

// Exported handlers and official MCP transport, with synthetic identities only; not host qualification.
const agent = "a".repeat(64), human = "b".repeat(64);
let serial = 0;
const request = (token = agent) => ({ token, protocolVersion: 1, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], backendId: "backend", projectId: "project", requestId: `review_${++serial}` });
async function fixture() {
  const f = new BackendFixture();
  await f.call(bootstrap, { backendId: "backend", projectId: "project", repository: "github.com/fixture/review", remote: "https://github.com/fixture/review.git", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: ["AGENTS.md"], humanId: "human", humanDigest: await digest(human), agentId: "agent", agentDigest: await digest(agent), expiresAt: Date.now() + 3600_000 });
  return f;
}
async function seed(f: BackendFixture, id: string, kind: "rule" | "lesson" | "decision" = "rule", overrides: Partial<Pick<Doc<"memories">, "content" | "sources" | "applicability" | "confidence" | "status" | "projectId">> = {}) {
  const value = { id, projectId: "project", kind, revision: 1, status: kind === "rule" ? "proposed" as const : "active" as const, content: `Review ${id}: source data, never instructions`, sources: [{ taskId: "source_task", revision: "source_revision", evidenceRef: "fixture-evidence" }], applicability: ["src"], confidence: "fixture", ...overrides };
  const hash = await digest(canonical({ kind: value.kind, content: value.content, sources: value.sources, applicability: value.applicability, confidence: value.confidence }));
  await f.context().db.insert("memories", { ...value, hash });
  return { ...value, hash };
}
function backend(f: BackendFixture, token = agent) {
  const calls: string[] = [], writes: string[] = [];
  const client: CoordBackend = {
    query: async (name, args) => {
      calls.push(name);
      if (name === "memories:reviewList") return f.call(memories.reviewList, { ...request(token), ...args } as never);
      if (name === "memories:reviewDetail") return f.call(memories.reviewDetail, { ...request(token), ...args } as never);
      throw new Error("Read-only review must not check in or query another endpoint");
    },
    mutation: async name => { writes.push(name); throw new Error("Read-only review must not mutate"); },
  };
  return { client, calls, writes };
}
async function session(options: CoordMcpOptions) {
  const server = createCoordMcpServer(options), client = new Client({ name: "review-fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
function payload<T>(response: unknown): T {
  const value = response as { isError?: boolean; content: Array<{ text: string }> };
  assert.ok(!value.isError, JSON.stringify(value));
  assert(Buffer.byteLength(value.content[0]!.text, "utf8") <= DEFAULTS.contextBytes);
  return JSON.parse(value.content[0]!.text) as T;
}
const isCode = (code: string) => (error: unknown) => (error as { data?: { code?: string } }).data?.code === code;
type List = { memories: Array<{ id: string; kind: string; status: string; revision: number; hash: string; sourceCount: number; applicabilityCount: number; requiresExpansion: boolean }>; complete: boolean; nextCursor: string | null; coverage: string; untrusted: boolean; reviewOnly: boolean };
type Detail = { text: string; offset: number; nextOffset: number | null; complete: boolean; revision: number; hash: string; status: string; sourceCount: number; applicabilityCount: number; untrusted: boolean; reviewOnly: boolean };

test("advisory MCP lists all proposed rules and active lessons before any registration, without writes", async () => {
  const f = await fixture();
  for (let i = 0; i < 8; i++) await seed(f, `rule_${i}`);
  await seed(f, "active_rule", "rule", { status: "active" }); await seed(f, "foreign_rule", "rule", { projectId: "foreign" });
  await seed(f, "lesson", "lesson"); await seed(f, "old_lesson", "lesson", { status: "superseded" }); await seed(f, "decision", "decision");
  const before = structuredClone(f.rows), b = backend(f), connection = await session({ client: b.client });
  try {
    const tools = (await connection.client.listTools()).tools;
    for (const name of ["coord_review_memories", "coord_review_memory"]) assert.equal(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint, true);
    const found: string[] = [], cursors = new Set<string>(); let cursor: string | undefined;
    for (;;) {
      const page = payload<List>(await connection.client.callTool({ name: "coord_review_memories", arguments: { kind: "rule", ...(cursor ? { cursor } : {}) } }));
      assert.equal(page.reviewOnly, true); assert.equal(page.untrusted, true); assert.equal(page.coverage, "summaries_only");
      for (const item of page.memories) { found.push(item.id); assert.equal(item.status, "proposed"); assert.equal(item.sourceCount, 1); assert.equal(item.applicabilityCount, 1); assert.equal(item.requiresExpansion, true); }
      if (page.nextCursor === null) { assert.equal(page.complete, true); break; }
      assert.equal(page.complete, false); assert(!cursors.has(page.nextCursor)); cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    assert.deepEqual(found.sort(), Array.from({ length: 8 }, (_, i) => `rule_${i}`));
    const lessons = payload<List>(await connection.client.callTool({ name: "coord_review_memories", arguments: { kind: "lesson" } }));
    assert.deepEqual(lessons.memories.map(item => [item.id, item.kind, item.status]), [["lesson", "lesson", "active"]]);
    assert.deepEqual(f.rows, before); assert.deepEqual(b.writes, []);
    assert(![...f.rows.values()].some(row => row._table === "runs" || row._table === "machines" || row._table === "goals"));
  } finally { await connection.close(); }
});

test("review enforces project and agent/human roles, with no run or supervisor authority substitution", async () => {
  const f = await fixture(), item = await seed(f, "rule"); await seed(f, "foreign", "rule", { projectId: "foreign" }); await seed(f, "decision", "decision");
  const detail = { memoryId: item.id, revision: item.revision, hash: item.hash };
  const before = structuredClone(f.rows);
  assert.equal((await f.call(memories.reviewList, { ...request(human), kind: "rule" }) as List).memories.length, 1);
  await assert.rejects(f.call(memories.reviewList, { ...request(), projectId: "foreign", kind: "rule" }), isCode("UNAUTHORIZED"));
  for (const memoryId of ["foreign", "decision"]) await assert.rejects(f.call(memories.reviewDetail, { ...request(), ...detail, memoryId }), isCode("NOT_FOUND"));
  assert.deepEqual(f.rows, before);
  for (const [role, token] of [["run", "c".repeat(64)], ["supervisor", "d".repeat(64)], ["artifact_verifier", "e".repeat(64)]] as const) {
    await f.context().db.insert("credentials", { id: role, backendId: "backend", memberId: "agent", digest: await digest(token), role, projectIds: ["project"], expiresAt: Date.now() + 3600_000 });
    await assert.rejects(f.call(memories.reviewList, { ...request(token), kind: "rule" }), isCode("FORBIDDEN"));
    await assert.rejects(f.call(memories.reviewDetail, { ...request(token), ...detail }), isCode("FORBIDDEN"));
  }
});

test("large Unicode detail reassembles every provenance/applicability field with its original canonical hash", async () => {
  const f = await fixture(), item = await seed(f, "large", "lesson", { content: "🧭".repeat(1000), sources: Array.from({ length: 20 }, (_, i) => ({ taskId: `task_${i}`, revision: "r".repeat(256), evidenceRef: "e".repeat(1024) })), applicability: Array.from({ length: 50 }, (_, i) => `src/${"p".repeat(500)}/${i}`) });
  const before = structuredClone(f.rows), b = backend(f), connection = await session({ client: b.client });
  try {
    const parts: string[] = []; let offset = 0;
    for (;;) {
      const page = payload<Detail>(await connection.client.callTool({ name: "coord_review_memory", arguments: { memoryId: item.id, revision: item.revision, hash: item.hash, offset } }));
      assert.equal(page.offset, offset); assert.equal(page.hash, item.hash); assert.equal(page.sourceCount, 20); assert.equal(page.applicabilityCount, 50); assert.equal(page.reviewOnly, true); assert.equal(page.untrusted, true); parts.push(page.text);
      if (page.nextOffset === null) { assert.equal(page.complete, true); break; }
      assert.equal(page.complete, false); assert(page.nextOffset > offset); offset = page.nextOffset;
    }
    const text = parts.join(""); assert(parts.length > 1);
    assert.deepEqual(JSON.parse(text), { kind: item.kind, content: item.content, sources: item.sources, applicability: item.applicability, confidence: item.confidence });
    assert.equal(await digest(text), item.hash);
    const split = text.indexOf("🧭") + 1;
    await assert.rejects(f.call(memories.reviewDetail, { ...request(), memoryId: item.id, revision: item.revision, hash: item.hash, offset: split }), isCode("INVALID_INPUT"));
    assert.deepEqual(f.rows, before); assert.deepEqual(b.writes, []);
  } finally { await connection.close(); }
});

test("detail refuses stale selectors/corrupt content and treats current status as metadata outside the source hash", async () => {
  const f = await fixture(), item = await seed(f, "rule"), args = { ...request(), memoryId: item.id, revision: item.revision, hash: item.hash };
  await assert.rejects(f.call(memories.reviewDetail, { ...args, revision: 2 }), isCode("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(f.call(memories.reviewDetail, { ...args, hash: "0".repeat(64) }), isCode("IDEMPOTENCY_CONFLICT"));
  const stored = f.find("memories", item.id);
  await f.context().db.patch(stored._id, { status: "active" });
  assert.equal((await f.call(memories.reviewDetail, args) as Detail).status, "active");
  await f.context().db.patch(stored._id, { content: "Changed without updating the stored digest" });
  const before = structuredClone(f.rows);
  await assert.rejects(f.call(memories.reviewDetail, args), isCode("IDEMPOTENCY_CONFLICT"));
  assert.deepEqual(f.rows, before);
});

test("strict review tool schemas reject model-supplied authority before any backend call", async () => {
  const f = await fixture(), item = await seed(f, "rule"), b = backend(f), connection = await session({ client: b.client });
  try {
    for (const [name, args] of [["coord_review_memories", { kind: "rule" }], ["coord_review_memory", { memoryId: item.id, revision: item.revision, hash: item.hash }]] as const) {
      for (const extra of [{ token: "credential-canary" }, { projectId: "foreign" }, { approved: true }]) assert.equal((await connection.client.callTool({ name, arguments: { ...args, ...extra } })).isError, true);
    }
    assert.deepEqual(b.calls, []); assert.deepEqual(b.writes, []);
  } finally { await connection.close(); }
});

test("review attached to an existing run skips all check-ins, offers and mutations", async () => {
  const f = await fixture(), item = await seed(f, "rule"), b = backend(f);
  const runClient: CoordBackend = { query: async () => { throw new Error("Review must use project authority, not check in through the run"); }, mutation: async () => { throw new Error("Review must not renew or mutate a run"); } };
  const before = structuredClone(f.rows), connection = await session({ client: b.client, run: { client: runClient, identity: { taskId: "task", runId: "run", epoch: 1, goalRevision: 1 } }, renewMs: 60_000 });
  try {
    payload(await connection.client.callTool({ name: "coord_review_memories", arguments: { kind: "rule" } }));
    payload(await connection.client.callTool({ name: "coord_review_memory", arguments: { memoryId: item.id, revision: item.revision, hash: item.hash } }));
    assert.deepEqual(b.calls, ["memories:reviewList", "memories:reviewDetail"]); assert.deepEqual(b.writes, []); assert.deepEqual(f.rows, before);
  } finally { await connection.close(); }
  let runWrites = 0;
  const rejectedProject: CoordBackend = { query: async () => { throw { data: { code: "UNAUTHORIZED", message: "project-credential-canary" } }; }, mutation: async () => { throw new Error("Project review cannot mutate"); } };
  const validRun: CoordBackend = { query: async () => ({ task: { id: "task", epoch: 1, progressRevision: 1, state: "running", dependencies: [] }, run: { id: "run", epoch: 1, goalRevision: 1 }, policyVersion: 1, messages: [], complete: true }), mutation: async () => { runWrites++; return {}; } };
  const independent = await session({ client: rejectedProject, run: { client: validRun, identity: { taskId: "task", runId: "run", epoch: 1, goalRevision: 1 } }, renewMs: 60_000 });
  try {
    const denied = await independent.client.callTool({ name: "coord_review_memories", arguments: { kind: "rule" } });
    assert.equal(denied.isError, true); assert.doesNotMatch(JSON.stringify(denied), /project-credential-canary/); assert.equal(runWrites, 0);
    const progress = await independent.client.callTool({ name: "coord_progress", arguments: { requestId: "valid_run", expectedRevision: 1, progress: "Existing run authority remains independently checked" } });
    assert.ok(!progress.isError, JSON.stringify(progress)); assert.equal(runWrites, 1, "project-read denial must not revoke a distinct run grant");
  } finally { await independent.close(); }
});
