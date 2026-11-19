import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { internalMutation, internalQuery, mutation, query } from "./server.js";
import type { Doc, MutationCtx, QueryCtx } from "./server.js";
import { authenticate, authorizeActor, bounded, canonical, digest, fail } from "./auth.js";
import { bindOAuth, consentForSession, currentConnection, currentGrant, currentLink, oauthResource, sessionUser, installIdentityLink, installLinkArgs, validateLineage } from "./oauthAuthority.js";
import type { AuthorityCtx } from "./oauthAuthority.js";
import { CONNECTION_CAP_MS } from "./oauthPolicy.js";
import { CAPABILITIES, CLIENT_VERSION, PROTOCOL_VERSION } from "../src/protocol.js";

export const HANDOFF_TTL_MS = 10 * 60_000;
const selector = { handoffId: v.string() };
const reviewArgs = { ...selector, linkId: v.id("identityLinks"), generation: v.number() };
export async function verifiedAccess(ctx: AuthorityCtx, bearer: string) {
  bounded(bearer, 4096, "OAuth bearer");
  if (!ctx.runQuery) fail("UNAUTHORIZED", "OAuth state unavailable");
  const verified = await ctx.runQuery(components.mcp.tokens.verify, { hash: await digest(bearer), now: Date.now() });
  if (!verified || verified.kind !== "access" || verified.resource !== oauthResource()) fail("UNAUTHORIZED", "Current access bearer required");
  const userId = ctx.db.normalizeId("users", verified.userId);
  const user = userId && await ctx.db.get(userId);
  if (!user || !user.enabled || user.disabledAt !== undefined) fail("UNAUTHORIZED", "Application identity unavailable");
  const grant = await currentGrant(ctx, user._id, verified.grantId);
  if (grant.clientId !== verified.clientId || grant._creationTime + CONNECTION_CAP_MS <= Date.now()) fail("UNAUTHORIZED", "Current OAuth grant unavailable");
  return { user, grant, scopes: grant.scopes.filter(scope => verified.scopes.includes(scope)) };
}
function stateOf(handoff: Doc<"connectHandoffs">) {
  if (handoff.state === "cancelled") return "cancelled" as const;
  if (handoff.state === "completed") return handoff.connectedAt === undefined ? "authorized_awaiting_host" as const : "connected" as const;
  return handoff.expiresAt <= Date.now() || handoff.absoluteExpiresAt <= Date.now() ? "expired" as const : "pending" as const;
}
async function ownHandoff(ctx: QueryCtx | MutationCtx, id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) fail("NOT_FOUND", "Connect attempt unavailable");
  const user = await sessionUser(ctx);
  const handoff = await ctx.db.query("connectHandoffs").withIndex("by_stable_id", q => q.eq("id", id)).unique();
  if (!handoff || handoff.userId !== user._id) fail("NOT_FOUND", "Connect attempt unavailable");
  return handoff;
}
async function handoffGrant(ctx: AuthorityCtx, handoff: Doc<"connectHandoffs">) {
  const grant = await currentGrant(ctx, handoff.userId, handoff.grantId);
  if (grant.clientId !== handoff.clientId || grant.resource !== handoff.resource || grant._creationTime !== handoff.grantCreatedAt || handoff.absoluteExpiresAt !== grant._creationTime + CONNECTION_CAP_MS || handoff.absoluteExpiresAt <= Date.now()) fail("UNAUTHORIZED", "Connect grant changed or expired");
  return grant;
}
async function reviewTuple(ctx: QueryCtx | MutationCtx, handoff: Doc<"connectHandoffs">, linkId: Doc<"identityLinks">["_id"], generation: number) {
  const grant = await handoffGrant(ctx, handoff);
  const { link, source, membership } = await currentLink(ctx, await ctx.db.get(linkId));
  if (link.userId !== handoff.userId || link.generation !== generation) fail("FORBIDDEN", "Exact own project link required");
  const scopes = handoff.originalScopes.filter(scope => grant.scopes.includes(scope) && link.scopes.includes(scope));
  if (!scopes.includes("coord:read")) fail("FORBIDDEN", "Connect requires current read scope to verify project access");
  const review = { handoffId: handoff.id, grantId: grant._id, userId: handoff.userId, clientId: handoff.clientId, resource: handoff.resource, grantCreatedAt: handoff.grantCreatedAt, backendId: link.backendId, projectId: link.projectId, sourceCredentialId: source.id, linkId: link._id, generation: link.generation, scopes, absoluteExpiresAt: Math.min(handoff.absoluteExpiresAt, link.expiresAt, source.expiresAt, membership.expiresAt) };
  return { review, digest: await digest(canonical(review)) };
}
async function currentRoot(ctx: AuthorityCtx, connection: Doc<"mcpConnections">, scope?: string) {
  if (!connection.rootCredentialId) fail("UNAUTHORIZED", "Connect root is not bound");
  const root = await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", connection.rootCredentialId!)).unique();
  if (!root || root.role !== "agent" || root.connectionId !== connection._id) fail("UNAUTHORIZED", "Connect root unavailable");
  const identity = { backendId: connection.backendId, projectId: connection.projectId, protocolVersion: PROTOCOL_VERSION, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], requestId: "connect_status" };
  await authorizeActor(ctx, identity, root, ["agent"]);
  await validateLineage(ctx, root, connection.projectId, scope);
}
export const identity = query({ args: {}, handler: async ctx => {
  const user = await sessionUser(ctx);
  const links = await ctx.db.query("identityLinks").withIndex("by_user_backend", q => q.eq("userId", user._id)).take(101);
  if (links.length > 100) fail("COVERAGE_INCOMPLETE", "Own identity link coverage is incomplete");
  const visible = [];
  for (const link of links) {
    try {
      await currentLink(ctx, link, false);
      if (!link.active && link.activationExpiresAt <= Date.now()) continue;
      visible.push({ linkId: link._id, generation: link.generation, backendId: link.backendId, projectId: link.projectId, sourceCredentialId: link.sourceCredentialId, scopes: link.scopes, activationExpiresAt: link.activationExpiresAt, expiresAt: link.expiresAt, active: link.active });
    } catch { /* stale links confer no selectable authority */ }
  }
  const connections = await ctx.db.query("mcpConnections").withIndex("by_user", q => q.eq("userId", user._id)).take(101);
  if (connections.length > 100) fail("COVERAGE_INCOMPLETE", "Own connection coverage is incomplete");
  return { userId: user._id, links: visible, connections: connections.map(connection => ({ connectionId: connection._id, projectId: connection.projectId, absoluteExpiresAt: connection.absoluteExpiresAt, revoked: connection.revokedAt !== undefined })) };
} });
export const review = query({ args: reviewArgs, handler: async (ctx, args) => {
  const handoff = await ownHandoff(ctx, args.handoffId);
  if (stateOf(handoff) !== "pending" && handoff.state !== "completed") return { state: stateOf(handoff), review: null, digest: null };
  const tuple = await reviewTuple(ctx, handoff, args.linkId, args.generation);
  if (handoff.state === "completed" && (handoff.linkId !== args.linkId || handoff.generation !== args.generation || handoff.reviewDigest !== tuple.digest)) fail("IDEMPOTENCY_CONFLICT", "Completed Connect tuple cannot change");
  return { state: stateOf(handoff), ...tuple };
} });
export const complete = mutation({ args: { ...reviewArgs, digest: v.string() }, handler: async (ctx, args) => {
  const handoff = await ownHandoff(ctx, args.handoffId);
  if (stateOf(handoff) !== "pending" && handoff.state !== "completed") fail("FORBIDDEN", "Connect attempt is terminal");
  const tuple = await reviewTuple(ctx, handoff, args.linkId, args.generation);
  if (args.digest !== tuple.digest || (handoff.state === "completed" && (handoff.linkId !== args.linkId || handoff.generation !== args.generation || handoff.reviewDigest !== args.digest))) fail("IDEMPOTENCY_CONFLICT", "Review changed; inspect the exact Connect tuple again");
  // Direct helper reuse keeps session, current grant/link and app writes in one
  // authoritative transaction. No earlier browser/action check grants authority.
  const consent = await consentForSession(ctx, { grantId: handoff.grantId, linkId: args.linkId, generation: args.generation }, handoff.originalScopes);
  if (consent.absoluteExpiresAt !== tuple.review.absoluteExpiresAt) fail("IDEMPOTENCY_CONFLICT", "Consent ceiling changed");
  if (handoff.state !== "completed") await ctx.db.patch(handoff._id, { state: "completed", linkId: args.linkId, generation: args.generation, reviewDigest: args.digest });
  return { state: stateOf({ ...handoff, state: "completed" }), projectId: consent.projectId, absoluteExpiresAt: consent.absoluteExpiresAt };
} });
export const status = query({ args: selector, handler: async (ctx, args) => {
  const handoff = await ownHandoff(ctx, args.handoffId);
  const state = stateOf(handoff);
  if (handoff.state !== "completed") {
    if (state === "pending") await handoffGrant(ctx, handoff);
    return { state };
  }
  await handoffGrant(ctx, handoff);
  const connection = await ctx.db.query("mcpConnections").withIndex("by_grant", q => q.eq("grantId", handoff.grantId)).unique();
  const valid = await currentConnection(ctx, connection);
  if (state === "connected") await currentRoot(ctx, valid.connection, "coord:read");
  return { state, projectId: valid.connection.projectId, absoluteExpiresAt: valid.connection.absoluteExpiresAt };
} });
export const cancel = mutation({ args: selector, handler: async (ctx, args) => {
  const handoff = await ownHandoff(ctx, args.handoffId);
  if (stateOf(handoff) === "pending") await ctx.db.patch(handoff._id, { state: "cancelled" });
  return { state: stateOf(handoff) === "pending" ? "cancelled" as const : stateOf(handoff) };
} });
// Pre-consent ingress uses only verified identity/grant, never connection
// authority. Caller-provided user/client/project strings cannot choose it.
export const inspectAccess = internalQuery({ args: { bearer: v.string() }, handler: async (ctx, args) => {
  try {
    const access = await verifiedAccess(ctx, args.bearer);
    const connection = await ctx.db.query("mcpConnections").withIndex("by_grant", q => q.eq("grantId", access.grant._id)).unique();
    const valid = connection && await currentConnection(ctx, connection);
    if (valid?.connection.rootCredentialId) await currentRoot(ctx, valid.connection);
    return { userId: access.user._id, clientId: access.grant.clientId!, connectionId: access.grant._id, scopes: valid ? valid.scopes.filter(scope => access.scopes.includes(scope)) : access.scopes, bound: !!valid?.connection.rootCredentialId };
  } catch { return null; }
} });
export function connectIdentity(bearer: string, connection: Pick<Doc<"mcpConnections">, "backendId" | "projectId">, grantId: string) {
  return { token: "", oauthBearer: bearer, backendId: connection.backendId, projectId: connection.projectId, protocolVersion: PROTOCOL_VERSION, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], requestId: `connect_${grantId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96)}` };
}
export const finish = internalMutation({ args: { bearer: v.string() }, handler: async (ctx, args) => {
  const access = await verifiedAccess(ctx, args.bearer);
  const connection = await ctx.db.query("mcpConnections").withIndex("by_grant", q => q.eq("grantId", access.grant._id)).unique();
  if (connection) {
    const state = await currentConnection(ctx, connection);
    if (!state.scopes.includes("coord:read") || !access.scopes.includes("coord:read")) fail("FORBIDDEN", "Read scope is required to verify Connect");
    await bindOAuth(ctx, connectIdentity(args.bearer, connection, access.grant._id));
    return { state: "bound" as const, backendId: connection.backendId, projectId: connection.projectId, grantId: access.grant._id, absoluteExpiresAt: connection.absoluteExpiresAt };
  }
  let handoff = await ctx.db.query("connectHandoffs").withIndex("by_grant", q => q.eq("grantId", access.grant._id)).unique();
  if (!handoff) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const id = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    const now = Date.now(), absoluteExpiresAt = access.grant._creationTime + CONNECTION_CAP_MS;
    const rowId = await ctx.db.insert("connectHandoffs", { id, grantId: access.grant._id, userId: access.user._id, clientId: access.grant.clientId!, resource: access.grant.resource, grantCreatedAt: access.grant._creationTime, originalScopes: access.scopes, absoluteExpiresAt, createdAt: now, expiresAt: Math.min(now + HANDOFF_TTL_MS, absoluteExpiresAt), state: "pending" });
    handoff = await ctx.db.get(rowId);
  }
  if (!handoff || handoff.userId !== access.user._id || handoff.clientId !== access.grant.clientId || handoff.resource !== access.grant.resource || handoff.grantCreatedAt !== access.grant._creationTime) fail("UNAUTHORIZED", "Connect attempt mismatch");
  return { state: stateOf(handoff), handoffId: handoff.id, url: `${new URL(oauthResource()).origin}/connect?handoff=${handoff.id}`, expiresAt: handoff.expiresAt };
} });
export const hostStatus = internalQuery({ args: { bearer: v.string() }, handler: async (ctx, args) => {
  const access = await verifiedAccess(ctx, args.bearer);
  const handoff = await ctx.db.query("connectHandoffs").withIndex("by_grant", q => q.eq("grantId", access.grant._id)).unique();
  if (!handoff) {
    const connection = await ctx.db.query("mcpConnections").withIndex("by_grant", q => q.eq("grantId", access.grant._id)).unique();
    if (!connection) return { state: "not_started" as const };
    const valid = await currentConnection(ctx, connection);
    if (!valid.connection.rootCredentialId) return { state: "authorized_awaiting_host" as const, projectId: connection.projectId, absoluteExpiresAt: connection.absoluteExpiresAt };
    await authenticate(ctx, connectIdentity(args.bearer, connection, access.grant._id), ["agent"], "projects.status");
    return { state: "connected" as const, projectId: connection.projectId, absoluteExpiresAt: connection.absoluteExpiresAt };
  }
  await handoffGrant(ctx, handoff);
  if (handoff.state === "completed") {
    const valid = await currentConnection(ctx, await ctx.db.query("mcpConnections").withIndex("by_grant", q => q.eq("grantId", handoff.grantId)).unique());
    if (stateOf(handoff) === "connected") await authenticate(ctx, connectIdentity(args.bearer, valid.connection, access.grant._id), ["agent"], "projects.status");
  }
  return { state: stateOf(handoff), handoffId: handoff.id, expiresAt: handoff.expiresAt };
} });
export const hostCancel = internalMutation({ args: { bearer: v.string() }, handler: async (ctx, args) => {
  const access = await verifiedAccess(ctx, args.bearer);
  const handoff = await ctx.db.query("connectHandoffs").withIndex("by_grant", q => q.eq("grantId", access.grant._id)).unique();
  if (!handoff) return { state: "not_started" as const };
  if (stateOf(handoff) === "pending") await ctx.db.patch(handoff._id, { state: "cancelled" });
  return { state: stateOf(handoff) === "pending" ? "cancelled" as const : stateOf(handoff) };
} });
export const confirmStatus = internalMutation({ args: { bearer: v.string() }, handler: async (ctx, args) => {
  const access = await verifiedAccess(ctx, args.bearer);
  const connection = await ctx.db.query("mcpConnections").withIndex("by_grant", q => q.eq("grantId", access.grant._id)).unique();
  if (!connection) fail("UNAUTHORIZED", "Connect binding unavailable");
  await authenticate(ctx, connectIdentity(args.bearer, connection, access.grant._id), ["agent"], "projects.status");
  const handoff = await ctx.db.query("connectHandoffs").withIndex("by_grant", q => q.eq("grantId", access.grant._id)).unique();
  if (handoff?.state === "completed" && handoff.connectedAt === undefined) await ctx.db.patch(handoff._id, { connectedAt: Date.now() });
  return { state: "connected" as const, projectId: connection.projectId, absoluteExpiresAt: connection.absoluteExpiresAt };
} });
// Exact deployment-owner readback; not a public browser/MCP provisioning path.
export const inspectLink = internalQuery({ args: { id: v.string() }, handler: async (ctx, args) => {
  const link = await ctx.db.query("identityLinks").withIndex("by_stable_id", q => q.eq("id", args.id)).unique();
  if (!link) return null;
  let eligible = true;
  try { await currentLink(ctx, link, false); } catch { eligible = false; }
  if (!link.active && link.activationExpiresAt <= Date.now()) eligible = false;
  const lifecycle = link.revokedAt !== undefined ? "revoked" : link.expiresAt <= Date.now() ? "expired" : !link.active && link.activationExpiresAt <= Date.now() ? "activation_expired" : eligible ? "current" : "authority_unavailable";
  return { eligible, lifecycle, id: link.id, generation: link.generation, userId: link.userId, backendId: link.backendId, projectId: link.projectId, sourceCredentialId: link.sourceCredentialId, scopes: link.scopes, activationExpiresAt: link.activationExpiresAt, expiresAt: link.expiresAt, linkId: link._id, active: link.active };
} });

const ownerSelection = { userId: v.id("users"), backendId: v.string(), projectId: v.string(), sourceCredentialId: v.string() };
async function ownerInspection(ctx: QueryCtx | MutationCtx, args: { userId: Doc<"users">["_id"]; backendId: string; projectId: string; sourceCredentialId: string }) {
  const user = await ctx.db.get(args.userId);
  const source = await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", args.sourceCredentialId)).unique();
  const project = await ctx.db.query("projects").withIndex("by_stable_id", q => q.eq("id", args.projectId)).unique();
  const prior = await ctx.db.query("identityLinks").withIndex("by_user_backend", q => q.eq("userId", args.userId).eq("backendId", args.backendId)).take(101);
  if (prior.length > 100) fail("COVERAGE_INCOMPLETE", "Owner link history exceeds bounded review");
  if (!user || !source || !project || source.backendId !== args.backendId || project.backendId !== args.backendId) fail("NOT_FOUND", "Owner link selection unavailable");
  const sourceView = { documentId: source._id, credentialId: source.id, memberId: source.memberId, role: source.role, projectIds: source.projectIds, expiresAt: source.expiresAt, revokedAt: source.revokedAt ?? null, lapsedAt: source.lapsedAt ?? null };
  const existing = prior.map(link => ({ id: link.id, generation: link.generation, projectId: link.projectId, sourceCredentialId: link.sourceCredentialId, active: link.active, revokedAt: link.revokedAt ?? null, expiresAt: link.expiresAt })).sort((a, b) => a.generation - b.generation || a.id.localeCompare(b.id));
  const review = { userId: args.userId, backendId: args.backendId, projectId: args.projectId, sourceCredentialId: args.sourceCredentialId, userEnabled: user.enabled && user.disabledAt === undefined, source: sourceView, project: { repository: project.repository, remote: project.remote, defaultBranch: project.defaultBranch }, existing };
  return { review, digest: await digest(canonical(review)), highestGeneration: Math.max(0, ...prior.map(link => link.generation)) };
}
export const inspectOwnerLink = internalQuery({ args: ownerSelection, handler: ownerInspection });
export const installOwnerLink = internalMutation({ args: { ...installLinkArgs, expectedStateDigest: v.string() }, handler: async (ctx, args) => {
  const current = await ownerInspection(ctx, args);
  if (current.digest !== args.expectedStateDigest || args.generation !== current.highestGeneration + 1) fail("IDEMPOTENCY_CONFLICT", "Owner link state changed; review a fresh exact plan before replacing authority");
  const { expectedStateDigest: _reviewed, ...link } = args;
  return installIdentityLink(ctx, link);
} });
