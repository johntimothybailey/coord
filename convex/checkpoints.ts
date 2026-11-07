import { v } from "convex/values";
import type { Doc, QueryCtx } from "./server.js";
import { mutation, query } from "./server.js";
import { runArgs, identityArgs, authenticate, liveRun, replay, bounded, fail, digest, canonical, stableId, approvedGoal } from "./auth.js";
import { safeBaseRetry, taskById, validateScope, noConflicts, dependencyInput } from "./tasks.js";
import { manifestValidator, validateManifest, verifiedRun, progressHash, requireVerifiedScan } from "./artifacts.js";
export const authority = query({ args: runArgs, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["run", "artifact_verifier", "human"]);
  const { task, run } = actor.role === "run" ? await liveRun(ctx, args, actor) : await verifiedRun(ctx, args, actor);
  let conflictBlocked = false; try { await noConflicts(ctx, task); } catch { conflictBlocked = true; }
  return { identity: { taskId: task.id, runId: run.id, epoch: task.epoch, goalRevision: task.goalRevision }, executionBase: task.executionBase, progressRevision: task.progressRevision, progressHash: await progressHash(task.progress), policyDigest: project.capturePolicyDigest ?? null, progress: task.progress, taskState: task.state, runMode: run.mode, conflictBlocked };
} });
export const prepare = mutation({ args: { ...runArgs, manifest: manifestValidator, summary: v.string() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); const { task, run } = await liveRun(ctx, args, actor);
  return replay(ctx, actor, "checkpoints.prepare", args, async () => {
    if (run.mode === "replan") fail("FORBIDDEN", "Replanning runs cannot prepare implementation code artifacts");
    bounded(args.summary, 16 * 1024, "checkpoint summary"); stableId(args.manifest.checkpointId); await validateManifest(args.manifest, task, run);
    if (await progressHash(args.summary) !== args.manifest.progressHash) fail("CHECKPOINT_INCOMPLETE", "Checkpoint summary must preserve its exact captured progress");
    const old = await ctx.db.query("checkpoints").withIndex("by_stable_id", q => q.eq("id", args.manifest.checkpointId)).unique();
    if (old) fail("IDEMPOTENCY_CONFLICT", "Checkpoint ID already exists; retry the original request identity");
    const m = args.manifest;
    await ctx.db.insert("checkpoints", { id: m.checkpointId, projectId: args.projectId, taskId: task.id, runId: run.id, epoch: run.epoch, state: "prepared", executionBase: m.executionBase, sourceHead: m.sourceHead, tree: m.tree, commit: m.commit, parent: m.reusedCommit ? null : m.remoteParent, ref: m.ref, manifestHash: m.manifestDigest, progressHash: m.progressHash, evidenceHash: await digest(canonical(m.evidence)), progressRevision: m.progressRevision, manifestJson: canonical(m), summary: args.summary });
    return { checkpointId: m.checkpointId, state: "prepared" as const, manifestHash: m.manifestDigest };
  });
} });
const readback = v.object({ commit: v.string(), tree: v.string(), parent: v.union(v.string(), v.null()), parents: v.optional(v.array(v.string())), ref: v.string(), manifestHash: v.string(), progressHash: v.string(), policyDigest: v.string(), evidenceRef: v.string() });
export const verifyCode = mutation({ args: { ...runArgs, checkpointId: v.string(), readback }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["artifact_verifier", "human"]); const { task, run } = await verifiedRun(ctx, args, actor);
  return replay(ctx, actor, "checkpoints.verifyCode", args, async () => {
    const checkpoint = await ctx.db.query("checkpoints").withIndex("by_stable_id", q => q.eq("id", args.checkpointId)).unique();
    if (!checkpoint || checkpoint.projectId !== args.projectId || checkpoint.runId !== run.id || checkpoint.epoch !== run.epoch || !["prepared", "code_published"].includes(checkpoint.state)) fail("CHECKPOINT_INCOMPLETE", "Checkpoint is not prepared for this run");
    const m = JSON.parse(checkpoint.manifestJson) as typeof manifestValidator.type; await validateManifest(m, task, run); if (!project.capturePolicyDigest || m.policyDigest !== project.capturePolicyDigest) fail("FORBIDDEN", "Capture policy lacks exact protected project approval"); bounded(args.readback.evidenceRef, 2048, "remote readback evidence");
    if (args.readback.commit !== checkpoint.commit || args.readback.tree !== checkpoint.tree || args.readback.ref !== checkpoint.ref || args.readback.manifestHash !== checkpoint.manifestHash || args.readback.progressHash !== checkpoint.progressHash || args.readback.policyDigest !== m.policyDigest) fail("CHECKPOINT_INCOMPLETE", "Remote readback differs from the prepared immutable artifact");
    const parents = args.readback.parents ?? (args.readback.parent === null ? [] : [args.readback.parent]);
    if (parents.length > 16 || parents.some(p => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(p)) || (m.reusedCommit ? m.commit !== m.executionBase.sha || parents.includes(m.commit) : parents.length !== 1 || parents[0] !== m.executionBase.sha)) fail("CHECKPOINT_INCOMPLETE", "Remote commit actual parentage does not match reused base or safe snapshot");
    await ctx.db.patch(checkpoint._id, { state: "code_published", parent: parents.length === 1 ? parents[0]! : null, actualParents: parents, manifestJson: canonical({ ...m, remoteReadback: args.readback }), evidenceHash: await digest(canonical({ evidence: m.evidence, readback: args.readback })) }); return { checkpointId: checkpoint.id, state: "code_published" as const };
  });
} });
export const ready = mutation({ args: { ...runArgs, checkpointId: v.string() }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["artifact_verifier", "human"]); const { task, run } = await verifiedRun(ctx, args, actor);
  return replay(ctx, actor, "checkpoints.ready", args, async () => {
    const checkpoint = await ctx.db.query("checkpoints").withIndex("by_stable_id", q => q.eq("id", args.checkpointId)).unique();
    if (!checkpoint || checkpoint.projectId !== args.projectId || checkpoint.runId !== run.id || checkpoint.epoch !== run.epoch || checkpoint.state !== "code_published") fail("CHECKPOINT_INCOMPLETE", "Verified remote code is required before ready acceptance");
    const manifest = JSON.parse(checkpoint.manifestJson) as typeof manifestValidator.type;
    await validateManifest(manifest, task, run);
    if (!project.capturePolicyDigest || manifest.policyDigest !== project.capturePolicyDigest) fail("FORBIDDEN", "Capture policy approval changed before ready acceptance");
    requireVerifiedScan(task, manifest);
    await ctx.db.patch(checkpoint._id, { state: "ready", manifestJson: canonical({ ...manifest, verifiedScan: task.verifiedScan }), evidenceHash: await digest(canonical({ previousEvidenceHash: checkpoint.evidenceHash, verifiedScan: task.verifiedScan })) }); await ctx.db.patch(task._id, { latestCheckpointId: checkpoint.id });
    return { checkpointId: checkpoint.id, state: "ready" as const, tree: checkpoint.tree, commit: checkpoint.commit };
  });
} });

async function dependencySummaries(ctx: Pick<QueryCtx, "db">, project: Doc<"projects">, task: Doc<"tasks">) {
  if (task.dependencies.length > 20 || new Set(task.dependencies.map(input => input.taskId)).size !== task.dependencies.length) fail("COVERAGE_INCOMPLETE", "Dependency input list exceeds its complete bounded contract");
  const inputs = [];
  for (const dependency of task.dependencies) inputs.push(await dependencyInput(ctx, project, task, dependency.taskId, false));
  // Bound only the added compact inputs, never the existing accepted checkpoint/manifest response.
  if (new TextEncoder().encode(canonical(inputs)).length > 64 * 1024) fail("COVERAGE_INCOMPLETE", "Compact dependency inputs exceed their complete response bound");
  return inputs;
}
export const getInput = query({ args: { ...identityArgs, taskId: v.string(), dependencyTaskId: v.string(), includeManifest: v.optional(v.boolean()) }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["agent", "human", "run"]);
  let task: Doc<"tasks">;
  if (actor.role === "run") {
    const run = actor.runId ? await ctx.db.query("runs").withIndex("by_stable_id", q => q.eq("id", actor.runId!)).unique() : null;
    if (!run || run.taskId !== args.taskId || run.projectId !== project.id) fail("FORBIDDEN", "Run credentials may inspect only their bound task's declared inputs");
    ({ task } = await liveRun(ctx, { ...args, runId: run.id, epoch: run.epoch, goalRevision: run.goalRevision }, actor, ["reserved", "starting", "running"]));
  } else {
    task = await taskById(ctx, args.taskId, project.id); await approvedGoal(ctx, task); validateScope(project, task.scope);
    if (!project.sharingApproved) fail("FORBIDDEN", "Project sharing is not approved");
  }
  return dependencyInput(ctx, project, task, args.dependencyTaskId, args.includeManifest === true);
} });

export const getReady = query({ args: { ...identityArgs, taskId: v.string(), checkpointId: v.optional(v.string()) }, handler: async (ctx, args) => {
  const { project } = await authenticate(ctx, args, ["agent", "human"]);
  const task = await taskById(ctx, args.taskId, args.projectId); const goal = await approvedGoal(ctx, task);
  validateScope(project, task.scope);
  if (!project.sharingApproved) fail("FORBIDDEN", "Project sharing is not approved");
  const inputs = await dependencySummaries(ctx, project, task);
  if (!args.checkpointId) {
    if (task.latestCheckpointId || !await safeBaseRetry(ctx, task)) fail("BLOCKED_CHECKPOINT", "Select the explicit latest ready checkpoint; absent progress is not evidence that execution never started");
    return { status: "initial_base" as const, task, goal, checkpoint: null, manifest: null, summary: null, executionBase: task.executionBase, inputs };
  }
  const checkpoint = await ctx.db.query("checkpoints").withIndex("by_stable_id", q => q.eq("id", args.checkpointId!)).unique();
  if (!checkpoint || checkpoint.projectId !== project.id || checkpoint.taskId !== task.id || checkpoint.id !== task.latestCheckpointId || checkpoint.state !== "ready") fail("BLOCKED_CHECKPOINT", "Selected checkpoint is unavailable, incomplete or not the current latest ready artifact");
  const manifest = JSON.parse(checkpoint.manifestJson) as typeof manifestValidator.type;
  if (manifest.identity.goalRevision !== task.goalRevision || canonical(manifest.executionBase) !== canonical(task.executionBase) || checkpoint.commit !== manifest.commit || checkpoint.tree !== manifest.tree || !project.capturePolicyDigest || manifest.policyDigest !== project.capturePolicyDigest) fail("BLOCKED_CHECKPOINT", "Ready artifact no longer matches the current approved goal, execution base or sharing policy");
  if (await progressHash(checkpoint.summary) !== manifest.progressHash) fail("BLOCKED_CHECKPOINT", "Ready checkpoint has no matching immutable progress summary");
  return { status: "ready" as const, task, goal, checkpoint, manifest, summary: checkpoint.summary, executionBase: checkpoint.executionBase, inputs };
} });
