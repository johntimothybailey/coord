import { canonicalJson } from "../src/canonical.js";
import { v, ConvexError } from "convex/values";
import type { ErrorCode, RequestIdentity } from "../src/protocol.js";
import { CAPABILITIES, DEFAULTS, PROTOCOL_VERSION, requireHandshake, requireCapability } from "../src/protocol.js";
import { internalMutation, mutation, query } from "./server.js";
import type { Doc, MutationCtx, QueryCtx } from "./server.js";

export const identityArgs = { token: v.string(), protocolVersion: v.number(), clientVersion: v.string(), capabilities: v.array(v.string()), backendId: v.string(), projectId: v.string(), requestId: v.string() };
export const runArgs = { ...identityArgs, taskId: v.string(), runId: v.string(), epoch: v.number(), goalRevision: v.number() };
export type Identity = RequestIdentity & { token: string };
export type RunIdentity = Identity & { taskId: string; runId: string; epoch: number; goalRevision: number };
export function fail(code: ErrorCode, message: string): never { throw new ConvexError({ code, message }); }
export function bounded(value: string, max: number, name: string): void {
  if (!value || new TextEncoder().encode(value).length > max) fail("INVALID_INPUT", `Invalid ${name}`);
}
export function stableId(value: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) fail("INVALID_INPUT", "Invalid record identity"); }
export function integer(value: number, min: number, max: number): void { if (!Number.isSafeInteger(value) || value < min || value > max) fail("INVALID_INPUT", "Invalid numeric limit"); }
export function path(value: string): void {
  if (!value || value.length > 8192 || value.startsWith("/") || value.includes("\\") || value.includes("\0") || value.split("/").some(p => p === ".." || p === "." || p.toLowerCase() === ".git" || !p)) fail("INVALID_INPUT", "Expected a repository-relative path");
}
export function paths(values: string[], max = 500): void { if (!values.length || values.length > max || new Set(values).size !== values.length) fail("INVALID_INPUT", "Invalid path list"); for (const value of values) path(value); }
export function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, "0")).join("");
}
export function tokenFormat(value: string): void { if (!/^[a-f0-9]{64}$/.test(value)) fail("UNAUTHORIZED", "Invalid credential"); }
export const canonical = canonicalJson;
export async function authenticate(ctx: Pick<QueryCtx, "db">, args: Identity, roles: readonly Doc<"credentials">["role"][]): Promise<{ actor: Doc<"credentials">; project: Doc<"projects"> }> {
  tokenFormat(args.token);
  stableId(args.requestId);
  const tokenDigest = await digest(args.token);
  const actor = await ctx.db.query("credentials").withIndex("by_digest", q => q.eq("digest", tokenDigest)).unique();
  if (!actor || actor.revokedAt !== undefined || actor.expiresAt <= Date.now() || actor.backendId !== args.backendId || !actor.projectIds.includes(args.projectId)) fail("UNAUTHORIZED", "Credential is invalid for this backend/project");
  const metadata = await ctx.db.query("metadata").withIndex("by_backend", q => q.eq("backendId", args.backendId)).unique();
  if (!metadata || args.protocolVersion !== PROTOCOL_VERSION || metadata.protocolVersion !== PROTOCOL_VERSION) fail("PROTOCOL_INCOMPATIBLE", "Client and backend protocol versions differ");
  try { requireHandshake({ backendProtocolVersion: metadata.protocolVersion, minSupportedClientVersion: metadata.minSupportedClientVersion, requiredCapabilities: metadata.requiredCapabilities ?? [], supportedCapabilities: metadata.supportedCapabilities ?? [] }, args); } catch { fail("PROTOCOL_INCOMPATIBLE", "Client/backend version or required capabilities are incompatible"); }
  if (metadata.writersPaused) fail("PROTOCOL_INCOMPATIBLE", "Backend writers are paused for migration");
  if (!roles.includes(actor.role)) fail("FORBIDDEN", "Credential does not permit this operation");
  const project = await ctx.db.query("projects").withIndex("by_stable_id", q => q.eq("id", args.projectId)).unique();
  if (!project || project.backendId !== args.backendId) fail("UNAUTHORIZED", "Project is outside this backend");
  return { actor, project };
}
export async function approvedGoal(ctx: Pick<QueryCtx, "db">, task: Doc<"tasks">): Promise<Doc<"goals">> {
  const goal = await ctx.db.query("goals").withIndex("by_stable_id", q => q.eq("id", task.goalId)).unique();
  if (!goal || goal.projectId !== task.projectId || goal.state !== "active" || goal.revision !== task.goalRevision || !goal.approvedBy || goal.approvedHash !== goal.hash) fail("GOAL_NOT_APPROVED", "Task requires the current exact approved goal revision");
  return goal;
}
export async function boundRun(ctx: Pick<QueryCtx, "db">, args: RunIdentity, actor: Doc<"credentials">): Promise<{ task: Doc<"tasks">; run: Doc<"runs"> }> {
  const task = await ctx.db.query("tasks").withIndex("by_stable_id", q => q.eq("id", args.taskId)).unique();
  const run = await ctx.db.query("runs").withIndex("by_stable_id", q => q.eq("id", args.runId)).unique();
  if (!task || !run || task.projectId !== args.projectId || run.projectId !== args.projectId || run.taskId !== task.id) fail("NOT_FOUND", "Run/task not found");
  if (actor.role !== "run" || actor.runId !== run.id || actor.id !== run.grantId || actor.memberId !== run.memberId) fail("FORBIDDEN", "A bound run grant is required");
  if (task.epoch !== args.epoch || run.epoch !== args.epoch || task.ownerRunId !== run.id || task.goalRevision !== args.goalRevision || run.goalRevision !== args.goalRevision) fail("STALE_EPOCH", "Run identity is no longer current");
  return { task, run };
}
export async function liveRun(ctx: Pick<QueryCtx, "db">, args: RunIdentity, actor: Doc<"credentials">, allowedStates = ["running"], allowedTaskStates = ["reserved", "running", "yielding"]): Promise<{ task: Doc<"tasks">; run: Doc<"runs">; goal: Doc<"goals"> }> {
  const { task, run } = await boundRun(ctx, args, actor);
  if (task.leaseUntil === undefined || task.leaseUntil <= Date.now() || run.leaseUntil <= Date.now() || run.deadline <= Date.now() || !allowedStates.includes(run.state) || task.holdRunId || task.dispatchHeld || !allowedTaskStates.includes(task.state)) fail("LEASE_REVOKED", "Run lease is not live for this operation");
  const project = await ctx.db.query("projects").withIndex("by_stable_id", q => q.eq("id", args.projectId)).unique();
  if (!project || !project.sharingApproved || task.scope.some(p => !project.allowedPaths.some(a => p === a || p.startsWith(`${a}/`)) || project.excludedPaths.some(a => overlaps(a, p)))) fail("FORBIDDEN", "Current routing/sharing policy no longer permits task scope");
  const machine = await ctx.db.query("machines").withIndex("by_id_project", q => q.eq("id", run.machineId).eq("projectId", project.id)).unique();
  if (!machine || machine.memberId !== run.memberId || !machine.qualifiedModes.includes(run.mode === "manual" ? "manual" : "managed") || !machine.capabilityKey || !machine.capabilityChecks || run.capabilityDigest !== machine.capabilityDigest || project.configVersion === undefined || run.configVersion !== project.configVersion || machine.configVersion !== project.configVersion || machine.qualificationExpiresAt <= Date.now()) fail("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Run capability or project policy changed after admission");
  try { requireCapability({ key: machine.capabilityKey, checks: machine.capabilityChecks }, machine.capabilityKey, run.mode === "manual" ? "manual" : "managed"); } catch { fail("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Run capability evidence expired"); }
  const goal = await approvedGoal(ctx, task);
  return { task, run, goal };
}
export async function replay<T>(ctx: MutationCtx, actor: Doc<"credentials">, operation: string, args: Identity, action: () => Promise<T>): Promise<T> {
  const { token: _token, ...payload } = args;
  const payloadHash = await digest(canonical(payload));
  const previous = await ctx.db.query("idempotency").withIndex("by_request", q => q.eq("credentialId", actor.id).eq("operation", operation).eq("requestId", args.requestId)).unique();
  if (previous) {
    if (previous.payloadHash !== payloadHash) fail("IDEMPOTENCY_CONFLICT", "Request ID was already used with different input");
    return JSON.parse(previous.resultJson) as T;
  }
  const result = await action();
  await ctx.db.insert("idempotency", { credentialId: actor.id, operation, requestId: args.requestId, payloadHash, resultJson: JSON.stringify(result) });
  await ctx.db.insert("audit", { projectId: args.projectId, actorId: actor.id, operation, requestId: args.requestId, recordId: args.requestId, detail: "accepted", at: Date.now() });
  return result;
}
export async function revokeGrant(ctx: MutationCtx, run: Doc<"runs">): Promise<void> {
  const grant = await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", run.grantId)).unique();
  if (grant && grant.revokedAt === undefined) await ctx.db.patch(grant._id, { revokedAt: Date.now() });
}

// Deployment-owner-only primitive. Never exposed through a public action, HTTP route or agent tool.
// The operator supplies locally generated random 32-byte tokens; only their digests persist.
export const bootstrap = internalMutation({
  args: { backendId: v.string(), projectId: v.string(), repository: v.string(), remote: v.string(), defaultBranch: v.string(), allowedPaths: v.array(v.string()), excludedPaths: v.array(v.string()), ruleTargets: v.array(v.string()), humanId: v.string(), humanToken: v.string(), agentId: v.string(), agentToken: v.string(), expiresAt: v.number() },
  handler: async (ctx, args) => {
    stableId(args.backendId); stableId(args.projectId); stableId(args.humanId); stableId(args.agentId); paths(args.allowedPaths); for (const p of args.excludedPaths) path(p); for (const p of args.ruleTargets) path(p);
    bounded(args.repository, 2048, "repository"); bounded(args.remote, 2048, "remote"); bounded(args.defaultBranch, 256, "branch");
    tokenFormat(args.humanToken); tokenFormat(args.agentToken);
    if (args.humanToken === args.agentToken || args.humanId === args.agentId || args.expiresAt <= Date.now() || args.expiresAt > Date.now() + 365 * 86400_000) fail("INVALID_INPUT", "Invalid bootstrap credentials");
    if (await ctx.db.query("metadata").take(1).then(rows => rows.length)) fail("FORBIDDEN", "Backend is already initialized");
    await ctx.db.insert("metadata", { backendId: args.backendId, protocolVersion: PROTOCOL_VERSION, minSupportedClientVersion: "0.1.0-private", migrationVersion: 1, writersPaused: false, requiredCapabilities: [...CAPABILITIES], supportedCapabilities: [...CAPABILITIES] });
    await ctx.db.insert("projects", { id: args.projectId, backendId: args.backendId, repository: args.repository, remote: args.remote, defaultBranch: args.defaultBranch, allowedPaths: args.allowedPaths, excludedPaths: args.excludedPaths, ruleTargets: args.ruleTargets, capacity: DEFAULTS.projectCapacity, taskCap: DEFAULTS.taskCap, configVersion: 1, policyVersion: 1, sharingApproved: false });
    for (const [id, token, role] of [[args.humanId, args.humanToken, "human"], [args.agentId, args.agentToken, "agent"]] as const) await ctx.db.insert("credentials", { id, memberId: id, digest: await digest(token), role, backendId: args.backendId, projectIds: [args.projectId], expiresAt: args.expiresAt });
    return { backendId: args.backendId, projectId: args.projectId, humanId: args.humanId, agentId: args.agentId };
  },
});

export const revoke = mutation({ args: { ...identityArgs, credentialId: v.string() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["human"]);
  return replay(ctx, actor, "auth.revoke", args, async () => {
    const target = await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", args.credentialId)).unique();
    if (!target || target.backendId !== args.backendId || target.projectIds.some(id => !actor.projectIds.includes(id))) fail("FORBIDDEN", "Credential is outside human scope");
    await ctx.db.patch(target._id, { revokedAt: Date.now() }); return { revoked: target.id };
  });
} });

export const handshake = query({ args: identityArgs, handler: async (ctx, args) => {
  await authenticate(ctx, args, ["human", "agent", "run", "supervisor", "artifact_verifier"]);
  const metadata = await ctx.db.query("metadata").withIndex("by_backend", q => q.eq("backendId", args.backendId)).unique();
  if (!metadata) fail("NOT_FOUND", "Backend metadata not found");
  return { backendProtocolVersion: metadata.protocolVersion, minSupportedClientVersion: metadata.minSupportedClientVersion, requiredCapabilities: metadata.requiredCapabilities ?? [], supportedCapabilities: metadata.supportedCapabilities ?? [] };
} });

export const invite = mutation({ args: { ...identityArgs, inviteToken: v.string(), memberId: v.string(), projectIds: v.array(v.string()), role: v.union(v.literal("agent"), v.literal("human")), expiresAt: v.number() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["human"]);
  return replay(ctx, actor, "auth.invite", args, async () => {
    tokenFormat(args.inviteToken); stableId(args.memberId);
    if (!args.projectIds.length || args.projectIds.length > 20 || new Set(args.projectIds).size !== args.projectIds.length || args.projectIds.some(id => !actor.projectIds.includes(id)) || !args.projectIds.includes(args.projectId) || args.expiresAt <= Date.now() || args.expiresAt > Date.now() + 24 * 3600_000 || args.inviteToken === args.token) fail("FORBIDDEN", "Invite exceeds approver scope or expiry limit");
    for (const id of args.projectIds) { const project = await ctx.db.query("projects").withIndex("by_stable_id", q => q.eq("id", id)).unique(); if (!project || project.backendId !== args.backendId) fail("FORBIDDEN", "Invite project/backend mismatch"); }
    const inviteDigest = await digest(args.inviteToken);
    if (await ctx.db.query("invites").withIndex("by_digest", q => q.eq("digest", inviteDigest)).unique() || await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", args.memberId)).unique()) fail("IDEMPOTENCY_CONFLICT", "Invite/member identity is already used");
    await ctx.db.insert("invites", { digest: inviteDigest, backendId: args.backendId, memberId: args.memberId, projectIds: args.projectIds, role: args.role, expiresAt: args.expiresAt, attempts: 0 });
    return { memberId: args.memberId, role: args.role, expiresAt: args.expiresAt };
  });
} });
export const INVITE_REDEEM_WINDOW_MS = 60_000;
export const INVITE_REDEEM_LIMIT = 60;
export const redeem = mutation({ args: { backendId: v.string(), projectId: v.string(), protocolVersion: v.number(), clientVersion: v.string(), capabilities: v.array(v.string()), requestId: v.string(), inviteToken: v.string(), newToken: v.string(), credentialExpiresAt: v.number() }, handler: async (ctx, args) => {
  const denied = { joined: false as const, code: "UNAUTHORIZED" as const };
  // Deployment-local singleton: neither backendId, invite digest nor a client field chooses a bucket.
  const key = "invite-redemption";
  const windowStart = Math.floor(Date.now() / INVITE_REDEEM_WINDOW_MS) * INVITE_REDEEM_WINDOW_MS;
  const bucket = await ctx.db.query("rateLimits").withIndex("by_key", q => q.eq("key", key)).unique();
  const attempts = bucket?.windowStart === windowStart ? Math.min(bucket.attempts + 1, 1_000_000) : 1;
  if (bucket) await ctx.db.patch(bucket._id, { windowStart, attempts }); else await ctx.db.insert("rateLimits", { key, windowStart, attempts });
  if (attempts > INVITE_REDEEM_LIMIT || !/^[a-f0-9]{64}$/.test(args.inviteToken) || !/^[a-f0-9]{64}$/.test(args.newToken) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(args.requestId)) return denied;
  const inviteDigest = await digest(args.inviteToken), newDigest = await digest(args.newToken);
  const invitation = await ctx.db.query("invites").withIndex("by_digest", q => q.eq("digest", inviteDigest)).unique();
  if (!invitation) return denied;
  if (invitation.attempts >= 5 || invitation.expiresAt <= Date.now()) return denied;
  const metadata = await ctx.db.query("metadata").withIndex("by_backend", q => q.eq("backendId", args.backendId)).unique();
  let compatible = true;
  try { if (!metadata || metadata.writersPaused) compatible = false; else requireHandshake({ backendProtocolVersion: metadata.protocolVersion, minSupportedClientVersion: metadata.minSupportedClientVersion, requiredCapabilities: metadata.requiredCapabilities ?? [], supportedCapabilities: metadata.supportedCapabilities ?? [] }, args); } catch { compatible = false; }
  if (!compatible || invitation.backendId !== args.backendId || !invitation.projectIds.includes(args.projectId) || args.newToken === args.inviteToken || args.credentialExpiresAt <= Date.now() || args.credentialExpiresAt > Date.now() + 365 * 86400_000) { await ctx.db.patch(invitation._id, { attempts: invitation.attempts + 1 }); return denied; }
  const payloadHash = await digest(canonical(args));
  const credentialId = `invite_${invitation.digest}`;
  const previous = await ctx.db.query("idempotency").withIndex("by_request", q => q.eq("credentialId", credentialId).eq("operation", "auth.redeem").eq("requestId", args.requestId)).unique();
  if (previous) {
    const current = await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", invitation.memberId)).unique();
    if (!current || current.digest !== newDigest || current.revokedAt !== undefined || current.expiresAt <= Date.now()) return denied;
    if (previous.payloadHash !== payloadHash) return { joined: false as const, code: "IDEMPOTENCY_CONFLICT" as const };
    return JSON.parse(previous.resultJson) as { joined: true; memberId: string; role: "agent" | "human"; projectIds: string[] };
  }
  if (invitation.redeemedAt !== undefined) return denied;
  if (await ctx.db.query("credentials").withIndex("by_digest", q => q.eq("digest", newDigest)).unique() || await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", invitation.memberId)).unique()) { await ctx.db.patch(invitation._id, { attempts: invitation.attempts + 1 }); return denied; }
  await ctx.db.insert("credentials", { id: invitation.memberId, memberId: invitation.memberId, backendId: args.backendId, digest: newDigest, projectIds: invitation.projectIds, role: invitation.role, expiresAt: args.credentialExpiresAt });
  await ctx.db.patch(invitation._id, { redeemedAt: Date.now(), attempts: invitation.attempts + 1 });
  const result = { joined: true as const, memberId: invitation.memberId, role: invitation.role, projectIds: invitation.projectIds };
  await ctx.db.insert("idempotency", { credentialId, operation: "auth.redeem", requestId: args.requestId, payloadHash, resultJson: JSON.stringify(result) });
  await ctx.db.insert("audit", { projectId: args.projectId, actorId: invitation.memberId, operation: "auth.redeem", requestId: args.requestId, recordId: invitation.memberId, detail: "one_use_invite_redeemed", at: Date.now() });
  return result;
} });
