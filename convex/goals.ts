import { v } from "convex/values";
import { mutation } from "./server.js";
import { identityArgs, authenticate, replay, fail, bounded, stableId, integer, digest, canonical, revokeGrant } from "./auth.js";
export const propose = mutation({ args: { ...identityArgs, goalId: v.string(), expectedRevision: v.number(), content: v.string(), taskLimit: v.number(), runTimeoutMs: v.number() }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["agent", "human"]);
  return replay(ctx, actor, "goals.propose", args, async () => {
    stableId(args.goalId); bounded(args.content, 32 * 1024, "goal content"); integer(args.taskLimit, 1, project.taskCap); integer(args.runTimeoutMs, 60_000, 24 * 3600_000);
    const old = await ctx.db.query("goals").withIndex("by_stable_id", q => q.eq("id", args.goalId)).unique();
    if (old && (old.projectId !== args.projectId || old.state !== "draft" || old.revision !== args.expectedRevision)) fail("FORBIDDEN", "Only the current draft revision can be edited");
    if (!old && args.expectedRevision !== 0) fail("INVALID_INPUT", "New goal requires revision zero");
    const revision = args.expectedRevision + 1; const hash = await digest(canonical({ content: args.content, taskLimit: args.taskLimit, runTimeoutMs: args.runTimeoutMs }));
    const goal = { id: args.goalId, projectId: args.projectId, revision, content: args.content, hash, state: "draft" as const, taskLimit: args.taskLimit, runTimeoutMs: args.runTimeoutMs };
    if (old) await ctx.db.replace(old._id, goal); else await ctx.db.insert("goals", goal);
    return { goalId: args.goalId, revision, hash };
  });
} });
export const approve = mutation({ args: { ...identityArgs, goalId: v.string(), revision: v.number(), hash: v.string() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["human"]);
  return replay(ctx, actor, "goals.approve", args, async () => {
    const goal = await ctx.db.query("goals").withIndex("by_stable_id", q => q.eq("id", args.goalId)).unique();
    if (!goal || goal.projectId !== args.projectId || goal.state !== "draft" || goal.revision !== args.revision || goal.hash !== args.hash || await digest(canonical({ content: goal.content, taskLimit: goal.taskLimit, runTimeoutMs: goal.runTimeoutMs })) !== args.hash) fail("GOAL_NOT_APPROVED", "Approval must bind the exact current draft revision and hash");
    const approvedAt = Date.now();
    await ctx.db.patch(goal._id, { state: "active", approvedBy: actor.memberId, approvedHash: args.hash, approvedAt });
    return { goalId: goal.id, revision: goal.revision, hash: goal.hash, state: "active" as const, approvedBy: actor.memberId, approvedAt };
  });
} });
export const control = mutation({ args: { ...identityArgs, goalId: v.string(), state: v.union(v.literal("paused"), v.literal("cancelled")) }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["human"]);
  return replay(ctx, actor, "goals.control", args, async () => {
    const goal = await ctx.db.query("goals").withIndex("by_stable_id", q => q.eq("id", args.goalId)).unique();
    if (!goal || goal.projectId !== args.projectId) fail("NOT_FOUND", "Goal not found");
    if (goal.state === "cancelled" && args.state !== "cancelled") fail("FORBIDDEN", "Cancelled goals cannot resume");
    const tasks = await ctx.db.query("tasks").withIndex("by_goal", q => q.eq("goalId", goal.id)).take(101);
    if (tasks.length > 100) fail("INVALID_INPUT", "Goal exceeds bounded task limit");
    await ctx.db.patch(goal._id, { state: args.state });
    for (const task of tasks) {
      if (task.ownerRunId) {
        const run = await ctx.db.query("runs").withIndex("by_stable_id", q => q.eq("id", task.ownerRunId!)).unique();
        if (run) { await revokeGrant(ctx, run); await ctx.db.patch(run._id, { state: "finalizing", requestedOutcome: "stopped", hold: run.capacityHeld ? "stop_confirmation_required" : undefined }); }
      }
      if (args.state === "cancelled" || task.ownerRunId) await ctx.db.patch(task._id, { state: args.state === "cancelled" ? "cancelled" : "blocked", reason: `goal_${args.state}`, holdRunId: task.ownerRunId, dispatchHeld: true, leaseUntil: undefined });
    }
    return { goalId: goal.id, state: args.state };
  });
} });

export const resume = mutation({ args: { ...identityArgs, goalId: v.string(), revision: v.number(), hash: v.string() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["human"]);
  return replay(ctx, actor, "goals.resume", args, async () => {
    const goal = await ctx.db.query("goals").withIndex("by_stable_id", q => q.eq("id", args.goalId)).unique();
    if (!goal || goal.projectId !== args.projectId || goal.state !== "paused" || goal.revision !== args.revision || goal.hash !== args.hash || goal.approvedHash !== args.hash || !goal.approvedBy) fail("GOAL_NOT_APPROVED", "Resume requires the exact previously approved paused goal");
    await ctx.db.patch(goal._id, { state: "active" }); return { goalId: goal.id, state: "active" as const, revision: goal.revision };
  });
} });
