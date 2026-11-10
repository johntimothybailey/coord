import { v } from "convex/values";
import { authenticate, canonical, digest, fail, identityArgs, integer, replay, stableId } from "./auth.js";
import { mutation, query } from "./server.js";
import type { Doc, QueryCtx } from "./server.js";

const TTL_MS = 5 * 60_000;
const envelope = (record: Doc<"approvalRequests">) => {
  const { schemaVersion, id, action, backendId, projectId, repository, remote, defaultBranch, memoryId, revision, hash, requestedBy, createdAt, expiresAt } = record;
  return { schemaVersion, id, action, backendId, projectId, repository, remote, defaultBranch, memoryId, revision, hash, requestedBy, createdAt, expiresAt };
};
export async function currentRule(ctx: Pick<QueryCtx, "db">, projectId: string, target: { memoryId: string; revision: number; hash: string }): Promise<boolean> {
  const rule = await ctx.db.query("memories").withIndex("by_stable_id", q => q.eq("id", target.memoryId)).unique();
  return !!rule && rule.projectId === projectId && rule.kind === "rule" && rule.status === "proposed" && rule.revision === target.revision && rule.hash === target.hash && await digest(canonical({ kind: rule.kind, content: rule.content, sources: rule.sources, applicability: rule.applicability, confidence: rule.confidence })) === target.hash;
}
export async function readRequest(ctx: Pick<QueryCtx, "db">, project: Doc<"projects">, id: string): Promise<Doc<"approvalRequests">> {
  stableId(id);
  const record = await ctx.db.query("approvalRequests").withIndex("by_stable_id", q => q.eq("id", id)).unique();
  if (!record || record.backendId !== project.backendId || record.projectId !== project.id) fail("NOT_FOUND", "Approval request is unavailable in this project");
  if (await digest(canonical(envelope(record))) !== record.requestDigest) fail("BLOCKED_ENV", "Approval request envelope is inconsistent");
  return record;
}
export async function requestView(ctx: Pick<QueryCtx, "db">, project: Doc<"projects">, record: Doc<"approvalRequests">) {
  const state = record.state === "approved" || record.state === "denied" ? record.state : record.state === "cancelled" ? "cancelled" : record.expiresAt <= Date.now() ? "expired"
    : record.repository !== project.repository || record.remote !== project.remote || record.defaultBranch !== project.defaultBranch || !await currentRule(ctx, project.id, record) ? "stale" : "pending";
  return { envelope: envelope(record), requestDigest: record.requestDigest, state, ...(record.decidedAt === undefined ? {} : { decidedBy: record.decidedBy, decidedAt: record.decidedAt, approvedBy: record.state === "approved" ? record.decidedBy : null, approvedAt: record.state === "approved" ? record.decidedAt : null, policyVersion: record.approvedPolicyVersion ?? null }), ...(record.cancelledAt === undefined ? {} : { cancelledAt: record.cancelledAt, cancelledBy: record.cancelledBy }), receipt: state === "approved" || state === "denied" ? "authenticated_rule_decision" : "pending_request_only", authorityGranted: state === "approved", approved: state === "approved", authorization: state === "approved" || state === "denied" ? "verified_passkey" : "passkey_required" };
}

export type ApprovalRequestView = Awaited<ReturnType<typeof requestView>>;

/** Prepare an exact handoff, never an approval. Replays read current state without renewing the envelope. */
export const requestRule = mutation({ args: { ...identityArgs, memoryId: v.string(), revision: v.number(), hash: v.string() }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["agent", "human"]);
  const id = await replay(ctx, actor, "approvalRequests.requestRule", args, async () => {
    stableId(args.memoryId); integer(args.revision, 1, Number.MAX_SAFE_INTEGER);
    if (!/^[a-f0-9]{64}$/.test(args.hash)) fail("INVALID_INPUT", "An exact rule content hash is required");
    if (!await currentRule(ctx, project.id, args)) fail("FORBIDDEN", "Only the exact current proposed rule can be requested");
    if (await ctx.db.query("approvalRequests").withIndex("by_stable_id", q => q.eq("id", args.requestId)).unique()) fail("IDEMPOTENCY_CONFLICT", "Approval request identity is already used");
    const createdAt = Date.now();
    const value = { schemaVersion: 1 as const, id: args.requestId, action: "approve_rule" as const, backendId: project.backendId, projectId: project.id, repository: project.repository, remote: project.remote, defaultBranch: project.defaultBranch, memoryId: args.memoryId, revision: args.revision, hash: args.hash, requestedBy: actor.memberId, createdAt, expiresAt: createdAt + TTL_MS };
    if (new TextEncoder().encode(canonical(value)).length > 8 * 1024) fail("COVERAGE_INCOMPLETE", "Approval request envelope exceeds its display budget");
    await ctx.db.insert("approvalRequests", { ...value, requestDigest: await digest(canonical(value)), state: "pending" });
    return value.id;
  });
  return requestView(ctx, project, await readRequest(ctx, project, id));
} });
export const get = query({ args: { ...identityArgs, approvalRequestId: v.string() }, handler: async (ctx, args) => {
  const { project } = await authenticate(ctx, args, ["agent", "human"]);
  return requestView(ctx, project, await readRequest(ctx, project, args.approvalRequestId));
} });
export const cancel = mutation({ args: { ...identityArgs, approvalRequestId: v.string() }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["agent", "human"]);
  await replay(ctx, actor, "approvalRequests.cancel", args, async () => {
    const record = await readRequest(ctx, project, args.approvalRequestId);
    if (actor.role !== "human" && actor.memberId !== record.requestedBy) fail("FORBIDDEN", "Only the requester or a project human can cancel this request");
    if (record.state === "approved" || record.state === "denied") fail("FORBIDDEN", "A completed human decision cannot be cancelled");
    if (record.state !== "cancelled") await ctx.db.patch(record._id, { state: "cancelled", cancelledBy: actor.memberId, cancelledAt: Date.now() });
    return record.id;
  });
  return requestView(ctx, project, await readRequest(ctx, project, args.approvalRequestId));
} });
