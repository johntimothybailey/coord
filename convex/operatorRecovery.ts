import { v } from "convex/values";
import { internalMutation, internalQuery } from "./server.js";
import type { QueryCtx } from "./server.js";
import { canonical, digest, fail, stableId } from "./auth.js";

const selection = { backendId: v.string(), projectId: v.string(), repository: v.string(), remote: v.string(), defaultBranch: v.string(), memberId: v.string(), replacedCredentialId: v.string() };
async function selected(ctx: Pick<QueryCtx, "db">, args: { backendId: string; projectId: string; repository: string; remote: string; defaultBranch: string; memberId: string; replacedCredentialId: string }) {
  for (const id of [args.backendId, args.projectId, args.memberId, args.replacedCredentialId]) stableId(id);
  const metadata = await ctx.db.query("metadata").withIndex("by_backend", q => q.eq("backendId", args.backendId)).unique();
  const project = await ctx.db.query("projects").withIndex("by_stable_id", q => q.eq("id", args.projectId)).unique();
  const old = await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", args.replacedCredentialId)).unique();
  if (!metadata || !project || project.backendId !== args.backendId || project.repository !== args.repository || project.remote !== args.remote || project.defaultBranch !== args.defaultBranch || !old || old.role !== "human" || old.backendId !== args.backendId || old.memberId !== args.memberId || old.projectIds.length !== 1 || old.projectIds[0] !== args.projectId || old.machineId !== undefined || old.runId !== undefined) fail("FORBIDDEN", "Recovery must select the exact existing project and single-project human authority");
  return old;
}
/** Deployment-owner inspection only. Never returns a credential digest, token or browser key. */
export const inspect = internalQuery({ args: selection, handler: async (ctx, args) => {
  const old = await selected(ctx, args);
  return { ...args, expiresAt: old.expiresAt, revoked: old.revokedAt !== undefined };
} });

/** Owner-only break-glass rotation, never a public endpoint or agent tool. */
export const recover = internalMutation({ args: { ...selection, recoveryId: v.string(), credentialId: v.string(), credentialDigest: v.string(), expiresAt: v.number() }, handler: async (ctx, args) => {
  const old = await selected(ctx, args); stableId(args.recoveryId); stableId(args.credentialId);
  if (args.credentialId !== `recovered_${args.recoveryId}` || args.credentialId === old.id || !/^[a-f0-9]{64}$/.test(args.credentialDigest) || !Number.isSafeInteger(args.expiresAt)) fail("INVALID_INPUT", "Invalid recovery binding");
  const payloadHash = await digest(canonical(args));
  const prior = await ctx.db.query("idempotency").withIndex("by_request", q => q.eq("credentialId", "deployment-owner").eq("operation", "operatorRecovery.recover").eq("requestId", args.recoveryId)).unique();
  const replacement = await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", args.credentialId)).unique();
  if (prior) {
    if (prior.payloadHash !== payloadHash) fail("IDEMPOTENCY_CONFLICT", "Recovery identity already binds another operation");
    const receipt = JSON.parse(prior.resultJson) as { recoveredAt: number };
    if (!replacement || replacement.revokedAt !== undefined || replacement.expiresAt <= Date.now() || replacement.digest !== args.credentialDigest || replacement.backendId !== args.backendId || replacement.memberId !== args.memberId || replacement.role !== "human" || replacement.machineId !== undefined || replacement.runId !== undefined || canonical(replacement.projectIds) !== canonical([args.projectId]) || replacement.expiresAt !== args.expiresAt || old.revokedAt !== receipt.recoveredAt) fail("FORBIDDEN", "Recorded recovery authority has changed; recovery cannot revive it");
    return JSON.parse(prior.resultJson) as { recoveryId: string; credentialId: string; replacedCredentialId: string; memberId: string; projectId: string; expiresAt: number; recoveredAt: number };
  }
  const now = Date.now();
  if (old.revokedAt !== undefined || replacement || args.expiresAt <= now || args.expiresAt > now + 365 * 86400_000 || (old.expiresAt > now && args.expiresAt > old.expiresAt) || await ctx.db.query("credentials").withIndex("by_digest", q => q.eq("digest", args.credentialDigest)).unique()) fail("FORBIDDEN", "Recovery cannot replace revoked authority, collide or extend a still-valid grant");
  await ctx.db.insert("credentials", { id: args.credentialId, backendId: args.backendId, memberId: old.memberId, role: "human", projectIds: [args.projectId], digest: args.credentialDigest, expiresAt: args.expiresAt });
  await ctx.db.patch(old._id, { revokedAt: now });
  const receipt = { recoveryId: args.recoveryId, credentialId: args.credentialId, replacedCredentialId: old.id, memberId: old.memberId, projectId: args.projectId, expiresAt: args.expiresAt, recoveredAt: now };
  await ctx.db.insert("idempotency", { credentialId: "deployment-owner", operation: "operatorRecovery.recover", requestId: args.recoveryId, payloadHash, resultJson: JSON.stringify(receipt) });
  await ctx.db.insert("audit", { projectId: args.projectId, actorId: "deployment-owner", operation: "operatorRecovery.recover", requestId: args.recoveryId, recordId: args.credentialId, detail: `replaced ${old.id}`, at: now });
  return receipt;
} });
