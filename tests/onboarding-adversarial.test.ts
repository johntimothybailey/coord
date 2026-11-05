import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexToJson } from "convex/values";
import type { Value } from "convex/values";
import { BackendFixture } from "./backend.fixture.js";
import * as auth from "../convex/auth.js";
import * as projects from "../convex/projects.js";
import { bootstrapArguments, configureAndConnect, createBundle, parseSetupPlan, planDigest, unlockBundle } from "../src/onboarding.js";
import { credentialKey, resolveWorkspace } from "../src/config.js";

const passphrase = "SYNTHETIC TEST PASSPHRASE ONLY 90b2";
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "coord-onboarding-adversarial-"))), root = join(directory, "repository"); await mkdir(root);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/fixture/independent.git"], { cwd: root, stdio: "ignore" });
  const plan = parseSetupPlan({ schemaVersion: 1, deploymentName: "fixture", workspaceRoot: root, config: { schemaVersion: 1, backendId: "backend", backendUrl: "https://fixture.convex.cloud", projectId: "project", repository: "github.com/fixture/independent", remote: "https://github.com/fixture/independent.git", defaultBranch: "main", ruleTargets: ["AGENTS.md"] }, humanId: "human", agentId: "agent", credentialExpiresAt: Date.now() + 3600_000, policy: { allowedPaths: ["src"], excludedPaths: [], sharingApproved: true, capacity: 2, taskCap: 20 } });
  const vault = join(directory, "operator/vault.json"), store = join(directory, "worker/coord"), bundle = await createBundle(plan, vault, passphrase), backend = new BackendFixture();
  await backend.call(auth.bootstrap, bootstrapArguments(plan, bundle) as never);
  return { directory, root, plan, vault, store, bundle, backend };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
interface WireCall { path: string; args: Record<string, unknown>; }
async function wire(f: Fixture, run: (calls: WireCall[]) => Promise<void>, fault?: (call: WireCall, result: unknown) => unknown): Promise<void> {
  const original = globalThis.fetch, calls: WireCall[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).origin, f.plan.config.backendUrl);
    const body = JSON.parse(String(init?.body)) as { path: string; args: Array<Record<string, unknown>> }, args = body.args[0]!;
    const call = { path: body.path, args }; calls.push(call);
    const handler = call.path === "auth:handshake" ? auth.handshake : call.path === "projects:status" ? projects.status : call.path === "projects:configure" ? projects.configure : undefined;
    assert(handler, "Only expected onboarding endpoints may be called");
    const result = await f.backend.call(handler as typeof auth.handshake, args as never);
    const altered = fault ? fault(call, result) : result;
    return new Response(JSON.stringify({ status: "success", value: convexToJson(altered as Value), logLines: [] }), { status: 200 });
  };
  try { await run(calls); } finally { globalThis.fetch = original; }
}

test("T1 exported configure refuses a bundle paired with a changed plan before transmitting credentials", async () => {
  const f = await fixture();
  try {
    await wire(f, async calls => {
      const altered = { ...f.plan, policy: { ...f.plan.policy, capacity: 1 } };
      assert.notEqual(planDigest(altered), f.bundle.planDigest);
      await assert.rejects(configureAndConnect(altered, f.bundle, f.store));
      assert.equal(calls.length, 0);
      assert.throws(() => bootstrapArguments(altered, f.bundle));
    });
    await assert.rejects(readFile(join(f.root, ".coord.json")), { code: "ENOENT" });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("T2 credential and trusted-registry collisions are rejected before configure HTTP or repository writes", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.store, "credentials"), { recursive: true, mode: 0o700 });
    const credential = join(f.store, "credentials", `${credentialKey(f.plan.config.backendId, f.plan.config.backendUrl)}.json`);
    await writeFile(credential, JSON.stringify({ schemaVersion: 1, token: "SYNTHETIC_EXISTING_CREDENTIAL_DO_NOT_OVERWRITE" }), { mode: 0o600 });
    await wire(f, async calls => {
      await assert.rejects(configureAndConnect(f.plan, f.bundle, f.store), /Existing local setup differs/); assert.equal(calls.length, 0);
      await assert.rejects(readFile(join(f.root, ".coord.json")), { code: "ENOENT" });
      await rm(credential);
      const commonGitDir = await realpath(join(f.root, ".git"));
      const registry = { schemaVersion: 1, workspaces: [{ ...f.plan.config, projectId: "other", root: f.root, commonGitDir, approvalReceipt: "unrelated-existing-receipt" }] };
      const path = join(f.store, "workspaces.json"); await writeFile(path, JSON.stringify(registry), { mode: 0o600 });
      await assert.rejects(configureAndConnect(f.plan, f.bundle, f.store), /Existing routing differs/); assert.equal(calls.length, 0);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), registry);
      await assert.rejects(readFile(join(f.root, ".coord.json")), { code: "ENOENT" });
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("T3 lost configure acknowledgment reuses the encrypted bundle request and preserves one backend configuration effect", async () => {
  const f = await fixture(); let drop = true;
  try {
    await wire(f, async calls => {
      await assert.rejects(configureAndConnect(f.plan, f.bundle, f.store), /SYNTHETIC_DROPPED_REPLY/);
      const configured = f.backend.find("projects", f.plan.config.projectId), configVersion = configured.configVersion;
      await assert.rejects(readFile(join(f.root, ".coord.json")), { code: "ENOENT" });
      const recovered = await unlockBundle(f.plan, f.vault, passphrase);
      await configureAndConnect(f.plan, recovered, f.store);
      const attempts = calls.filter(call => call.path === "projects:configure"); assert.equal(attempts.length, 2);
      assert.equal(attempts[0]?.args.requestId, attempts[1]?.args.requestId); assert.equal(attempts[1]?.args.requestId, recovered.configureRequestId);
      assert.equal(f.backend.find("projects", f.plan.config.projectId).configVersion, configVersion);
      const resolved = await resolveWorkspace(f.root, join(f.store, "workspaces.json")); assert.equal(resolved.config.projectId, f.plan.config.projectId);
      assert(!(await readFile(join(f.store, "workspaces.json"), "utf8")).includes(f.bundle.humanToken));
    }, (call, result) => { if (call.path === "projects:configure" && drop) { drop = false; throw new Error("SYNTHETIC_DROPPED_REPLY"); } return result; });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("T1 agent readback of another project cannot persist trusted routing after human configuration", async () => {
  const f = await fixture();
  try {
    await wire(f, async calls => {
      await assert.rejects(configureAndConnect(f.plan, f.bundle, f.store), /Backend project identity differs/);
      assert(calls.some(call => call.path === "projects:configure"));
      await assert.rejects(readFile(join(f.root, ".coord.json")), { code: "ENOENT" });
      await assert.rejects(readFile(join(f.store, "workspaces.json")), { code: "ENOENT" });
      await assert.rejects(readFile(join(f.store, "credentials", `${credentialKey(f.plan.config.backendId, f.plan.config.backendUrl)}.json`)), { code: "ENOENT" });
    }, (call, result) => call.path === "projects:status" && call.args.token === f.bundle.agentToken ? { ...result as object, project: { ...(result as { project: object }).project, id: "another-project" } } : result);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("T1/T2 asynchronous setup pins a deep plan and bundle snapshot before any caller mutation", async () => {
  const f = await fixture();
  try {
    await wire(f, async calls => {
      const plan = structuredClone(f.plan), bundle = { ...f.bundle };
      const pending = configureAndConnect(plan, bundle, f.store);
      plan.config.backendUrl = "https://unexpected.convex.cloud"; plan.config.projectId = "different-project";
      plan.policy.allowedPaths.push("different-path"); plan.policy.capacity = 1;
      bundle.humanToken = "a".repeat(64); bundle.agentToken = "b".repeat(64); bundle.configureRequestId = "different-request";
      await pending;
      const configured = calls.find(call => call.path === "projects:configure")!;
      assert.equal(configured.args.requestId, f.bundle.configureRequestId); assert.equal(configured.args.token, f.bundle.humanToken);
      assert.deepEqual(configured.args.allowedPaths, f.plan.policy.allowedPaths); assert.equal(configured.args.capacity, f.plan.policy.capacity);
      const resolved = await resolveWorkspace(f.root, join(f.store, "workspaces.json")); assert.deepEqual(resolved.config, f.plan.config);
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("T1 real vault-file tampering, wrong passphrase and public permissions never return or echo synthetic bundle secrets", async () => {
  const f = await fixture();
  try {
    const original = await readFile(f.vault, "utf8"), envelope = JSON.parse(original) as { tag: string };
    envelope.tag = `${envelope.tag[0] === "a" ? "b" : "a"}${envelope.tag.slice(1)}`;
    await writeFile(f.vault, JSON.stringify(envelope));
    const redacted = (error: unknown) => { const text = String(error); assert(!text.includes(f.bundle.humanToken)); assert(!text.includes(f.bundle.agentToken)); assert(!text.includes(passphrase)); return true; };
    await assert.rejects(unlockBundle(f.plan, f.vault, passphrase), redacted);
    await writeFile(f.vault, original); await assert.rejects(unlockBundle(f.plan, f.vault, "SYNTHETIC INCORRECT PASSPHRASE"), redacted);
    await chmod(f.vault, 0o644); await assert.rejects(unlockBundle(f.plan, f.vault, passphrase), redacted);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
