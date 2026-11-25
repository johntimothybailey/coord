import { v } from "convex/values";
import { authenticate, canonical, digest, fail, identityArgs, integer, replay, stableId } from "./auth.js";
import { mutation, query } from "./server.js";
import type { Doc, QueryCtx } from "./server.js";

const TTL_MS = 5 * 60_000;
// Actor model. requesterUserId is the server-derived signed-in application user who
// asked for this exact approval; requestedBy is the delegated member of the agent that
// acted for them. requesterUserId is OMITTED entirely when no application user is
// identified, and canonical JSON drops absent keys, so every historical envelope, its
// stored digest and its already-issued approval link stay byte-identical.
const envelope = (record: Doc<"approvalRequests">) => {
  const { schemaVersion, id, action, backendId, projectId, repository, remote, defaultBranch, memoryId, revision, hash, requestedBy, requesterUserId, createdAt, expiresAt } = record;
  return { schemaVersion, id, action, backendId, projectId, repository, remote, defaultBranch, memoryId, revision, hash, requestedBy, ...(requesterUserId === undefined ? {} : { requesterUserId }), createdAt, expiresAt };
};
// Displayed and enforced consistently: an unidentified historical or legacy record is
// never presented as owned by a person, and a shared delegated member never stands in
// for one. Ownership of such a record stays with the project human.
function requesterOf(record: Doc<"approvalRequests">) {
  const identified = record.requesterUserId !== undefined;
  return { userId: record.requesterUserId ?? null, identified, actingMemberId: record.requestedBy, attribution: identified ? "signed_in_person" as const : "delegated_member_only" as const };
}
/** True when this caller is the person who made the request. A record that identifies
 *  no person can only be owned by a caller that also identifies none, which is the
 *  preserved legacy delegated-member rule. */
function ownsRequest(record: Doc<"approvalRequests">, actor: Doc<"credentials">, personUserId: string | undefined): boolean {
  return record.requesterUserId === undefined
    ? personUserId === undefined && actor.memberId === record.requestedBy
    : personUserId === record.requesterUserId;
}
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
  return { envelope: envelope(record), requestDigest: record.requestDigest, state, requester: requesterOf(record), ...(record.decidedAt === undefined ? {} : { decidedBy: record.decidedBy, decidedAt: record.decidedAt, approvedBy: record.state === "approved" ? record.decidedBy : null, approvedAt: record.state === "approved" ? record.decidedAt : null, policyVersion: record.approvedPolicyVersion ?? null }), ...(record.cancelledAt === undefined ? {} : { cancelledAt: record.cancelledAt, cancelledBy: record.cancelledBy }), receipt: state === "approved" || state === "denied" ? "authenticated_rule_decision" : "pending_request_only", authorityGranted: state === "approved", approved: state === "approved", authorization: state === "approved" || state === "denied" ? "verified_passkey" : "passkey_required" };
}

export type ApprovalRequestView = Awaited<ReturnType<typeof requestView>>;

/** Prepare an exact handoff, never an approval. Replays read current state without renewing the envelope. */
export const requestRule = mutation({ args: { ...identityArgs, memoryId: v.string(), revision: v.number(), hash: v.string() }, handler: async (ctx, args) => {
  const { actor, project, personUserId } = await authenticate(ctx, args, ["agent", "human"], "approvalRequests.requestRule");
  const id = await replay(ctx, actor, "approvalRequests.requestRule", args, async () => {
    stableId(args.memoryId); integer(args.revision, 1, Number.MAX_SAFE_INTEGER);
    if (!/^[a-f0-9]{64}$/.test(args.hash)) fail("INVALID_INPUT", "An exact rule content hash is required");
    if (!await currentRule(ctx, project.id, args)) fail("FORBIDDEN", "Only the exact current proposed rule can be requested");
    if (await ctx.db.query("approvalRequests").withIndex("by_stable_id", q => q.eq("id", args.requestId)).unique()) fail("IDEMPOTENCY_CONFLICT", "Approval request identity is already used");
    const createdAt = Date.now();
    const value = { schemaVersion: 1 as const, id: args.requestId, action: "approve_rule" as const, backendId: project.backendId, projectId: project.id, repository: project.repository, remote: project.remote, defaultBranch: project.defaultBranch, memoryId: args.memoryId, revision: args.revision, hash: args.hash, requestedBy: actor.memberId, ...(personUserId === undefined ? {} : { requesterUserId: personUserId }), createdAt, expiresAt: createdAt + TTL_MS };
    if (new TextEncoder().encode(canonical(value)).length > 8 * 1024) fail("COVERAGE_INCOMPLETE", "Approval request envelope exceeds its display budget");
    await ctx.db.insert("approvalRequests", { ...value, requestDigest: await digest(canonical(value)), state: "pending" });
    return value.id;
  });
  return requestView(ctx, project, await readRequest(ctx, project, id));
} });
export const get = query({ args: { ...identityArgs, approvalRequestId: v.string() }, handler: async (ctx, args) => {
  const { project } = await authenticate(ctx, args, ["agent", "human"], "approvalRequests.get");
  return requestView(ctx, project, await readRequest(ctx, project, args.approvalRequestId));
} });
export const cancel = mutation({ args: { ...identityArgs, approvalRequestId: v.string() }, handler: async (ctx, args) => {
  const { actor, project, personUserId } = await authenticate(ctx, args, ["agent", "human"], "approvalRequests.cancel");
  await replay(ctx, actor, "approvalRequests.cancel", args, async () => {
    const record = await readRequest(ctx, project, args.approvalRequestId);
    // An authorized project human may always cancel. Otherwise ownership is the exact
    // person who asked, so two people sharing one source agent cannot withdraw each
    // other's request and no shared member stands for an unidentified older record.
    if (actor.role !== "human" && !ownsRequest(record, actor, personUserId)) fail("FORBIDDEN", "Only the person who made this request, or a project human, can cancel it");
    if (record.state === "approved" || record.state === "denied") fail("FORBIDDEN", "A completed human decision cannot be cancelled");
    if (record.state !== "cancelled") await ctx.db.patch(record._id, { state: "cancelled", cancelledBy: actor.memberId, cancelledAt: Date.now() });
    return record.id;
  });
  return requestView(ctx, project, await readRequest(ctx, project, args.approvalRequestId));
} });
