import assert from "node:assert/strict";
import test from "node:test";
import childProcess, { execFileSync } from "node:child_process";
import fs, { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexToJson } from "convex/values";
import type { Value } from "convex/values";
import { BackendFixture } from "./backend.fixture.js";
import * as auth from "../convex/auth.js";
import * as recovery from "../convex/operatorRecovery.js";
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
    const result = await x.backend.call(recovery.recover, args as never); if (loseReply) { loseReply = false; throw new Error("secret-child-error-canary"); } return result;
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
      await passkeySetupCommand([x.planPath, x.newVault], { prompt: async (label, hidden) => hidden ? password : label.slice(5, label.indexOf(" to approve exactly this:")), write: () => {}, openBrowser: async url => {
        enrollmentId = new URL(url).searchParams.get("enrollment")!;
        const row = x.backend.find("approvalEnrollments", enrollmentId); assert.equal(row.humanCredentialId, argsSeen[0]!.credentialId);
        await x.backend.context().db.patch(row._id, { credentialId: "Y3JlZGVudGlhbA", publicKeySpki: "cHVibGlj", fingerprint: "f".repeat(43), signCount: 0 });
      } });
      assert(x.backend.find("approvalEnrollments", enrollmentId).enrolledAt);
    });
  } finally { await rm(x.directory, { recursive: true, force: true }); }
});

test("official owner subprocess receives only digests/public binding and suppresses raw errors", async () => {
  const x = await fixture(), original = childProcess.execFileSync; const calls: string[][] = []; let output = "", failInspect = true;
  childProcess.execFileSync = ((file: string, args: readonly string[], options: unknown) => {
    if (!String(args[0]).endsWith("node_modules/convex/bin/main.js")) return original(file, args, options as never);
    calls.push([...args]); const operation = args[2]; if (operation === "operatorRecovery:inspect" && !failInspect) return JSON.stringify({ ...x.selection, expiresAt: x.plan.credentialExpiresAt, revoked: false });
    throw new Error("SENSITIVE OWNER CLI ERROR");
  }) as typeof childProcess.execFileSync; syncBuiltinESMExports();
  try {
    await assert.rejects(recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human"], { prompt: confirm, write: text => { output += text; } }), error => String(error).includes("before recovery") && !String(error).includes("SENSITIVE OWNER"));
    await assert.rejects(readFile(x.newVault), { code: "ENOENT" }); assert.equal(x.backend.find("credentials", "human").revokedAt, undefined); failInspect = false; calls.length = 0;
    await assert.rejects(recoverOperatorCommand([x.planPath, x.newVault, "--replace", "human"], { prompt: confirm, write: text => { output += text; } }), error => String(error).includes("unconfirmed") && !String(error).includes("SENSITIVE OWNER"));
    const unlocked = await unlockOperatorBundle(x.plan, x.newVault, password); const args = JSON.parse(calls[1]![3]!); assert.equal(args.credentialDigest, digest(unlocked.humanToken));
    assert(!JSON.stringify(calls).includes(unlocked.humanToken)); assert(!JSON.stringify(calls).includes(password)); assert(!output.includes("SENSITIVE OWNER")); assert(calls.every(args => args.includes("--deployment") && args.includes("fixture") && !args.includes("--push")));
  } finally { childProcess.execFileSync = original; syncBuiltinESMExports(); await rm(x.directory, { recursive: true, force: true }); }
});
