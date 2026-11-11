import assert from "node:assert/strict";
import test from "node:test";
import childProcess, { execFileSync } from "node:child_process";
import fs, { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvexError, convexToJson } from "convex/values";
import { getFunctionName } from "convex/server";
import type { Value } from "convex/values";
import { BackendFixture } from "./backend.fixture.js";
import * as auth from "../convex/auth.js";
import * as recovery from "../convex/operatorRecovery.js";
import * as lifecycle from "../convex/lifecycle.js";
import * as approvalAuth from "../convex/approvalAuth.js";
import * as projects from "../convex/projects.js";
import { bootstrapArguments, createBundle, parseSetupPlan, unlockBundle, unlockOperatorBundle } from "../src/onboarding.js";
import { recoverOperatorCommand } from "../src/operator-recovery.js";
import { openOperatorSession } from "../src/approval.js";
import { passkeySetupCommand } from "../src/passkey-setup.js";
import { createHash } from "node:crypto";

const password = "SYNTHETIC NEW RECOVERY PASSPHRASE";
const oldPassword = "SYNTHETIC LOST VAULT PASSPHRASE";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
process.env.CONVEX_SITE_URL = "https://fixture.convex.site";
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "coord-recovery-"))), root = join(directory, "repo"); await mkdir(root);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, stdio: "ignore" }); execFileSync("git", ["remote", "add", "origin", "https://github.com/fixture/recovery.git"], { cwd: root, stdio: "ignore" });
  const plan = parseSetupPlan({ schemaVersion: 1, deploymentName: "fixture", workspaceRoot: root, config: { schemaVersion: 1, backendId: "backend", backendUrl: "https://fixture.convex.cloud", projectId: "project", repository: "github.com/fixture/recovery", remote: "https://github.com/fixture/recovery.git", defaultBranch: "main", ruleTargets: ["AGENTS.md"] }, humanId: "human", agentId: "agent", credentialExpiresAt: Date.now() + 3600_000, policy: { allowedPaths: ["src"], excludedPaths: [], sharingApproved: true, capacity: 2, taskCap: 20 } });
  const planPath = join(directory, "plan.json"), oldVault = join(directory, "operator/old.json"), newVault = join(directory, "operator/recovered.json"); await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
  const old = await createBundle(plan, oldVault, oldPassword), backend = new BackendFixture(); await backend.call(auth.bootstrap, bootstrapArguments(plan, old) as never);
  const selection = { backendId: "backend", projectId: "project", repository: plan.config.repository, remote: plan.config.remote, defaultBranch: "main", memberId: "human", replacedCredentialId: "human" };
  const args = { ...selection, recoveryId: "one", credentialId: "recovered_one", credentialDigest: "c".repeat(64), expiresAt: plan.credentialExpiresAt };
  return { directory, plan, planPath, oldVault, newVault, old, backend, selection, args };
}
const confirm = async (label: string, hidden: boolean): Promise<string> => hidden ? password : label.slice(5, label.indexOf(" to authorize this exact recovery:"));
async function attempt(backend: BackendFixture, args: Record<string, unknown>) {
  // The action catches the outcome of a separate transaction, including its rollback.
  const ctx = { runMutation: async (reference: Parameters<typeof getFunctionName>[0], value: Record<string, unknown>) => {
    assert.equal(getFunctionName(reference), "operatorRecovery:recover");
    return backend.call(recovery.recover, value as never);
  } };
  return (recovery.recoverAttempt as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> })._handler(ctx, args);
}
async function wire(backend: BackendFixture, operation: () => Promise<void>) {
  const original = globalThis.fetch;
  const handlers = { "auth:handshake": auth.handshake, "projects:status": projects.status, "approvalAuth:beginEnrollment": approvalAuth.beginEnrollment, "approvalAuth:enrollmentStatus": approvalAuth.enrollmentStatus, "approvalAuth:finishEnrollment": approvalAuth.finishEnrollment };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { path: keyof typeof handlers; args: unknown[] };
    try { return new Response(JSON.stringify({ status: "success", value: convexToJson(await backend.call(handlers[body.path] as never, body.args[0] as never) as Value), logLines: [] })); }
    catch (error) { if (!(error as { data?: unknown }).data) throw error; return new Response(JSON.stringify({ status: "error", errorMessage: "Fixture rejected", errorData: (error as { data: Value }).data, logLines: [] })); }
  };
  try { await operation(); } finally { globalThis.fetch = original; }
}

test("owner recovery preserves project and agent authority, revokes old human and linked browser authority, and replays exactly", async () => {
  const x = await fixture(); try {
    const beforeProject = x.backend.find("projects", "project"), beforeAgent = x.backend.find("credentials", "agent");
    const identity = { backendId: "backend", projectId: "project", token: x.old.humanToken, protocolVersion: 1, clientVersion: "0.1.0-private", capabilities: [], requestId: "before" };
    // Use normal client metadata from the handshake fixture rather than inventing approval authority.
    const { PROTOCOL_VERSION, CAPABILITIES, CLIENT_VERSION } = await import("../src/protocol.js"); Object.assign(identity, { protocolVersion: PROTOCOL_VERSION, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES] });
    const enrollment = await x.backend.call(approvalAuth.beginEnrollment, { ...identity, enrollmentId: "old-browser" }) as {url: string}; assert(enrollment.url);
    const receipt = await x.backend.call(recovery.recover, x.args) as { recoveredAt: number };
    assert.deepEqual(await x.backend.call(recovery.recover, x.args), receipt);
    assert.equal(x.backend.find("credentials", "human").revokedAt, receipt.recoveredAt);
    assert.equal(x.backend.find("credentials", "recovered_one").memberId, "human");
    assert.deepEqual(x.backend.find("projects", "project"), beforeProject); assert.deepEqual(x.backend.find("credentials", "agent"), beforeAgent);
    await assert.rejects(x.backend.call(auth.handshake, identity), /invalid for this backend\/project/);
    await assert.rejects(x.backend.call(approvalAuth.enrollmentOptions, { enrollmentId: "old-browser" }), /invalid for this backend\/project/);
    await assert.rejects(x.backend.call(recovery.recover, { ...x.args, credentialDigest: "d".repeat(64) }), /already binds another/);
    assert.equal([...x.backend.rows.values()].filter(row => row._table === "audit" && row.operation === "operatorRecovery.recover").length, 1);
    await x.backend.context().db.patch(x.backend.find("credentials", "recovered_one")._id, { revokedAt: Date.now() });
    await assert.rejects(x.backend.call(recovery.recover, x.args), /cannot revive/);
  } finally { await rm(x.directory, { recursive: true, force: true }); }
});

test("owner recovery refuses wrong routing/member/scope/expiry and rolls back atomically on failure", async () => {
  const x = await fixture(); try {
    for (const patch of [{ repository: "other" }, { memberId: "other" }, { projectId: "other" }, { expiresAt: x.args.expiresAt + 1 }, { credentialId: "human" }]) {
      const before = structuredClone(x.backend.rows); await assert.rejects(x.backend.call(recovery.recover, { ...x.args, ...patch })); assert.deepEqual(x.backend.rows, before);
    }
    const context = x.backend.context.bind(x.backend), before = structuredClone(x.backend.rows);
    x.backend.context = () => { const ctx = context(); ctx.db.patch = async () => { throw new Error("transaction fault"); }; return ctx; };
    await assert.rejects(x.backend.call(recovery.recover, x.args), /transaction fault/); assert.deepEqual(x.backend.rows, before, "failure after inserting the new credential rolls back both authorities"); x.backend.context = context;
    await x.backend.context().db.patch(x.backend.find("credentials", "human")._id, { projectIds: ["project", "other"] });
    await assert.rejects(x.backend.call(recovery.recover, x.args), /single-project human/);
    await x.backend.context().db.patch(x.backend.find("credentials", "human")._id, { projectIds: ["project"], expiresAt: Date.now() - 1 });
    assert.equal((await x.backend.call(recovery.recover, x.args) as {expiresAt:number}).expiresAt, x.plan.credentialExpiresAt, "an owner may explicitly reauthorize expired scope");
    await x.backend.context().db.patch(x.backend.find("credentials", "recovered_one")._id, { expiresAt: Date.now() - 1 });
    await assert.rejects(x.backend.call(recovery.recover, x.args), /cannot revive/);
  } finally { await rm(x.directory, { recursive: true, force: true }); }
});

test("owner action reports only structured refusals after rollback and cannot revive later-revoked authority", async () => {
  const x = await fixture(); try {
    const before = structuredClone(x.backend.rows);
    assert.deepEqual(await attempt(x.backend, { ...x.args, repository: "other" }), { status: "refused", code: "FORBIDDEN" });
    assert.deepEqual(x.backend.rows, before);
    assert.deepEqual(await attempt(x.backend, { ...x.args, credentialId: "human" }), { status: "refused", code: "INVALID_INPUT" });
    const context = x.backend.context.bind(x.backend);
    // Even an allowlisted refusal after the insert must roll back before the action catches it.
    x.backend.context = () => { const ctx = context(); ctx.db.patch = async () => { throw new ConvexError({ code: "FORBIDDEN", message: "SENSITIVE TRANSACTION ERROR" }); }; return ctx; };
    assert.deepEqual(await attempt(x.backend, x.args), { status: "refused", code: "FORBIDDEN" });
    assert.deepEqual(x.backend.rows, before);
    for (const error of [new Error("SENSITIVE DB ERROR"), new ConvexError({ code: "UNKNOWN", message: "SENSITIVE UNKNOWN ERROR" }), { data: { code: "FORBIDDEN" } }]) {
      x.backend.context = () => { const ctx = context(); ctx.db.patch = async () => { throw error; }; return ctx; };
      assert.deepEqual(await attempt(x.backend, x.args), { status: "unconfirmed" });
      assert.deepEqual(x.backend.rows, before);
    }
    x.backend.context = context;
    const success = await attempt(x.backend, x.args) as { status: string; receipt: unknown }; assert.equal(success.status, "recovered");
    assert.deepEqual(await attempt(x.backend, x.args), success);
    assert.deepEqual(await attempt(x.backend, { ...x.args, credentialDigest: "d".repeat(64) }), { status: "refused", code: "IDEMPOTENCY_CONFLICT" });
    await x.backend.context().db.patch(x.backend.find("credentials", "recovered_one")._id, { revokedAt: Date.now() });
    const revoked = structuredClone(x.backend.rows);
    assert.deepEqual(await attempt(x.backend, x.args), { status: "refused", code: "FORBIDDEN" }); assert.deepEqual(x.backend.rows, revoked);
    assert.equal((recovery.recoverAttempt as unknown as { isInternal: boolean }).isInternal, true);
  } finally { await rm(x.directory, { recursive: true, force: true }); }
});

test("create refuses an existing lost vault without opening it or calling owner recovery", async () => {
  const x = await fixture(), open = fs.open; let openedOld = false, ownerCalled = false;
  fs.open = (async (...args: Parameters<typeof fs.open>) => { if (args[0] === x.oldVault) openedOld = true; return open(...args); }) as typeof fs.open; syncBuiltinESMExports();
  try {
    await assert.rejects(recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human"], { ownerCall: async () => { ownerCalled = true; return {}; } }), /separate operator terminal/);
    assert.equal(ownerCalled, false, "default non-TTY entry refuses before touching owner authentication");
    await assert.rejects(recoverOperatorCommand([x.planPath, x.oldVault, "--replace", "human"], { prompt: confirm, write: () => {}, ownerCall: async () => { ownerCalled = true; return {}; } }), /new vault path/);
    assert.equal(openedOld, false); assert.equal(ownerCalled, false);
  } finally { fs.open = open; syncBuiltinESMExports(); await rm(x.directory, { recursive: true, force: true }); }
});

test("human recovery persists only new authority before digest-only owner call; lost reply retries and passkey setup uses recovered vault", async () => {
  const x = await fixture(), shown: string[] = [], oldBytes = await readFile(x.oldVault), argsSeen: Record<string, unknown>[] = []; let loseReply = true;
  const ownerCall = async (_plan: unknown, operation: "inspect" | "recover", args: Record<string, unknown>) => {
    if (operation === "inspect") return x.backend.call(recovery.inspect, args as never);
    const encoded = await readFile(x.newVault, "utf8"); assert(encoded.includes('"ciphertext"')); assert(!encoded.includes(password)); argsSeen.push(args);
    const result = await attempt(x.backend, args); if (loseReply) { loseReply = false; throw new Error("secret-child-error-canary"); } return result;
  };
  try {
    await assert.rejects(recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human"], { prompt: confirm, write: text => { shown.push(text); }, ownerCall }), error => !String(error).includes("secret-child-error-canary"));
    assert(!shown.join("").includes("Operator access recovered."), "a lost reply never reports success");
    await assert.rejects(recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human"], { prompt: confirm, write: () => {}, ownerCall }), /new vault path/);
    await recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human", "--retry"], { prompt: confirm, write: text => { shown.push(text); }, ownerCall });
    assert.deepEqual(argsSeen[0], argsSeen[1]); assert.deepEqual(await readFile(x.oldVault), oldBytes);
    const recovered = await unlockOperatorBundle(x.plan, x.newVault, password); assert.equal(digest(recovered.humanToken), argsSeen[0]!.credentialDigest); assert.notEqual(recovered.humanToken, x.old.humanToken);
    await assert.rejects(unlockBundle(x.plan, x.newVault, password), /Invalid onboarding/);
    for (const secret of [password, oldPassword, x.old.humanToken, x.old.agentToken, recovered.humanToken, "secret-child-error-canary"]) { assert(!shown.join("").includes(secret)); assert(!JSON.stringify(argsSeen).includes(secret)); }
    await wire(x.backend, async () => {
      const session = await openOperatorSession({ plan: x.planPath, vault: x.newVault }, { prompt: async () => password, write: () => {} }); assert.equal(session.plan.humanId, "human");
      let enrollmentId = "";
      await passkeySetupCommand([x.planPath, x.newVault], { prompt: async (label, hidden) => hidden ? password : label === "Browser's own fingerprint (43 characters, copied from the browser): " ? "f".repeat(43) : label.slice(5, label.indexOf(" to approve exactly this:")), write: () => {}, openBrowser: async url => {
        enrollmentId = new URL(url).searchParams.get("enrollment")!;
        const row = x.backend.find("approvalEnrollments", enrollmentId); assert.equal(row.humanCredentialId, argsSeen[0]!.credentialId);
        await x.backend.context().db.patch(row._id, { credentialId: "Y3JlZGVudGlhbA", publicKeySpki: "cHVibGlj", fingerprint: "f".repeat(43), signCount: 0 });
      } });
      assert(x.backend.find("approvalEnrollments", enrollmentId).enrolledAt);
    });
  } finally { await rm(x.directory, { recursive: true, force: true }); }
});

test("confirmed CLI refusal preserves the vault for protected inspection and never recommends blind retry", async () => {
  const x = await fixture(); let shown = "";
  const ownerCall = async (_plan: unknown, operation: "inspect" | "recover", args: Record<string, unknown>) => {
    if (operation === "inspect") return x.backend.call(recovery.inspect, args as never);
    const result = await attempt(x.backend, args);
    if ((result as { status: string }).status === "recovered") {
      await x.backend.context().db.patch(x.backend.find("credentials", String(args.credentialId))._id, { revokedAt: Date.now() });
      throw new Error("SENSITIVE LOST REPLY");
    }
    return result;
  };
  try {
    await assert.rejects(recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human"], { prompt: confirm, write: text => { shown += text; }, ownerCall }), /unconfirmed.*--retry/);
    const encoded = await readFile(x.newVault), before = structuredClone(x.backend.rows);
    await assert.rejects(recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human", "--retry"], { prompt: confirm, write: text => { shown += text; }, ownerCall }), error => {
      const message = String(error); return message.includes("refused (FORBIDDEN)") && message.includes("Preserve the recovery vault") && message.includes("protected owner inspection") && !message.includes("--retry") && !message.includes("SENSITIVE");
    });
    assert.deepEqual(await readFile(x.newVault), encoded); assert.deepEqual(x.backend.rows, before); assert(!shown.includes("Operator access recovered."));
  } finally { await rm(x.directory, { recursive: true, force: true }); }
});

test("malformed, unbound and unknown recovery replies stay uncertain with the same vault and exact retry", async () => {
  const x = await fixture(); let reply: unknown, encoded: Buffer | undefined; const calls: Record<string, unknown>[] = [];
  const ownerCall = async (_plan: unknown, operation: "inspect" | "recover", args: Record<string, unknown>) => {
    if (operation === "inspect") return x.backend.call(recovery.inspect, args as never);
    calls.push(args); if (reply instanceof Error) throw reply; return reply;
  };
  try {
    for (const value of [new Error("SENSITIVE TIMEOUT"), undefined, [], { status: "refused", code: "UNKNOWN" }, { status: "refused", code: "FORBIDDEN", raw: "SENSITIVE" }, { status: "unconfirmed" }, { status: "recovered", receipt: {} }, { status: "recovered", receipt: { ...x.args, recoveredAt: Date.now() } }]) {
      reply = value;
      await assert.rejects(recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human", ...(encoded ? ["--retry"] : [])], { prompt: confirm, write: () => {}, ownerCall }), error => String(error).includes("unconfirmed") && String(error).includes("--retry") && !String(error).includes("SENSITIVE"));
      const current = await readFile(x.newVault); if (encoded) assert.deepEqual(current, encoded); else encoded = current;
      assert.equal(x.backend.find("credentials", "human").revokedAt, undefined);
    }
    assert(calls.every(args => JSON.stringify(args) === JSON.stringify(calls[0])));
  } finally { await rm(x.directory, { recursive: true, force: true }); }
});

test("official owner subprocess parses only structured stdout and suppresses raw errors", async () => {
  const x = await fixture(), original = childProcess.execFileSync; const calls: string[][] = []; let output = "", failInspect = true, recoverOutput: string | undefined;
  childProcess.execFileSync = ((file: string, args: readonly string[], options: unknown) => {
    if (!String(args[0]).endsWith("node_modules/convex/bin/main.js")) return original(file, args, options as never);
    calls.push([...args]); const operation = args[2]; if (operation === "operatorRecovery:inspect" && !failInspect) return JSON.stringify({ ...x.selection, expiresAt: x.plan.credentialExpiresAt, revoked: false, lapsed: false });
    if (operation === "operatorRecovery:recoverAttempt" && recoverOutput !== undefined) return recoverOutput;
    throw new Error("SENSITIVE OWNER CLI ERROR");
  }) as typeof childProcess.execFileSync; syncBuiltinESMExports();
  try {
    await assert.rejects(recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human"], { prompt: confirm, write: text => { output += text; } }), error => String(error).includes("before recovery") && !String(error).includes("SENSITIVE OWNER"));
    await assert.rejects(readFile(x.newVault), { code: "ENOENT" }); assert.equal(x.backend.find("credentials", "human").revokedAt, undefined); failInspect = false; calls.length = 0;
    await assert.rejects(recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human"], { prompt: confirm, write: text => { output += text; } }), error => String(error).includes("unconfirmed") && !String(error).includes("SENSITIVE OWNER"));
    const unlocked = await unlockOperatorBundle(x.plan, x.newVault, password); const args = JSON.parse(calls[1]![3]!); assert.equal(args.credentialDigest, digest(unlocked.humanToken));
    const encoded = await readFile(x.newVault), receipt = { recoveryId: args.recoveryId, credentialId: args.credentialId, replacedCredentialId: args.replacedCredentialId, memberId: args.memberId, projectId: args.projectId, expiresAt: args.expiresAt, recoveredAt: Date.now() };
    for (const [value, expected] of [
      [JSON.stringify({ status: "refused", code: "FORBIDDEN" }), /refused \(FORBIDDEN\).*protected owner inspection/],
      ['SENSITIVE malformed stderr-like "code":"FORBIDDEN"', /unconfirmed.*--retry/],
      [JSON.stringify({ status: "refused", code: "SENSITIVE UNKNOWN CODE" }), /unconfirmed.*--retry/],
      [JSON.stringify({ status: "recovered", receipt: { ...receipt, credentialId: "wrong" } }), /unconfirmed.*--retry/],
      [JSON.stringify({ status: "recovered", receipt: { ...receipt, raw: "SENSITIVE" } }), /unconfirmed.*--retry/],
    ] as const) {
      recoverOutput = value;
      await assert.rejects(recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human", "--retry"], { prompt: confirm, write: text => { output += text; } }), error => expected.test(String(error)) && !String(error).includes("SENSITIVE"));
      assert.deepEqual(await readFile(x.newVault), encoded);
    }
    assert(!output.includes("Operator access recovered."));
    recoverOutput = JSON.stringify({ status: "recovered", receipt });
    await recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human", "--retry"], { prompt: confirm, write: text => { output += text; } });
    assert(output.includes("Operator access recovered."));
    assert(calls.filter(args => args[2] === "operatorRecovery:recoverAttempt").every(call => call[3] === calls[1]![3]));
    assert(!calls.some(args => args[2] === "operatorRecovery:recover"), "owner CLI always uses the safe action envelope");
    assert(!JSON.stringify(calls).includes(unlocked.humanToken)); assert(!JSON.stringify(calls).includes(password)); assert(!output.includes("SENSITIVE OWNER")); assert(calls.every(args => args.includes("--deployment") && args.includes("fixture") && !args.includes("--push")));
  } finally { childProcess.execFileSync = original; syncBuiltinESMExports(); await rm(x.directory, { recursive: true, force: true }); }
});

// The recorded audit row names the public replacement credential without opening the recovery vault's own binding.
const recoveredId = (backend: BackendFixture): string => String([...backend.rows.values()].find(row => row._table === "audit" && row.operation === "operatorRecovery.recover")!.recordId);
const wiredOwnerCall = (x: { backend: BackendFixture }) => async (_plan: unknown, operation: "inspect" | "recover", args: Record<string, unknown>): Promise<unknown> =>
  operation === "inspect" ? x.backend.call(recovery.inspect, args as never) : attempt(x.backend, args);

test("the bounded expiry sweep leaves lapsed human authority recoverable through the documented path", async () => {
  const x = await fixture(); let shown = ""; try {
    const beforeAgent = x.backend.find("credentials", "agent"), beforeProject = x.backend.find("projects", "project");
    await x.backend.context().db.patch(x.backend.find("credentials", "human")._id, { expiresAt: Date.now() - 1 });
    assert.equal((await x.backend.call(lifecycle.sweep, {}) as { credentials: number }).credentials, 1);
    const swept = x.backend.find("credentials", "human");
    // The sweep must keep revoking the lapsed grant; only its separate cause stamp makes the lapse recoverable.
    assert.equal(typeof swept.revokedAt, "number"); assert.equal(swept.lapsedAt, swept.revokedAt); assert.equal(swept.expiresAt, Number.MAX_SAFE_INTEGER);
    await assert.rejects(x.backend.call(auth.handshake, { backendId: "backend", projectId: "project", token: x.old.humanToken, protocolVersion: 1, clientVersion: "0.1.0-private", capabilities: [], requestId: "swept" }), /invalid for this backend\/project/);
    assert.deepEqual(await x.backend.call(recovery.inspect, x.selection), { ...x.selection, expiresAt: Number.MAX_SAFE_INTEGER, revoked: true, lapsed: true, replacement: null });
    await recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human"], { prompt: confirm, write: text => { shown += text; }, ownerCall: wiredOwnerCall(x) });
    assert(shown.includes("The old grant expired."), "a swept lapse still reports explicit reauthorization");
    assert(shown.includes("Operator access recovered."));
    const recovered = await unlockOperatorBundle(x.plan, x.newVault, password), replacement = x.backend.find("credentials", recoveredId(x.backend));
    assert.equal(replacement.revokedAt, undefined); assert.equal(replacement.memberId, "human"); assert.equal(replacement.digest, digest(recovered.humanToken)); assert.equal(replacement.expiresAt, x.plan.credentialExpiresAt);
    const replaced = x.backend.find("credentials", "human");
    assert.equal(typeof replaced.revokedAt, "number"); assert.equal(replaced.lapsedAt, undefined, "recovery replaces the lapse with its own deliberate revocation");
    assert.deepEqual(x.backend.find("credentials", "agent"), beforeAgent); assert.deepEqual(x.backend.find("projects", "project"), beforeProject);
    for (const secret of [password, oldPassword, x.old.humanToken, recovered.humanToken]) assert(!shown.includes(secret));
  } finally { await rm(x.directory, { recursive: true, force: true }); }
});

test("the bounded expiry sweep keeps deliberately revoked human authority unrecoverable", async () => {
  const x = await fixture(); const revokedAt = Date.now() - 5_000; try {
    await x.backend.context().db.patch(x.backend.find("credentials", "human")._id, { revokedAt, expiresAt: Date.now() - 1 });
    await x.backend.call(lifecycle.sweep, {});
    const swept = x.backend.find("credentials", "human");
    assert.equal(swept.revokedAt, revokedAt); assert.equal(swept.lapsedAt, undefined, "the sweep never stamps a lapse over a deliberate revocation");
    assert.deepEqual(await x.backend.call(recovery.inspect, x.selection), { ...x.selection, expiresAt: Number.MAX_SAFE_INTEGER, revoked: true, lapsed: false, replacement: null });
    await assert.rejects(x.backend.call(recovery.recover, x.args), /cannot replace revoked authority/);
    await assert.rejects(recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human"], { prompt: confirm, write: () => {}, ownerCall: wiredOwnerCall(x) }), /did not confirm the exact recoverable human authority/);
    await assert.rejects(readFile(x.newVault), { code: "ENOENT" });
  } finally { await rm(x.directory, { recursive: true, force: true }); }
});

test("owner inspection reports the replacement credential so a confirmed refusal names the permanent state", async () => {
  const x = await fixture(); let shown = ""; const ownerCall = wiredOwnerCall(x); try {
    assert.deepEqual((await x.backend.call(recovery.inspect, { ...x.selection, replacementCredentialId: "recovered_one" }) as { replacement: unknown }).replacement, { present: false, revoked: false, expiresAt: null });
    await recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human"], { prompt: confirm, write: text => { shown += text; }, ownerCall });
    const recovered = await unlockOperatorBundle(x.plan, x.newVault, password), credentialId = recoveredId(x.backend);
    const healthy = await x.backend.call(recovery.inspect, { ...x.selection, replacementCredentialId: credentialId });
    assert.deepEqual((healthy as { replacement: unknown }).replacement, { present: true, revoked: false, expiresAt: x.plan.credentialExpiresAt });
    for (const secret of [digest(recovered.humanToken), recovered.humanToken, password]) assert(!JSON.stringify(healthy).includes(secret));
    const record = [...x.backend.rows.values()].find(row => row._table === "idempotency" && row.operation === "operatorRecovery.recover")!;
    await x.backend.context().db.patch(record._id as never, { payloadHash: "0".repeat(64) });
    await assert.rejects(recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human", "--retry"], { prompt: confirm, write: text => { shown += text; }, ownerCall }), error => {
      const message = String(error);
      return message.includes("refused (IDEMPOTENCY_CONFLICT)") && message.includes("present and still valid") && message.includes("already applied") && !message.includes("--retry");
    });
    await x.backend.context().db.patch(record._id as never, { payloadHash: record.payloadHash as string });
    await x.backend.context().db.patch(x.backend.find("credentials", credentialId)._id, { expiresAt: Date.now() - 1 });
    const expired = structuredClone(x.backend.rows);
    await assert.rejects(recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human", "--retry"], { prompt: confirm, write: text => { shown += text; }, ownerCall }), error => {
      const message = String(error);
      return message.includes("refused (FORBIDDEN)") && message.includes("revoked or expired") && message.includes("no exact retry can ever succeed") && message.includes("Preserve the recovery vault") && !message.includes("--retry");
    });
    assert.deepEqual(x.backend.rows, expired, "a confirmed refusal changes no backend state");
    assert.equal(shown.split("Operator access recovered.").length - 1, 1);
  } finally { await rm(x.directory, { recursive: true, force: true }); }
});
