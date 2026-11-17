import { identityArgs } from "./authArgs.js";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { internalMutation, internalQuery, mutation, query } from "./server.js";
import type { Doc, MutationCtx, QueryCtx } from "./server.js";
import { authorizeActor, bounded, canonical, digest, fail, stableId } from "./auth.js";
import { CONNECTION_CAP_MS, MAX_ANCESTORS, OAUTH_SCOPES, operationScope } from "./oauthPolicy.js";

export type AuthorityCtx = Pick<QueryCtx, "db"> & Partial<Pick<QueryCtx, "runQuery">>;
function componentQuery(ctx: AuthorityCtx): QueryCtx["runQuery"] {
  if (!ctx.runQuery) fail("UNAUTHORIZED", "Authoritative grant state unavailable");
  return ctx.runQuery.bind(ctx);
}
export function oauthResource(): string {
  const origin = process.env.CONVEX_SITE_URL;
  if (!origin || new URL(origin).origin !== origin) fail("UNAUTHORIZED", "OAuth resource unavailable");
  return `${origin}/mcp`;
}
function alive(actor: Doc<"credentials"> | null, backendId: string, projectId: string): asserts actor is Doc<"credentials"> {
  if (!actor || actor.revokedAt !== undefined || actor.lapsedAt !== undefined || (!Number.isFinite(actor.expiresAt) || actor.expiresAt <= Date.now()) || actor.backendId !== backendId || !actor.projectIds.includes(projectId)) fail("UNAUTHORIZED", "Credential authority unavailable");
}
export function isOAuth(actor: Doc<"credentials">): boolean {
  // Linkage without its discriminator is malformed, never a legacy fallback.
  if (actor.credentialSource !== "oauth" && (actor.connectionId !== undefined || actor.parentCredentialId !== undefined || actor.oauthScopes !== undefined || actor.absoluteExpiresAt !== undefined)) fail("UNAUTHORIZED", "Incomplete credential origin");
  return actor.credentialSource === "oauth";
}
async function currentLink(ctx: AuthorityCtx, link: Doc<"identityLinks"> | null, requireActive = true) {
  if (!link || !Number.isFinite(link.expiresAt) || link.revokedAt !== undefined || link.expiresAt <= Date.now() || (requireActive && !link.active)) fail("UNAUTHORIZED", "Identity link unavailable");
  const user = await ctx.db.get(link.userId);
  const source = await ctx.db.get(link.sourceDocumentId);
  alive(source, link.backendId, link.projectId);
  if (!user?.enabled || user.disabledAt !== undefined || source.id !== link.sourceCredentialId || source.role !== "agent" || source.memberId !== link.memberId || isOAuth(source)) fail("UNAUTHORIZED", "Identity source unavailable");
  const membership = await ctx.db.query("memberships").withIndex("by_link", q => q.eq("linkId", link._id)).unique();
  if (!membership || !Number.isFinite(membership.expiresAt) || membership.revokedAt !== undefined || membership.expiresAt <= Date.now() || (requireActive && !membership.active) || membership.generation !== link.generation || membership.userId !== link.userId || membership.backendId !== link.backendId || membership.projectId !== link.projectId || membership.memberId !== link.memberId || membership.sourceCredentialId !== source.id) fail("UNAUTHORIZED", "Membership unavailable");
  const project = await ctx.db.query("projects").withIndex("by_stable_id", q => q.eq("id", link.projectId)).unique();
  if (!project || project.backendId !== link.backendId) fail("UNAUTHORIZED", "Project unavailable");
  return { link, source, membership };
}
async function currentGrant(ctx: AuthorityCtx, userId: string, grantId: string) {
  // The supported API lists only the newest 200. Missing/failed lookup denies;
  // it is not evidence that the user deliberately revoked this grant.
  const grants = await componentQuery(ctx)(components.mcp.grants.list, { userId });
  const grant = grants.find(item => item._id === grantId);
  if (!grant || grant.kind !== "oauth" || grant.userId !== userId || !grant.clientId || grant.resource !== oauthResource() || (!Number.isFinite(grant._creationTime) || grant._creationTime < 0) || grant._creationTime > Date.now()) fail("UNAUTHORIZED", "Current OAuth grant unavailable");
  return grant;
}
export async function currentConnection(ctx: AuthorityCtx, connection: Doc<"mcpConnections"> | null) {
  if (!connection || !Number.isFinite(connection.absoluteExpiresAt) || connection.revokedAt !== undefined || connection.absoluteExpiresAt <= Date.now() || connection.resource !== oauthResource()) fail("UNAUTHORIZED", "Connection unavailable");
  const { link, source, membership } = await currentLink(ctx, await ctx.db.get(connection.linkId));
  if (connection.linkGeneration !== link.generation || connection.membershipId !== membership._id || connection.membershipGeneration !== membership.generation || connection.userId !== link.userId || connection.backendId !== link.backendId || connection.projectId !== link.projectId || connection.sourceCredentialId !== source.id || connection.memberId !== source.memberId) fail("UNAUTHORIZED", "Connection lineage mismatch");
  const grant = await currentGrant(ctx, connection.userId, connection.grantId);
  if (grant.clientId !== connection.clientId || grant._creationTime !== connection.grantCreatedAt || connection.absoluteExpiresAt > grant._creationTime + CONNECTION_CAP_MS || connection.absoluteExpiresAt > Math.min(source.expiresAt, membership.expiresAt, link.expiresAt)) fail("UNAUTHORIZED", "Connection ceiling mismatch");
  const scopes = connection.scopes.filter(scope => grant.scopes.includes(scope) && link.scopes.includes(scope));
  return { connection, link, source, membership, scopes, ceiling: Math.min(connection.absoluteExpiresAt, source.expiresAt, membership.expiresAt, link.expiresAt) };
}
export async function validateLineage(ctx: AuthorityCtx, actor: Doc<"credentials">, projectId: string, requiredScope?: string) {
  alive(actor, actor.backendId, projectId);
  if (!isOAuth(actor)) return actor.expiresAt;
  if (!actor.connectionId || !actor.oauthScopes || actor.absoluteExpiresAt === undefined || actor.role === "human") fail("UNAUTHORIZED", "Incomplete OAuth lineage");
  const state = await currentConnection(ctx, await ctx.db.get(actor.connectionId));
  if (state.connection.backendId !== actor.backendId || state.connection.projectId !== projectId || state.connection.memberId !== actor.memberId) fail("UNAUTHORIZED", "Foreign OAuth lineage");
  let ceiling = state.ceiling;
  let current = actor;
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
    alive(current, actor.backendId, projectId);
    if (seen.has(current.id) || !isOAuth(current) || current.connectionId !== actor.connectionId || current.memberId !== actor.memberId || current.absoluteExpiresAt === undefined || current.absoluteExpiresAt > state.connection.absoluteExpiresAt || !current.oauthScopes || current.oauthScopes.some(scope => !state.connection.scopes.includes(scope))) fail("UNAUTHORIZED", "Invalid OAuth ancestry");
    seen.add(current.id);
    ceiling = Math.min(ceiling, current.expiresAt, current.absoluteExpiresAt);
    if (requiredScope && (!state.scopes.includes(requiredScope) || !current.oauthScopes.includes(requiredScope))) fail("FORBIDDEN", "OAuth scope does not permit this operation");
    if (!current.parentCredentialId) {
      if (current.role !== "agent" || current.id !== state.connection.rootCredentialId) fail("UNAUTHORIZED", "OAuth root missing");
      if (ceiling <= Date.now()) fail("UNAUTHORIZED", "OAuth lifetime ended");
      return ceiling;
    }
    const parent = await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", current.parentCredentialId!)).unique();
    if (!parent || current.expiresAt > parent.expiresAt || current.absoluteExpiresAt > (parent.absoluteExpiresAt ?? 0) || current.oauthScopes.some(scope => !parent.oauthScopes?.includes(scope))) fail("UNAUTHORIZED", "OAuth parent unavailable");
    current = parent;
  }
  fail("UNAUTHORIZED", "OAuth ancestry exceeds supported depth");
}
export async function authorizeOAuth(ctx: AuthorityCtx, actor: Doc<"credentials">, projectId: string, operation?: string) {
  if (!isOAuth(actor)) return;
  const scope = operationScope(operation, actor.role);
  if (!scope) fail("FORBIDDEN", "Operation does not permit OAuth authority");
  await validateLineage(ctx, actor, projectId, scope);
}
export function childLineage(actor: Doc<"credentials">) {
  return isOAuth(actor) ? { credentialSource: "oauth" as const, connectionId: actor.connectionId!, parentCredentialId: actor.id, oauthScopes: actor.oauthScopes!, absoluteExpiresAt: actor.absoluteExpiresAt! } : { credentialSource: "legacy" as const };
}
export async function bearerActor(ctx: AuthorityCtx, bearer: string, backendId: string, projectId: string) {
  bounded(bearer, 4096, "OAuth bearer");
  const verified = await componentQuery(ctx)(components.mcp.tokens.verify, { hash: await digest(bearer), now: Date.now() });
  if (!verified || verified.kind !== "access" || verified.resource !== oauthResource()) fail("UNAUTHORIZED", "OAuth bearer unavailable");
  const connection = await ctx.db.query("mcpConnections").withIndex("by_grant", q => q.eq("grantId", verified.grantId)).unique();
  const state = await currentConnection(ctx, connection);
  if (state.connection.userId !== verified.userId || state.connection.clientId !== verified.clientId || state.connection.backendId !== backendId || state.connection.projectId !== projectId || !state.connection.rootCredentialId) fail("UNAUTHORIZED", "OAuth binding required");
  const actor = await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", state.connection.rootCredentialId!)).unique();
  if (!actor || actor.connectionId !== connection!._id) fail("UNAUTHORIZED", "OAuth binding unavailable");
  // Per-token scopes further narrow the immutable root consent without writes.
  return { ...actor, oauthScopes: actor.oauthScopes?.filter(scope => verified.scopes.includes(scope)) };
}
async function auditTransition(ctx: MutationCtx, projectId: string, actorId: string, operation: string, recordId: string) {
  await ctx.db.insert("audit", { projectId, actorId, operation, requestId: recordId, recordId, detail: "accepted", at: Date.now() });
}
async function sessionUser(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx, components.auth);
  if (!userId) fail("UNAUTHORIZED", "Live browser authentication required");
  const user = await ctx.db.get(userId);
  if (!user?.enabled || user.disabledAt !== undefined) fail("UNAUTHORIZED", "Application identity unavailable");
  return user;
}
// Identity only. No profile-derived membership or authority. A future sign-in
// method must attach this callback, rather than accept a caller's user ID.
export const createUser = internalMutation({ args: { method: v.object({ name: v.string(), profile: v.any() }) }, returns: v.id("users"), handler: ctx => ctx.db.insert("users", { enabled: true, createdAt: Date.now() }) });
export const identity = query({ args: {}, handler: async ctx => ({ userId: (await sessionUser(ctx))._id }) });
export const installLink = internalMutation({ args: { id: v.string(), generation: v.number(), userId: v.id("users"), backendId: v.string(), projectId: v.string(), sourceCredentialId: v.string(), scopes: v.array(v.string()), activationExpiresAt: v.number(), expiresAt: v.number() }, handler: async (ctx, args) => {
  stableId(args.id);
  if (!Number.isSafeInteger(args.activationExpiresAt) || !Number.isSafeInteger(args.expiresAt) || !Number.isSafeInteger(args.generation) || args.generation < 1 || args.activationExpiresAt <= Date.now() || args.activationExpiresAt > args.expiresAt || args.expiresAt <= Date.now() || !args.scopes.length || args.scopes.length > OAUTH_SCOPES.length || new Set(args.scopes).size !== args.scopes.length || args.scopes.some(scope => !(OAUTH_SCOPES as readonly string[]).includes(scope))) fail("INVALID_INPUT", "Invalid identity link limits");
  const source = await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", args.sourceCredentialId)).unique();
  alive(source, args.backendId, args.projectId);
  const user = await ctx.db.get(args.userId);
  const project = await ctx.db.query("projects").withIndex("by_stable_id", q => q.eq("id", args.projectId)).unique();
  if (!user?.enabled || user.disabledAt !== undefined || !project || project.backendId !== args.backendId || source.role !== "agent" || isOAuth(source) || args.expiresAt > source.expiresAt) fail("FORBIDDEN", "Invalid identity source");
  const tuple = { ...args, sourceDocumentId: source._id, memberId: source.memberId };
  const existing = await ctx.db.query("identityLinks").withIndex("by_stable_id", q => q.eq("id", args.id)).unique();
  if (existing) {
    const { _id, _creationTime, active, revokedAt, ...stored } = existing;
    if (revokedAt !== undefined || canonical(stored) !== canonical(tuple)) fail("IDEMPOTENCY_CONFLICT", "Link identity already used");
    await currentLink(ctx, existing, false); return { linkId: _id, generation: existing.generation };
  }
  const prior = await ctx.db.query("identityLinks").withIndex("by_user_backend", q => q.eq("userId", args.userId).eq("backendId", args.backendId)).take(101);
  if (prior.length > 100 || prior.some(link => link.generation >= args.generation)) fail("IDEMPOTENCY_CONFLICT", "Link generation must advance");
  // A replacement is a fresh immutable generation; old descendants stay dead.
  for (const link of prior) if (link.revokedAt === undefined) await ctx.db.patch(link._id, { revokedAt: Date.now() });
  const linkId = await ctx.db.insert("identityLinks", { ...tuple, active: false });
  await ctx.db.insert("memberships", { linkId, generation: args.generation, userId: args.userId, backendId: args.backendId, projectId: args.projectId, sourceCredentialId: source.id, memberId: source.memberId, expiresAt: args.expiresAt, active: false });
  await auditTransition(ctx, args.projectId, "deployment_owner", "oauth.installLink", linkId);
  return { linkId, generation: args.generation };
} });
export const activateLink = mutation({ args: { linkId: v.id("identityLinks"), generation: v.number() }, handler: async (ctx, args) => {
  const user = await sessionUser(ctx);
  const state = await currentLink(ctx, await ctx.db.get(args.linkId), false);
  if (state.link.userId !== user._id || state.link.generation !== args.generation || (!state.link.active && state.link.activationExpiresAt <= Date.now())) fail("UNAUTHORIZED", "Activation unavailable");
  if (!state.link.active) {
    await ctx.db.patch(state.link._id, { active: true }); await ctx.db.patch(state.membership._id, { active: true });
    await auditTransition(ctx, state.link.projectId, user._id, "oauth.activateLink", state.link._id);
  }
  return { active: true, projectId: state.link.projectId, generation: state.link.generation };
} });
// Authenticated project consent is separate from generic OAuth scopes. There is
// no Connect UI in this slice: these bounded browser APIs are infrastructure.
export const consentGrant = mutation({ args: { grantId: v.string(), linkId: v.id("identityLinks"), generation: v.number() }, handler: async (ctx, args) => {
  const user = await sessionUser(ctx);
  const { link, source, membership } = await currentLink(ctx, await ctx.db.get(args.linkId));
  if (link.userId !== user._id || link.generation !== args.generation) fail("FORBIDDEN", "Consent identity mismatch");
  const grant = await currentGrant(ctx, user._id, args.grantId);
  const scopes = grant.scopes.filter(scope => link.scopes.includes(scope));
  const tuple = { grantId: grant._id, userId: user._id, backendId: link.backendId, projectId: link.projectId, resource: grant.resource, clientId: grant.clientId!, linkId: link._id, linkGeneration: link.generation, membershipId: membership._id, membershipGeneration: membership.generation, sourceCredentialId: source.id, memberId: source.memberId, scopes, grantCreatedAt: grant._creationTime, absoluteExpiresAt: Math.min(grant._creationTime + CONNECTION_CAP_MS, link.expiresAt, membership.expiresAt, source.expiresAt) };
  if (!scopes.length || tuple.absoluteExpiresAt <= Date.now()) fail("UNAUTHORIZED", "Consent authority expired");
  const prior = await ctx.db.query("mcpConnections").withIndex("by_grant", q => q.eq("grantId", grant._id)).unique();
  if (prior) {
    await currentConnection(ctx, prior);
    const { _id, _creationTime, rootCredentialId, revokedAt, clientObservation: _telemetry, ...stored } = prior;
    if (canonical(stored) !== canonical(tuple)) fail("IDEMPOTENCY_CONFLICT", "Grant consent is immutable");
    return { connectionId: _id, projectId: prior.projectId, absoluteExpiresAt: prior.absoluteExpiresAt };
  }
  const connectionId = await ctx.db.insert("mcpConnections", tuple);
  await auditTransition(ctx, link.projectId, user._id, "oauth.consentGrant", connectionId);
  return { connectionId, projectId: link.projectId, absoluteExpiresAt: tuple.absoluteExpiresAt };
} });
export const bind = mutation({ args: { ...identityArgs }, handler: async (ctx, args) => {
  if (!args.oauthBearer || args.token !== "") fail("UNAUTHORIZED", "Explicit OAuth bearer required");
  bounded(args.oauthBearer, 4096, "OAuth bearer");
  const verified = await ctx.runQuery(components.mcp.tokens.verify, { hash: await digest(args.oauthBearer), now: Date.now() });
  if (!verified || verified.kind !== "access" || verified.resource !== oauthResource()) fail("UNAUTHORIZED", "OAuth bearer unavailable");
  const connection = await ctx.db.query("mcpConnections").withIndex("by_grant", q => q.eq("grantId", verified.grantId)).unique();
  const state = await currentConnection(ctx, connection);
  if (state.connection.userId !== verified.userId || state.connection.clientId !== verified.clientId || state.connection.backendId !== args.backendId || state.connection.projectId !== args.projectId || state.connection.scopes.some(scope => !verified.scopes.includes(scope))) fail("UNAUTHORIZED", "Exact project consent required");
  await authorizeActor(ctx, args, state.source, ["agent"]);
  const id = `oauth_${await digest(`${verified.grantId}:${connection!._id}`)}`;
  const existing = await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", id)).unique();
  if (existing) {
    if (connection!.rootCredentialId !== id || existing.connectionId !== connection!._id || existing.role !== "agent" || existing.memberId !== connection!.memberId || existing.absoluteExpiresAt !== connection!.absoluteExpiresAt || canonical(existing.oauthScopes) !== canonical(connection!.scopes)) fail("IDEMPOTENCY_CONFLICT", "OAuth root collision");
    await validateLineage(ctx, existing, args.projectId); return { credentialId: id, absoluteExpiresAt: connection!.absoluteExpiresAt };
  }
  if (connection!.rootCredentialId) fail("IDEMPOTENCY_CONFLICT", "OAuth root unavailable");
  // No usable root secret exists: only the explicit bearer path can use roots.
  await ctx.db.insert("credentials", { id, backendId: connection!.backendId, memberId: connection!.memberId, digest: `oauth:${id}`, role: "agent", projectIds: [connection!.projectId], expiresAt: connection!.absoluteExpiresAt, credentialSource: "oauth", connectionId: connection!._id, oauthScopes: connection!.scopes, absoluteExpiresAt: connection!.absoluteExpiresAt });
  await ctx.db.patch(connection!._id, { rootCredentialId: id });
  await auditTransition(ctx, args.projectId, id, "oauth.bind", connection!._id);
  return { credentialId: id, absoluteExpiresAt: connection!.absoluteExpiresAt };
} });
export const revokeConnection = mutation({ args: { connectionId: v.id("mcpConnections") }, handler: async (ctx, args) => {
  const user = await sessionUser(ctx); const connection = await ctx.db.get(args.connectionId);
  if (!connection || connection.userId !== user._id) fail("FORBIDDEN", "Connection unavailable");
  // Component mutation and local cutoff are in the same Convex transaction.
  await ctx.runMutation(components.mcp.grants.revoke, { userId: user._id, grantId: connection.grantId });
  if (connection.revokedAt === undefined) {
    await ctx.db.patch(connection._id, { revokedAt: Date.now() });
    await auditTransition(ctx, connection.projectId, user._id, "oauth.revokeConnection", connection._id);
  }
  return { revoked: true };
} });
export const revokeLink = internalMutation({ args: { linkId: v.id("identityLinks"), generation: v.number() }, handler: async (ctx, args) => {
  const link = await ctx.db.get(args.linkId);
  if (!link || link.generation !== args.generation) fail("NOT_FOUND", "Exact link unavailable");
  if (link.revokedAt === undefined) {
    await ctx.db.patch(link._id, { revokedAt: Date.now() });
    await auditTransition(ctx, link.projectId, "deployment_owner", "oauth.revokeLink", link._id);
  }
  return { revoked: true };
} });
export const disableUser = internalMutation({ args: { userId: v.id("users") }, handler: async (ctx, args) => {
  const user = await ctx.db.get(args.userId); if (!user) fail("NOT_FOUND", "Identity unavailable");
  if (user.disabledAt === undefined) {
    // Disable first; project audit enumeration is bounded and does not decide
    // whether any descendant is denied. The enabled flag is authoritative.
    await ctx.db.patch(user._id, { enabled: false, disabledAt: Date.now() });
    const links = await ctx.db.query("identityLinks").withIndex("by_user_backend", q => q.eq("userId", user._id)).take(100);
    for (const projectId of new Set(links.map(link => link.projectId))) await auditTransition(ctx, projectId, "deployment_owner", "oauth.disableUser", user._id);
  }
  return { disabled: true };
} });

// HTTP ingress reads current consent even for discovery/initialization. Domain
// functions independently verify the bearer again in their own transaction.
export const inspectBearer = internalQuery({ args: { bearer: v.string() }, handler: async (ctx, args): Promise<{ userId: string; scopes: string[]; clientId: string; connectionId: string } | null> => {
  try {
    bounded(args.bearer, 4096, "OAuth bearer");
    const verified = await ctx.runQuery(components.mcp.tokens.verify, { hash: await digest(args.bearer), now: Date.now() });
    if (!verified || verified.kind !== "access" || verified.resource !== oauthResource()) return null;
    const connection = await ctx.db.query("mcpConnections").withIndex("by_grant", q => q.eq("grantId", verified.grantId)).unique();
    const state = await currentConnection(ctx, connection);
    if (verified.userId !== state.connection.userId || verified.clientId !== state.connection.clientId) return null;
    return { userId: verified.userId, scopes: state.scopes.filter(scope => verified.scopes.includes(scope)), clientId: state.connection.clientId, connectionId: verified.grantId };
  } catch { return null; }
} });

export const revokeMembership = internalMutation({ args: { membershipId: v.id("memberships"), generation: v.number() }, handler: async (ctx, args) => {
  const membership = await ctx.db.get(args.membershipId);
  if (!membership || membership.generation !== args.generation) fail("NOT_FOUND", "Exact membership unavailable");
  if (membership.revokedAt === undefined) {
    await ctx.db.patch(membership._id, { revokedAt: Date.now() });
    await auditTransition(ctx, membership.projectId, "deployment_owner", "oauth.revokeMembership", membership._id);
  }
  return { revoked: true };
} });

// Action-safe browser identity bridge. Convex forwards the authenticated caller
// into this query; no supplied user ID or SDK metadata establishes authority.
export const browserIdentity = internalQuery({ args: {}, handler: async (ctx): Promise<string | null> => {
  try { return (await sessionUser(ctx))._id; } catch { return null; }
} });
