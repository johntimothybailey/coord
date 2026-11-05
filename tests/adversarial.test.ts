import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Value } from "convex/values";
import { credentialKey, parseConfig, readAgentCredential, resolveWorkspace } from "../src/config.js";
import type { WorkspaceConfig } from "../src/config.js";
import { BackendClient } from "../src/client.js";
import { CoordError, REQUIRED_CHECKS, requireCapability } from "../src/protocol.js";
import type { CapabilityEvidence, CapabilityKey, ExecutionMode, RunIdentity } from "../src/protocol.js";
import { loadSession, registerManual } from "../src/session.js";
import type { ManualAdmission } from "../src/session.js";

const config = parseConfig({ schemaVersion: 1, backendId: "team", backendUrl: "https://fixture.convex.cloud", projectId: "project", repository: "github.com/team/repo", remote: "git@github.com:team/repo.git", defaultBranch: "main", ruleTargets: ["AGENTS.md"] });
const key: CapabilityKey = { os: "fixture", harness: "codex", harnessVersion: "fixture-1", adapterVersion: "1", probeVersion: "1", configurationDigest: "fixture-config", gitPolicyDigest: "fixture-policy" };
const isCode = (code: string) => (error: unknown) => error instanceof CoordError && error.code === code;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coord-adversarial-")));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function repository(directory: string) {
  const root = join(directory, "repository");
  await mkdir(root); git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Coord fixture"); git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "remote", "add", "origin", config.remote);
  await writeFile(join(root, ".coord.json"), JSON.stringify(config));
  git(root, "add", ".coord.json"); git(root, "commit", "-m", "Create disposable routing fixture");
  const canonicalRoot = await realpath(root), commonGitDir = await realpath(join(root, ".git"));
  const registry = join(directory, "workspaces.json");
  await writeFile(registry, JSON.stringify({ schemaVersion: 1, workspaces: [{ ...config, root: canonicalRoot, commonGitDir, approvalReceipt: "operator-fixture-receipt" }] }));
  return { root, canonicalRoot, commonGitDir, registry };
}

test("T2 actual Git routing resolves symlink entry paths and rejects committed destination or origin substitutions", async () => {
  await temporary(async directory => {
    const { root, canonicalRoot, registry } = await repository(directory);
    const alias = join(directory, "repository-alias"); await symlink(root, alias, "dir");
    assert.equal((await resolveWorkspace(alias, registry)).root, canonicalRoot);
    for (const changed of [{ backendUrl: "https://other.convex.cloud" }, { backendId: "other" }, { projectId: "other" }, { ruleTargets: ["OTHER.md"] }]) {
      await writeFile(join(root, ".coord.json"), JSON.stringify({ ...config, ...changed }));
      await assert.rejects(resolveWorkspace(root, registry), isCode("UNTRUSTED_WORKSPACE_CONFIG"));
    }
    await writeFile(join(root, ".coord.json"), JSON.stringify(config));
    git(root, "remote", "set-url", "origin", "https://github.com/attacker/repo.git");
    await assert.rejects(resolveWorkspace(root, registry), isCode("UNTRUSTED_WORKSPACE_CONFIG"));
  });
});

test("T2 configuration symlink outside the repository is rejected even with identical trusted contents", async () => {
  await temporary(async directory => {
    const { root, registry } = await repository(directory);
    const external = join(directory, "external-config.json"); await writeFile(external, JSON.stringify(config));
    await rm(join(root, ".coord.json")); await symlink(external, join(root, ".coord.json"));
    await assert.rejects(resolveWorkspace(root, registry), isCode("UNTRUSTED_WORKSPACE_CONFIG"));
  });
});

test("T2 linked worktree inherits only the matching common Git directory, routing and run branch receipt", async () => {
  await temporary(async directory => {
    const { root, commonGitDir, registry } = await repository(directory);
    const worktree = join(directory, "derived"), run = { projectId: config.projectId, commonGitDir, taskId: "task", runId: "run", epoch: 3 };
    git(root, "worktree", "add", "-b", "coord/tasks/task/e3/run", worktree, "HEAD");
    await assert.rejects(resolveWorkspace(worktree, registry));
    await mkdir(join(worktree, ".coord-local"));
    const receipt = join(worktree, ".coord-local/run.json");
    for (const mismatch of [{ taskId: "different" }, { runId: "different" }, { epoch: 2 }, { commonGitDir: directory }, { projectId: "different" }]) {
      await writeFile(receipt, JSON.stringify({ ...run, ...mismatch }));
      await assert.rejects(resolveWorkspace(worktree, registry), isCode("UNTRUSTED_WORKSPACE_CONFIG"));
    }
    await writeFile(receipt, JSON.stringify(run));
    const resolved = await resolveWorkspace(worktree, registry);
    assert.equal(resolved.commonGitDir, commonGitDir); assert.equal(resolved.trust.root, await realpath(root));
    assert.equal(resolved.root, await realpath(worktree));
    await mkdir(join(directory, "unrelated-container"));
    const unrelated = await repository(join(directory, "unrelated-container"));
    await assert.rejects(resolveWorkspace(unrelated.root, registry), isCode("UNTRUSTED_WORKSPACE_CONFIG"));
  });
});

test("T1 credential files cannot substitute another backend destination, identity, role or malformed secret", async () => {
  await temporary(async directory => {
    const path = join(directory, `${credentialKey(config.backendId, config.backendUrl)}.json`);
    const token = "a".repeat(64), stored = { schemaVersion: 1, backendId: config.backendId, backendUrl: config.backendUrl, role: "agent", memberId: "agent", projectIds: [config.projectId], expiresAt: Date.now() + 60_000, token };
    for (const changed of [{ backendId: "other" }, { backendUrl: "https://other.convex.cloud" }, { role: "human" }, { token: "short" }, { schemaVersion: 0 }, { projectIds: ["other-project"] }, { projectIds: [] }, { expiresAt: Date.now() - 1 }, { expiresAt: Number.POSITIVE_INFINITY }]) {
      await writeFile(path, JSON.stringify({ ...stored, ...changed }), { mode: 0o600 });
      await assert.rejects(readAgentCredential(config, directory), isCode("UNAUTHORIZED"));
    }
    await writeFile(path, JSON.stringify(stored));
    assert.equal(await readAgentCredential(config, directory), token);
    const other: WorkspaceConfig = { ...config, backendUrl: "https://other.convex.cloud" };
    await assert.rejects(readAgentCredential(other, directory), { code: "ENOENT" });
  });
});

test("T1 agent credentials reject shared file/directory access and symlink paths before returning a token", async () => {
  await temporary(async directory => {
    const path = join(directory, `${credentialKey(config.backendId, config.backendUrl)}.json`);
    const stored = { schemaVersion: 1, backendId: config.backendId, backendUrl: config.backendUrl, role: "agent", memberId: "agent", projectIds: [config.projectId], expiresAt: Date.now() + 60_000, token: "a".repeat(64) };
    await writeFile(path, JSON.stringify(stored), { mode: 0o600 });
    await chmod(path, 0o644); await assert.rejects(readAgentCredential(config, directory));
    await chmod(path, 0o600); await chmod(directory, 0o755); await assert.rejects(readAgentCredential(config, directory));
    await chmod(directory, 0o700);
    const external = join(directory, "external.json"); await writeFile(external, JSON.stringify(stored), { mode: 0o600 });
    await rm(path); await symlink(external, path); await assert.rejects(readAgentCredential(config, directory));
    await rm(path);
    const alias = join(directory, "credential-alias"); await symlink(directory, alias, "dir");
    await assert.rejects(readAgentCredential(config, alias));
  });
});

function syntheticEvidence(mode: ExecutionMode): CapabilityEvidence {
  return { key: { ...key }, checks: REQUIRED_CHECKS[mode].map(checkId => ({ schemaVersion: 1, checkId, status: "PASS", mode, observedAt: new Date().toISOString(), configurationDigest: key.configurationDigest, command: ["synthetic-guard-fixture"], summary: "Synthetic guard inputs, not observed host qualification", evidenceRef: "fixture-only", kind: "real" })) };
}
test("T20 every capability key component invalidates stale evidence; fixture and incomplete passing checks cannot qualify", () => {
  for (const mode of ["advisory", "manual", "managed"] as const) {
    const evidence = syntheticEvidence(mode);
    requireCapability(evidence, key, mode);
    for (const field of Object.keys(key) as Array<keyof CapabilityKey>) {
      const expected = { ...key, [field]: `${key[field]}-changed` } as CapabilityKey;
      assert.throws(() => requireCapability(evidence, expected, mode), isCode("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION"));
    }
    for (const check of evidence.checks) {
      for (const replacement of [{ kind: "fixture" as const }, { status: "BLOCKED" as const }, { status: "FAIL" as const }, { configurationDigest: "old-config" }, { observedAt: "2000-01-01T00:00:00.000Z" }, { observedAt: new Date(Date.now() + 3600_000).toISOString() }, { evidenceRef: undefined }]) {
        const changed = { ...evidence, checks: evidence.checks.map(current => current === check ? { ...current, ...replacement } : current) };
        assert.throws(() => requireCapability(changed, key, mode), isCode("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION"));
      }
    }
    assert.throws(() => requireCapability({ ...evidence, checks: [...evidence.checks, evidence.checks[0]!] }, key, mode), isCode("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION"));
  }
});

interface TransportState { lostReply: boolean; revoked: boolean; calls: Array<{ name: string; payload: Record<string, Value>; requestId: string }>; checks: number; accepted?: { payload: Record<string, Value>; requestId: string; identity: RunIdentity }; }
/** A dropped-response transport fixture; no HTTP server or Convex runtime is simulated. */
class ReceiptClient extends BackendClient {
  constructor(readonly state: TransportState, configValue: WorkspaceConfig = config, readonly credential = "b".repeat(64)) { super(configValue, credential); }
  override withRunToken(token: string): BackendClient { return new ReceiptClient(this.state, this.config, token); }
  override async mutation(name: string, payload: Record<string, Value>, requestId: string): Promise<unknown> {
    this.state.calls.push({ name, payload: structuredClone(payload), requestId });
    assert.equal(name, "tasks:registerManual");
    if (this.state.accepted) {
      assert.deepEqual(payload, this.state.accepted.payload); assert.equal(requestId, this.state.accepted.requestId);
    } else this.state.accepted = { payload: structuredClone(payload), requestId, identity: { taskId: String(payload.taskId), runId: String(payload.runId), epoch: 1, goalRevision: 2 } };
    if (this.state.lostReply) { this.state.lostReply = false; throw new Error("Lost admission response after acceptance"); }
    return { ...this.state.accepted.identity };
  }
  override async query(name: string, payload: Record<string, Value> = {}): Promise<unknown> {
    this.state.checks++; assert.equal(name, "tasks:checkIn"); assert.deepEqual(payload, this.state.accepted?.identity);
    assert.equal(this.credential, this.state.accepted?.payload.grantToken);
    if (this.state.revoked) throw new CoordError("LEASE_REVOKED", "Historical admission is no longer live");
    return { registered: true };
  }
}
const admission: ManualAdmission = { requestId: "request-1", taskId: "task", machineId: "machine", harness: "codex", capabilityKey: key };
const transport = (): TransportState => ({ lostReply: false, revoked: false, calls: [], checks: 0 });

test("T3/T5 lost manual-admission response replays the persisted request and grant without creating a new identity", async () => {
  await temporary(async root => {
    const state = transport(); state.lostReply = true;
    await assert.rejects(registerManual(root, new ReceiptClient(state), "session", admission), /Lost admission response/);
    const path = join(root, ".coord-local/sessions/session/admission.json");
    const first = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.equal(first.identity, undefined); assert.equal((await loadSession(root, new ReceiptClient(state), "session")), undefined);
    const binding = await registerManual(root, new ReceiptClient(state), "session", admission);
    assert.equal(state.calls.length, 2); assert.equal(state.checks, 1);
    assert.deepEqual(state.calls[0], state.calls[1]);
    const recovered = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.equal(recovered.runId, first.runId); assert.equal(recovered.grantToken, first.grantToken);
    assert.deepEqual(recovered.identity, binding.identity);
    assert(!JSON.stringify(binding.publicResult).includes(String(first.grantToken)));
    assert.deepEqual((await loadSession(root, new ReceiptClient(state), "session"))?.identity, binding.identity);
    await assert.rejects(registerManual(root, new ReceiptClient(state), "session", { ...admission, taskId: "other" }), isCode("IDEMPOTENCY_CONFLICT"));
    assert.equal(state.calls.length, 2);
  });
});

test("T3/T11 old admission success cannot turn a revoked receipt into current registration", async () => {
  await temporary(async root => {
    const state = transport(), client = new ReceiptClient(state);
    await registerManual(root, client, "session", admission);
    state.revoked = true;
    await assert.rejects(registerManual(root, new ReceiptClient(state), "session", admission), isCode("LEASE_REVOKED"));
    assert.equal(state.calls.length, 2); assert.equal(state.checks, 2);
    assert.deepEqual(state.calls[0], state.calls[1]);
    await assert.rejects(loadSession(root, new ReceiptClient(state), "session"), isCode("LEASE_REVOKED"));
    assert.equal(state.checks, 3);
  });
});

test("T1/T2 private admission receipts reject routing substitution, broad permissions and symlink directories", async () => {
  await temporary(async root => {
    const state = transport(); await registerManual(root, new ReceiptClient(state), "session", admission);
    const path = join(root, ".coord-local/sessions/session/admission.json");
    const anotherBackend = new ReceiptClient(state, { ...config, backendId: "another" });
    await assert.rejects(loadSession(root, anotherBackend, "session"), isCode("UNAUTHORIZED"));
    await chmod(path, 0o644);
    await assert.rejects(loadSession(root, new ReceiptClient(state), "session"), isCode("UNAUTHORIZED"));
    const external = join(root, "external"); await mkdir(external);
    await symlink(external, join(root, ".coord-local/sessions/linked"), "dir");
    await assert.rejects(loadSession(root, new ReceiptClient(state), "linked"), isCode("UNTRUSTED_WORKSPACE_CONFIG"));
    await assert.rejects(registerManual(root, new ReceiptClient(state), "../escape", admission), isCode("INVALID_INPUT"));
    await assert.rejects(registerManual(root, new ReceiptClient(state), undefined, admission), isCode("BLOCKED_ENV"));
  });
});
