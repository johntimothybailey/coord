import { v } from "convex/values";
import { authenticate, authorizeActor, canonical, digest, fail, identityArgs, replay, stableId } from "./auth.js";
import { mutation, query, internalMutation, internalQuery } from "./server.js";
import type { Doc, MutationCtx, QueryCtx } from "./server.js";
import { currentRule, readRequest, requestView } from "./approvalRequests.js";
import { approveExactRule } from "./ruleApproval.js";
import { CLIENT_VERSION, CAPABILITIES, PROTOCOL_VERSION } from "../src/protocol.js";
import { decode64, passkeyFingerprint, randomChallenge, trustedApprovalOrigin, verifyPasskey, encode64 } from "../src/passkeys.js";
import type { PasskeyAssertion } from "../src/passkeys.js";

export const assertionArgs = v.object({ credentialId: v.string(), clientDataJSON: v.string(), authenticatorData: v.string(), signature: v.string(), userHandle: v.optional(v.union(v.string(), v.null())) });
const phaseArgs = v.union(v.literal("review"), v.literal("approve"), v.literal("deny"));
export function siteOrigin(): string { return trustedApprovalOrigin(process.env.CONVEX_SITE_URL ?? process.env.COORD_APPROVAL_ORIGIN); }
const identityFor = (record: { backendId: string; projectId: string; id: string }) => ({ backendId: record.backendId, projectId: record.projectId, requestId: record.id, protocolVersion: PROTOCOL_VERSION, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES] });
async function humanFor(ctx: Pick<QueryCtx, "db">, record: { backendId: string; projectId: string; id: string }, credentialId: string) {
  const actor = await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", credentialId)).unique();
  return authorizeActor(ctx, identityFor(record), actor, ["human"]);
}
async function userHandle(record: { backendId: string; projectId: string; memberId: string }): Promise<string> { const hex = await digest(`${record.backendId}:${record.projectId}:${record.memberId}`); return encode64(Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16))); }
function enrollmentBinding(record: Doc<"approvalEnrollments">): string { return canonical({ enrollmentId: record.id, backendId: record.backendId, projectId: record.projectId, memberId: record.memberId, origin: record.origin }); }
async function enrollment(ctx: Pick<QueryCtx, "db">, id: string) {
  stableId(id);
  const record = await ctx.db.query("approvalEnrollments").withIndex("by_stable_id", q => q.eq("id", id)).unique();
  if (!record || record.expiresAt <= Date.now() || record.origin !== siteOrigin()) fail("FORBIDDEN", "Enrollment is unavailable");
  const { actor } = await humanFor(ctx, record, record.humanCredentialId);
  if (actor.memberId !== record.memberId) fail("FORBIDDEN", "Enrollment operator identity changed");
  return record;
}
export const beginEnrollment = mutation({ args: { ...identityArgs, enrollmentId: v.string() }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["human"]);
  const id = await replay(ctx, actor, "approvalAuth.beginEnrollment", args, async () => {
    stableId(args.enrollmentId);
    if (await ctx.db.query("approvalEnrollments").withIndex("by_stable_id", q => q.eq("id", args.enrollmentId)).unique()) fail("IDEMPOTENCY_CONFLICT", "Enrollment identity already used");
    const createdAt = Date.now();
    await ctx.db.insert("approvalEnrollments", { id: args.enrollmentId, backendId: project.backendId, projectId: project.id, humanCredentialId: actor.id, memberId: actor.memberId, origin: siteOrigin(), challenge: randomChallenge(), createdAt, expiresAt: createdAt + 10 * 60_000 });
    return args.enrollmentId;
  });
  const record = await enrollment(ctx, id);
  return { enrollmentId: id, memberId: record.memberId, url: `${record.origin}/approval?enrollment=${encodeURIComponent(id)}`, expiresAt: record.expiresAt };
} });
export const enrollmentStatus = query({ args: { ...identityArgs, enrollmentId: v.string() }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["human"]); const record = await enrollment(ctx, args.enrollmentId);
  if (record.projectId !== project.id || record.humanCredentialId !== actor.id) fail("FORBIDDEN", "Enrollment belongs to another operator");
  return { enrollmentId: record.id, memberId: record.memberId, fingerprint: record.fingerprint ?? null, credentialId: record.credentialId ?? null, enrolled: record.enrolledAt !== undefined, expiresAt: record.expiresAt };
} });
export const finishEnrollment = mutation({ args: { ...identityArgs, enrollmentId: v.string(), fingerprint: v.string() }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["human"]);
  return replay(ctx, actor, "approvalAuth.finishEnrollment", args, async () => {
    const record = await enrollment(ctx, args.enrollmentId);
    if (record.projectId !== project.id || record.humanCredentialId !== actor.id || !record.credentialId || !record.publicKeySpki || !record.fingerprint || record.fingerprint !== args.fingerprint || record.signCount === undefined) fail("FORBIDDEN", "Exact browser key fingerprint must be confirmed by this operator");
    const old = await ctx.db.query("approvalPasskeys").withIndex("by_credential", q => q.eq("id", record.credentialId!)).unique();
    if (old) fail("IDEMPOTENCY_CONFLICT", "Passkey is already registered");
    const createdAt = Date.now();
    await ctx.db.insert("approvalPasskeys", { id: record.credentialId, backendId: record.backendId, projectId: record.projectId, humanCredentialId: actor.id, memberId: actor.memberId, origin: record.origin, publicKeySpki: record.publicKeySpki, signCount: record.signCount, createdAt });
    await ctx.db.patch(record._id, { enrolledAt: createdAt });
    return { credentialId: record.credentialId, memberId: actor.memberId, fingerprint: record.fingerprint, enrolledAt: createdAt };
  });
} });
export const revokePasskey = mutation({ args: { ...identityArgs, credentialId: v.string() }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["human"]);
  return replay(ctx, actor, "approvalAuth.revokePasskey", args, async () => {
    const key = await ctx.db.query("approvalPasskeys").withIndex("by_credential", q => q.eq("id", args.credentialId)).unique();
    if (!key || key.projectId !== project.id || key.memberId !== actor.memberId) fail("FORBIDDEN", "Passkey does not belong to this human");
    if (key.revokedAt === undefined) await ctx.db.patch(key._id, { revokedAt: Date.now() });
    return { credentialId: key.id, revoked: true };
  });
} });
export const enrollmentOptions = internalQuery({ args: { enrollmentId: v.string() }, handler: async (ctx, args) => {
  const record = await enrollment(ctx, args.enrollmentId);
  if (record.enrolledAt !== undefined) fail("FORBIDDEN", "Enrollment already completed");
  return { enrollmentId: record.id, challenge: record.challenge, origin: record.origin, userId: await digest(`${record.backendId}:${record.projectId}:${record.memberId}`), userName: `${record.memberId} (${record.projectId})`, binding: enrollmentBinding(record) };
} });
export const stageEnrollment = internalMutation({ args: { enrollmentId: v.string(), credentialId: v.string(), publicKeySpki: v.string(), assertion: assertionArgs }, handler: async (ctx, args) => {
  const record = await enrollment(ctx, args.enrollmentId);
  if (record.enrolledAt !== undefined || args.credentialId !== args.assertion.credentialId) fail("FORBIDDEN", "Enrollment cannot be replaced");
  decode64(args.credentialId, 2048); decode64(args.publicKeySpki, 1024);
  const count = await verifyPasskey(args.assertion, { spki: args.publicKeySpki, origin: record.origin, challenge: record.challenge, previousCounter: 0, userHandle: await userHandle(record) });
  const fingerprint = await passkeyFingerprint(args.credentialId, args.publicKeySpki, enrollmentBinding(record));
  if (record.fingerprint && (record.fingerprint !== fingerprint || record.credentialId !== args.credentialId)) fail("IDEMPOTENCY_CONFLICT", "Another key claimed this enrollment; start a new enrollment and compare fingerprints");
  await ctx.db.patch(record._id, { credentialId: args.credentialId, publicKeySpki: args.publicKeySpki, fingerprint, signCount: count });
  return { fingerprint, pendingOperatorConfirmation: true };
} });
async function requestRecord(ctx: Pick<QueryCtx, "db">, id: string, requestDigest: string) {
  stableId(id);
  const raw = await ctx.db.query("approvalRequests").withIndex("by_stable_id", q => q.eq("id", id)).unique();
  if (!raw) fail("FORBIDDEN", "Approval is unavailable");
  const project = await ctx.db.query("projects").withIndex("by_stable_id", q => q.eq("id", raw.projectId)).unique();
  if (!project) fail("FORBIDDEN", "Approval is unavailable");
  const record = await readRequest(ctx, project, id);
  if (record.requestDigest !== requestDigest) fail("FORBIDDEN", "Approval binding changed");
  return { record, project };
}
function challengeFor(record: Doc<"approvalRequests">, phase: "review" | "approve" | "deny"): string | undefined { return phase === "review" ? record.reviewChallenge : phase === "approve" ? record.approveChallenge : record.denyChallenge; }
export const challenge = internalMutation({ args: { approvalRequestId: v.string(), requestDigest: v.string(), phase: phaseArgs }, handler: async (ctx, args) => {
  const { record, project } = await requestRecord(ctx, args.approvalRequestId, args.requestDigest);
  const current = await requestView(ctx, project, record);
  if (current.state !== "pending" && current.state !== "approved" && current.state !== "denied") fail("FORBIDDEN", "Approval request is not available");
  if (args.phase !== "review" && !record.reviewedCredentialId) fail("FORBIDDEN", "Authenticate and review the exact request before deciding");
  let value = challengeFor(record, args.phase);
  if (!value) { value = randomChallenge(); await ctx.db.patch(record._id, { [args.phase === "review" ? "reviewChallenge" : args.phase === "approve" ? "approveChallenge" : "denyChallenge"]: value }); }
  return { challenge: value, rpId: new URL(siteOrigin()).hostname, userVerification: "required" as const, phase: args.phase, requestDigest: record.requestDigest };
} });
async function verifiedHuman(ctx: MutationCtx, record: Doc<"approvalRequests">, assertion: PasskeyAssertion, phase: "review" | "approve" | "deny", replayDigest?: string) {
  const key = await ctx.db.query("approvalPasskeys").withIndex("by_credential", q => q.eq("id", assertion.credentialId)).unique();
  if (!key || key.revokedAt !== undefined || key.backendId !== record.backendId || key.projectId !== record.projectId || key.origin !== siteOrigin()) fail("FORBIDDEN", "Passkey authentication rejected");
  const { actor, project } = await humanFor(ctx, record, key.humanCredentialId);
  if (key.memberId !== actor.memberId) fail("FORBIDDEN", "Passkey identity changed");
  const challenge = challengeFor(record, phase);
  if (!challenge) fail("FORBIDDEN", "Approval challenge is unavailable");
  const exactReplay = replayDigest !== undefined && record.decisionAssertionDigest === replayDigest && record.decisionCredentialId === key.id;
  const count = await verifyPasskey(assertion, { spki: key.publicKeySpki, origin: key.origin, challenge, previousCounter: exactReplay ? 0 : key.signCount, userHandle: await userHandle(key), requireUserHandle: phase === "review" });
  if (!exactReplay) await ctx.db.patch(key._id, { signCount: count });
  return { actor, project };
}
export const review = internalMutation({ args: { approvalRequestId: v.string(), requestDigest: v.string(), assertion: assertionArgs }, handler: async (ctx, args) => {
  const { record, project } = await requestRecord(ctx, args.approvalRequestId, args.requestDigest);
  if ((await requestView(ctx, project, record)).state !== "pending") fail("FORBIDDEN", "Request is no longer pending");
  const { actor } = await verifiedHuman(ctx, record, args.assertion, "review");
  if (record.reviewedCredentialId !== undefined && record.reviewedBy !== actor.memberId) fail("IDEMPOTENCY_CONFLICT", "Another project human already holds this request's review; wait for their decision, or cancel and request again to review it yourself");
  await ctx.db.patch(record._id, { reviewedBy: actor.memberId, reviewedCredentialId: args.assertion.credentialId, reviewedAt: Date.now() });
  const rule = await ctx.db.query("memories").withIndex("by_stable_id", q => q.eq("id", record.memoryId)).unique();
  if (!rule || !await currentRule(ctx, project.id, record)) fail("FORBIDDEN", "Exact rule changed");
  return { request: await requestView(ctx, project, record), rule: { id: rule.id, revision: rule.revision, hash: rule.hash, content: rule.content, sources: rule.sources, applicability: rule.applicability, confidence: rule.confidence }, policyVersion: project.policyVersion };
} });
export const decide = internalMutation({ args: { approvalRequestId: v.string(), requestDigest: v.string(), decision: v.union(v.literal("approve"), v.literal("deny")), assertion: assertionArgs }, handler: async (ctx, args) => {
  const { record, project } = await requestRecord(ctx, args.approvalRequestId, args.requestDigest);
  const assertionDigest = await digest(canonical(args.assertion));
  const { actor } = await verifiedHuman(ctx, record, args.assertion, args.decision, assertionDigest);
  if (record.reviewedBy !== actor.memberId || record.reviewedCredentialId !== args.assertion.credentialId) fail("FORBIDDEN", "The deciding key must review this exact request first");
  const desired = args.decision === "approve" ? "approved" : "denied";
  if (record.state === "approved" || record.state === "denied") {
    if (record.state !== desired || record.decidedBy !== actor.memberId) fail("IDEMPOTENCY_CONFLICT", "This request already has another exact human decision");
    return requestView(ctx, project, record);
  }
  if ((await requestView(ctx, project, record)).state !== "pending") fail("FORBIDDEN", "Request is no longer pending");
  const decidedAt = Date.now();
  const approved = args.decision === "approve" ? await approveExactRule(ctx, project, actor, record, decidedAt) : null;
  await ctx.db.patch(record._id, { state: desired, decidedBy: actor.memberId, decidedAt, decisionCredentialId: args.assertion.credentialId, decisionAssertionDigest: assertionDigest, ...(approved ? { approvedPolicyVersion: approved.policyVersion } : {}) });
  await ctx.db.insert("audit", { projectId: project.id, actorId: actor.id, operation: `approvalRequests.${args.decision}`, requestId: record.id, recordId: record.memoryId, detail: "passkey-user-verified", at: decidedAt });
  const updated = await readRequest(ctx, project, record.id);
  return requestView(ctx, project, updated);
} });
