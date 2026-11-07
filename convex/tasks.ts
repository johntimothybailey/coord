import { v } from "convex/values";
import { progressHash } from "./artifacts.js";
import type { Manifest } from "./artifacts.js";
import { DEFAULTS, requireCapability } from "../src/protocol.js";
import { boundedRecords } from "./messages.js";
import { base, dependency, capabilityKey } from "./schema.js";
import { mutation, query } from "./server.js";
import type { Doc, MutationCtx, QueryCtx } from "./server.js";
import { identityArgs, runArgs, authenticate, replay, fail, stableId, bounded, paths, overlaps, boundRun, approvedGoal, liveRun, digest, tokenFormat, canonical } from "./auth.js";

export function validateScope(project: Doc<"projects">, scope: string[]): void {
  paths(scope);
  for (const p of scope) if (!project.allowedPaths.some(a => p === a || p.startsWith(`${a}/`)) || project.excludedPaths.some(a => overlaps(a, p))) fail("FORBIDDEN", "Task scope escapes approved project paths");
}
export async function taskById(ctx: Pick<QueryCtx, "db">, id: string, projectId: string): Promise<Doc<"tasks">> {
  const task = await ctx.db.query("tasks").withIndex("by_stable_id", q => q.eq("id", id)).unique();
  if (!task || task.projectId !== projectId) fail("NOT_FOUND", "Task not found");
  return task;
}
export async function dependencyInput(ctx: Pick<QueryCtx, "db">, project: Doc<"projects">, parent: Doc<"tasks">, dependencyTaskId: string, includeManifest: boolean) {
  const dependency = parent.dependencies.find(input => input.taskId === dependencyTaskId);
  if (!dependency) fail("FORBIDDEN", "Only an explicitly declared dependency can be inspected");
  const child = await taskById(ctx, dependency.taskId, project.id); validateScope(project, child.scope);
  const task = { id: child.id, title: child.title, state: child.state, reason: child.reason };
  if (dependency.mode === "merged") return { dependency, task, availability: "unverified_merge" as const, code: null };
  if (!dependency.artifact) return { dependency, task, availability: "unavailable" as const, code: null };
  const checkpoint = await ctx.db.query("checkpoints").withIndex("by_stable_id", q => q.eq("id", dependency.artifact!)).unique();
  if (!checkpoint || checkpoint.projectId !== project.id || checkpoint.taskId !== child.id || checkpoint.state !== "ready") return { dependency, task, availability: "unavailable" as const, code: null };
  let manifest: Manifest;
  try { manifest = JSON.parse(checkpoint.manifestJson) as Manifest; } catch { fail("BLOCKED_CHECKPOINT", "Dependency manifest is not valid immutable metadata"); }
  if (manifest?.schemaVersion !== 1 || manifest.identity?.taskId !== child.id || manifest.identity?.runId !== checkpoint.runId || manifest.identity?.epoch !== checkpoint.epoch || manifest.checkpointId !== checkpoint.id || canonical(manifest.executionBase) !== canonical(checkpoint.executionBase) || manifest.remoteParent !== checkpoint.executionBase.sha || manifest.sourceHead !== checkpoint.sourceHead || manifest.commit !== checkpoint.commit || manifest.tree !== checkpoint.tree || manifest.ref !== checkpoint.ref || manifest.progressHash !== checkpoint.progressHash || manifest.progressRevision !== checkpoint.progressRevision || manifest.manifestDigest !== checkpoint.manifestHash || !project.capturePolicyDigest || manifest.policyDigest !== project.capturePolicyDigest || await progressHash(checkpoint.summary) !== checkpoint.progressHash) fail("BLOCKED_CHECKPOINT", "Dependency artifact no longer matches immutable code/progress or current sharing policy");
  const core = { identity: manifest.identity, sourceHead: manifest.sourceHead, executionBase: manifest.executionBase, tree: manifest.tree, files: manifest.files, exclusions: manifest.exclusions, progressHash: manifest.progressHash, policyDigest: manifest.policyDigest, progressRevision: manifest.progressRevision };
  if (await digest(canonical(core)) !== checkpoint.manifestHash) fail("BLOCKED_CHECKPOINT", "Dependency manifest digest does not match its immutable capture");
  const code = { checkpointId: checkpoint.id, ref: checkpoint.ref, commit: checkpoint.commit, tree: checkpoint.tree, executionBase: checkpoint.executionBase, manifestHash: checkpoint.manifestHash, progressHash: checkpoint.progressHash, ...(includeManifest ? { summary: checkpoint.summary, manifest } : {}) };
  const result = { dependency, task, availability: "published" as const, code };
  if (new TextEncoder().encode(canonical(result)).length > (includeManifest ? 600 : 64) * 1024) fail("COVERAGE_INCOMPLETE", "Dependency detail exceeds the supported individual response bound");
  return result;
}
export async function dependenciesReady(ctx: Pick<QueryCtx, "db">, task: Doc<"tasks">): Promise<void> {
  if (!task.dependencies.length) return;
  const project = await ctx.db.query("projects").withIndex("by_stable_id", q => q.eq("id", task.projectId)).unique();
  if (!project || !project.sharingApproved) fail("FORBIDDEN", "Dependency inputs require current project sharing approval");
  validateScope(project, task.scope);
  for (const dep of task.dependencies) {
    const input = await dependencyInput(ctx, project, task, dep.taskId, false);
    if (input.task.state === "failed" || input.task.state === "cancelled") fail("BLOCKED_CHECKPOINT", "Terminal dependency failure requires bounded replanning before ordinary admission");
    if (input.availability === "unverified_merge") fail("BLOCKED_CHECKPOINT", "Merged dependency requires independently observed integration evidence; unsupported until configured");
    if (input.availability !== "published") fail("BLOCKED_CHECKPOINT", "Dependency needs an exact authorized ready published checkpoint");
  }
}
export async function noConflicts(ctx: Pick<QueryCtx, "db">, task: Doc<"tasks">, admission = false): Promise<void> {
  const messages = await ctx.db.query("messages").withIndex("by_recipient", q => q.eq("projectId", task.projectId).eq("recipientTaskId", task.id)).take(101);
  if (messages.length > 100) fail("CONFLICT_UNRESOLVED", "Coordination conflict coverage is incomplete");
  for (const message of messages.filter(m => m.conflict)) {
    const sender = await taskById(ctx, message.senderTaskId, task.projectId);
    if (message.resolution !== "accepted" || message.decisionRecipientEpoch !== task.epoch + (admission ? 1 : 0) || message.decisionSenderEpoch !== sender.epoch || !message.decision) fail("CONFLICT_UNRESOLVED", "Conflict lacks an accepted decision for the current named task epochs");
  }
}
export const propose = mutation({ args: { ...identityArgs, taskId: v.string(), goalId: v.string(), goalRevision: v.number(), title: v.string(), scope: v.array(v.string()), dependencies: v.array(dependency), executionBase: base }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["agent", "human"]);
  return replay(ctx, actor, "tasks.propose", args, async () => {
    stableId(args.taskId); bounded(args.title, 1024, "task title"); validateScope(project, args.scope);
    if (!/^[a-f0-9]{40,64}$/.test(args.executionBase.sha) || !Number.isSafeInteger(args.executionBase.revision) || args.executionBase.revision < 1 || !args.executionBase.remoteRef.startsWith("refs/")) fail("INVALID_INPUT", "Invalid execution base");
    if (args.dependencies.length > 20 || new Set(args.dependencies.map(d => d.taskId)).size !== args.dependencies.length) fail("INVALID_INPUT", "Invalid dependencies");
    if (await ctx.db.query("tasks").withIndex("by_stable_id", q => q.eq("id", args.taskId)).unique()) fail("IDEMPOTENCY_CONFLICT", "Task identity is already used");
    const goal = await ctx.db.query("goals").withIndex("by_stable_id", q => q.eq("id", args.goalId)).unique();
    if (!goal || goal.projectId !== project.id || goal.revision !== args.goalRevision || goal.state !== "active" || goal.approvedHash !== goal.hash || !goal.approvedBy) fail("GOAL_NOT_APPROVED", "Task requires an approved current goal");
    const tasks = await ctx.db.query("tasks").withIndex("by_goal", q => q.eq("goalId", goal.id)).take(project.taskCap + 1);
    if (tasks.length >= Math.min(goal.taskLimit, project.taskCap)) fail("CAPACITY_EXHAUSTED", "Approved goal task limit reached");
    // Existing-only edges make a cycle impossible when appending a new task.
    for (const dep of args.dependencies) await taskById(ctx, dep.taskId, project.id);
    await ctx.db.insert("tasks", { id: args.taskId, projectId: project.id, goalId: goal.id, goalRevision: goal.revision, title: args.title, scope: args.scope, dependencies: args.dependencies, executionBase: args.executionBase, state: "queued", epoch: 0, replanAttempts: 0, dispatchHeld: false, progressRevision: 0, progress: "", coverageComplete: false });
    return { taskId: args.taskId, state: "queued" as const };
  });
} });

const admissionArgs = { ...identityArgs, taskId: v.string(), runId: v.string(), launchId: v.string(), grantToken: v.string(), machineId: v.string(), harness: v.union(v.literal("codex"), v.literal("antigravity")), capabilityKey };
type Admission = { token: string; protocolVersion: number; clientVersion: string; capabilities: string[]; backendId: string; projectId: string; requestId: string; taskId: string; runId: string; launchId: string; grantToken: string; machineId: string; harness: "codex" | "antigravity"; capabilityKey: Doc<"machines">["capabilityKey"] & {} };
async function admit(ctx: MutationCtx, args: Admission, mode: "manual" | "managed" | "replan") {
  const { actor, project } = await authenticate(ctx, args, ["agent"]);
  return replay(ctx, actor, `tasks.${mode === "manual" ? "registerManual" : mode === "replan" ? "claimReplan" : "claim"}`, args, async () => {
    stableId(args.runId); stableId(args.launchId); stableId(args.machineId); tokenFormat(args.grantToken);
    if (args.grantToken === args.token) fail("INVALID_INPUT", "Run credential must be independent");
    const task = await taskById(ctx, args.taskId, project.id); validateScope(project, task.scope); const goal = await approvedGoal(ctx, task);
    if (task.state !== (mode === "replan" ? "replan_requested" : "queued") || task.ownerRunId || task.holdRunId || task.dispatchHeld) fail(task.holdRunId ? "LAUNCH_UNCERTAIN" : "CAPACITY_EXHAUSTED", "Task cannot be admitted");
    if (mode === "replan" && task.replanAttempts >= DEFAULTS.replanLimit) fail("NEEDS_HUMAN", "Persistent automatic replanning attempt limit reached");
    if (!project.sharingApproved) fail("FORBIDDEN", "Project routing/sharing has not been approved");
    const machine = await ctx.db.query("machines").withIndex("by_id_project", q => q.eq("id", args.machineId).eq("projectId", project.id)).unique();
    if (!machine || machine.memberId !== actor.memberId || !machine.qualifiedModes.includes(mode === "replan" ? "managed" : mode) || machine.qualificationExpiresAt <= Date.now() || project.configVersion === undefined || machine.configVersion !== project.configVersion || !machine.capabilityKey || !machine.capabilityChecks || args.capabilityKey.harness !== args.harness) fail("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Machine lacks current real capability qualification");
    try { requireCapability({ key: machine.capabilityKey, checks: machine.capabilityChecks }, args.capabilityKey, mode === "replan" ? "managed" : mode); } catch { fail("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Machine capability evidence does not match current configuration"); }
    if (mode !== "replan") await dependenciesReady(ctx, task); await noConflicts(ctx, task, true);
    for (const state of ["reserved", "running", "yielding", "launch_uncertain"] as const) {
      const contenders = await ctx.db.query("tasks").withIndex("by_project_state", q => q.eq("projectId", project.id).eq("state", state)).take(101);
      if (contenders.length > 100 || contenders.some(t => t.id !== task.id && t.scope.some(p => task.scope.some(s => overlaps(p, s))))) fail("CONFLICT_UNRESOLVED", "Declared scope is already reserved or cannot be completely checked");
    }
    const held = await ctx.db.query("runs").withIndex("by_project_capacity", q => q.eq("projectId", project.id).eq("capacityHeld", true)).take(project.capacity + 1);
    const machineHeld = await ctx.db.query("runs").withIndex("by_machine_capacity", q => q.eq("machineId", machine.id).eq("capacityHeld", true)).take(machine.capacity + 1);
    if (mode !== "manual" && (held.length >= project.capacity || machineHeld.length >= machine.capacity)) fail("CAPACITY_EXHAUSTED", "Managed capacity is reserved");
    const grantDigest = await digest(args.grantToken); const grantId = `grant_${args.runId}`;
    if (await ctx.db.query("credentials").withIndex("by_digest", q => q.eq("digest", grantDigest)).unique() || await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", grantId)).unique() || await ctx.db.query("runs").withIndex("by_stable_id", q => q.eq("id", args.runId)).unique()) fail("IDEMPOTENCY_CONFLICT", "Run or grant identity already used");
    const epoch = task.epoch + 1; const deadline = Date.now() + goal.runTimeoutMs; const leaseUntil = Math.min(Date.now() + DEFAULTS.leaseMs, deadline);
    await ctx.db.insert("runs", { id: args.runId, projectId: project.id, taskId: task.id, memberId: actor.memberId, machineId: machine.id, harness: args.harness, mode, goalRevision: goal.revision, epoch, launchId: args.launchId, state: mode === "manual" ? "running" : "reserved", grantId, capabilityDigest: machine.capabilityDigest, configVersion: project.configVersion, policyVersion: project.policyVersion, leaseUntil, deadline, capacityHeld: mode !== "manual", resultAccepted: false });
    await ctx.db.insert("credentials", { id: grantId, backendId: args.backendId, memberId: actor.memberId, digest: grantDigest, role: "run", projectIds: [project.id], runId: args.runId, expiresAt: deadline });
    await ctx.db.patch(task._id, { epoch, ownerRunId: args.runId, leaseUntil, state: mode === "manual" ? "running" : "reserved", replanAttempts: task.replanAttempts + (mode === "replan" ? 1 : 0), coverageComplete: false });
    return { taskId: task.id, runId: args.runId, epoch, goalRevision: goal.revision, launchId: args.launchId, grantId, leaseUntil, deadline, mode };
  });
}
export const claim = mutation({ args: admissionArgs, handler: (ctx, args) => admit(ctx, args, "managed") });
export const claimReplan = mutation({ args: admissionArgs, handler: (ctx, args) => admit(ctx, args, "replan") });
export const registerManual = mutation({ args: admissionArgs, handler: (ctx, args) => admit(ctx, args, "manual") });
export const renew = mutation({ args: runArgs, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); const { task, run } = await liveRun(ctx, args, actor, ["reserved", "starting", "running"]);
  return replay(ctx, actor, "tasks.renew", args, async () => {
    const leaseUntil = Math.min(Date.now() + DEFAULTS.leaseMs, run.deadline);
    await ctx.db.patch(task._id, { leaseUntil }); await ctx.db.patch(run._id, { leaseUntil }); return { runId: run.id, epoch: run.epoch, leaseUntil };
  });
} });
// Status facts are not execution/renewal authority; post-result native check-in remains blocked.
export const sessionStatus = query({ args: runArgs, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); const { task, run } = await boundRun(ctx, args, actor);
  return { taskState: task.state, runState: run.state, resultAccepted: run.resultAccepted, requestedOutcome: run.requestedOutcome, leaseUntil: run.leaseUntil, deadline: run.deadline, currentOwner: task.ownerRunId === run.id && task.epoch === run.epoch };
} });
export const checkIn = query({ args: runArgs, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["run"]); const { task, run, goal } = await liveRun(ctx, args, actor, ["reserved", "starting", "running"]);
  const messages = await ctx.db.query("messages").withIndex("by_recipient", q => q.eq("projectId", project.id).eq("recipientTaskId", task.id)).take(101);
  let conflictBlocked = false; try { await noConflicts(ctx, task); } catch { conflictBlocked = true; }
  const selected = boundedRecords(messages.filter(m => (m.recipientEpoch === task.epoch && m.state !== "acknowledged_by_agent") || (m.conflict && (m.resolution !== "accepted" || m.decisionRecipientEpoch !== task.epoch))).slice(0, 100), 2048);
  return { task, run, goal, policyVersion: project.policyVersion, messages: selected.records, conflictBlocked, complete: messages.length <= 100 && selected.complete };
} });
export const progress = mutation({ args: { ...runArgs, expectedRevision: v.number(), progress: v.string() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); const { task } = await liveRun(ctx, args, actor);
  return replay(ctx, actor, "tasks.progress", args, async () => {
    bounded(args.progress, 16 * 1024, "progress"); if (task.progressRevision !== args.expectedRevision) fail("IDEMPOTENCY_CONFLICT", "Task progress changed");
    await ctx.db.patch(task._id, { progress: args.progress, progressRevision: task.progressRevision + 1, coverageComplete: false }); return { revision: task.progressRevision + 1 };
  });
} });

const proposedTask = v.object({ taskId: v.string(), title: v.string(), scope: v.array(v.string()), dependencies: v.array(dependency), executionBase: base });
async function acyclic(ctx: MutationCtx, projectId: string, replacements: Map<string, Array<{ taskId: string }>>): Promise<void> {
  const visiting = new Set<string>(), visited = new Set<string>();
  async function visit(id: string): Promise<void> {
    if (visiting.has(id)) fail("INVALID_INPUT", "Task dependencies contain a cycle");
    if (visited.has(id)) return;
    if (visited.size + visiting.size >= 100) fail("INVALID_INPUT", "Dependency graph exceeds bounded validation capacity");
    visiting.add(id); const edges = replacements.get(id) ?? (await taskById(ctx, id, projectId)).dependencies;
    for (const edge of edges) await visit(edge.taskId);
    visiting.delete(id); visited.add(id);
  }
  for (const id of replacements.keys()) await visit(id);
}
export const proposeSubtasks = mutation({ args: { ...runArgs, rationale: v.string(), children: v.array(proposedTask) }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["run"]); const { task, run, goal } = await liveRun(ctx, args, actor);
  return replay(ctx, actor, "tasks.proposeSubtasks", args, async () => {
    bounded(args.rationale, 4096, "subtask purpose");
    if (run.mode === "manual") fail("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Prerequisite yielding requires supervised managed execution");
    if (!args.children.length || args.children.length > 20 || new Set(args.children.map(c => c.taskId)).size !== args.children.length) fail("INVALID_INPUT", "Invalid bounded child proposal");
    const all = await ctx.db.query("tasks").withIndex("by_goal", q => q.eq("goalId", goal.id)).take(101);
    if (all.length + args.children.length > Math.min(goal.taskLimit, project.taskCap)) fail("CAPACITY_EXHAUSTED", "Atomic child proposal exceeds approved goal limit");
    const replacements = new Map<string, Array<{ taskId: string }>>();
    for (const child of args.children) {
      stableId(child.taskId); bounded(child.title, 1024, "child title"); validateScope(project, child.scope);
      if (child.dependencies.length > 20 || child.dependencies.some(d => d.taskId === child.taskId) || new Set(child.dependencies.map(d => d.taskId)).size !== child.dependencies.length) fail("INVALID_INPUT", "Invalid child dependencies");
      if (await ctx.db.query("tasks").withIndex("by_stable_id", q => q.eq("id", child.taskId)).unique()) fail("IDEMPOTENCY_CONFLICT", "Child identity already exists");
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(child.executionBase.sha) || child.executionBase.revision < 1 || !Number.isSafeInteger(child.executionBase.revision) || !child.executionBase.remoteRef.startsWith("refs/")) fail("INVALID_INPUT", "Invalid child execution base");
      replacements.set(child.taskId, child.dependencies);
    }
    const dependencies = [...task.dependencies, ...args.children.map(c => ({ taskId: c.taskId, mode: "published" as const }))];
    if (dependencies.length > 20) fail("INVALID_INPUT", "Parent dependency limit exceeded");
    replacements.set(task.id, dependencies); await acyclic(ctx, project.id, replacements);
    for (const child of args.children) await ctx.db.insert("tasks", { id: child.taskId, projectId: project.id, goalId: goal.id, goalRevision: goal.revision, title: child.title, scope: child.scope, dependencies: child.dependencies, executionBase: child.executionBase, state: "queued", epoch: 0, replanAttempts: 0, dispatchHeld: true, parentTaskId: task.id, progressRevision: 0, progress: "", coverageComplete: false });
    await ctx.db.patch(task._id, { state: "yielding", dependencies, reason: args.rationale, progressRevision: task.progressRevision + 1, coverageComplete: false });
    return { taskId: task.id, state: "yielding" as const, children: args.children.map(c => c.taskId), dispatchHeld: true };
  });
} });

export async function refreshWaiting(ctx: MutationCtx, waiting: Doc<"tasks">[]) {
    const changed: Array<{ taskId: string; state: string }> = [];
    for (const task of waiting) {
      if (!["queued", "waiting_dependencies"].includes(task.state) || task.ownerRunId || task.holdRunId || task.dispatchHeld || (task.state === "queued" && !task.dependencies.length)) continue;
      try { await approvedGoal(ctx, task); } catch { continue; }
      const project = await ctx.db.query("projects").withIndex("by_stable_id", q => q.eq("id", task.projectId)).unique();
      if (!project || !project.sharingApproved) continue;
      try { validateScope(project, task.scope); } catch { continue; }
      const dependencies: Doc<"tasks">["dependencies"] = []; let terminalFailure = false; let allReady = true; let dependenciesChanged = false;
      for (const dep of task.dependencies) {
        const child = await taskById(ctx, dep.taskId, task.projectId);
        if (child.state === "failed" || child.state === "cancelled") terminalFailure = true;
        if (dep.mode !== "published" || !(dep.artifact ?? child.latestCheckpointId)) { allReady = false; dependencies.push(dep); continue; }
        const checkpoint = await ctx.db.query("checkpoints").withIndex("by_stable_id", q => q.eq("id", (dep.artifact ?? child.latestCheckpointId)!)).unique();
        if (!checkpoint || checkpoint.state !== "ready" || checkpoint.taskId !== child.id || checkpoint.projectId !== task.projectId) { allReady = false; dependencies.push(dep); continue; }
        const candidate = dep.artifact ? dep : { ...dep, artifact: checkpoint.id };
        try {
          const input = await dependencyInput(ctx, project, { ...task, dependencies: task.dependencies.map(current => current.taskId === dep.taskId ? candidate : current) }, dep.taskId, false);
          if (input.availability !== "published") { allReady = false; dependencies.push(dep); continue; }
        } catch { allReady = false; dependencies.push(dep); continue; }
        if (!dep.artifact) dependenciesChanged = true;
        dependencies.push(candidate);
      }
      if (terminalFailure) {
        const exhausted = task.replanAttempts >= DEFAULTS.replanLimit;
        await ctx.db.patch(task._id, { state: exhausted ? "blocked" : "replan_requested", reason: exhausted ? "NEEDS_HUMAN: replan_limit" : "terminal_dependency_failure", dispatchHeld: exhausted });
        changed.push({ taskId: task.id, state: exhausted ? "blocked" : "replan_requested" });
      } else if (allReady && (task.state !== "queued" || dependenciesChanged)) {
        await ctx.db.patch(task._id, { state: "queued", dependencies, reason: "dependencies_published" }); changed.push({ taskId: task.id, state: "queued" });
      } else if (dependenciesChanged) {
        await ctx.db.patch(task._id, { dependencies }); changed.push({ taskId: task.id, state: task.state });
      }
    }
    return { changed, complete: true };
}

// Deterministic scheduler transition, not a project-agent ownership override.
export const refreshDependencies = mutation({ args: identityArgs, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["agent", "human"]);
  return replay(ctx, actor, "tasks.refreshDependencies", args, async () => {
    const waiting = await ctx.db.query("tasks").withIndex("by_project_state", q => q.eq("projectId", args.projectId).eq("state", "waiting_dependencies")).take(101);
    const queued = await ctx.db.query("tasks").withIndex("by_project_state", q => q.eq("projectId", args.projectId).eq("state", "queued")).take(101);
    if (waiting.length > 100 || queued.length > 100) fail("COVERAGE_INCOMPLETE", "Dependency batch exceeds bounded project state limits");
    return refreshWaiting(ctx, [...waiting, ...queued]);
  });
} });
export const finishReplan = mutation({ args: { ...runArgs, result: v.union(v.literal("revised"), v.literal("blocked"), v.literal("failed")), dependencies: v.array(dependency), rationale: v.string() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); await boundRun(ctx, args, actor);
  return replay(ctx, actor, "tasks.finishReplan", args, async () => {
    const { task, run } = await liveRun(ctx, args, actor);
    bounded(args.rationale, 4096, "replanning result");
    if (run.mode !== "replan" || args.dependencies.length > 20 || new Set(args.dependencies.map(d => d.taskId)).size !== args.dependencies.length) fail("FORBIDDEN", "A bounded replanning run is required");
    if (args.result === "revised") await acyclic(ctx, args.projectId, new Map([[task.id, args.dependencies]]));
    const state = args.result === "revised" ? "waiting_dependencies" as const : args.result;
    await ctx.db.patch(task._id, { dependencies: args.result === "revised" ? args.dependencies : task.dependencies, state, reason: args.rationale, dispatchHeld: true, holdRunId: run.id });
    await ctx.db.patch(run._id, { state: "finalizing", finalizationKind: "normal", requestedOutcome: args.result === "failed" ? "failed" : "succeeded", resultAccepted: true, replanDisposition: state, hold: "replan_stop_confirmation_required" });
    return { taskId: task.id, state, attempt: task.replanAttempts, capacityHeld: true };
  });
} });
// A missing progress update is never evidence that native tools made no changes.
export async function safeBaseRetry(ctx: Pick<QueryCtx, "db">, task: Doc<"tasks">): Promise<boolean> {
  if (task.epoch === 0) return true;
  const current = await ctx.db.query("runs").withIndex("by_task_epoch", q => q.eq("taskId", task.id).eq("epoch", task.epoch)).unique();
  if (!current || current.projectId !== task.projectId) return false;
  if (current.releasedAt !== undefined) return !current.capacityHeld && !current.process && current.stopEvidence?.kind === "proven_never_started";
  // Admission must reconstruct an execution base before the first-ever launch can start.
  if (task.epoch === 1 && task.ownerRunId === current.id && current.state === "reserved" && !current.process && !current.hold && !task.holdRunId) return true;
  if (current.state === "reserved" && !current.process && !current.hold && !task.holdRunId && task.ownerRunId === current.id) {
    const prior = await ctx.db.query("runs").withIndex("by_task_epoch", q => q.eq("taskId", task.id).eq("epoch", task.epoch - 1)).unique();
    return !!prior && prior.projectId === task.projectId && prior.releasedAt !== undefined && !prior.capacityHeld && !prior.process && prior.stopEvidence?.kind === "proven_never_started";
  }
  return false;
}
export const requestResume = mutation({ args: { ...identityArgs, taskId: v.string(), checkpointId: v.optional(v.string()) }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["agent", "human"]);
  return replay(ctx, actor, "tasks.requestResume", args, async () => {
    const task = await taskById(ctx, args.taskId, project.id); await approvedGoal(ctx, task); validateScope(project, task.scope);
    if (task.state !== "blocked" || task.ownerRunId || task.holdRunId || task.reason === "human_recovery_required" || task.reason?.startsWith("NEEDS_HUMAN")) fail("LAUNCH_UNCERTAIN", "Task requires a settled reservation and eligible recovery decision");
    if (args.checkpointId || !await safeBaseRetry(ctx, task)) {
      const checkpoint = args.checkpointId ? await ctx.db.query("checkpoints").withIndex("by_stable_id", q => q.eq("id", args.checkpointId!)).unique() : null;
      if (!checkpoint || checkpoint.projectId !== project.id || checkpoint.taskId !== task.id || checkpoint.id !== task.latestCheckpointId || checkpoint.state !== "ready" || JSON.parse(checkpoint.manifestJson).identity.goalRevision !== task.goalRevision) fail("BLOCKED_CHECKPOINT", "Resume requires the explicit matching latest ready checkpoint");
    }
    await dependenciesReady(ctx, task); await noConflicts(ctx, task, true);
    await ctx.db.patch(task._id, { state: "queued", dispatchHeld: false, reason: "explicit_ready_resume" }); return { taskId: task.id, state: "queued" as const, checkpointId: args.checkpointId ?? null };
  });
} });
