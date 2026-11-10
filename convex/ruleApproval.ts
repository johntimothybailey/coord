import type { Doc, MutationCtx } from "./server.js";
import { boundedRecords } from "./messages.js";
import { canonical, digest, fail } from "./auth.js";
/** Shared exact approval transaction; entry points authenticate the human before invoking it. */
export async function approveExactRule(ctx: MutationCtx, project: Doc<"projects">, actor: Doc<"credentials">, args: { memoryId: string; revision: number; hash: string }, approvedAt = Date.now()) {
  if (actor.role !== "human") fail("FORBIDDEN", "Human authority is required");
  const memory = await ctx.db.query("memories").withIndex("by_stable_id", q => q.eq("id", args.memoryId)).unique();
  if (!memory || memory.projectId !== project.id || memory.kind !== "rule" || memory.status !== "proposed" || memory.hash !== args.hash || memory.revision !== args.revision || await digest(canonical({ kind: memory.kind, content: memory.content, sources: memory.sources, applicability: memory.applicability, confidence: memory.confidence })) !== args.hash) fail("FORBIDDEN", "Approval must bind the exact proposed rule revision/hash");
  const records = await ctx.db.query("memories").withIndex("by_project_kind_status", q => q.eq("projectId", project.id).eq("kind", "rule").eq("status", "active")).take(201);
  const approved = records.filter(r => r.kind === "rule" && r.status === "active");
  const result = boundedRecords([...approved, { ...memory, status: "active", approvedBy: actor.memberId, approvedHash: memory.hash, policyVersion: project.policyVersion + 1, approvedAt }], 12 * 1024);
  if (records.length > 200 || !result.complete) fail("COVERAGE_INCOMPLETE", "Approved rules exceed bounded complete briefing capacity");
  const policyVersion = project.policyVersion + 1;
  await ctx.db.patch(memory._id, { status: "active", approvedBy: actor.memberId, approvedHash: memory.hash, policyVersion, approvedAt }); await ctx.db.patch(project._id, { policyVersion });
  return { memoryId: memory.id, revision: memory.revision, policyVersion, hash: memory.hash, approvedBy: actor.memberId, approvedAt };
}
