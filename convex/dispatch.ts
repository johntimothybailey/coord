import { v } from "convex/values";
import { query } from "./server.js";
import { identityArgs, authenticate, fail, approvedGoal } from "./auth.js";
import { dependenciesReady, noConflicts, validateScope } from "./tasks.js";
import { capabilityKey } from "./schema.js";
import { requireCapability } from "../src/protocol.js";

/** Reactive candidate discovery is advisory; tasks.claim repeats all admission checks atomically. */
export const runnable = query({ args: { ...identityArgs, machineId: v.string(), capabilityKey }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["agent"]);
  const machine = await ctx.db.query("machines").withIndex("by_id_project", q => q.eq("id", args.machineId).eq("projectId", project.id)).unique();
  if (!machine || machine.memberId !== actor.memberId || !machine.capabilityKey || !machine.capabilityChecks || machine.qualificationExpiresAt <= Date.now() || project.configVersion === undefined || machine.configVersion !== project.configVersion || !machine.qualifiedModes.includes("managed")) fail("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Machine has no current managed qualification");
  requireCapability({ key: machine.capabilityKey, checks: machine.capabilityChecks }, args.capabilityKey, "managed");
  const queued = await ctx.db.query("tasks").withIndex("by_project_state", q => q.eq("projectId", project.id).eq("state", "queued")).take(101);
  const replans = await ctx.db.query("tasks").withIndex("by_project_state", q => q.eq("projectId", project.id).eq("state", "replan_requested")).take(101);
  const held = await ctx.db.query("runs").withIndex("by_project_capacity", q => q.eq("projectId", project.id).eq("capacityHeld", true)).take(project.capacity + 1);
  const machineHeld = await ctx.db.query("runs").withIndex("by_machine_capacity", q => q.eq("machineId", machine.id).eq("capacityHeld", true)).take(machine.capacity + 1);
  const complete = queued.length <= 100 && replans.length <= 100;
  const slots = Math.max(0, Math.min(project.capacity - held.length, machine.capacity - machineHeld.length));
  const candidates = [];
  if (complete && slots > 0 && project.sharingApproved) for (const task of [...queued, ...replans].sort((a, b) => a._creationTime - b._creationTime || a.id.localeCompare(b.id))) {
    if (task.holdRunId || task.dispatchHeld || task.ownerRunId) continue;
    try {
      validateScope(project, task.scope); await approvedGoal(ctx, task); await noConflicts(ctx, task, true);
      if (task.state !== "replan_requested") await dependenciesReady(ctx, task);
      if (task.state === "replan_requested" && task.replanAttempts >= 2) continue;
      candidates.push({ taskId: task.id, epoch: task.epoch, goalRevision: task.goalRevision, mode: task.state === "replan_requested" ? "replan" : "managed", executionBase: task.executionBase, checkpointId: task.latestCheckpointId ?? null });
    } catch { /* Admission blockers remain in the authoritative task; never infer eligibility on error. */ }
  }
  return { candidates, slots, complete, policyVersion: project.policyVersion };
} });
