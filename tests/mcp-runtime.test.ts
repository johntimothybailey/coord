import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCoordMcpServer, type CoordBackend, type CoordMcpOptions } from "../src/mcp.js";
import type { RuntimeActions } from "../src/commands.js";
import { CoordError } from "../src/protocol.js";

const identity = { taskId: "task1", runId: "run1", epoch: 2, goalRevision: 1 };
const checkIn = { task: { id: "task1", epoch: 2, progressRevision: 1, state: "running", dependencies: [] as { taskId: string; mode: string; artifact?: string }[] }, run: { id: "run1", epoch: 2, goalRevision: 1 }, policyVersion: 1, messages: [], complete: true };
const backend: CoordBackend = { query: async () => checkIn, mutation: async () => ({}) };
const callbacks = (seen: { operation: string; input: unknown }[]): RuntimeActions => ({
  checkpoint: async input => { seen.push({ operation: "checkpoint", input }); return { checkpointId: input.checkpointId, state: "ready", kind: "fixture" }; },
  review: async input => { seen.push({ operation: "review", input }); return { publicationId: input.publicationId, state: "review_ready", capacityHeld: true, kind: "fixture" }; },
  finalize: async input => { seen.push({ operation: "finalize", input }); return { state: "finalizing", capacityHeld: true, kind: "fixture" }; },
  finishReplan: async input => { seen.push({ operation: "finishReplan", input }); return { state: "waiting_dependencies", capacityHeld: true, kind: "fixture" }; },
});
async function session(options: CoordMcpOptions) {
  const server = createCoordMcpServer(options), client = new Client({ name: "runtime-fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("runtime MCP passes only bounded proposal/ID arguments into fixed callbacks", async () => {
  const seen: { operation: string; input: unknown }[] = [];
  const connection = await session({ client: backend, run: { client: backend, identity }, runtimeActions: callbacks(seen) });
  try {
    const tools = (await connection.client.listTools()).tools;
    for (const tool of ["coord_checkpoint", "coord_review", "coord_finalize", "coord_finish_replan"]) assert.ok(tools.some(item => item.name === tool));
    assert.ok(!tools.some(item => /approve|configure|merge|deploy|raw|claim|attest|verify/.test(item.name)));
    const checkpoint = await connection.client.callTool({ name: "coord_checkpoint", arguments: { checkpointId: "cp1" } });
    assert.ok(!checkpoint.isError);
    assert.match(JSON.stringify(checkpoint), /runtime_action_result/);
    const review = await connection.client.callTool({ name: "coord_review", arguments: { checkpointId: "cp1", publicationId: "publication1" } });
    assert.ok(!review.isError);
    assert.match(JSON.stringify(review), /capacityHeld/);
    const closed = await connection.client.callTool({ name: "coord_progress", arguments: { requestId: "progress1", expectedRevision: 1, progress: "No new work" } });
    assert.equal(closed.isError, true);
    const finalize = await connection.client.callTool({ name: "coord_finalize", arguments: { outcome: "succeeded" } });
    assert.ok(!finalize.isError);
    assert.deepEqual(seen, [{ operation: "checkpoint", input: { checkpointId: "cp1" } }, { operation: "review", input: { checkpointId: "cp1", publicationId: "publication1" } }, { operation: "finalize", input: { outcome: "succeeded" } }]);
  } finally { await connection.close(); }
  const replan = await session({ client: backend, run: { client: backend, identity }, runtimeActions: callbacks(seen) });
  try {
    const input = { result: "revised", dependencies: [{ taskId: "dependency1", mode: "published", artifact: "cp_dependency" }], rationale: "Reuse the exact published prerequisite" };
    assert.ok(!(await replan.client.callTool({ name: "coord_finish_replan", arguments: input })).isError);
    assert.deepEqual(seen.at(-1), { operation: "finishReplan", input });
  } finally { await replan.close(); }
});

test("runtime MCP rejects credential, path, process identity and attestation overrides before callbacks", async () => {
  const seen: { operation: string; input: unknown }[] = [];
  const connection = await session({ client: backend, run: { client: backend, identity }, runtimeActions: callbacks(seen) });
  try {
    const inputs = [
      ["coord_checkpoint", { checkpointId: "cp1" }],
      ["coord_review", { checkpointId: "cp1", publicationId: "publication1" }],
      ["coord_finalize", { outcome: "stopped" }],
      ["coord_finish_replan", { result: "blocked", dependencies: [], rationale: "No accepted prerequisite" }],
    ] as const;
    for (const [name, args] of inputs) for (const [key, value] of Object.entries({ token: "credential-canary", runtimePath: "/tmp/model-runtime.json", sessionId: "other_session", epoch: 999, launchId: "other_launch", command: ["sh", "-c", "unsafe"], approved: true, attestation: "model assertion" })) {
      assert.equal((await connection.client.callTool({ name, arguments: { ...args, [key]: value } })).isError, true);
    }
    assert.equal((await connection.client.callTool({ name: "coord_checkpoint", arguments: { checkpointId: "../escape" } })).isError, true);
    assert.equal((await connection.client.callTool({ name: "coord_checkpoint", arguments: { checkpointId: "x".repeat(129) } })).isError, true);
    assert.equal((await connection.client.callTool({ name: "coord_finish_replan", arguments: { result: "revised", dependencies: [{ taskId: "a", mode: "published", approved: true }], rationale: "Proposal" } })).isError, true);
    assert.equal((await connection.client.callTool({ name: "coord_finish_replan", arguments: { result: "revised", dependencies: [{ taskId: "a", mode: "published" }, { taskId: "a", mode: "published" }], rationale: "Duplicate proposal" } })).isError, true);
    assert.equal((await connection.client.callTool({ name: "coord_finish_replan", arguments: { result: "blocked", dependencies: [], rationale: "🧭".repeat(1025) } })).isError, true);
    assert.deepEqual(seen, []);
  } finally { await connection.close(); }
});

test("runtime MCP missing configuration is explicit and callback failures redact sensitive details", async () => {
  const connection = await session({ client: backend, run: { client: backend, identity } });
  try {
    const response = await connection.client.callTool({ name: "coord_checkpoint", arguments: { checkpointId: "cp1" } });
    assert.equal(response.isError, true); assert.match(JSON.stringify(response), /BLOCKED_ENV/);
    assert.doesNotMatch(JSON.stringify(response), /"ready"|"accepted"/);
  } finally { await connection.close(); }
  const unboundCalls: { operation: string; input: unknown }[] = [];
  const unbound = await session({ client: backend, runtimeActions: callbacks(unboundCalls) });
  try {
    assert.equal((await unbound.client.callTool({ name: "coord_finalize", arguments: { outcome: "stopped" } })).isError, true);
    assert.deepEqual(unboundCalls, []);
  } finally { await unbound.close(); }
  for (const failure of [new CoordError("FORBIDDEN", "secret-local-canary"), { data: { code: "UNAUTHORIZED", message: "secret-backend-canary" } }, new Error("secret-network-canary")]) {
    const actions = callbacks([]); actions.checkpoint = async () => { throw failure; };
    const failing = await session({ client: backend, run: { client: backend, identity }, runtimeActions: actions });
    try {
      const response = await failing.client.callTool({ name: "coord_checkpoint", arguments: { checkpointId: "cp1" } });
      assert.equal(response.isError, true); assert.doesNotMatch(JSON.stringify(response), /secret-.*-canary/);
    } finally { await failing.close(); }
  }
});

test("finalization reaches backend-revalidating callback after a stale local renewal failure", async () => {
  let revoked = false, finalizations = 0;
  const renewing: CoordBackend = { query: async () => checkIn, mutation: async () => { revoked = true; throw new CoordError("LEASE_REVOKED", "Expired locally"); } };
  const actions = callbacks([]); actions.finalize = async input => { finalizations++; assert.deepEqual(input, { outcome: "stopped" }); return { state: "stopped", kind: "fixture" }; };
  const connection = await session({ client: renewing, run: { client: renewing, identity }, runtimeActions: actions, renewMs: 5 });
  try {
    await delay(25); assert.equal(revoked, true);
    assert.equal((await connection.client.callTool({ name: "coord_checkpoint", arguments: { checkpointId: "cp1" } })).isError, true);
    assert.ok(!(await connection.client.callTool({ name: "coord_finalize", arguments: { outcome: "stopped" } })).isError);
    assert.equal(finalizations, 1);
  } finally { await connection.close(); }
});

test("review reconciliation reaches the authoritative callback after local lease failure and accepted result", async () => {
  let renewals = 0, attempts = 0;
  const renewing: CoordBackend = { query: async () => checkIn, mutation: async () => { renewals++; throw new CoordError("LEASE_REVOKED", "Expired locally"); } };
  const actions = callbacks([]);
  actions.review = async input => {
    attempts++;
    if (input.publicationId !== "publication1") throw new CoordError("FORBIDDEN", "A different publication cannot reuse the accepted run");
    return { publicationId: input.publicationId, state: "review_ready", capacityHeld: true, kind: "fixture" };
  };
  const connection = await session({ client: renewing, run: { client: renewing, identity }, runtimeActions: actions, renewMs: 5 });
  try {
    await delay(25); assert.equal(renewals, 1);
    for (let attempt = 0; attempt < 2; attempt++) assert.ok(!(await connection.client.callTool({ name: "coord_review", arguments: { checkpointId: "cp1", publicationId: "publication1" } })).isError);
    const changed = await connection.client.callTool({ name: "coord_review", arguments: { checkpointId: "cp1", publicationId: "publication2" } });
    assert.equal(changed.isError, true); assert.match(JSON.stringify(changed), /FORBIDDEN/);
    assert.equal(attempts, 3);
    assert.equal((await connection.client.callTool({ name: "coord_progress", arguments: { requestId: "after_review", expectedRevision: 1, progress: "No new authority" } })).isError, true);
  } finally { await connection.close(); }
});

test("trusted cleanup-only restart never renews or writes ordinary state but still revalidates review/finalization", async () => {
  const seen: { operation: string; input: unknown }[] = [];
  let writes = 0, registrations = 0;
  const closedBackend: CoordBackend = { query: async () => checkIn, mutation: async () => { writes++; return {}; } };
  const connection = await session({ client: closedBackend, run: { client: closedBackend, identity }, runtimeActions: callbacks(seen), cleanupOnly: true, renewMs: 5, registerManual: async () => { registrations++; return { client: closedBackend, identity }; } });
  try {
    await delay(25);
    const ordinary = [
      ["coord_progress", { requestId: "progress1", expectedRevision: 1, progress: "No new work" }],
      ["coord_propose_goal", { requestId: "goal1", goalId: "goal1", expectedRevision: 0, content: "No fresh intake", taskLimit: 1, runTimeoutMs: 60_000 }],
      ["coord_checkpoint", { checkpointId: "cp1" }],
      ["coord_finish_replan", { result: "blocked", dependencies: [], rationale: "Cleanup is not a replanning run" }],
      ["coord_register_manual", { requestId: "register1", taskId: "task1", machineId: "machine1", harness: "codex", capabilityKey: { os: "fixture/os", harness: "codex", harnessVersion: "1", adapterVersion: "1", probeVersion: "1", configurationDigest: "config", gitPolicyDigest: "git" } }],
    ] as const;
    for (const [name, args] of ordinary) assert.equal((await connection.client.callTool({ name, arguments: args })).isError, true);
    assert.equal(writes, 0); assert.equal(registrations, 0); assert.equal(seen.length, 0);
    assert.ok(!(await connection.client.callTool({ name: "coord_review", arguments: { checkpointId: "cp1", publicationId: "publication1" } })).isError);
    const finalized = await connection.client.callTool({ name: "coord_finalize", arguments: { outcome: "succeeded" } });
    assert.ok(!finalized.isError);
    assert.match(JSON.stringify(finalized), /runWritesClosed/);
    assert.deepEqual(seen.map(item => item.operation), ["review", "finalize"]);
    await delay(10); assert.equal(writes, 0);
  } finally { await connection.close(); }
});

test("dependency source lookup uses the fixed task and suppresses arbitrary task/token/manifest selectors", async () => {
  const reads: { name: string; args: unknown }[] = [];
  const dependencyBackend: CoordBackend = {
    query: async (name, args) => {
      reads.push({ name, args });
      return name === "checkpoints:getInput" ? { dependency: { taskId: "dependency1", mode: "published", artifact: "cp_historical" }, taskState: "review_ready", availability: "published", code: { ref: "refs/coord/checkpoints/dependency1/e1/cp_historical", commit: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), manifestHash: "hash" } } : checkIn;
    },
    mutation: async () => { throw new Error("Read-only lookup cannot mutate"); },
  };
  const connection = await session({ client: dependencyBackend, run: { client: dependencyBackend, identity } });
  try {
    for (const extra of [{ taskId: "other_task" }, { token: "canary" }, { includeManifest: true }, { runtimePath: "/tmp/model-runtime" }, { epoch: 99 }]) assert.equal((await connection.client.callTool({ name: "coord_dependency_input", arguments: { dependencyTaskId: "dependency1", ...extra } })).isError, true);
    assert.deepEqual(reads, []);
    const response = await connection.client.callTool({ name: "coord_dependency_input", arguments: { dependencyTaskId: "dependency1" } });
    assert.ok(!response.isError);
    assert.deepEqual(reads[0], { name: "checkpoints:getInput", args: { taskId: identity.taskId, dependencyTaskId: "dependency1", includeManifest: false } });
    assert.match(JSON.stringify(response), /cp_historical/);
    assert.match(JSON.stringify(response), /Source data|source data/);
    assert.match(JSON.stringify(response), /do not substitute the latest artifact/);
  } finally { await connection.close(); }
});
