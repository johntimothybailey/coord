import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexToJson } from "convex/values";
import type { Value } from "convex/values";
import { PassThrough } from "node:stream";
import * as auth from "../convex/auth.js";
import * as projects from "../convex/projects.js";
import { BackendFixture } from "./backend.fixture.js";
import { bootstrapArguments, configureAndConnect, createBundle, inspectPlan, parseSetupPlan, planDigest, readProtectedLine, runOwnerBootstrap, setupCommand, unlockBundle } from "../src/onboarding.js";
import type { SetupPlan } from "../src/onboarding.js";
import { credentialKey, readAgentCredential, resolveWorkspace } from "../src/config.js";
import { MAX_LOCAL_FILE_BYTES } from "../src/credentials.js";
const passphrase = "fixture only operator passphrase";
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "coord-onboarding-fixture-"))), root = join(directory, "repository");
  await mkdir(root);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/fixture/private-pilot.git"], { cwd: root, stdio: "ignore" });
  const plan = parseSetupPlan({ schemaVersion: 1, deploymentName: "fixture", workspaceRoot: root, config: { schemaVersion: 1, backendId: "backend", backendUrl: "https://fixture.convex.cloud", projectId: "project", repository: "github.com/fixture/private-pilot", remote: "https://github.com/fixture/private-pilot.git", defaultBranch: "main", ruleTargets: ["AGENTS.md"] }, humanId: "human", agentId: "agent", credentialExpiresAt: Date.now() + 3600_000, policy: { allowedPaths: ["src", "test"], excludedPaths: ["src/private"], sharingApproved: true, capacity: 2, taskCap: 20 } });
  const vault = join(directory, "operator", "vault.json"), store = join(directory, "worker", "coord");
  return { directory, root, plan, vault, store };
}

test("T2 onboarding rejects altered destinations, secret-bearing plan fields and invalid path policy", async () => {
  const f = await fixture();
  try {
    assert.equal((await inspectPlan(f.plan)).root, f.root);
    assert.throws(() => parseSetupPlan({ ...f.plan, token: "not permitted" }));
    assert.throws(() => parseSetupPlan({ ...f.plan, deploymentName: "other" }));
    assert.throws(() => parseSetupPlan({ ...f.plan, policy: { ...f.plan.policy, allowedPaths: ["../private"] } }));
    assert.throws(() => parseSetupPlan({ ...f.plan, config: { ...f.plan.config, backendId: "bad\nvalue" } }));
    assert.throws(() => parseSetupPlan({ ...f.plan, humanId: f.plan.agentId }));
    await assert.rejects(inspectPlan({ ...f.plan, config: { ...f.plan.config, repository: "github.com/fixture/other" } }));
    assert.notEqual(planDigest(f.plan), planDigest({ ...f.plan, policy: { ...f.plan.policy, capacity: 1 } }));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("T1 bootstrap argv contains only digests; protected bundle survives exact retry and rejects changed policy", async () => {
  const f = await fixture();
  try {
    const bundle = await createBundle(f.plan, f.vault, passphrase), args = bootstrapArguments(f.plan, bundle);
    assert.ok(!JSON.stringify(args).includes(bundle.humanToken) && !JSON.stringify(args).includes(bundle.agentToken));
    assert.equal(args.humanDigest, await auth.digest(bundle.humanToken));
    assert.equal(args.agentDigest, await auth.digest(bundle.agentToken));
    assert.deepEqual(await unlockBundle(f.plan, f.vault, passphrase), bundle);
    await assert.rejects(createBundle(f.plan, f.vault, passphrase), { code: "EEXIST" });
    await assert.rejects(unlockBundle({ ...f.plan, policy: { ...f.plan.policy, taskCap: 1 } }, f.vault, passphrase));
    const backend = new BackendFixture();
    await backend.call(auth.bootstrap, args as never);
    assert.equal(backend.find("credentials", "human").digest, args.humanDigest);
    assert.ok(!JSON.stringify([...backend.rows.values()]).includes(bundle.humanToken));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

// Wire-format/handler fixtures only: no cloud, actual human unlock or host qualification is claimed.
test("T1/T2 configured CLI routing uses only project agent authority; replay and drift remain guarded", async () => {
  const f = await fixture(), originalFetch = globalThis.fetch;
  try {
    const bundle = await createBundle(f.plan, f.vault, passphrase), backend = new BackendFixture();
    await backend.call(auth.bootstrap, bootstrapArguments(f.plan, bundle) as never);
    const calls: Array<{ path: string; token: string }> = [];
    globalThis.fetch = async (input, init) => {
      assert.equal(new URL(String(input)).origin, f.plan.config.backendUrl);
      const body = JSON.parse(String(init?.body)) as { path: string; args: Array<{ token: string }> };
      const args = body.args[0]!; calls.push({ path: body.path, token: args.token });
      const handler = body.path === "auth:handshake" ? auth.handshake : body.path === "projects:status" ? projects.status : projects.configure;
      try {
        const result = await backend.call(handler as typeof auth.handshake, args as never);
        return new Response(JSON.stringify({ status: "success", value: convexToJson(result as Value), logLines: [] }), { status: 200 });
      } catch (error) {
        return new Response(JSON.stringify({ status: "error", errorMessage: "Fixture denied", errorData: (error as { data: unknown }).data, logLines: [] }), { status: 200 });
      }
    };
    await configureAndConnect(f.plan, bundle, f.store);
    const config = JSON.parse(await readFile(join(f.root, ".coord.json"), "utf8")) as SetupPlan["config"];
    const resolved = await resolveWorkspace(f.root, join(f.store, "workspaces.json"));
    assert.equal(resolved.config.projectId, f.plan.config.projectId);
    assert.match(resolved.trust.approvalReceipt, new RegExp(planDigest(f.plan)));
    assert.equal(await readAgentCredential(config, join(f.store, "credentials")), bundle.agentToken);
    const local = await readFile(join(f.store, "credentials", `${credentialKey(config.backendId, config.backendUrl)}.json`), "utf8");
    assert.ok(!local.includes(bundle.humanToken));
    assert.ok(calls.filter(c => c.path === "projects:configure").every(c => c.token === bundle.humanToken));
    assert.ok(calls.some(c => c.path === "auth:handshake" && c.token === bundle.agentToken));
    const auditCount = [...backend.rows.values()].filter(row => row._table === "audit").length;
    await configureAndConnect(f.plan, bundle, f.store);
    assert.equal([...backend.rows.values()].filter(row => row._table === "audit").length, auditCount);
    const project = backend.find("projects", f.plan.config.projectId);
    await backend.context().db.patch(project._id, { capacity: 1 });
    await assert.rejects(configureAndConnect(f.plan, bundle, f.store), /permissions differ/);
    await writeFile(join(f.root, ".coord.json"), JSON.stringify({ ...config, projectId: "other" }));
    calls.length = 0;
    await assert.rejects(configureAndConnect(f.plan, bundle, f.store), /Existing local setup differs/);
    assert.equal(calls.length, 0, "local collision rejected before sensitive network operations");
  } finally { globalThis.fetch = originalFetch; await rm(f.directory, { recursive: true, force: true }); }
});

test("hidden input preserves Unicode passphrases across arbitrary UTF-8 chunk boundaries", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(value: boolean) { this.isRaw = value; return this; } });
  const output: string[] = [], expected = "fixture passphrase 🔒 café";
  const pending = readProtectedLine(input as unknown as typeof process.stdin, text => output.push(text), true);
  for (const byte of Buffer.from(expected + "\n")) input.write(Buffer.from([byte]));
  assert.equal(await pending, expected);
  assert.equal(output.join(""), "\n");
  assert.equal(input.isRaw, false);
});

test("registry expansion beyond bounded readable size is rejected before network or replacement", async () => {
  const f = await fixture(), originalFetch = globalThis.fetch;
  try {
    const bundle = await createBundle(f.plan, f.vault, passphrase);
    await mkdir(f.store, { recursive: true, mode: 0o700 });
    const path = join(f.store, "workspaces.json"), original = JSON.stringify({ schemaVersion: 1, workspaces: [], padding: "x".repeat(MAX_LOCAL_FILE_BYTES - 90) });
    await writeFile(path, original, { mode: 0o600 });
    let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("Unexpected network"); };
    await assert.rejects(configureAndConnect(f.plan, bundle, f.store), /registry exceeds local limit/);
    assert.equal(calls, 0);
    assert.equal(await readFile(path, "utf8"), original);
    await assert.rejects(readFile(join(f.root, ".coord.json")), { code: "ENOENT" });
  } finally { globalThis.fetch = originalFetch; await rm(f.directory, { recursive: true, force: true }); }
});

test("bootstrap retry re-syncs exact readable vault bytes and every parent before any owner effect", async () => {
  const f = await fixture(), originalOpen = fs.open, originalExec = childProcess.execFileSync;
  try {
    await mkdir(join(f.directory, "operator"), { mode: 0o700 });
    const events: string[] = []; let failSync = true;
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const file = await originalOpen(...args), originalSync = file.sync.bind(file);
      file.sync = async () => {
        const isFile = (await file.stat()).isFile(); events.push(isFile ? "file-sync" : "directory-sync");
        if (String(args[0]) === f.vault && failSync) throw new Error("Fixture crash before vault fsync");
        return originalSync();
      };
      return file;
    };
    childProcess.execFileSync = ((...args: Parameters<typeof childProcess.execFileSync>) => {
      assert.ok(events.includes("file-sync"));
      assert.ok(events.filter(event => event === "directory-sync").length >= 3);
      assert.equal(events.at(-1), "directory-sync"); events.push("owner-effect");
      assert.equal(args[0], process.execPath);
      const argv = args[1] as string[];
      assert.ok(argv.includes("--deployment") && argv.includes("fixture"));
      return Buffer.from("{}");
    }) as typeof childProcess.execFileSync;
    syncBuiltinESMExports();
    await assert.rejects(createBundle(f.plan, f.vault, passphrase), /before vault fsync/);
    const bundle = await unlockBundle(f.plan, f.vault, passphrase);
    events.length = 0;
    await assert.rejects(runOwnerBootstrap(f.plan, bundle, f.vault), /before vault fsync/);
    assert.ok(!events.includes("owner-effect"));
    failSync = false; events.length = 0;
    await runOwnerBootstrap(f.plan, bundle, f.vault);
    assert.equal(events.at(-1), "owner-effect");
    await writeFile(f.vault, (await readFile(f.vault, "utf8")) + " ");
    events.length = 0;
    await assert.rejects(runOwnerBootstrap(f.plan, bundle, f.vault), /bytes differ/);
    assert.ok(!events.includes("owner-effect"));
  } finally { fs.open = originalOpen; childProcess.execFileSync = originalExec; syncBuiltinESMExports(); await rm(f.directory, { recursive: true, force: true }); }
});

test("protected setup refuses piped agent-owned stdin before creating any credential vault", async () => {
  const f = await fixture(), originalLog = console.log;
  try {
    const path = join(f.directory, "plan.json"); await writeFile(path, JSON.stringify(f.plan));
    console.log = () => {};
    if (!process.stdin.isTTY) await assert.rejects(setupCommand(["bootstrap", path, f.vault]), /separate operator terminal/);
    await assert.rejects(readFile(f.vault), { code: "ENOENT" });
  } finally { console.log = originalLog; await rm(f.directory, { recursive: true, force: true }); }
});
