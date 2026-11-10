import { v } from "convex/values";
import { identityArgs, authenticate, replay, fail, paths, path, integer } from "./auth.js";
import { mutation, query } from "./server.js";
export const status = query({ args: identityArgs, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["agent", "human", "run"]);
  if (actor.role === "run") fail("FORBIDDEN", "Use task-scoped check-in for run context");
  const goals = await ctx.db.query("goals").withIndex("by_project", q => q.eq("projectId", project.id)).take(51);
  const reservations = await ctx.db.query("runs").withIndex("by_project_capacity", q => q.eq("projectId", project.id).eq("capacityHeld", true)).take(101);
  return { project, goals: goals.slice(0, 50), goalsComplete: goals.length <= 50, reservations: reservations.slice(0, 100), reservationsComplete: reservations.length <= 100 };
} });
export const configure = mutation({ args: { ...identityArgs, repository: v.string(), remote: v.string(), defaultBranch: v.string(), allowedPaths: v.array(v.string()), excludedPaths: v.array(v.string()), ruleTargets: v.array(v.string()), sharingApproved: v.boolean(), capturePolicyDigest: v.optional(v.string()), expectedConfigVersion: v.optional(v.number()), capacity: v.number(), taskCap: v.number() }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["human"]);
  return replay(ctx, actor, "projects.configure", args, async () => {
    if (args.expectedConfigVersion !== undefined && (!Number.isSafeInteger(args.expectedConfigVersion) || args.expectedConfigVersion < 0 || args.expectedConfigVersion !== (project.configVersion ?? 0))) fail("IDEMPOTENCY_CONFLICT", "Project configuration changed; review the current policy before approving again");
    paths(args.allowedPaths); for (const p of args.excludedPaths) path(p); for (const p of args.ruleTargets) path(p);
    if (args.capturePolicyDigest !== undefined && !/^[a-f0-9]{64}$/.test(args.capturePolicyDigest)) fail("INVALID_INPUT", "Invalid capture policy digest");
    integer(args.capacity, 1, 100); integer(args.taskCap, 1, 100);
    if (args.repository !== project.repository || args.remote !== project.remote || args.defaultBranch !== project.defaultBranch) fail("NEEDS_HUMAN", "Repository rerouting requires a separate project and local protected trust approval");
    await ctx.db.patch(project._id, { allowedPaths: args.allowedPaths, excludedPaths: args.excludedPaths, ruleTargets: args.ruleTargets, sharingApproved: args.sharingApproved, capturePolicyDigest: args.capturePolicyDigest ?? project.capturePolicyDigest, capacity: args.capacity, taskCap: args.taskCap, configVersion: (project.configVersion ?? 0) + 1, policyVersion: project.policyVersion + 1 });
    return { projectId: project.id, configVersion: (project.configVersion ?? 0) + 1, policyVersion: project.policyVersion + 1 };
  });
} });
