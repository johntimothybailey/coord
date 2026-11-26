import test from "node:test";
import assert from "node:assert/strict";
import { getFunctionAddress, getFunctionName } from "convex/server";
import { BackendFixture } from "./backend.fixture.js";
import type { MutationCtx, Doc } from "../convex/server.js";
import * as oauth from "../convex/oauthAuthority.js";
import * as connect from "../convex/connect.js";
import { bootstrap, digest } from "../convex/auth.js";
import { mcpIngress } from "../convex/mcpIngress.js";
import { OAUTH_SCOPES, CONNECTION_CAP_MS } from "../convex/oauthPolicy.js";
import * as projects from "../convex/projects.js";

process.env.CONVEX_SITE_URL = "https://connect-fixture.convex.site";
const site = process.env.CONVEX_SITE_URL;
type Handler = { _handler(ctx: unknown, args: Record<string, unknown>): Promise<unknown> };
// Application handlers + simulated component boundary only; no live OAuth,
// browser/human validation or Convex OCC claim follows from these tests.
class ConnectFixture extends BackendFixture {
  browserUser: string | null = null;
  grant = { _id: "grant", _creationTime: Date.now() - 1000, kind: "oauth", userId: "", clientId: "host", resource: `${site}/mcp`, scopes: [...OAUTH_SCOPES] as string[], name: "Unverified client" };
  validBearer = true;
  domainCalls = 0;
  forwarded: Record<string, unknown>[] = [];
  override context(): MutationCtx {
    const ctx = super.context();
    ctx.db.normalizeId = ((_table: string, id: string) => this.rows.has(id) ? id : null) as typeof ctx.db.normalizeId;
    ctx.auth = { getUserIdentity: async () => this.browserUser ? { subject: "session" } : null } as MutationCtx["auth"];
    ctx.runQuery = (async (ref: unknown, args: Record<string, unknown>) => {
      const address = getFunctionAddress(ref).reference ?? "";
      if (address.endsWith("public/getSession")) return this.browserUser ? { userId: this.browserUser } : null;
      if (address.endsWith("grants/list")) return this.grant.userId === args.userId ? [this.grant] : [];
      if (address.endsWith("tokens/verify")) return this.validBearer && args.hash === await digest("actual-access") ? { ...this.grant, grantId: this.grant._id, kind: "access", stale: true } : null;
      if (address.endsWith("public/getUserIdByUsername")) return null;
      const name = getFunctionName(ref as never);
      if (name === "connect:inspectAccess") return (connect.inspectAccess as unknown as Handler)._handler(ctx, args);
      if (name === "oauthAuthority:inspectBearer") return (oauth.inspectBearer as unknown as Handler)._handler(ctx, args);
      if (name === "connect:hostStatus") return (connect.hostStatus as unknown as Handler)._handler(ctx, args);
      if (name === "projects:status") { this.domainCalls++; return (projects.status as unknown as Handler)._handler(ctx, args); }
      throw new Error(`Unexpected query ${address || name}`);
    }) as MutationCtx["runQuery"];
    ctx.runMutation = (async (ref: unknown, args: Record<string, unknown>) => {
      const address = getFunctionAddress(ref).reference ?? "";
      const name = getFunctionName(ref as never);
      this.forwarded.push({ name, ...args });
      if (name === "connect:finish") return (connect.finish as unknown as Handler)._handler(ctx, args);
      if (name === "connect:hostCancel") return (connect.hostCancel as unknown as Handler)._handler(ctx, args);
      if (name === "connect:confirmStatus") return (connect.confirmStatus as unknown as Handler)._handler(ctx, args);
      if (name === "attribution:recordHandshake") return null;
      throw new Error(`Unexpected mutation ${address || name}`);
    }) as MutationCtx["runMutation"];
    return ctx;
  }

  patch(id: string, fields: Record<string, unknown>) { const old = this.rows.get(id); assert(old); this.rows.set(id, { ...old, ...fields }); }
}
async function setup() {
  const f = new ConnectFixture();
  await f.call(bootstrap, { backendId: "backend", projectId: "project", repository: "https://example.test/repo", remote: "origin", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: [], humanId: "human", humanDigest: await digest("1".repeat(64)), agentId: "agent", agentDigest: await digest("2".repeat(64)), expiresAt: Date.now() + 3 * CONNECTION_CAP_MS });
  const userId = await f.call(oauth.createUser, { method: { name: "fixture", profile: {} } }) as Doc<"users">["_id"];
  f.browserUser = userId; f.grant.userId = userId;
  const link = await f.call(oauth.installLink, { id: "link", generation: 1, userId, backendId: "backend", projectId: "project", sourceCredentialId: "agent", scopes: [...OAUTH_SCOPES], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + CONNECTION_CAP_MS }) as { linkId: Doc<"identityLinks">["_id"]; generation: number };
  await f.call(oauth.activateLink, link);
  return { f, userId, link };
}
const rejected = (error: unknown) => !!error && typeof error === "object" && "data" in error;
const code = (expected: string) => (error: unknown) => rejected(error) && (error as { data: { code?: string } }).data.code === expected;
// Direct row seeding for listing volume only. These rows are registered metadata: no
// handler wrote them and no protected operation accepts them as authority.
function seedConnections(f: ConnectFixture, userId: string, count: number, label: string) {
  return Array.from({ length: count }, (_unused, index) => f.seed("mcpConnections", { grantId: `${label}_grant_${index}`, userId, backendId: "backend", projectId: "project", resource: `${site}/mcp`, clientId: "host", linkId: `${label}_link`, linkGeneration: 1, membershipId: `${label}_membership`, membershipGeneration: 1, sourceCredentialId: "agent", memberId: "agent", scopes: ["coord:read"], grantCreatedAt: Date.now() - 1000, absoluteExpiresAt: Date.now() + CONNECTION_CAP_MS }, Date.now() + index));
}
// Registered link metadata only. identityLinks.by_user_backend has key
// (userId, backendId, _creationTime), so .order("desc") walks backendId DESCENDING and is
// newest-first only WITHIN one backendId. By default these rows therefore go into the same
// single backend as the real install and strictly older than it: that single-backend
// placement, not any global newest-first rule, is what keeps the one genuinely selectable
// link in first position. A caller may pass another backendId/creation base to pin
// cross-backend order explicitly. Every seeded row fails its current authority check (its
// source document does not exist), so none is ever selectable.
function seedLinks(f: ConnectFixture, userId: string, count: number, backendId = "backend", label = "volume", from = Date.now() - 1_000_000) {
  return Array.from({ length: count }, (_unused, index) => f.seed("identityLinks", { id: `${label}_${index}`, generation: 1, userId, backendId, projectId: "project", sourceCredentialId: "agent", sourceDocumentId: "absent_source", memberId: "agent", scopes: ["coord:read"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + CONNECTION_CAP_MS, active: false }, from + index));
}
// Walks one paginated listing to exhaustion, preserving page boundaries and row order.
async function walkPages(fetch: (args: { cursor?: string; pageSize?: number }) => Promise<unknown>, key: "links" | "connections", pageSize: number) {
  const ids: string[] = [], sizes: number[] = [];
  let cursor: string | undefined, guard = 0;
  for (;;) {
    const page = await fetch({ pageSize, ...(cursor === undefined ? {} : { cursor }) }) as { complete: boolean; nextCursor: string | null } & Record<string, unknown>;
    const rows = page[key] as Record<string, unknown>[];
    sizes.push(rows.length);
    for (const row of rows) ids.push(String(row[key === "links" ? "linkId" : "connectionId"]));
    if (page.complete) { assert.equal(page.nextCursor, null); break; }
    assert.equal(typeof page.nextCursor, "string"); cursor = page.nextCursor!;
    if (++guard > 50) assert.fail("cursor walk never completed");
  }
  return { ids, sizes };
}
async function handoff(f: ConnectFixture) { return await f.call(connect.finish, { bearer: "actual-access" }) as { handoffId: string; state: string; url: string }; }
async function rpc(f: ConnectFixture, method: string, params: Record<string, unknown>) {
  return mcpIngress.handleMcp(f.context() as unknown as Parameters<typeof mcpIngress.handleMcp>[0], new Request(`${site}/mcp`, { method: "POST", headers: { Authorization: "Bearer actual-access", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
}


test("handoff selectors never select another user's active link or expose another user's attempt", async () => {
  const { f, link } = await setup(), pending = await handoff(f);
  const originalUser = f.browserUser;
  const foreignUser = await f.call(oauth.createUser, { method: { name: "fixture", profile: {} } }) as Doc<"users">["_id"];
  const foreignLink = await f.call(oauth.installLink, { id: "foreign", generation: 1, userId: foreignUser, backendId: "backend", projectId: "project", sourceCredentialId: "agent", scopes: ["coord:read"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + 120_000 }) as typeof link;
  f.browserUser = foreignUser; await f.call(oauth.activateLink, foreignLink);
  for (const operation of [connect.status, connect.review, connect.cancel]) {
    await assert.rejects(f.call(operation as typeof connect.review, { handoffId: pending.handoffId, ...link }), rejected);
  }
  f.browserUser = originalUser;
  const before = structuredClone(f.rows);
  await assert.rejects(f.call(connect.review, { handoffId: pending.handoffId, ...foreignLink }), rejected);
  await assert.rejects(f.call(connect.complete, { handoffId: pending.handoffId, ...foreignLink, digest: "f".repeat(64) }), rejected);
  assert.deepEqual(f.rows, before);
});

test("displayed exact review is invalidated when link scopes or source lifetime narrow", async () => {
  for (const changed of ["link_scope", "source_lifetime"] as const) {
    const { f, link } = await setup(), pending = await handoff(f);
    const args = { handoffId: pending.handoffId, ...link };
    const shown = await f.call(connect.review, args) as { digest: string };
    if (changed === "link_scope") f.patch(link.linkId, { scopes: ["coord:read"] });
    else f.patch(f.find("credentials", "agent")._id, { expiresAt: Date.now() + 30_000 });
    const fresh = await f.call(connect.review, args) as { digest: string };
    assert.notEqual(fresh.digest, shown.digest);
    const before = structuredClone(f.rows);
    await assert.rejects(f.call(connect.complete, { ...args, digest: shown.digest }), rejected);
    assert.deepEqual(f.rows, before);
    assert(![...f.rows.values()].some(row => row._table === "mcpConnections"));
  }
});

test("a completed grant cannot move to a replacement project and preserves the old binding", async () => {
  const { f, userId, link } = await setup(), pending = await handoff(f);
  const view = await f.call(connect.review, { ...link, handoffId: pending.handoffId }) as { digest: string };
  await f.call(connect.complete, { ...link, handoffId: pending.handoffId, digest: view.digest });
  const original = structuredClone([...f.rows.values()].find(row => row._table === "mcpConnections"));
  const { _id, _creationTime, ...project } = f.find("projects", "project"); void _id; void _creationTime;
  await f.context().db.insert("projects", { ...project, id: "other_project" });
  f.patch(f.find("credentials", "agent")._id, { projectIds: ["project", "other_project"] });
  const replacement = await f.call(oauth.installLink, { id: "replacement", generation: 2, userId, backendId: "backend", projectId: "other_project", sourceCredentialId: "agent", scopes: ["coord:read"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + 120_000 }) as typeof link;
  await f.call(oauth.activateLink, replacement);
  // MOVED from consentForSession's immutable "Grant consent is immutable" check: the only
  // consent path is this handoff, and a completed handoff's reviewed tuple cannot change, so
  // both review and completion of the replacement are refused as IDEMPOTENCY_CONFLICT. The
  // preserved invariant is that one grant can never be moved to another project/generation.
  await assert.rejects(f.call(connect.review, { ...replacement, handoffId: pending.handoffId }), code("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(f.call(connect.complete, { ...replacement, handoffId: pending.handoffId, digest: "f".repeat(64) }), code("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(handoff(f), code("UNAUTHORIZED"));
  assert.deepEqual([...f.rows.values()].filter(row => row._table === "mcpConnections"), [original]);
});

test("preconsent MCP rejects hidden domain tools and caller identity claims cannot select a grant", async () => {
  const { f, userId } = await setup();
  const before = structuredClone(f.rows);
  const deniedCall = await (await rpc(f, "tools/call", { name: "coord_status", arguments: { projectId: "project", userId, grantId: "grant", tier: "human" } })).json();
  assert.match(JSON.stringify(deniedCall), /error|not found|unknown/i);
  assert.equal(f.domainCalls, 0); assert.deepEqual(f.rows, before);
  const forged = { bearer: "forged", grantId: "foreign", userId: "foreign", projectId: "other_project", tier: "human" };
  const forgedResult = await (await rpc(f, "tools/call", { name: "coord_finish_connect", arguments: forged })).json();
  assert(f.forwarded.some(call => call.name === "connect:finish") || /error/i.test(JSON.stringify(forgedResult)), "forged arguments are rejected or forwarded solely under verified bearer authority");
  assert.equal(f.domainCalls, 0);
  assert(f.forwarded.every(call => call.bearer === "actual-access" && call.grantId === undefined && call.userId === undefined && call.tier === undefined));
  for (const row of f.rows.values()) if (row._table === "connectHandoffs") {
    assert.equal(row.userId, userId); assert.equal(row.grantId, "grant");
  }
  assert(![...f.rows.values()].some(row => row._table === "mcpConnections"));
});

test("a listing cursor is always scoped to the signed-in account and never carries another user's rows", async () => {
  const { f, userId } = await setup();
  const mine = seedConnections(f, userId, 7, "mine");
  const otherUser = await f.call(oauth.createUser, { method: { name: "fixture", profile: {} } }) as Doc<"users">["_id"];
  const theirs = seedConnections(f, otherUser, 7, "theirs");
  const first = await f.call(connect.connectionPage, {}) as { connections: { connectionId: string }[]; nextCursor: string | null };
  // mcpConnections.by_user has key (userId, _creationTime), so a descending walk is
  // newest-first across the whole signed-in user and never includes another account's rows.
  assert.deepEqual(first.connections.map(row => row.connectionId), [...mine].reverse().slice(0, 5));
  const cursor = first.nextCursor!; assert.equal(typeof cursor, "string");
  // Replaying one account's cursor while signed in as another cannot widen the range: the
  // query always pins q.eq("userId", user._id). Real Convex cursor invalidation is runtime
  // behaviour this offline fixture simulates and does not prove.
  f.browserUser = otherUser;
  const replayed = await f.call(connect.connectionPage, { cursor }) as { connections: { connectionId: string }[] };
  assert(replayed.connections.length > 0);
  assert(replayed.connections.every(row => theirs.includes(row.connectionId)));
  assert(!replayed.connections.some(row => mine.includes(row.connectionId)));
  // Omitting the cursor restarts at page one for whoever is actually signed in.
  const restarted = await f.call(connect.connectionPage, {}) as { connections: { connectionId: string }[] };
  assert.deepEqual(restarted.connections.map(row => row.connectionId), [...theirs].reverse().slice(0, 5));
});

test("listing volume can never refuse the signed-in browser surface or hide the selectable link", async () => {
  const { f, userId, link } = await setup();
  // The lockout this correction fixes: with volume past the bound, identity used to refuse
  // and the whole browser surface failed to render. It must now always succeed.
  const connections = seedConnections(f, userId, 150, "volume");
  seedLinks(f, userId, 150);
  const own = await f.call(connect.identity, {}) as { userId: string; links: { linkId: string }[]; linksMore: boolean; connections: { connectionId: string }[]; connectionsMore: boolean };
  assert.equal(own.userId, userId);
  assert.equal(own.connections.length, 100); assert.equal(own.connectionsMore, true);
  assert.equal(own.links.length, 1); assert.equal(own.linksMore, true);
  assert.deepEqual(own.links.map(row => row.linkId), [link.linkId], "volume never displaces the one currently selectable link");
  assert.doesNotMatch(JSON.stringify(own), /COVERAGE_INCOMPLETE/);
  // The bounded read is a cap, not a refusal: the records beyond it stay reachable by cursor.
  const walked: string[] = [];
  let cursor: string | undefined, guard = 0;
  for (;;) {
    const page = await f.call(connect.connectionPage, { pageSize: 25, ...(cursor === undefined ? {} : { cursor }) }) as { connections: { connectionId: string }[]; complete: boolean; nextCursor: string | null };
    for (const row of page.connections) walked.push(row.connectionId);
    if (page.complete) break;
    cursor = page.nextCursor!;
    if (++guard > 50) assert.fail("cursor walk never completed");
  }
  assert.deepEqual([...walked].sort(), [...connections].sort());
});

test("each listing's order is exactly what its own index key gives: links group by backend, connections stay newest-first per user", async () => {
  const { f, userId, link } = await setup();
  // identityLinks.by_user_backend key is (userId, backendId, _creationTime): a descending
  // walk is ordered by backendId first and is newest-first only within one backendId.
  // Nothing requires an account to use a single backend, so a globally newest-first link
  // order is not a property of this listing and no test may assume one. The three backend
  // ids below sort "zz-backend" > "backend" > "aa-backend", and the globally newest row is
  // deliberately the one in the LAST group.
  const base = Date.now();
  const [zzOlder, zzNewer] = seedLinks(f, userId, 2, "zz-backend", "zz", base - 2_000) as [string, string];
  const [aaNewest] = seedLinks(f, userId, 1, "aa-backend", "aa", base + 5_000) as [string];
  const links = await walkPages(args => f.call(connect.linkPage, args), "links", 2);
  assert.deepEqual(links.ids, [zzNewer, zzOlder, link.linkId, aaNewest], "the listing groups by backendId descending, newest-first inside each group");
  // The same rows in global creation order are a different sequence, so this listing is
  // demonstrably not globally newest-first and does not interleave by creation time.
  assert.notDeepEqual(links.ids, [aaNewest, link.linkId, zzNewer, zzOlder]);
  assert.notEqual(links.ids[0], aaNewest, "the globally newest link is not first");
  // A cursor walk still reaches every record exactly once across the grouped pages.
  assert.deepEqual(links.sizes, [2, 2]);
  assert.equal(new Set(links.ids).size, links.ids.length);
  assert.deepEqual([...links.ids].sort(), [link.linkId, zzOlder, zzNewer, aaNewest].sort());
  // Connections index on (userId, _creationTime) alone, so backendId never groups them:
  // the descending walk is newest-first across everything this user owns.
  const spread = Array.from({ length: 4 }, (_unused, index) => f.seed("mcpConnections", { grantId: `order_grant_${index}`, userId, backendId: index % 2 ? "zz-backend" : "aa-backend", projectId: "project", resource: `${site}/mcp`, clientId: "host", linkId: "order_link", linkGeneration: 1, membershipId: "order_membership", membershipGeneration: 1, sourceCredentialId: "agent", memberId: "agent", scopes: ["coord:read"], grantCreatedAt: base - 1000, absoluteExpiresAt: base + CONNECTION_CAP_MS }, base + index));
  const connections = await walkPages(args => f.call(connect.connectionPage, args), "connections", 3);
  assert.deepEqual(connections.ids, [...spread].reverse(), "newest-first within the user, regardless of backendId");
  assert.deepEqual(connections.sizes, [3, 1]);
  assert.equal(new Set(connections.ids).size, connections.ids.length);
});
