import assert from "node:assert/strict";
import test from "node:test";
import { runCoordHook, renderCheckIn } from "../src/hooks.js";
import type { CoordBackend, RunConnection } from "../src/mcp.js";
import { CoordError, DEFAULTS, type RunIdentity } from "../src/protocol.js";

const identity: RunIdentity = { taskId: "task1", runId: "run1", epoch: 2, goalRevision: 1 };
const message = { id: "message1", recipientTaskId: "task1", recipientEpoch: 2, type: "warning", payload: "Coordinate the shared interface", conflict: false, state: "queued" };
const data = (messages: unknown[] = [message]) => ({ task: { id: "task1", epoch: 2, progressRevision: 1, state: "running" }, run: { id: "run1", epoch: 2, goalRevision: 1 }, policyVersion: 1, messages, complete: true });

test("stateless hooks independently fetch durable messages and replay offered output after a lost response", async () => {
  const calls: string[] = [], receipts: unknown[] = [];
  const client: CoordBackend = {
    query: async name => { calls.push(name); return data([{ ...message, state: receipts.length ? "offered_to_turn" : "queued" }]); },
    mutation: async (name, args) => { calls.push(name); receipts.push(args); return {}; },
  };
  const run = { client, identity };
  const first = await runCoordHook({ harness: "codex", event: "PreToolUse", run });
  const replay = await runCoordHook({ harness: "codex", event: "PreToolUse", run });
  assert.match(JSON.stringify(first), /Coordinate the shared interface/);
  assert.match(JSON.stringify(replay), /Coordinate the shared interface/);
  assert.deepEqual(calls, ["tasks:checkIn", "messages:receipt", "tasks:checkIn", "messages:receipt"]);
  assert.ok(receipts.every(r => (r as { state: string }).state === "offered_to_turn"));
  assert.doesNotMatch(JSON.stringify(receipts), /acknowledged_by_agent|injected_into_turn/);
});

test("declined and escalated conflicts still deny native tools; accepted decisions clear the conflict", async () => {
  for (const resolution of [undefined, "declined", "escalated", "accepted"]) {
    const run: RunConnection = { identity, client: { query: async () => data([{ ...message, conflict: true, resolution }]), mutation: async () => ({}) } };
    const codex = await runCoordHook({ harness: "codex", event: "PreToolUse", run });
    const output = codex.hookSpecificOutput as Record<string, unknown>;
    assert.equal(output.permissionDecision, resolution === "accepted" ? undefined : "deny");
    const agy = await runCoordHook({ harness: "antigravity", event: "PreToolUse", run });
    assert.equal(agy.decision, resolution === "accepted" ? "allow" : "deny");
  }
});

test("missing registration blocks known native edit paths without pretending to register", async () => {
  const output = await runCoordHook({ harness: "codex", event: "PreToolUse", input: { tool_name: "apply_patch" } });
  assert.equal((output.hookSpecificOutput as Record<string, unknown>).permissionDecision, "deny");
  assert.match(JSON.stringify(output), /not registered/);
  const startup = await runCoordHook({ harness: "antigravity", event: "SessionStart" });
  assert.ok(Array.isArray(startup.injectSteps));
});

test("revocation and backend errors block writes without leaking request credentials", async () => {
  for (const error of [new CoordError("LEASE_REVOKED", "Lease expired"), new Error("secret-token-canary")]) {
    const run: RunConnection = { identity, client: { query: async () => { throw error; }, mutation: async () => ({}) } };
    const output = await runCoordHook({ harness: "antigravity", event: "PreToolUse", run });
    assert.equal(output.decision, "deny");
    assert.doesNotMatch(JSON.stringify(output), /secret-token-canary/);
  }
});

test("unresolved conflicts keep diagnostic and resolution tools available", async () => {
  const run: RunConnection = { identity, client: { query: async () => ({ ...data([{ ...message, conflict: true }]), conflictBlocked: true }), mutation: async () => ({}) } };
  const codex = await runCoordHook({ harness: "codex", event: "PreToolUse", input: { tool_name: "mcp__coord__coord_resolve_message" }, run });
  assert.equal((codex.hookSpecificOutput as Record<string, unknown>).permissionDecision, undefined);
  assert.match(JSON.stringify(codex), /blocked/);
  const agy = await runCoordHook({ harness: "antigravity", event: "PreToolUse", input: { toolCall: { name: "mcp:coord:coord_read_messages" } }, run });
  assert.equal(agy.decision, "allow");
  const invocation = await runCoordHook({ harness: "antigravity", event: "PreInvocation", run });
  assert.equal(invocation.terminationBehavior, undefined);
});

test("oversized messages and incomplete retrieval block and fit the routine UTF-8 bound", () => {
  const output = renderCheckIn(data([{ ...message, payload: "🧭".repeat(2000) }]), identity);
  assert.equal(output.blocked, true);
  assert.deepEqual(output.messageIds, []);
  assert.ok(Buffer.byteLength(output.text, "utf8") <= DEFAULTS.updateBytes);
  assert.equal(renderCheckIn({ ...data([]), complete: false }, identity).blocked, true);
  assert.equal(renderCheckIn({ ...data([]), conflictBlocked: true }, identity).blocked, true);
  const stub = renderCheckIn(data([{ ...message, payload: undefined, requiresExpansion: true, payloadPreview: "Expanded source required" }]), identity);
  assert.equal(stub.blocked, true);
  assert.deepEqual(stub.messageIds, []);
  assert.match(stub.text, /Expanded source required/);
  const old = renderCheckIn({ ...data([{ ...message, recipientEpoch: 1, conflict: true, resolution: "accepted" }]), conflictBlocked: true }, identity);
  assert.equal(old.blocked, true);
  assert.deepEqual(old.messageIds, []);
  assert.throws(() => renderCheckIn({ ...data([]), run: { id: "wrong", epoch: 2, goalRevision: 1 } }, identity), /identity/);
});
