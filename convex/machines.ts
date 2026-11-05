import { v } from "convex/values";
import { requireCapability } from "../src/protocol.js";
import { capabilityKey, capabilityCheck } from "./schema.js";
import { internalMutation } from "./server.js";
import { stableId, tokenFormat, digest, fail, bounded, integer } from "./auth.js";

// Qualification is an operator/owner operation, never an agent-reported PASS endpoint.
// Real host evidence still has to be gathered and independently qualified outside Convex.
export const provisionQualification = internalMutation({ args: { backendId: v.string(), projectId: v.string(), memberId: v.string(), machineId: v.string(), capacity: v.number(), modes: v.array(v.union(v.literal("manual"), v.literal("managed"))), key: capabilityKey, checks: v.array(capabilityCheck), evidenceRef: v.string(), expiresAt: v.number(), supervisorId: v.string(), supervisorToken: v.string(), artifactVerifierId: v.string(), artifactVerifierToken: v.string() }, handler: async (ctx, args) => {
  stableId(args.machineId); stableId(args.supervisorId); stableId(args.artifactVerifierId); tokenFormat(args.artifactVerifierToken); stableId(args.memberId); tokenFormat(args.supervisorToken); bounded(args.evidenceRef, 2048, "qualification evidence"); integer(args.capacity, 1, 100);
  const project = await ctx.db.query("projects").withIndex("by_stable_id", q => q.eq("id", args.projectId)).unique();
  const member = await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", args.memberId)).unique();
  if (!project || project.configVersion === undefined || project.backendId !== args.backendId || !member || member.role !== "agent" || member.backendId !== args.backendId || !member.projectIds.includes(project.id) || member.revokedAt !== undefined || member.expiresAt <= Date.now()) fail("FORBIDDEN", "Qualification member/project mismatch");
  if (!args.modes.length || args.modes.length > 2 || args.checks.length > 100 || args.expiresAt <= Date.now() || args.expiresAt > Date.now() + 24 * 3600_000) fail("INVALID_INPUT", "Invalid qualification bounds");
  for (const check of args.checks) if (!Number.isFinite(Date.parse(check.observedAt)) || Date.parse(check.observedAt) > Date.now() || Date.parse(check.observedAt) < Date.now() - 24 * 3600_000 || !check.evidenceRef || check.command.length > 64 || check.command.some(c => c.length > 2048) || check.summary.length > 4096) fail("INVALID_INPUT", "Qualification requires recent bounded evidence references");
  try { for (const mode of args.modes) requireCapability({ key: args.key, checks: args.checks }, args.key, mode); } catch { fail("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Missing real passing qualification checks"); }
  if (args.supervisorId === args.artifactVerifierId || args.supervisorToken === args.artifactVerifierToken) fail("INVALID_INPUT", "Artifact verification and supervision credentials must be independent");
  const tokenDigest = await digest(args.supervisorToken), verifierDigest = await digest(args.artifactVerifierToken);
  if (await ctx.db.query("credentials").withIndex("by_digest", q => q.eq("digest", tokenDigest)).unique() || await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", args.supervisorId)).unique()) fail("IDEMPOTENCY_CONFLICT", "Supervisor credential already exists");
  if (await ctx.db.query("credentials").withIndex("by_digest", q => q.eq("digest", verifierDigest)).unique() || await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", args.artifactVerifierId)).unique()) fail("IDEMPOTENCY_CONFLICT", "Artifact verifier credential already exists");
  const machine = { id: args.machineId, projectId: args.projectId, memberId: member.memberId, capacity: args.capacity, capabilityDigest: await digest(JSON.stringify(args.key)), qualifiedModes: args.modes, qualificationExpiresAt: args.expiresAt, configVersion: project.configVersion, policyVersion: project.policyVersion, heartbeatAt: Date.now(), capabilityKey: args.key, capabilityChecks: args.checks, qualificationEvidenceRef: args.evidenceRef };
  const old = await ctx.db.query("machines").withIndex("by_id_project", q => q.eq("id", args.machineId).eq("projectId", args.projectId)).unique();
  if (old) await ctx.db.replace(old._id, machine); else await ctx.db.insert("machines", machine);
  await ctx.db.insert("credentials", { id: args.supervisorId, backendId: args.backendId, memberId: member.memberId, digest: tokenDigest, role: "supervisor", projectIds: [project.id], machineId: machine.id, expiresAt: args.expiresAt });
  await ctx.db.insert("credentials", { id: args.artifactVerifierId, backendId: args.backendId, memberId: member.memberId, digest: verifierDigest, role: "artifact_verifier", projectIds: [project.id], machineId: machine.id, expiresAt: args.expiresAt });
  return { machineId: machine.id, projectId: project.id, qualifiedModes: args.modes, expiresAt: args.expiresAt };
} });
