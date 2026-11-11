import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { processIdentity, stopEvidence } from "./schema.js";
import { internalMutation, mutation, query } from "./server.js";
import type { Doc, QueryCtx } from "./server.js";
import { authenticate, replay, runArgs, identityArgs, liveRun, fail, revokeGrant, bounded, canonical, boundRun, digest } from "./auth.js";
import { taskById, refreshWaiting } from "./tasks.js";

export async function supervisedRun(ctx: Pick<QueryCtx, "db">, args: { projectId: string; taskId: string; runId: string; epoch: number; goalRevision: number }, actor: Doc<"credentials">) {
  const run = await ctx.db.query("runs").withIndex("by_stable_id", q => q.eq("id", args.runId)).unique();
  if (!run || run.taskId !== args.taskId || run.projectId !== args.projectId || run.epoch !== args.epoch || run.goalRevision !== args.goalRevision) fail("NOT_FOUND", "Run not found");
  if (actor.role !== "supervisor" || actor.machineId !== run.machineId || actor.memberId !== run.memberId || run.mode === "manual") fail("FORBIDDEN", "Supervisor is not authorized for this managed run");
  return { run, task: await taskById(ctx, args.taskId, args.projectId) };
}
export const status = query({ args: runArgs, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["supervisor"]);
  const { task, run } = await supervisedRun(ctx, args, actor);
  return { taskState: task.state, runState: run.state, resultAccepted: run.resultAccepted, requestedOutcome: run.requestedOutcome, leaseUntil: run.leaseUntil, deadline: run.deadline, capacityHeld: run.capacityHeld, releaseReceipt: run.releaseReceipt, process: run.process };
} });
export const starting = mutation({ args: runArgs, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); const { run } = await liveRun(ctx, args, actor, ["reserved", "starting"]);
  return replay(ctx, actor, "lifecycle.starting", args, async () => {
    if (run.mode === "manual") fail("FORBIDDEN", "Manual sessions do not authorize managed launch");
    await ctx.db.patch(run._id, { state: "starting" }); return { launchId: run.launchId, state: "starting" as const };
  });
} });
export const authorizeLaunch = mutation({ args: { ...runArgs, process: processIdentity }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["supervisor"]); const supervised = await supervisedRun(ctx, args, actor);
  const grant = await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", supervised.run.grantId)).unique();
  if (!grant || grant.revokedAt !== undefined || grant.expiresAt <= Date.now() || grant.backendId !== args.backendId || !grant.projectIds.includes(args.projectId)) fail("LEASE_REVOKED", "Launch credential expired or left the scoped backend/project");
  const { task, run } = await liveRun(ctx, args, grant, ["starting", "running"]);
  return replay(ctx, actor, "lifecycle.authorizeLaunch", args, async () => {
    if (args.process.launchId !== run.launchId || !Number.isSafeInteger(args.process.pid) || args.process.pid <= 0 || !args.process.bootId || !args.process.startIdentity) fail("INVALID_INPUT", "Process identity does not bind this launch");
    if (run.process && canonical(run.process) !== canonical(args.process)) fail("LAUNCH_UNCERTAIN", "Different process identity already recorded");
    await ctx.db.patch(run._id, { process: args.process, state: "running" }); await ctx.db.patch(task._id, { state: "running" });
    return { launchId: run.launchId, authorized: true, leaseUntil: run.leaseUntil };
  });
} });
export const reportUncertain = mutation({ args: { ...runArgs, reason: v.string() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["supervisor"]); const { run, task } = await supervisedRun(ctx, args, actor);
  return replay(ctx, actor, "lifecycle.reportUncertain", args, async () => {
    bounded(args.reason, 2048, "uncertainty reason");
    if (run.releasedAt !== undefined) fail("FORBIDDEN", "Released reservation cannot become uncertain again");
    await revokeGrant(ctx, run); await ctx.db.patch(run._id, { hold: args.reason, state: "finalizing", requestedOutcome: "stopped" });
    if (task.ownerRunId === run.id && task.epoch === run.epoch) {
      const goal = await ctx.db.query("goals").withIndex("by_stable_id", q => q.eq("id", task.goalId)).unique();
      const active = goal?.state === "active" && goal.projectId === task.projectId && goal.revision === task.goalRevision && goal.approvedHash === goal.hash;
      const preserveTask = !active || run.resultAccepted || !["reserved", "running", "yielding", "launch_uncertain"].includes(task.state);
      await ctx.db.patch(task._id, { state: preserveTask ? task.state : "launch_uncertain", holdRunId: task.holdRunId ?? run.id, dispatchHeld: true, reason: preserveTask ? task.reason : args.reason, leaseUntil: undefined });
    }
    return { runId: run.id, capacityHeld: run.capacityHeld, hold: args.reason };
  });
} });
export const requestFinalization = mutation({ args: { ...runArgs, outcome: v.union(v.literal("succeeded"), v.literal("failed"), v.literal("stopped")), reason: v.string() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); await boundRun(ctx, args, actor);
  return replay(ctx, actor, "lifecycle.requestFinalization", args, async () => {
    const { run, task } = await liveRun(ctx, args, actor, ["running"], ["running", "review_ready", "yielding"]);
    bounded(args.reason, 2048, "finalization reason");
    if (args.outcome === "succeeded" && !run.resultAccepted) fail("PUBLICATION_STALE", "Successful code run requires an accepted verified publication");
    if (run.requestedOutcome && run.requestedOutcome !== args.outcome) fail("IDEMPOTENCY_CONFLICT", "Run already has another terminal outcome request");
    await ctx.db.patch(run._id, { state: "finalizing", finalizationKind: "normal", requestedOutcome: args.outcome, hold: run.capacityHeld ? "stop_confirmation_required" : undefined });
    if (args.outcome !== "succeeded" && !run.resultAccepted) await ctx.db.patch(task._id, { state: args.outcome === "failed" ? "failed" : "blocked", reason: args.reason, dispatchHeld: true, holdRunId: run.capacityHeld ? run.id : undefined });
    // Manual registration cannot claim to supervise or stop its parent harness.
    if (run.mode === "manual") {
      await revokeGrant(ctx, run);
      await ctx.db.patch(run._id, { state: args.outcome, releasedAt: Date.now(), releaseReason: "manual_registration_revoked", releaseReceipt: `manual_${run.id}`, capacityHeld: false, leaseUntil: Number.MAX_SAFE_INTEGER });
      if (task.ownerRunId === run.id && task.epoch === run.epoch) await ctx.db.patch(task._id, { ownerRunId: undefined, leaseUntil: undefined, holdRunId: task.holdRunId === run.id ? undefined : task.holdRunId });
    }
    return { runId: run.id, state: run.mode === "manual" ? args.outcome : "finalizing", capacityHeld: run.capacityHeld };
  });
} });
const terminalLaunchReceipt = v.object({ schemaVersion: v.literal(1), identity: v.object({ taskId: v.string(), runId: v.string(), epoch: v.number(), goalRevision: v.number() }), launchId: v.string(), machineId: v.string(), workspace: v.string(), process: processIdentity, recordedAt: v.string() });
export const confirmStopped = mutation({ args: { ...runArgs, evidence: stopEvidence, launchReceipt: v.optional(terminalLaunchReceipt) }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["supervisor"]); const { run, task } = await supervisedRun(ctx, args, actor);
  return replay(ctx, actor, "lifecycle.confirmStopped", args, async () => {
    const evidence = args.evidence; bounded(evidence.evidenceRef, 2048, "stop evidence");
    if (evidence.machineId !== run.machineId || evidence.launchId !== run.launchId || !Number.isFinite(Date.parse(evidence.observedAt)) || Date.parse(evidence.observedAt) > Date.now()) fail("INVALID_INPUT", "Stop evidence does not bind this run");
    let recordedProcess = run.process, processReceiptHash = run.processReceiptHash;
    if (args.launchReceipt) {
      const receipt = args.launchReceipt, recordedAt = Date.parse(receipt.recordedAt);
      bounded(receipt.workspace, 8192, "launch receipt workspace"); bounded(receipt.process.bootId, 4096, "launch receipt boot identity"); bounded(receipt.process.startIdentity, 4096, "launch receipt process identity");
      if (receipt.schemaVersion !== 1 || receipt.identity.taskId !== run.taskId || receipt.identity.runId !== run.id || receipt.identity.epoch !== run.epoch || receipt.identity.goalRevision !== run.goalRevision || !Number.isSafeInteger(receipt.identity.epoch) || receipt.identity.epoch < 1 || !Number.isSafeInteger(receipt.identity.goalRevision) || receipt.identity.goalRevision < 1 || receipt.launchId !== run.launchId || receipt.machineId !== run.machineId || receipt.process.launchId !== run.launchId || !Number.isSafeInteger(receipt.process.pid) || receipt.process.pid <= 0 || /[\0\r\n]/.test(receipt.workspace) || !(receipt.workspace.startsWith("/") || /^[A-Za-z]:[\\/]/.test(receipt.workspace)) || !Number.isFinite(recordedAt) || recordedAt > Date.now() || recordedAt > Date.parse(evidence.observedAt)) fail("INVALID_INPUT", "Launch receipt must bind the exact reserved run and a valid prior process identity");
      const receiptHash = await digest(canonical(receipt));
      if (processReceiptHash && processReceiptHash !== receiptHash) fail("LAUNCH_UNCERTAIN", "Terminal launch receipt was already recorded with different metadata");
      if (run.process && canonical(run.process) !== canonical(receipt.process)) fail("LAUNCH_UNCERTAIN", "Terminal launch receipt differs from the registered process identity");
      if (!run.process && !["reserved", "starting", "finalizing"].includes(run.state)) fail("LAUNCH_UNCERTAIN", "A terminal receipt cannot adopt a process outside failed-start settlement");
      if (evidence.kind === "proven_never_started") fail("LAUNCH_UNCERTAIN", "A durable process receipt cannot prove execution never started");
      recordedProcess = run.process ?? receipt.process; processReceiptHash = receiptHash;
    }
    if (evidence.kind === "observed_tree_exit" && (!recordedProcess || !evidence.process || canonical(recordedProcess) !== canonical(evidence.process))) fail("LAUNCH_UNCERTAIN", "Positive exit evidence must identify the registered process tree");
    if (evidence.kind === "proven_never_started" && recordedProcess) fail("LAUNCH_UNCERTAIN", "A registered process cannot be declared never started");
    if (evidence.kind === "verified_reboot" && (!recordedProcess || !evidence.process || evidence.process.bootId === recordedProcess.bootId || evidence.process.launchId !== run.launchId)) fail("LAUNCH_UNCERTAIN", "Reboot evidence requires a changed verified machine boot identity");
    if (run.releaseReceipt) return { runId: run.id, receipt: run.releaseReceipt, releasedAt: run.releasedAt! };
    if (run.requestedOutcome === "succeeded" && !run.resultAccepted) fail("PUBLICATION_STALE", "No accepted successful result");
    const outcome = run.requestedOutcome ?? "stopped"; const receipt = `release_${run.id}`; const releasedAt = Date.now();
    await revokeGrant(ctx, run);
    await ctx.db.patch(run._id, { state: outcome, capacityHeld: false, hold: undefined, process: recordedProcess, processReceiptHash, stopEvidence: evidence, releasedAt, releaseReason: evidence.kind, releaseReceipt: receipt, leaseUntil: Number.MAX_SAFE_INTEGER });
    // Late evidence settles only this reservation. Cancellation and a newer epoch always win.
    if (task.ownerRunId === run.id && task.epoch === run.epoch) {
      const goal = await ctx.db.query("goals").withIndex("by_stable_id", q => q.eq("id", task.goalId)).unique();
      const active = goal?.state === "active" && goal.revision === task.goalRevision && goal.approvedHash === goal.hash;
      const neverStarted = evidence.kind === "proven_never_started";
      if (active && run.mode === "replan" && run.resultAccepted && task.state !== "cancelled") {
        if (run.replanDisposition === "waiting_dependencies") {
          const children = await ctx.db.query("tasks").withIndex("by_goal", q => q.eq("goalId", task.goalId)).take(101);
          if (children.length > 100) fail("COVERAGE_INCOMPLETE", "Replan child dispatch coverage is incomplete");
          const required = new Set(task.dependencies.map(dependency => dependency.taskId));
          for (const child of children.filter(child => child.parentTaskId === task.id && required.has(child.id) && child.dispatchHeld && child.state === "queued")) await ctx.db.patch(child._id, { dispatchHeld: false });
        }
        await ctx.db.patch(task._id, { ownerRunId: undefined, leaseUntil: undefined, holdRunId: task.holdRunId === run.id ? undefined : task.holdRunId, state: run.replanDisposition ?? task.state, dispatchHeld: (run.replanDisposition ?? task.state) !== "waiting_dependencies" });
        return { runId: run.id, receipt, releasedAt };
      }
      if (active && run.finalizationKind === "yield" && task.state !== "cancelled") {
        const checkpoint = task.latestCheckpointId ? await ctx.db.query("checkpoints").withIndex("by_stable_id", q => q.eq("id", task.latestCheckpointId!)).unique() : null;
        if (!checkpoint || checkpoint.state !== "ready" || checkpoint.runId !== run.id || checkpoint.epoch !== run.epoch) fail("BLOCKED_CHECKPOINT", "Yield cannot release dispatch without the parent's ready checkpoint");
        const children = await ctx.db.query("tasks").withIndex("by_goal", q => q.eq("goalId", task.goalId)).take(101);
        if (children.length > 100) fail("INVALID_INPUT", "Yield child coverage is incomplete");
        for (const child of children.filter(t => t.parentTaskId === task.id && t.dispatchHeld && t.state === "queued")) await ctx.db.patch(child._id, { dispatchHeld: false });
        await ctx.db.patch(task._id, { ownerRunId: undefined, leaseUntil: undefined, holdRunId: undefined, dispatchHeld: false, state: "waiting_dependencies", reason: "yield_stopped_checkpoint_ready" });
        return { runId: run.id, receipt, releasedAt };
      }
      await ctx.db.patch(task._id, { ownerRunId: undefined, leaseUntil: undefined, holdRunId: task.holdRunId === run.id ? undefined : task.holdRunId, dispatchHeld: !active || (!run.resultAccepted && !neverStarted), state: task.state === "cancelled" ? "cancelled" : !active ? task.state : run.resultAccepted ? "review_ready" : active && neverStarted ? "queued" : task.state === "failed" ? "failed" : "blocked", reason: !active || run.resultAccepted ? task.reason : neverStarted ? "proven_never_started" : "BLOCKED_CHECKPOINT" });
    }
    return { runId: run.id, receipt, releasedAt };
  });
} });

// Time alone does not invalidate reactive reads: bounded durable cron writes revoke expiries.
export const sweep = internalMutation({ args: {}, handler: async ctx => {
  const now = Date.now();
  const expiredCredentials = await ctx.db.query("credentials").withIndex("by_expiry", q => q.lte("expiresAt", now)).take(100);
  // A swept lapse stays distinguishable from a deliberate revocation: stamp the cause without changing any existing denial.
  for (const credential of expiredCredentials) await ctx.db.patch(credential._id, credential.revokedAt === undefined ? { revokedAt: now, lapsedAt: now, expiresAt: Number.MAX_SAFE_INTEGER } : { expiresAt: Number.MAX_SAFE_INTEGER });
  const expiredRuns = await ctx.db.query("runs").withIndex("by_lease", q => q.lte("leaseUntil", now)).take(100);
  for (const run of expiredRuns) {
    if (run.mode === "manual") {
      const task = await taskById(ctx, run.taskId, run.projectId); await revokeGrant(ctx, run);
      // Revoking a manual registration says nothing about its parent harness or managed slots.
      await ctx.db.patch(run._id, { state: ["succeeded", "failed", "stopped"].includes(run.state) ? run.state : "stopped", hold: undefined, leaseUntil: Number.MAX_SAFE_INTEGER, releasedAt: run.releasedAt ?? now, releaseReason: run.releaseReason ?? "manual_registration_expired", releaseReceipt: run.releaseReceipt ?? `manual_expired_${run.id}` });
      if (task.ownerRunId === run.id && task.epoch === run.epoch) {
        const block = ["queued", "reserved", "running", "yielding", "launch_uncertain"].includes(task.state);
        await ctx.db.patch(task._id, { ownerRunId: undefined, leaseUntil: undefined, holdRunId: task.holdRunId === run.id ? undefined : task.holdRunId, state: block ? "blocked" : task.state, reason: block ? "manual_registration_expired_checkpoint_required" : task.reason, dispatchHeld: block || task.state === "blocked" ? true : task.dispatchHeld });
      }
      continue;
    }
    if (["succeeded", "failed", "stopped"].includes(run.state) && !run.capacityHeld) { await ctx.db.patch(run._id, { leaseUntil: Number.MAX_SAFE_INTEGER }); continue; }
    const task = await taskById(ctx, run.taskId, run.projectId); await revokeGrant(ctx, run);
    // No inference that an absent receipt or timed-out stop proves execution ended.
    await ctx.db.patch(run._id, { state: "finalizing", requestedOutcome: run.requestedOutcome ?? "stopped", hold: run.hold ?? (run.process ? "expired_stop_unconfirmed" : "launch_identity_unknown"), leaseUntil: Number.MAX_SAFE_INTEGER });
    if (task.ownerRunId === run.id && task.epoch === run.epoch) await ctx.db.patch(task._id, { state: task.state === "cancelled" ? "cancelled" : run.process ? "blocked" : "launch_uncertain", reason: "lease_expired", holdRunId: run.id, dispatchHeld: true, leaseUntil: undefined });
  }
  return { credentials: expiredCredentials.length, runs: expiredRuns.length, complete: expiredCredentials.length < 100 && expiredRuns.length < 100 };
} });
export const forceClear = mutation({ args: { ...identityArgs, runId: v.string(), reason: v.string(), recoveryAction: v.string() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["human"]);
  return replay(ctx, actor, "lifecycle.forceClear", args, async () => {
    bounded(args.reason, 2048, "override reason"); bounded(args.recoveryAction, 2048, "recovery action");
    const run = await ctx.db.query("runs").withIndex("by_stable_id", q => q.eq("id", args.runId)).unique();
    if (!run || run.projectId !== args.projectId) fail("NOT_FOUND", "Run not found");
    const task = await taskById(ctx, run.taskId, args.projectId); await revokeGrant(ctx, run);
    await ctx.db.patch(run._id, { capacityHeld: false, state: "stopped", releasedAt: Date.now(), releaseReason: `human_override: ${args.reason}; ${args.recoveryAction}`, releaseReceipt: run.releaseReceipt ?? `override_${run.id}`, hold: "human_override_does_not_prove_process_dead", leaseUntil: Number.MAX_SAFE_INTEGER });
    if (task.ownerRunId === run.id && task.epoch === run.epoch) await ctx.db.patch(task._id, { epoch: task.epoch + 1, ownerRunId: undefined, leaseUntil: undefined, holdRunId: undefined, state: task.state === "cancelled" ? "cancelled" : "blocked", dispatchHeld: true, reason: "human_recovery_required" });
    return { runId: run.id, receipt: run.releaseReceipt ?? `override_${run.id}`, override: true, processExitProven: false };
  });
} });

export const requestYield = mutation({ args: { ...runArgs, checkpointId: v.string() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); await boundRun(ctx, args, actor);
  return replay(ctx, actor, "lifecycle.requestYield", args, async () => {
    const { task, run } = await liveRun(ctx, args, actor);
    if (run.mode === "manual" || task.state !== "yielding" || task.latestCheckpointId !== args.checkpointId) fail("BLOCKED_CHECKPOINT", "Supervised yielding requires the latest ready resume point");
    const checkpoint = await ctx.db.query("checkpoints").withIndex("by_stable_id", q => q.eq("id", args.checkpointId)).unique();
    if (!checkpoint || checkpoint.state !== "ready" || checkpoint.runId !== run.id || checkpoint.progressRevision !== task.progressRevision) fail("BLOCKED_CHECKPOINT", "Yield checkpoint does not match current parent progress");
    await ctx.db.patch(run._id, { state: "finalizing", finalizationKind: "yield", requestedOutcome: "stopped", hold: "yield_stop_confirmation_required" });
    await ctx.db.patch(task._id, { dispatchHeld: true, holdRunId: run.id });
    return { taskId: task.id, runId: run.id, state: "finalizing" as const, capacityHeld: true };
  });
} });

export const sweepDependencies = internalMutation({ args: { cursor: v.optional(v.string()), state: v.optional(v.union(v.literal("waiting_dependencies"), v.literal("queued"))) }, handler: async (ctx, args) => {
  const state = args.state ?? "waiting_dependencies";
  const page = await ctx.db.query("tasks").withIndex("by_state", q => q.eq("state", state)).paginate({ cursor: args.cursor ?? null, numItems: 25 });
  const result = await refreshWaiting(ctx, page.page);
  const continuation = makeFunctionReference<"mutation", { cursor?: string; state: "waiting_dependencies" | "queued" }>("lifecycle:sweepDependencies");
  if (!page.isDone) await ctx.scheduler.runAfter(0, continuation, { state, cursor: page.continueCursor });
  else if (state === "waiting_dependencies") await ctx.scheduler.runAfter(0, continuation, { state: "queued" });
  return { ...result, state, complete: page.isDone && state === "queued" };
} });
