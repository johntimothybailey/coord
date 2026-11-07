import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Value } from "convex/values";
import { connectWorkspace, BackendClient } from "./client.js";
import { resolveWorkspace } from "./config.js";
import type { ResolvedWorkspace } from "./config.js";
import { captureCheckpoint, captureDigest, git, gitText, publishCheckpoint, readTree, verifyRemoteCheckpoint } from "./checkpoint.js";
import type { CaptureAuthority, CaptureOptions, PreparedCheckpoint } from "./checkpoint.js";
import { CommandStore, effectivePreflight, readRuntime, roleClient, runtimeDigest, verifyRuntime, writeRoutingCopy } from "./command-runtime.js";
import type { RuntimeConfig } from "./command-runtime.js";
import { admitSession, copySession, loadSession, readSessionBinding } from "./session.js";
import type { RunBinding } from "./session.js";
import { createResumeWorktree } from "./worktree.js";
import { scanCheckpoint, uploadScope, verifyScope } from "./scan.js";
import { publishReview } from "./review.js";
import { GitHubReviewAdapter } from "./github.js";
import { CoordError } from "./protocol.js";
import type { ExecutionBase, RunIdentity, StopEvidence, VerificationEvidence } from "./protocol.js";
import type { CapabilityEvidence, CapabilityKey, LaunchReceipt } from "./protocol.js";
import { LaunchJournalStore, recordExitAndRelease, startLaunch } from "./launch.js";
import { createLaunchSupervisor, readNativeBootId } from "./supervisor.js";
import { startDaemon } from "./daemon.js";
import type { DispatchCandidate, DispatchSnapshot } from "./daemon.js";
import { codexAdapter } from "./adapters/codex.js";
import { antigravityAdapter } from "./adapters/antigravity.js";
import { createCgroupControl } from "./containment.js";
import { runVerification } from "./verification-runner.js";
import { canonicalJson } from "./canonical.js";
import { requireGitMetadataIsolation, validateGitTransport } from "./git-transport.js";
import { checkStoreDirectory, readSmallFile, syncLocalFile, writeNewPrivateFile } from "./credentials.js";
import { backendFailure } from "./hooks.js";

interface OwnerProvenance { schemaVersion: 1; route: ResolvedWorkspace["config"]; runtimeDigest: string; machineId: string; memberId: string; capability: CapabilityEvidence; containment?: RuntimeConfig["containment"]; metadataRoot: string; verifiedAt: string; evidenceRef: string; }
interface Context { workspace: ResolvedWorkspace; agent?: BackendClient; runtime: RuntimeConfig; runtimePath: string; store: CommandStore; recoveryOnly: boolean; mode: "manual" | "managed"; boundRun?: RunBinding; ownerProvenance?: OwnerProvenance; }
interface Authority extends CaptureAuthority { progress: string; taskState: string; runMode: "manual" | "managed" | "replan"; conflictBlocked: boolean; }
interface DependencyInput { dependency: { taskId: string; mode: "published" | "merged"; artifact?: string }; task: { id: string; title: string; state: string; reason?: string }; availability: "published" | "unavailable" | "unverified_merge"; code: { checkpointId: string; ref: string; commit: string; tree: string; executionBase: ExecutionBase; manifestHash: string; progressHash: string; summary?: string; manifest?: PreparedCheckpoint } | null; }
interface Selection { status: "ready" | "initial_base"; task: { id: string; title: string; progress: string; progressRevision: number; state: string; dependencies: DependencyInput["dependency"][]; latestCheckpointId?: string; executionBase: ExecutionBase; }; goal: { content: string }; manifest: PreparedCheckpoint | null; summary: string | null; executionBase: ExecutionBase; inputs: DependencyInput[]; }
interface CheckpointJournal { schemaVersion: 1; fingerprint: string; identity: RunIdentity; checkpointId: string; createdAt: string; progress: unknown; progressRevision: number; executionBase: ExecutionBase; manifest?: PreparedCheckpoint; state: "started" | "captured" | "ready"; }
interface ResumeJournal { schemaVersion: 1; fingerprint: string; selection: Selection; sessionId: string; requestId: string; mode: "manual" | "managed" | "replan"; state: "selected" | "admitted" | "allocating" | "allocated" | "ready" | "never-started"; identity?: RunIdentity; path?: string; restoreRevision?: number; }
interface ReviewJournal { schemaVersion: 1; fingerprint: string; verification?: VerificationEvidence; targetBase?: string; state: "started" | "verified" | "accepting" | "accepted"; }
const req = (operation: string, value: unknown): string => `${operation}_${captureDigest(value)}`;
const asValue = (value: unknown): Value => value as Value;
const metadataProof = (ctx: Context) => ({ expectedKey: ctx.runtime.capability.key, capabilityEvidence: ctx.runtime.capability, mode: ctx.mode });
const commandGit = (ctx: Context, repo: string, argv: string[]) => git(repo, argv, { transport: ctx.runtime.gitTransport, metadataIsolation: metadataProof(ctx) });
const commandGitText = (ctx: Context, repo: string, argv: string[]) => gitText(repo, argv, { transport: ctx.runtime.gitTransport, metadataIsolation: metadataProof(ctx) });
const identityPayload = (run: RunBinding): Record<string, Value> => ({ ...run.identity });
function projectClient(ctx: Context): BackendClient { if (!ctx.agent) throw new CoordError("FORBIDDEN", "Recovery cannot create project execution authority"); return ctx.agent; }
const parseProgress = (progress: string): unknown => { try { return JSON.parse(progress) as unknown; } catch { return progress; } };
function selectedAdapter(runtime: RuntimeConfig, replan: boolean) {
  if (!replan) return runtime.harness.kind === "codex" ? codexAdapter : antigravityAdapter;
  const checks = runtime.capability.checks.filter(check => check.checkId === "harness.replan-readonly"), check = checks[0];
  const observed = check ? Date.parse(check.observedAt) : NaN;
  if (runtime.harness.kind !== "codex" || checks.length !== 1 || !check || check.kind !== "real" || check.status !== "PASS" || check.mode !== "managed" || check.configurationDigest !== runtimeDigest(runtime) || !check.evidenceRef || !Number.isFinite(observed) || observed > Date.now() || Date.now() - observed > 86400_000) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Replanning requires current owner-provisioned all-tool read-only Codex qualification; Antigravity mode is unsupported");
  return { ...codexAdapter, launchArgs: (prompt: string) => ["exec", "--json", "--sandbox", "read-only", "--", prompt] };
}
function requireRuntimeActions(runtime: RuntimeConfig, mode: "manual" | "managed"): void {
  const checks = runtime.capability.checks.filter(check => check.checkId === "mcp.runtime-actions"), check = checks[0], observed = check ? Date.parse(check.observedAt) : NaN;
  if (checks.length !== 1 || !check || check.kind !== "real" || check.status !== "PASS" || check.mode !== mode && !(mode === "manual" && check.mode === "managed") || check.configurationDigest !== runtimeDigest(runtime) || !check.evidenceRef || !Number.isFinite(observed) || observed > Date.now() || Date.now() - observed > 86400_000) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Current owner-provisioned protected runtime MCP action wiring is required for this execution mode");
}
function runtimeAdapter(ctx: Context, run: RunBinding, replan: boolean) {
  requireRuntimeActions(ctx.runtime, ctx.mode);
  const adapter = selectedAdapter(ctx.runtime, replan);
  if (adapter.harness !== "codex") return adapter; // Antigravity uses the already qualified installed plugin and bound nonsecret environment.
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  return { ...adapter, launchArgs: (prompt: string) => ["-c", `mcp_servers.coord.command=${JSON.stringify(process.execPath)}`, "-c", `mcp_servers.coord.args=${JSON.stringify([cli, "mcp", "--runtime", ctx.runtimePath, "--session", run.sessionId!])}`, ...adapter.launchArgs(prompt)] };
}
function beneath(path: string, root: string): boolean { const value = relative(root, path); return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.startsWith(sep)); }
async function context(cwd: string, runtimePath: string, recoveryOnly = false): Promise<Context> {
  const runtime = await readRuntime(runtimePath);
  await readSmallFile(runtime.trustedRegistryPath, true);
  const workspace = await resolveWorkspace(cwd, runtime.trustedRegistryPath);
  runtimePath = await realpath(runtimePath);
  if (beneath(runtimePath, runtime.workspaceRoot) || beneath(runtimePath, runtime.worktreeRoot)) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Protected runtime configuration must remain outside every worker tree");
  if (runtime.workspaceRoot !== workspace.trust.root || await realpath(runtime.workspaceRoot) !== runtime.workspaceRoot || !beneath(workspace.root, runtime.workspaceRoot) && workspace.commonGitDir !== workspace.trust.commonGitDir) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Runtime differs from protected repository association");
  for (const path of [runtime.stateDirectory, runtime.trustedRegistryPath, runtime.agentCredentialDirectory, runtime.verifierCredentialFile, runtime.supervisorCredentialFile].filter((value): value is string => Boolean(value))) if (beneath(path, runtime.workspaceRoot) || beneath(path, runtime.worktreeRoot)) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Trusted routing/runtime state and credentials must remain outside worker trees");
  for (const path of recoveryOnly ? [] : [runtime.harness.executable, runtime.gitTransport.executable, runtime.gitTransport.home, ...runtime.gitTransport.searchPath.split(":")]) {
    const canonical = await realpath(path);
    const info = await lstat(canonical);
    if (canonical !== path || (info.mode & 0o022) || [runtime.workspaceRoot, runtime.worktreeRoot, runtime.policy.workerHome].some(root => beneath(canonical, root))) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Selected trusted executables/provider paths must be canonical and outside worker-writable roots");
  }
  if (runtime.gitTransport.url !== workspace.config.remote) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Fixed Git transport differs from selected project remote");
  if (!recoveryOnly) await validateGitTransport(runtime.gitTransport);
  const agent = recoveryOnly ? undefined : await connectWorkspace(cwd, { registryPath: runtime.trustedRegistryPath, credentialDirectory: runtime.agentCredentialDirectory });
  return { workspace, runtime, runtimePath, agent, store: new CommandStore(runtime.stateDirectory), recoveryOnly, mode: "manual" };
}
async function authority(client: BackendClient, identity: RunIdentity): Promise<Authority> {
  const current = await client.query("checkpoints:authority", { ...identity }) as Authority;
  if (captureDigest(current.identity) !== captureDigest(identity) || !current.policyDigest || current.conflictBlocked) throw new CoordError("CHECKPOINT_INCOMPLETE", "Current exact authority and approved capture policy are required");
  return current;
}
async function verifyQualification(ctx: Context, mode: "manual" | "managed") {
  ctx.mode = mode;
  const actual = await readRuntime(ctx.runtimePath);
  if (runtimeDigest(actual) !== runtimeDigest(ctx.runtime) || captureDigest(actual.capability.key) !== captureDigest(ctx.runtime.capability.key)) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Protected runtime changed during operation");
  const key = await verifyRuntime(actual, mode);
  if (!ctx.recoveryOnly) {
    const status = await projectClient(ctx).query("projects:status") as { project: { id: string; backendId: string; repository: string; remote: string; defaultBranch: string; sharingApproved: boolean; capturePolicyDigest?: string } };
    const project = status.project;
    if (project.id !== ctx.workspace.config.projectId || project.backendId !== ctx.workspace.config.backendId || project.repository !== ctx.workspace.config.repository || project.remote !== ctx.workspace.config.remote || project.defaultBranch !== ctx.workspace.config.defaultBranch || !project.sharingApproved || project.capturePolicyDigest !== captureDigest(actual.policy.capture)) throw new CoordError("FORBIDDEN", "Runtime lacks the current exact protected repository/sharing/capture policy");
  }
  const machine = await projectClient(ctx).query("machines:runtime", { machineId: ctx.runtime.machineId }) as { machineId: string; memberId: string; configVersion: number; projectConfigVersion: number; qualificationExpiresAt: number; qualifiedModes: string[]; capabilityKey: unknown; capabilityChecks: unknown[]; qualificationEvidenceRef: string | null };
  if (machine.machineId !== ctx.runtime.machineId || machine.memberId !== ctx.runtime.memberId || machine.configVersion !== machine.projectConfigVersion || !machine.qualifiedModes.includes(mode) || machine.qualificationExpiresAt <= Date.now() || !machine.qualificationEvidenceRef || captureDigest(machine.capabilityKey) !== captureDigest(key) || captureDigest(machine.capabilityChecks) !== captureDigest(actual.capability.checks)) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Protected runtime evidence differs from independently owner-provisioned backend qualification");
  if (!ctx.recoveryOnly) requireGitMetadataIsolation(metadataProof(ctx));
  ctx.ownerProvenance = { schemaVersion: 1, route: structuredClone(ctx.workspace.config), runtimeDigest: runtimeDigest(actual), machineId: ctx.runtime.machineId, memberId: ctx.runtime.memberId, capability: structuredClone(actual.capability), containment: structuredClone(actual.containment), metadataRoot: join(actual.stateDirectory, "launches"), verifiedAt: new Date().toISOString(), evidenceRef: machine.qualificationEvidenceRef };
  return key;
}
function captureAuthority(value: Authority): CaptureAuthority { return { identity: value.identity, executionBase: value.executionBase, progressRevision: value.progressRevision, progressHash: value.progressHash, policyDigest: value.policyDigest }; }
function captureOptions(ctx: Context, run: RunBinding, journal: CheckpointJournal, reader = run.client): CaptureOptions {
  return { repo: ctx.workspace.root, remote: { name: "origin", url: ctx.workspace.config.remote }, checkpointId: journal.checkpointId, identity: journal.identity, executionBase: journal.executionBase, progress: journal.progress, progressRevision: journal.progressRevision, createdAt: journal.createdAt, commitMessage: "Preserve verified progress for independent continuation\n\nConfidence: high\nScope-risk: narrow\nDirective: Preserve the verified execution-base parent", policy: ctx.runtime.policy.capture, gitTransport: ctx.runtime.gitTransport, gitMetadataIsolation: metadataProof(ctx), readAuthority: async () => captureAuthority(await authority(reader, run.identity)), quietBoundary: async () => { await authority(reader, run.identity); } };
}
async function requireRun(ctx: Context, sessionId: string, finalizing = false): Promise<RunBinding> {
  if (ctx.boundRun) {
    if (ctx.boundRun.sessionId !== sessionId) throw new CoordError("STALE_EPOCH", "Runtime action session differs from its protected startup binding");
    if (!finalizing) await ctx.boundRun.client.query("tasks:checkIn", identityPayload(ctx.boundRun));
    return ctx.boundRun;
  }
  const run = await (finalizing ? readSessionBinding : loadSession)(ctx.workspace.root, projectClient(ctx), sessionId);
  if (!run) throw new CoordError("LEASE_REVOKED", "A persisted current participating session is required");
  return run;
}
async function assertPolicy(ctx: Context, current: Authority): Promise<void> {
  await verifyQualification(ctx, current.runMode === "manual" ? "manual" : "managed");
  if (current.runMode === "replan") throw new CoordError("FORBIDDEN", "Replanning cannot publish implementation artifacts");
  if (current.policyDigest !== captureDigest(ctx.runtime.policy.capture)) throw new CoordError("FORBIDDEN", "Local capture policy lacks exact protected project approval");
}
async function checkpoint(ctx: Context, sessionId: string, checkpointId: string): Promise<unknown> {
  const run = await requireRun(ctx, sessionId), current = await authority(run.client, run.identity); await assertPolicy(ctx, current);
  const checked = await run.client.query("tasks:checkIn", identityPayload(run)) as { run: { machineId: string } };
  if (checked.run.machineId !== ctx.runtime.machineId) throw new CoordError("FORBIDDEN", "Session belongs to another runtime machine");
  if (current.progressRevision < 1) throw new CoordError("CHECKPOINT_INCOMPLETE", "Record actual task progress before taking a checkpoint");
  const verifier = await roleClient(ctx.workspace.config, ctx.runtime, "artifact_verifier");
  return ctx.store.lock("checkpoint", checkpointId, async () => {
    const fingerprint = captureDigest({ backend: ctx.workspace.config, root: ctx.workspace.root, runtime: runtimeDigest(ctx.runtime), identity: run.identity });
    let journal = await ctx.store.read<CheckpointJournal>("checkpoint", checkpointId);
    if (journal && journal.fingerprint !== fingerprint) throw new CoordError("IDEMPOTENCY_CONFLICT", "Checkpoint ID already belongs to another exact run/configuration");
    if (!journal) { journal = { schemaVersion: 1, fingerprint, identity: run.identity, checkpointId, createdAt: new Date().toISOString(), progress: parseProgress(current.progress), progressRevision: current.progressRevision, executionBase: current.executionBase, state: "started" }; await ctx.store.write("checkpoint", checkpointId, journal, true); }
    const options = captureOptions(ctx, run, journal);
    if (!journal.manifest) { journal.manifest = await captureCheckpoint(options); journal.state = "captured"; await ctx.store.write("checkpoint", checkpointId, journal); }
    const manifest = journal.manifest, operation = { identity: run.identity, checkpointId };
    await run.client.mutation("checkpoints:prepare", { ...run.identity, manifest: asValue(manifest), summary: canonicalJson(journal.progress) }, req("prepare", operation));
    const revision = req("scan", operation);
    await uploadScope(run, await scanCheckpoint(options, manifest, revision));
    const verifierOptions = captureOptions(ctx, run, journal, verifier);
    const evidenceRef = `coord-journal:${checkpointId}:${manifest.manifestDigest}`;
    await verifyScope(verifier, run.identity, verifierOptions, manifest, revision, evidenceRef);
    await publishCheckpoint(verifierOptions, manifest);
    const readback = await verifyRemoteCheckpoint(verifierOptions, manifest);
    await verifier.mutation("checkpoints:verifyCode", { ...run.identity, checkpointId, readback: asValue({ commit: readback.commit, tree: readback.tree, parent: readback.parent, parents: readback.parents, ref: readback.ref, manifestHash: readback.manifestHash, progressHash: readback.progressHash, policyDigest: readback.policyDigest, evidenceRef }) }, req("code", operation));
    const result = await verifier.mutation("checkpoints:ready", { ...run.identity, checkpointId }, req("ready", operation));
    journal.state = "ready"; await ctx.store.write("checkpoint", checkpointId, journal);
    return result;
  });
}
async function selected(ctx: Context, taskId: string, checkpointId?: string): Promise<Selection> { return projectClient(ctx).query("checkpoints:getReady", { taskId, ...(checkpointId ? { checkpointId } : {}) }) as Promise<Selection>; }
async function verifyBase(ctx: Context, base: ExecutionBase): Promise<void> {
  const ref = `refs/coord/internal/${randomUUID()}`;
  try {
    await commandGit(ctx, ctx.workspace.root, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `${base.remoteRef}:${ref}`]);
    await commandGit(ctx, ctx.workspace.root, ["cat-file", "-e", `${base.sha}^{commit}`]);
    await commandGit(ctx, ctx.workspace.root, ["merge-base", "--is-ancestor", base.sha, ref]);
  } finally { await commandGit(ctx, ctx.workspace.root, ["update-ref", "-d", ref]); }
}
function selectedCapture(ctx: Context, selection: Selection): CaptureOptions {
  const m = selection.manifest;
  if (!m || typeof selection.summary !== "string" || captureDigest(parseProgress(selection.summary)) !== m.progressHash || m.policyDigest !== captureDigest(ctx.runtime.policy.capture)) throw new CoordError("BLOCKED_CHECKPOINT", "Immutable checkpoint code/progress/policy binding differs");
  return { repo: ctx.workspace.root, remote: { name: "origin", url: ctx.workspace.config.remote }, checkpointId: m.checkpointId, identity: m.identity, executionBase: m.executionBase, progress: parseProgress(selection.summary), progressRevision: m.progressRevision, createdAt: m.createdAt, commitMessage: "Preserve verified progress for independent continuation\n\nConfidence: high\nScope-risk: narrow\nDirective: Preserve the verified execution-base parent", policy: ctx.runtime.policy.capture, gitTransport: ctx.runtime.gitTransport, gitMetadataIsolation: metadataProof(ctx), readAuthority: async () => { throw new CoordError("FORBIDDEN", "Resume never reauthorizes the source run"); }, quietBoundary: async () => {} };
}
async function preflightSelected(ctx: Context, selection: Selection, mode: "manual" | "managed" | "replan") {
  if (!Array.isArray(selection.inputs) || selection.inputs.length !== selection.task.dependencies.length || selection.inputs.length > 20) throw new CoordError("COVERAGE_INCOMPLETE", "Complete exact declared dependency inputs are required before admission");
  await preflightBriefing(ctx, selection, mode === "replan");
  for (const compact of selection.inputs) {
    const input = await projectClient(ctx).query("checkpoints:getInput", { taskId: selection.task.id, dependencyTaskId: compact.dependency.taskId, includeManifest: true }) as DependencyInput;
    if (captureDigest(input.dependency) !== captureDigest(compact.dependency) || !selection.task.dependencies.some(dependency => captureDigest(dependency) === captureDigest(input.dependency))) throw new CoordError("BLOCKED_CHECKPOINT", "A pinned dependency changed during exact input preflight");
    if (mode !== "replan" && (input.task.state === "failed" || input.task.state === "cancelled" || input.availability !== "published")) throw new CoordError("BLOCKED_CHECKPOINT", "A declared dependency is unavailable or terminal; published code is not automatic satisfaction");
    if (input.availability !== "published") continue;
    const m = input.code?.manifest, summary = input.code?.summary;
    if (!m || typeof summary !== "string" || input.dependency.artifact !== m.checkpointId || input.task.id !== m.identity.taskId || input.code?.commit !== m.commit || input.code.tree !== m.tree || input.code.ref !== m.ref) throw new CoordError("BLOCKED_CHECKPOINT", "Dependency code does not match its exact immutable checkpoint pin");
    const dependency: Selection = { ...selection, manifest: m, summary, executionBase: m.executionBase };
    await verifyRemoteCheckpoint(selectedCapture(ctx, dependency), m);
  }
  await verifyBase(ctx, selection.executionBase);
  if (selection.manifest) await verifyRemoteCheckpoint(selectedCapture(ctx, selection), selection.manifest);
  else {
    const files = await readTree(ctx.workspace.root, selection.executionBase.sha, ctx.runtime.gitTransport, metadataProof(ctx));
    if (files.length > 20_000) throw new CoordError("BLOCKED_CHECKPOINT", "Initial execution tree exceeds supported portable bounds");
    for (const entry of files) {
      const size = Number(await commandGitText(ctx, ctx.workspace.root, ["cat-file", "-s", entry.oid]));
      if (!Number.isSafeInteger(size) || size > (ctx.runtime.policy.capture.maxFileBytes ?? 5 * 1024 * 1024)) throw new CoordError("BLOCKED_CHECKPOINT", "Initial execution asset exceeds supported size policy");
      if (entry.path.endsWith(".gitattributes") || entry.path.endsWith(".gitmodules") || entry.type === "symlink" || size <= 1024) {
        const data = (await commandGit(ctx, ctx.workspace.root, ["cat-file", "blob", entry.oid])).stdout.toString("utf8");
        if ((entry.path.endsWith(".gitattributes") || entry.path.endsWith(".gitmodules")) && data.split(/\r?\n/).some(line => line.trim() && !line.trim().startsWith("#")) || data.startsWith("version https://git-lfs.github.com/spec/v1")) throw new CoordError("BLOCKED_CHECKPOINT", "Initial filters, LFS pointers and submodule requirements are unsupported");
        if (entry.type === "symlink" && (!beneath(join(ctx.workspace.root, entry.path, "..", data), ctx.workspace.root) || data.startsWith("/") || data.includes("\0"))) throw new CoordError("BLOCKED_CHECKPOINT", "Initial symlink escapes portable source policy");
      }
    }
  }
  await checkStoreDirectory(ctx.runtime.worktreeRoot, true);
  const path = join(ctx.runtime.worktreeRoot, `preflight-${randomUUID()}`);
  await commandGit(ctx, ctx.workspace.root, ["worktree", "add", "--detach", "--quiet", "--", path, selection.manifest?.commit ?? selection.executionBase.sha]);
  try { return await effectivePreflight(ctx.runtime, path, mode === "manual" ? "manual" : "managed"); }
  finally { await commandGit(ctx, ctx.workspace.root, ["worktree", "remove", "--force", "--", path]); }
}
async function allocateInitial(ctx: Context, run: RunBinding, base: ExecutionBase): Promise<string> {
  await verifyBase(ctx, base);
  await run.client.query("tasks:checkIn", identityPayload(run));
  await mkdir(ctx.runtime.worktreeRoot, { recursive: true, mode: 0o700 });
  if (await realpath(ctx.runtime.worktreeRoot) !== ctx.runtime.worktreeRoot) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Worktree allocation root must be canonical");
  const path = join(ctx.runtime.worktreeRoot, `${run.identity.taskId}-e${run.identity.epoch}-${run.identity.runId}`);
  await commandGit(ctx, ctx.workspace.root, ["worktree", "add", "--quiet", "-b", `coord/tasks/${run.identity.taskId}/e${run.identity.epoch}/${run.identity.runId}`, "--", path, base.sha]);
  const local = join(path, ".coord-local"); await mkdir(local, { mode: 0o700 });
  const file = await open(join(local, "run.json"), "wx", 0o600);
  try { await file.writeFile(JSON.stringify({ projectId: ctx.workspace.config.projectId, commonGitDir: ctx.workspace.commonGitDir, ...run.identity })); await file.sync(); } finally { await file.close(); }
  return path;
}
async function resume(ctx: Context, taskId: string, sessionId: string, checkpointId: string | undefined, mode: "manual" | "managed" | "replan" = "manual"): Promise<{ path: string; run: RunBinding }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(taskId)) throw new CoordError("INVALID_INPUT", "Task identity exceeds the supported portable command format");
  await verifyQualification(ctx, mode === "manual" ? "manual" : "managed");
  requireRuntimeActions(ctx.runtime, ctx.mode);
  if (mode === "replan") selectedAdapter(ctx.runtime, true);
  await effectivePreflight(ctx.runtime, ctx.workspace.root, mode === "manual" ? "manual" : "managed");
  const fingerprint = captureDigest({ backend: ctx.workspace.config, runtime: runtimeDigest(ctx.runtime), taskId, sessionId, checkpointId: checkpointId ?? null, mode });
  return ctx.store.lock("resume", sessionId, async () => {
    let journal = await ctx.store.read<ResumeJournal>("resume", sessionId);
    if (journal && journal.fingerprint !== fingerprint) throw new CoordError("IDEMPOTENCY_CONFLICT", "Resume session already belongs to another exact request");
    if (!journal) {
      const selection = await selected(ctx, taskId, checkpointId);
      await preflightSelected(ctx, selection, mode);
      journal = { schemaVersion: 1, fingerprint, selection, sessionId, requestId: req("admit", fingerprint), mode, state: "selected" };
      await ctx.store.write("resume", sessionId, journal, true);
    }
    if (journal.state === "never-started") { const unused = await readSessionBinding(ctx.runtime.workspaceRoot, projectClient(ctx), sessionId); if (unused) await settleUnused(ctx, unused, "resume_failed_before_startLaunch"); throw new CoordError("LEASE_REVOKED", "This positively unused reservation was settled; choose a new explicit resume session"); }
    await preflightSelected(ctx, journal.selection, mode);
    if (journal.state === "selected" && journal.selection.task.state === "blocked") await projectClient(ctx).mutation("tasks:requestResume", { taskId, ...(checkpointId ? { checkpointId } : {}) }, req("resume", fingerprint));
    try {
    const run = await admitSession(ctx.runtime.workspaceRoot, projectClient(ctx), sessionId, { requestId: journal.requestId, taskId, machineId: ctx.runtime.machineId, harness: ctx.runtime.harness.kind, capabilityKey: ctx.runtime.capability.key }, mode);
    const assertAdmission = async (): Promise<void> => { const status = await run.client.query("tasks:checkIn", identityPayload(run)) as { task: { executionBase: ExecutionBase; dependencies: DependencyInput["dependency"][]; latestCheckpointId?: string; progressRevision: number }; conflictBlocked: boolean }; if (status.conflictBlocked || captureDigest(status.task.executionBase) !== captureDigest(journal!.selection.executionBase) || captureDigest(status.task.dependencies) !== captureDigest(journal!.selection.task.dependencies)) throw new CoordError("STALE_EPOCH", "Admitted task no longer matches selected execution base and exact dependency pins"); };
    await assertAdmission();
    if (journal.state === "ready" && journal.path) {
      const destination = await resolveWorkspace(journal.path), expected = join(ctx.runtime.worktreeRoot, `${taskId}-e${run.identity.epoch}-${run.identity.runId}`);
      const receipt = JSON.parse(await readSmallFile(join(journal.path, ".coord-local", "run.json"), true)) as Record<string, unknown>;
      const installed = await loadSession(journal.path, projectClient(ctx), sessionId);
      if (destination.root !== expected || destination.commonGitDir !== ctx.workspace.commonGitDir || receipt.runId !== run.identity.runId || receipt.taskId !== taskId || receipt.epoch !== run.identity.epoch || !installed || captureDigest(installed.identity) !== captureDigest(run.identity)) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Ready resume journal does not match this exact destination run");
      return { path: journal.path, run };
    }
    if (journal.state === "allocating") throw new CoordError("LAUNCH_UNCERTAIN", "Interrupted worktree allocation needs inspection; existing branches are never reset");
    const selection = journal.selection;
    let path: string;
    if (journal.state === "allocated" && journal.path) {
      path = journal.path;
      const receipt = JSON.parse(await readSmallFile(join(path, ".coord-local", "run.json"), true)) as Record<string, unknown>;
      if (receipt.runId !== run.identity.runId || receipt.taskId !== taskId || receipt.epoch !== run.identity.epoch || await commandGitText(ctx, path, ["rev-parse", "HEAD"]) !== (selection.manifest?.commit ?? selection.executionBase.sha) || await commandGitText(ctx, path, ["branch", "--show-current"]) !== `coord/tasks/${taskId}/e${run.identity.epoch}/${run.identity.runId}` || (await commandGitText(ctx, path, ["diff", "--name-only", "HEAD", "--"]))) throw new CoordError("LAUNCH_UNCERTAIN", "Allocated worktree changed; no automatic reset or adoption");
    } else {
    journal.identity = run.identity; journal.state = "allocating"; await ctx.store.write("resume", sessionId, journal);
    if (selection.manifest) {
      const m = selection.manifest;
      const capture = selectedCapture(ctx, selection);
      const resumed = await createResumeWorktree({ capture, checkpoint: m, identity: run.identity, projectId: ctx.workspace.config.projectId, worktreeRoot: ctx.runtime.worktreeRoot, trustedCommonGitDir: ctx.workspace.commonGitDir, assertReady: async () => { const live = await selected(ctx, taskId, m.checkpointId); if (live.manifest?.commit !== m.commit || live.manifest.tree !== m.tree) throw new CoordError("BLOCKED_CHECKPOINT", "Selected ready checkpoint changed"); }, preflight: async () => (await preflightSelected(ctx, selection, mode)).report, assertAdmission });
      path = resumed.path;
    } else path = await allocateInitial(ctx, run, selection.executionBase);
    journal.state = "allocated"; journal.path = path; await ctx.store.write("resume", sessionId, journal);
    }
    await writeRoutingCopy(join(path, ".coord.json"), ctx.workspace.config);
    await copySession(ctx.runtime.workspaceRoot, path, projectClient(ctx), sessionId);
    await assertAdmission();
    if (selection.manifest && typeof selection.summary === "string") {
      const status = await run.client.query("tasks:checkIn", identityPayload(run)) as { task: { progress: string; progressRevision: number } };
      journal.restoreRevision ??= status.task.progressRevision;
      await ctx.store.write("resume", sessionId, journal);
      const receipt = { checkpointId: selection.manifest.checkpointId, commit: selection.manifest.commit, tree: selection.manifest.tree, progress: parseProgress(selection.summary), progressHash: selection.manifest.progressHash, sourceProgressRevision: selection.manifest.progressRevision, expectedDestinationRevision: journal.restoreRevision, uncapturedSourceProgressNotRestored: journal.restoreRevision !== selection.manifest.progressRevision };
      const receiptPath = join(path, ".coord-local", "resume.json"), encoded = JSON.stringify(receipt);
      try { await writeNewPrivateFile(receiptPath, encoded); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (await readSmallFile(receiptPath, true) !== encoded) throw new CoordError("IDEMPOTENCY_CONFLICT", "Existing resume progress receipt differs"); await syncLocalFile(receiptPath, createHash("sha256").update(encoded).digest("hex")); }
      if (mode === "manual") await run.client.mutation("tasks:progress", { ...run.identity, expectedRevision: journal.restoreRevision, progress: selection.summary }, req("restore", { identity: run.identity, checkpointId: selection.manifest.checkpointId }));
    }
    journal.state = "ready"; journal.path = path; await ctx.store.write("resume", sessionId, journal);
    return { path, run };
    } catch (error) {
      if (mode !== "manual" && journal.state !== "ready") {
        // This control path has not called startLaunch/spawn. Record the exact failed prelaunch event, not a PID/file-absence inference.
        const unused = await readSessionBinding(ctx.runtime.workspaceRoot, projectClient(ctx), sessionId);
        if (unused) { journal.state = "never-started"; journal.identity = unused.identity; await ctx.store.write("resume", sessionId, journal); await settleUnused(ctx, unused, "resume_failed_before_startLaunch"); }
      }
      throw error;
    }
  });
}

interface ApprovedRules { complete: boolean; rules: { content: string; approvedHash?: string; hash: string; approvedBy?: string }[]; }
function composeBriefing(input: { identity: RunIdentity; task: string; goal: string; rules: ApprovedRules; progress: unknown; checkpoint: unknown; inputs: DependencyInput[]; replan: boolean }): string {
  if (!input.rules.complete || !Array.isArray(input.rules.rules) || input.rules.rules.some(rule => typeof rule.content !== "string" || !rule.approvedBy || rule.hash !== rule.approvedHash)) throw new CoordError("COVERAGE_INCOMPLETE", "Fresh harness requires complete current approved rules");
  const prompt = canonicalJson({ instructions: input.replan ? "READ-ONLY REPLANNING: inspect evidence and return an in-scope revised proposal or blocked/failed decision through Coord. Native code edits, implementation, checkpoint/PR publication, approval, merge, deploy and scope expansion are forbidden." : "Continue only this admitted Coord task. Check in through the installed participating integration before edits. Do not approve, merge, deploy or widen scope. Uncaptured source progress was not restored. Consume only the pinned dependency artifact IDs and prefetched exact Git commits, never substitute a neighboring task's latest pointer or auto-merge an input.", rules: input.rules.rules.map(rule => rule.content), identity: input.identity, task: input.task, goal: input.goal, dependencies: input.inputs, progress: input.progress, checkpoint: input.checkpoint });
  if (Buffer.byteLength(prompt) > 12 * 1024) throw new CoordError("COVERAGE_INCOMPLETE", "Mandatory fresh-session briefing exceeds supported bound");
  return prompt;
}
async function preflightBriefing(ctx: Context, selection: Selection, replan: boolean): Promise<void> {
  const rules = await projectClient(ctx).query("memories:projectRules") as ApprovedRules;
  const manifest = selection.manifest, progress = manifest && typeof selection.summary === "string" ? parseProgress(selection.summary) : parseProgress(selection.task.progress);
  const checkpoint = manifest ? { checkpointId: manifest.checkpointId, commit: manifest.commit, tree: manifest.tree, progress, progressHash: manifest.progressHash, sourceProgressRevision: manifest.progressRevision, expectedDestinationRevision: Number.MAX_SAFE_INTEGER, uncapturedSourceProgressNotRestored: false } : null;
  // Exact text with conservative identity/restore overhead: these placeholders cannot authorize a run.
  composeBriefing({ identity: { taskId: selection.task.id, runId: "r".repeat(100), epoch: Number.MAX_SAFE_INTEGER, goalRevision: Number.MAX_SAFE_INTEGER }, task: selection.task.title, goal: selection.goal.content, rules, progress, checkpoint, inputs: selection.inputs, replan });
}
async function startupBriefing(ctx: Context, path: string, run: RunBinding, replan = false): Promise<string> {
  const checkIn = await run.client.query("tasks:checkIn", identityPayload(run)) as { task: { title: string; progress: string; dependencies: { taskId: string; mode: string; artifact?: string }[] }; goal: { content: string } };
  const rules = await run.client.query("memories:rules", identityPayload(run)) as ApprovedRules;
  let resumeNotice: { progress: unknown; progressHash: string; commit: string; tree: string } | null = null;
  try { resumeNotice = JSON.parse(await readSmallFile(join(path, ".coord-local", "resume.json"), true)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (resumeNotice && (captureDigest(resumeNotice.progress) !== resumeNotice.progressHash || await commandGitText(ctx, path, ["rev-parse", "HEAD"]) !== resumeNotice.commit || await commandGitText(ctx, path, ["rev-parse", "HEAD^{tree}"]) !== resumeNotice.tree)) throw new CoordError("BLOCKED_CHECKPOINT", "Startup code/context differs from the selected immutable checkpoint");
  const inputs: DependencyInput[] = [];
  for (const dependency of checkIn.task.dependencies) {
    const input = await projectClient(ctx).query("checkpoints:getInput", { taskId: run.identity.taskId, dependencyTaskId: dependency.taskId }) as DependencyInput;
    if (captureDigest(input.dependency) !== captureDigest(dependency) || !replan && (input.availability !== "published" || input.task.state === "failed" || input.task.state === "cancelled")) throw new CoordError("BLOCKED_CHECKPOINT", "Startup dependency changed or is unavailable; no newer artifact is substituted");
    inputs.push(input);
  }
  return composeBriefing({ identity: run.identity, task: checkIn.task.title, goal: checkIn.goal.content, rules, progress: resumeNotice?.progress ?? parseProgress(checkIn.task.progress), checkpoint: resumeNotice, inputs, replan });
}
async function launchManual(ctx: Context, path: string, run: RunBinding): Promise<unknown> {
  await verifyQualification(ctx, "manual");
  const prompt = await startupBriefing(ctx, path, run);
  const preflight = await effectivePreflight(ctx.runtime, path, "manual"), adapter = runtimeAdapter(ctx, run, false);
  const operationId = run.sessionId!, fingerprint = captureDigest({ identity: run.identity, path, runtime: runtimeDigest(ctx.runtime), prompt });
  return ctx.store.lock("manual-launch", operationId, async () => {
    if (await ctx.store.read("manual-launch", operationId)) throw new CoordError("LAUNCH_UNCERTAIN", "This manual launch already has an external-effect journal; no blind respawn");
    await ctx.store.write("manual-launch", operationId, { schemaVersion: 1, fingerprint, identity: run.identity, path, phase: "spawn_requested", parentStopAuthority: false }, true);
    const child = spawn(ctx.runtime.harness.executable, adapter.launchArgs(prompt), { cwd: path, env: { ...preflight.environment, COORD_SESSION_ID: operationId, COORD_RUNTIME_PATH: ctx.runtimePath }, shell: false, stdio: ["inherit", "inherit", "inherit"] });
    let renewalError = false, acceptedResult = false, finalizedRegistration: unknown;
    const timer = setInterval(() => {
      void (async () => {
        const status = await run.client.query("tasks:sessionStatus", identityPayload(run)) as { taskState: string; resultAccepted: boolean; currentOwner: boolean };
        if (status.currentOwner && status.resultAccepted && status.taskState === "review_ready") {
          acceptedResult = true; finalizedRegistration = await finalize(ctx, operationId, "succeeded");
          clearInterval(timer); try { child.kill("SIGTERM"); } catch {} return;
        }
        await verifyQualification(ctx, "manual"); await run.client.mutation("tasks:renew", identityPayload(run), randomUUID());
      })().catch(() => { renewalError = true; try { child.kill("SIGTERM"); } catch {} });
    }, 20_000);
    let code: number | null;
    try { code = await new Promise<number | null>((resolveExit, reject) => { child.once("error", () => reject(new CoordError("BLOCKED_ENV", "Fresh harness could not start; raw subprocess output withheld"))); child.once("exit", value => resolveExit(value)); }); }
    finally { clearInterval(timer); }
    // Direct-child exit revokes only registration. It never proves a descendant tree stopped or releases managed capacity.
    let registration: unknown = finalizedRegistration;
    try { if (registration === undefined) registration = await finalize(ctx, operationId, acceptedResult || code === 0 && !renewalError ? "succeeded" : renewalError ? "stopped" : "failed"); }
    catch (error) {
      const backendCode = (error as { data?: { code?: string } }).data?.code;
      if (backendCode === "PUBLICATION_STALE") registration = await finalize(ctx, operationId, "stopped");
      else if (backendCode === "UNAUTHORIZED" || backendCode === "LEASE_REVOKED") registration = { current: false };
      else throw error;
    }
    await ctx.store.write("manual-launch", operationId, { schemaVersion: 1, fingerprint, identity: run.identity, path, phase: "direct_child_exited", exitCode: code, registration, descendantStopProven: false });
    return { path, identity: run.identity, sessionId: operationId, exitCode: code, registration, descendantStopProven: false };
  });
}
async function review(ctx: Context, sessionId: string, checkpointId: string, publicationId: string): Promise<unknown> {
  const run = await requireRun(ctx, sessionId, true);
  const checkpointJournal = await ctx.store.read<CheckpointJournal>("checkpoint", checkpointId);
  if (!checkpointJournal?.manifest || checkpointJournal.state !== "ready" || captureDigest(checkpointJournal.identity) !== captureDigest(run.identity)) throw new CoordError("BLOCKED_CHECKPOINT", "Publication needs this run's ready checkpoint journal");
  const verifier = await roleClient(ctx.workspace.config, ctx.runtime, "artifact_verifier"), options = captureOptions(ctx, run, checkpointJournal, verifier), artifact = checkpointJournal.manifest;
  const current = await authority(verifier, run.identity); await assertPolicy(ctx, current);
  const fingerprint = captureDigest({ backend: ctx.workspace.config, runtime: runtimeDigest(ctx.runtime), identity: run.identity, checkpointId, publicationId, manifest: artifact.manifestDigest });
  return ctx.store.lock("review", publicationId, async () => {
    let journal = await ctx.store.read<ReviewJournal>("review", publicationId);
    if (journal && journal.fingerprint !== fingerprint) throw new CoordError("IDEMPOTENCY_CONFLICT", "Publication ID already belongs to another artifact/configuration");
    if (!journal) { journal = { schemaVersion: 1, fingerprint, state: "started" }; await ctx.store.write("review", publicationId, journal, true); }
    await authority(verifier, run.identity);
    const targetRef = `refs/heads/${ctx.workspace.config.defaultBranch}`, tempRef = `refs/coord/internal/${randomUUID()}`;
    let base: string;
    try { await commandGit(ctx, ctx.workspace.root, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `${targetRef}:${tempRef}`]); base = await commandGitText(ctx, ctx.workspace.root, ["rev-parse", tempRef]); } finally { await commandGit(ctx, ctx.workspace.root, ["update-ref", "-d", tempRef]); }
    if (!journal.verification) {
      const path = join(ctx.runtime.worktreeRoot, `verify-${publicationId}`);
      await mkdir(ctx.runtime.worktreeRoot, { recursive: true, mode: 0o700 });
      await commandGit(ctx, ctx.workspace.root, ["worktree", "add", "--detach", "--quiet", "--", path, artifact.commit]);
      const preflight = await effectivePreflight(ctx.runtime, path, current.runMode === "manual" ? "manual" : "managed");
      journal.verification = await runVerification({ runtime: ctx.runtime, repo: path, head: artifact.commit, tree: artifact.tree, base, environmentDigest: preflight.digest });
      journal.targetBase = base; journal.state = "verified"; await ctx.store.write("review", publicationId, journal);
    }
    if (journal.targetBase !== base) throw new CoordError("PUBLICATION_STALE", "Live review target changed; use a new independently verified publication identity");
    const verification = journal.verification;
    if (!verification) throw new CoordError("PUBLICATION_STALE", "Exact final-head verification did not complete");
    if (!["accepting", "accepted"].includes(journal.state)) await run.client.mutation("publications:request", { ...run.identity, publicationId, checkpointId, targetBase: base, verification: asValue(verification) }, req("publication", fingerprint));
    const published = await publishReview({ capture: options, artifact, publicationId, repositoryId: ctx.workspace.config.repository, targetRef, verification: [verification], requiredCommands: ctx.runtime.policy.verificationCommands, environmentDigest: verification.environmentDigest!, host: new GitHubReviewAdapter(ctx.workspace.config.repository, { HOME: ctx.runtime.gitTransport.home, PATH: ctx.runtime.gitTransport.searchPath }, undefined, ctx.runtime.gitTransport.executable), preflight: async () => { await assertPolicy(ctx, await authority(verifier, run.identity)); } });
    const evidenceRef = `coord-publication:${publicationId}:${artifact.manifestDigest}`;
    await verifier.mutation("publications:verifyBranch", { ...run.identity, publicationId, head: artifact.commit, tree: artifact.tree, parent: published.branchReadback.parent, parents: published.branchReadback.parents, branch: published.headRef, liveTargetBase: base, evidenceRef }, req("branch", fingerprint));
    await verifier.mutation("publications:verifyPR", { ...run.identity, publicationId, head: artifact.commit, tree: artifact.tree, liveTargetBase: base, repository: ctx.workspace.config.repository, headBranch: published.headRef, targetBaseRef: ctx.workspace.config.defaultBranch, prId: published.review.id, prUrl: published.review.url, open: published.review.state === "open", evidenceRef }, req("pr", fingerprint));
    journal.state = "accepting"; await ctx.store.write("review", publicationId, journal);
    const result = await verifier.mutation("publications:accept", { ...run.identity, publicationId, liveTargetBase: base }, req("accept", fingerprint));
    journal.state = "accepted"; await ctx.store.write("review", publicationId, journal);
    return result;
  });
}

async function finalize(ctx: Context, sessionId: string, outcome: "succeeded" | "failed" | "stopped"): Promise<unknown> {
  const run = await requireRun(ctx, sessionId, true);
  return run.client.mutation("lifecycle:requestFinalization", { ...run.identity, outcome, reason: `Explicit ${outcome} finalization through participating command` }, req("finalize", { identity: run.identity, outcome }));
}
async function settleUnused(ctx: Context, run: RunBinding, reason: string): Promise<void> {
  const id = run.launchId!, route = { backendId: ctx.workspace.config.backendId, backendUrl: ctx.workspace.config.backendUrl, projectId: ctx.workspace.config.projectId }, expected = { route, identity: run.identity, launchId: id, machineId: ctx.runtime.machineId };
  let record = await ctx.store.read<{ route: typeof route; identity: RunIdentity; launchId: string; machineId: string; reason: string; evidence: StopEvidence }>("unused-launch", id);
  if (!record) {
    record = { ...expected, reason, evidence: { kind: "proven_never_started", launchId: id, machineId: ctx.runtime.machineId, observedAt: new Date().toISOString(), evidenceRef: `coord-prelaunch:${id}:${captureDigest(expected)}` } };
    await ctx.store.write("unused-launch", id, record, true);
  }
  if (captureDigest({ route: record.route, identity: record.identity, launchId: record.launchId, machineId: record.machineId }) !== captureDigest(expected)) throw new CoordError("IDEMPOTENCY_CONFLICT", "Prelaunch failure belongs to another reservation");
  const supervisor = await roleClient(ctx.workspace.config, ctx.runtime, "supervisor");
  await supervisor.mutation("lifecycle:confirmStopped", { ...run.identity, evidence: asValue(record.evidence) }, req("unused", expected));
}
async function lifecycleControlKey(ctx: Context, supervisor: BackendClient) {
  const current = await readRuntime(ctx.runtimePath);
  if (runtimeDigest(current) !== runtimeDigest(ctx.runtime)) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Native lifecycle configuration changed; exact stop proof requires inspection");
  const machine = await supervisor.query("machines:runtime", { machineId: ctx.runtime.machineId }) as { machineId: string; memberId: string; qualificationExpiresAt: number; capabilityKey: unknown; capabilityChecks: unknown[] };
  if (machine.machineId !== ctx.runtime.machineId || machine.memberId !== ctx.runtime.memberId || machine.qualificationExpiresAt <= Date.now() || captureDigest(machine.capabilityKey) !== captureDigest(ctx.runtime.capability.key) || captureDigest(machine.capabilityChecks) !== captureDigest(current.capability.checks)) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Native lifecycle owner evidence differs; no guessed stop proof");
  // This is historical control ownership, never an assertion of fresh harness/admission authority.
  return { ...ctx.runtime.capability.key };
}
async function releaseStopped(ctx: Context, identity: RunIdentity, launchId: string, requestId: string, evidence: StopEvidence): Promise<string> {
  let stored = await ctx.store.read<{ requestId: string; payload: Record<string, Value> }>("release-request", launchId);
  if (!stored) {
    const journal = await new LaunchJournalStore(join(ctx.runtime.stateDirectory, "launches")).read(launchId), receipt = journal?.receipt;
    const launchReceipt = receipt ? { schemaVersion: receipt.schemaVersion, identity: { ...receipt.identity }, launchId: receipt.launchId, machineId: receipt.machineId, workspace: receipt.workspace, process: { ...receipt.process }, recordedAt: receipt.recordedAt } : undefined;
    stored = { requestId, payload: { ...identity, evidence: asValue(evidence), ...(launchReceipt ? { launchReceipt: asValue(launchReceipt) } : {}) } };
    await ctx.store.write("release-request", launchId, stored, true);
  }
  if (stored.requestId !== requestId || captureDigest({ taskId: stored.payload.taskId, runId: stored.payload.runId, epoch: stored.payload.epoch, goalRevision: stored.payload.goalRevision }) !== captureDigest(identity)) throw new CoordError("IDEMPOTENCY_CONFLICT", "Stop receipt belongs to another exact release request");
  const supervisor = await roleClient(ctx.workspace.config, ctx.runtime, "supervisor");
  return (await supervisor.mutation("lifecycle:confirmStopped", stored.payload, stored.requestId) as { receipt: string }).receipt;
}
async function ownedControl(ctx: Context, launchId: string, identity: RunIdentity) {
  const provenance = await ctx.store.read<OwnerProvenance>("lifecycle-provenance", launchId);
  const binding = await ctx.store.read<{ route: unknown; runtimeDigest: string; identity: RunIdentity; machineId: string; workspace: string }>("launch-binding", launchId);
  if (!provenance?.containment || !binding || provenance.metadataRoot !== join(ctx.runtime.stateDirectory, "launches") || captureDigest(provenance.route) !== captureDigest(ctx.workspace.config) || captureDigest(binding.route) !== captureDigest(provenance.route) || binding.runtimeDigest !== provenance.runtimeDigest || binding.machineId !== provenance.machineId || provenance.machineId !== ctx.runtime.machineId || provenance.memberId !== ctx.runtime.memberId || captureDigest(binding.identity) !== captureDigest(identity)) throw new CoordError("LAUNCH_UNCERTAIN", "Original owner-verified lifecycle provenance is missing or differs; no native action");
  return createCgroupControl({ root: provenance.containment.root, key: provenance.capability.key, metadataRoot: provenance.metadataRoot, capabilityEvidence: provenance.capability, lifecycleOnly: true, checkCurrentConfiguration: async () => { throw new CoordError("FORBIDDEN", "Historical cleanup cannot authorize a new launch"); }, verifyLifecycleOwnership: async (receipt: LaunchReceipt): Promise<CapabilityKey> => {
    if (receipt.launchId !== launchId || receipt.machineId !== provenance.machineId || receipt.workspace !== binding.workspace || captureDigest(receipt.identity) !== captureDigest(identity)) throw new CoordError("LAUNCH_UNCERTAIN", "Native receipt differs from owner-verified historical control");
    const current = await ctx.store.read<OwnerProvenance>("lifecycle-provenance", launchId);
    if (captureDigest(current) !== captureDigest(provenance)) throw new CoordError("LAUNCH_UNCERTAIN", "Historical control provenance changed");
    return { ...provenance.capability.key };
  } });
}
async function control(ctx: Context, supervisor?: BackendClient) {
  if (!ctx.runtime.containment) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Managed execution requires an operator-selected qualified Linux cgroup-v2 containment");
  return createCgroupControl({ root: ctx.runtime.containment.root, key: ctx.runtime.capability.key, metadataRoot: join(ctx.runtime.stateDirectory, "launches"), capabilityEvidence: ctx.runtime.capability, checkCurrentConfiguration: async () => supervisor ? lifecycleControlKey(ctx, supervisor) : verifyQualification(ctx, "managed") });
}
async function launchManaged(ctx: Context, path: string, run: RunBinding, stoppers: Set<(reason: string) => Promise<unknown>>): Promise<void> {
  let containment: Awaited<ReturnType<typeof control>> | undefined, supervisor: Awaited<ReturnType<typeof createLaunchSupervisor>> | undefined;
  let attempted = false, stopping: ((reason: string) => Promise<unknown>) | undefined;
  const store = new LaunchJournalStore(join(ctx.runtime.stateDirectory, "launches"));
  const launchId = run.launchId!;
  if (await store.read(launchId)) throw new CoordError("LAUNCH_UNCERTAIN", "Existing launch must be reconciled; command never respawns it");
  if (!ctx.ownerProvenance) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Launch lacks current independently owner-verified qualification");
  await ctx.store.write("lifecycle-provenance", launchId, ctx.ownerProvenance, true);
  await ctx.store.write("launch-binding", launchId, { schemaVersion: 1, route: ctx.workspace.config, runtimeDigest: runtimeDigest(ctx.runtime), identity: run.identity, machineId: ctx.runtime.machineId, workspace: path }, true);
  try {
  const supervisorClient = await roleClient(ctx.workspace.config, ctx.runtime, "supervisor");
  containment = await control(ctx, supervisorClient); await containment.preflight();
  const preflight = await effectivePreflight(ctx.runtime, path, "managed");
  const status = await run.client.query("tasks:checkIn", identityPayload(run)) as { run: { mode: "manual" | "managed" | "replan" } };
  const prompt = await startupBriefing(ctx, path, run, status.run.mode === "replan");
  const journal = { schemaVersion: 1 as const, launchId, identity: run.identity, machineId: ctx.runtime.machineId, workspace: path, bootId: await readNativeBootId(), state: "starting" as const };
  const environment = { ...preflight.environment, COORD_SESSION_ID: run.sessionId!, COORD_LAUNCH_ID: launchId, COORD_RUNTIME_PATH: ctx.runtimePath };
  const lifecycleStatus = () => supervisorClient.query("lifecycle:status", identityPayload(run)) as Promise<{ runState: string; taskState: string; resultAccepted: boolean; requestedOutcome?: string; capacityHeld: boolean }>;
    supervisor = await createLaunchSupervisor({ store, journal, expectedCapability: ctx.runtime.capability.key, capabilityEvidence: ctx.runtime.capability, checkCurrentConfiguration: async () => verifyQualification(ctx, "managed"), adapter: runtimeAdapter(ctx, run, status.run.mode === "replan"), executable: ctx.runtime.harness.executable, prompt, approvedEnvironment: environment, allowedEnvironmentKeys: Object.keys(environment), containment, stopAdapter: containment.adapter,
      markStarting: async () => { await run.client.mutation("lifecycle:starting", identityPayload(run), req("starting", run.identity)); },
      authorize: async receipt => {
        const result = await supervisorClient.mutation("lifecycle:authorizeLaunch", { ...run.identity, process: { ...receipt.process } }, req("authorize", receipt)) as { launchId: string; authorized: true; leaseUntil: number };
        try {
          const selected = JSON.parse(await readSmallFile(join(path, ".coord-local", "resume.json"), true)) as { checkpointId: string; progress: unknown; progressHash: string; expectedDestinationRevision: number; commit: string; tree: string };
          if (captureDigest(selected.progress) !== selected.progressHash || await commandGitText(ctx, path, ["rev-parse", "HEAD"]) !== selected.commit || await commandGitText(ctx, path, ["rev-parse", "HEAD^{tree}"]) !== selected.tree || await commandGitText(ctx, path, ["diff", "--name-only", "HEAD", "--"])) throw new CoordError("BLOCKED_CHECKPOINT", "Resumed code/progress changed before wrapper release");
          await run.client.mutation("tasks:progress", { ...run.identity, expectedRevision: selected.expectedDestinationRevision, progress: canonicalJson(selected.progress) }, req("restore", { identity: run.identity, checkpointId: selected.checkpointId }));
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        return result;
      },
      renew: async () => {
        const current = await lifecycleStatus();
        if (current.runState === "finalizing" || !current.capacityHeld) { queueMicrotask(() => { void supervisor!.stop("backend_finalization_requested"); }); throw new CoordError("LEASE_REVOKED", "Finalization requested; execution must stop"); }
        if (current.taskState === "review_ready" && current.resultAccepted) {
          await run.client.mutation("lifecycle:requestFinalization", { ...run.identity, outcome: "succeeded", reason: "Accepted exact PR; stop supervised execution before capacity release" }, req("auto_finalize", run.identity));
          queueMicrotask(() => { void supervisor!.stop("accepted_result_finalization"); }); throw new CoordError("LEASE_REVOKED", "Accepted result entered finalization");
        }
        return run.client.mutation("tasks:renew", identityPayload(run), randomUUID()) as Promise<{ runId: string; epoch: number; leaseUntil: number }>;
      },
      hold: async reason => { await supervisorClient.mutation("lifecycle:reportUncertain", { ...run.identity, reason }, req("hold", { identity: run.identity, reason })); },
    });
    stopping = reason => supervisor!.stop(reason); stoppers.add(stopping);
    let unsubscribe: (() => void) | undefined;
    try {
      await startLaunch(store, journal, { ...supervisor.effects, spawnWrapper: async () => { attempted = true; return supervisor!.effects.spawnWrapper(); } });
      unsubscribe = supervisorClient.subscribe("lifecycle:status", identityPayload(run), raw => { const current = raw as { runState: string }; if (current.runState === "finalizing") void supervisor!.stop("backend_finalization_requested"); }, () => { void supervisor!.stop("backend_status_unavailable"); });
      const outcome = await supervisor.completion;
      if (outcome.state !== "stopped") throw new CoordError("LAUNCH_UNCERTAIN", "Stop proof unavailable; reservation remains held");
      await recordExitAndRelease(store, launchId, outcome.evidence, (requestId, evidence) => releaseStopped(ctx, run.identity, launchId, requestId, evidence));
    } finally { unsubscribe?.(); }
  } catch (error) {
    if (!attempted) await settleUnused(ctx, run, "preflight_failed_before_startLaunch");
    else if (supervisor) {
      const outcome = await supervisor.stop("launch_or_stop_uncertain");
      if (outcome.state === "stopped") {
        await recordExitAndRelease(store, launchId, outcome.evidence, (requestId, evidence) => releaseStopped(ctx, run.identity, launchId, requestId, evidence));
      }
    }
    throw error;
  } finally { if (stopping) stoppers.delete(stopping); await containment?.close(); }
}
async function reconcile(ctx: Context, launchId: string, stop: boolean): Promise<unknown> {
  const route = { backendId: ctx.workspace.config.backendId, backendUrl: ctx.workspace.config.backendUrl, projectId: ctx.workspace.config.projectId };
  const unused = await ctx.store.read<{ route: typeof route; identity: RunIdentity; launchId: string; machineId: string; reason: string; evidence: StopEvidence }>("unused-launch", launchId);
  if (unused) {
    if (captureDigest(unused.route) !== captureDigest(route) || unused.machineId !== ctx.runtime.machineId || unused.launchId !== launchId) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Unused reservation belongs to another exact backend/project/machine");
    const supervisor = await roleClient(ctx.workspace.config, ctx.runtime, "supervisor");
    return supervisor.mutation("lifecycle:confirmStopped", { ...unused.identity, evidence: asValue(unused.evidence) }, req("unused", { route: unused.route, identity: unused.identity, launchId, machineId: unused.machineId }));
  }
  const binding = await ctx.store.read<{ route: unknown; runtimeDigest: string; identity: RunIdentity; machineId: string; workspace: string }>("launch-binding", launchId);
  const store = new LaunchJournalStore(join(ctx.runtime.stateDirectory, "launches")), journal = await store.read(launchId);
  if (!binding || !journal || captureDigest(binding.route) !== captureDigest(ctx.workspace.config) || binding.machineId !== ctx.runtime.machineId || binding.workspace !== journal.workspace || captureDigest(binding.identity) !== captureDigest(journal.identity)) throw new CoordError("LAUNCH_UNCERTAIN", "Launch lacks an exact route/runtime-bound recovery record; no replacement or release");
  if (journal.state === "released") return { launchId, state: "released", receipt: journal.releaseReceipt, historical: true, grantsExecution: false };
  if (journal.state === "exit_recorded" && journal.stop) return recordExitAndRelease(store, launchId, journal.stop, (requestId, evidence) => releaseStopped(ctx, journal.identity, launchId, requestId, evidence)).then(value => ({ launchId, state: value.state, receipt: value.releaseReceipt }));
  if (!journal.receipt) return { launchId, state: "held", reason: "No exact receipt; absence of a process is not stop proof" };
  const containment = await ownedControl(ctx, launchId, journal.identity);
  try {
    const observation = { wrapperExited: false, wrapperExitCode: null, receiptPath: join(store.root, launchId, "wrapper-receipt.json"), outcomePath: join(store.root, launchId, "wrapper-outcome.json") };
    const evidence = stop ? await containment.adapter.stop(journal.receipt, "explicit_reconcile_stop", observation) : await containment.adapter.observe(journal.receipt, observation);
    if (!evidence) return { launchId, state: "held", reason: "Exact containment has no positive stop evidence" };
    const result = await recordExitAndRelease(store, launchId, evidence, (requestId, positive) => releaseStopped(ctx, journal.identity, launchId, requestId, positive));
    return { launchId, state: result.state, receipt: result.releaseReceipt };
  } finally { await containment.close(); }
}
async function daemon(ctx: Context, checkOnly: boolean): Promise<unknown> {
  if (checkOnly) return projectClient(ctx).query("dispatch:runnable", { machineId: ctx.runtime.machineId, capabilityKey: { ...ctx.runtime.capability.key } });
  await verifyQualification(ctx, "managed");
  const containment = await control(ctx); await containment.preflight(); await containment.close();
  await roleClient(ctx.workspace.config, ctx.runtime, "supervisor");
  const active = new Set<Promise<void>>();
  const stoppers = new Set<(reason: string) => Promise<unknown>>(); let shuttingDown = false;
  const dispatcher = startDaemon(ctx.runtime.machineId, ctx.runtime.capability.key, {
    subscribe: (machineId, key, update, error) => projectClient(ctx).subscribe("dispatch:runnable", { machineId, capabilityKey: { ...key } }, value => update(value as DispatchSnapshot), error),
    preflight: async candidate => {
      await verifyQualification(ctx, "managed");
      const cgroup = await control(ctx); try { await cgroup.preflight(); } finally { await cgroup.close(); }
      const selection = await selected(ctx, candidate.taskId, candidate.checkpointId ?? undefined);
      return { configurationDigest: (await preflightSelected(ctx, selection, candidate.mode)).digest };
    },
    claim: async (candidate, configurationDigest) => {
      const selection = await selected(ctx, candidate.taskId, candidate.checkpointId ?? undefined), latest = await preflightSelected(ctx, selection, candidate.mode);
      if (latest.digest !== configurationDigest) throw new CoordError("BLOCKED_ENV", "Effective environment/setup changed before admission");
      return resume(ctx, candidate.taskId, req("dispatch", { candidate, machine: ctx.runtime.machineId }), candidate.checkpointId ?? undefined, candidate.mode);
    },
    launch: async (_candidate: DispatchCandidate, admission: unknown) => { const admitted = admission as { path: string; run: RunBinding }; if (shuttingDown) { await settleUnused(ctx, admitted.run, "daemon_shutdown_before_startLaunch"); throw new CoordError("LEASE_REVOKED", "Daemon stopped before launch; unused reservation settled"); } const pending = launchManaged(ctx, admitted.path, admitted.run, stoppers); active.add(pending); try { await pending; } finally { active.delete(pending); } },
    notify: (taskId, state, code) => { console.log(JSON.stringify({ taskId, state, code })); },
  });
  await new Promise<void>(resolveStop => {
    const stop = (): void => { shuttingDown = true; dispatcher.stop(); process.off("SIGINT", stop); process.off("SIGTERM", stop); void Promise.allSettled([...stoppers].map(stopRun => stopRun("daemon_shutdown"))).then(() => Promise.allSettled([...active])).then(() => resolveStop()); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
  });
  await dispatcher.idle(); return { stopped: true };
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [], flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const name = value.slice(2);
    if (name in flags || !["runtime", "session", "checkpoint", "harness", "check", "prepare-only", "stop"].includes(name)) throw new CoordError("INVALID_INPUT", "Unknown or duplicate command option");
    if (name === "check" || name === "prepare-only" || name === "stop") { flags[name] = true; continue; }
    const next = args[++index]; if (!next || next.startsWith("--")) throw new CoordError("INVALID_INPUT", "Command option requires a value"); flags[name] = next;
  }
  return { positional, flags };
}
/** Actual CLI parser shared by the command entrypoint and bounded transport rehearsals. */
export async function runCommand(command: string, args: string[], cwd = process.cwd()): Promise<unknown> {
  const { positional, flags } = parseFlags(args), runtimePath = flags.runtime;
  if (typeof runtimePath !== "string") throw new CoordError("INVALID_INPUT", "Runtime command requires --runtime <protected-runtime.json>");
  if (flags["prepare-only"] && command !== "resume") throw new CoordError("INVALID_INPUT", "--prepare-only belongs to explicit worktree preparation");
  if (command === "run" && (flags.checkpoint || flags.harness)) throw new CoordError("INVALID_INPUT", "Finalization accepts only runtime/session options");
  if (command === "run" && positional[0] === "reconcile" && (flags.check || flags.session)) throw new CoordError("INVALID_INPUT", "Reconciliation accepts only runtime and optional --stop; --check is daemon query-only diagnostics");
  const ctx = await context(cwd, runtimePath, command === "run" && positional.length === 2 && positional[0] === "reconcile");
  if (command === "run" && positional.length === 2 && positional[0] === "reconcile") return reconcile(ctx, positional[1]!, flags.stop === true);
  if (flags.stop) throw new CoordError("INVALID_INPUT", "--stop belongs to explicit run reconciliation only");
  if (typeof flags.harness === "string" && flags.harness !== ctx.runtime.harness.kind) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Selected harness differs from runtime qualification");
  if (command === "daemon") { if (positional.length || flags.session || flags.checkpoint) throw new CoordError("INVALID_INPUT", "Usage: coord daemon --runtime <file> [--check]"); return daemon(ctx, flags.check === true); }
  const sessionId = typeof flags.session === "string" ? flags.session : process.env.COORD_SESSION_ID;
  if (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(sessionId)) throw new CoordError("INVALID_INPUT", "Command requires --session <stable-id> or participating COORD_SESSION_ID");
  if (flags.check) throw new CoordError("INVALID_INPUT", "--check belongs to daemon diagnostics only");
  if (command === "checkpoint" && positional.length === 1 && !flags.checkpoint) return checkpoint(ctx, sessionId, positional[0]!);
  if (command === "resume" && positional.length === 1) { const result = await resume(ctx, positional[0]!, sessionId, typeof flags.checkpoint === "string" ? flags.checkpoint : undefined); if (flags["prepare-only"]) return { prepared: true, launched: false, path: result.path, identity: result.run.identity, sessionId }; return launchManual(ctx, result.path, result.run); }
  if (command === "review" && positional.length === 1 && typeof flags.checkpoint === "string") return review(ctx, sessionId, flags.checkpoint, positional[0]!);
  if (command === "run" && positional.length === 2 && positional[0] === "finalize" && ["succeeded", "failed", "stopped"].includes(positional[1]!)) return finalize(ctx, sessionId, positional[1] as "succeeded" | "failed" | "stopped");
  throw new CoordError("INVALID_INPUT", "Usage: checkpoint <id> | resume <task> [--checkpoint <id>] | review <id> --checkpoint <id> | run finalize succeeded|failed|stopped; all require --runtime and --session");
}

export interface RuntimeActions {
  checkpoint(input: { checkpointId: string }): Promise<unknown>;
  review(input: { checkpointId: string; publicationId: string }): Promise<unknown>;
  finalize(input: { outcome: "succeeded" | "failed" | "stopped" }): Promise<unknown>;
  finishReplan(input: { result: "revised" | "blocked" | "failed"; dependencies: { taskId: string; mode: "published" | "merged"; artifact?: string }[]; rationale: string }): Promise<unknown>;
}
/** Trusted stdio startup binds paths and credentials before model tools receive ID-only operations. */
export async function connectRuntimeBridge(cwd: string, runtimePath: string, sessionId: string): Promise<{ client: BackendClient; run: RunBinding; runtimeActions: RuntimeActions; cleanupOnly: boolean; workspaceRoot: string }> {
  const initial = await context(cwd, runtimePath), loaded = await requireRun(initial, sessionId, true);
  const run: RunBinding = Object.freeze({ ...loaded, identity: Object.freeze({ ...loaded.identity }) });
  let mode: "manual" | "managed", cleanupOnly = false;
  try { const status = await run.client.query("tasks:checkIn", identityPayload(run)) as { run: { mode: string } }; mode = status.run.mode === "manual" ? "manual" : "managed"; }
  catch (error) {
    if (backendFailure(error).code !== "LEASE_REVOKED") throw error;
    const verifier = await roleClient(initial.workspace.config, initial.runtime, "artifact_verifier"), status = await authority(verifier, run.identity);
    if (status.taskState !== "review_ready") throw new CoordError("LEASE_REVOKED", "Restarted runtime has no current cleanup-capable accepted result");
    mode = status.runMode === "manual" ? "manual" : "managed"; cleanupOnly = true;
  }
  await verifyQualification(initial, mode);
  requireRuntimeActions(initial.runtime, initial.mode);
  const bound = async (): Promise<Context> => {
    const current = await context(cwd, runtimePath), binding = await requireRun(current, sessionId, true);
    if (current.workspace.root !== initial.workspace.root || current.workspace.commonGitDir !== initial.workspace.commonGitDir || captureDigest(current.workspace.config) !== captureDigest(initial.workspace.config) || runtimeDigest(current.runtime) !== runtimeDigest(initial.runtime) || captureDigest(binding.identity) !== captureDigest(run.identity) || binding.launchId !== run.launchId) throw new CoordError("STALE_EPOCH", "Runtime MCP action remains bound to its startup runtime, route and run");
    const receipt = JSON.parse(await readSmallFile(join(current.workspace.root, ".coord-local/run.json"), true)) as Record<string, unknown>;
    if (receipt.runId !== run.identity.runId || receipt.taskId !== run.identity.taskId || receipt.epoch !== run.identity.epoch || receipt.projectId !== current.workspace.config.projectId || receipt.commonGitDir !== current.workspace.commonGitDir) throw new CoordError("STALE_EPOCH", "Runtime MCP worktree receipt differs from its startup run");
    current.boundRun = run;
    return current;
  };
  return { client: projectClient(initial), run, cleanupOnly, workspaceRoot: initial.workspace.root, runtimeActions: {
    checkpoint: async input => checkpoint(await bound(), sessionId, input.checkpointId),
    review: async input => review(await bound(), sessionId, input.checkpointId, input.publicationId),
    finalize: async input => finalize(await bound(), sessionId, input.outcome),
    finishReplan: async input => {
      const current = await bound(), binding = await requireRun(current, sessionId, true);
      return binding.client.mutation("tasks:finishReplan", { ...binding.identity, result: input.result, dependencies: asValue(input.dependencies), rationale: input.rationale }, req("finish_replan", { identity: binding.identity, ...input }));
    },
  } };
}
