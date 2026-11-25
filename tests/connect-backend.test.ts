import test from "node:test";
import assert from "node:assert/strict";
import { getFunctionAddress, getFunctionName } from "convex/server";
import { BackendFixture } from "./backend.fixture.js";
import type { MutationCtx, Doc } from "../convex/server.js";
import * as oauth from "../convex/oauthAuthority.js";
import * as connect from "../convex/connect.js";
import { bootstrap, digest, handshake } from "../convex/auth.js";
import { mcpIngress } from "../convex/mcpIngress.js";
import { OAUTH_SCOPES, CONNECTION_CAP_MS } from "../convex/oauthPolicy.js";
import { CAPABILITIES, CLIENT_VERSION } from "../src/protocol.js";
import * as projects from "../convex/projects.js";

process.env.CONVEX_SITE_URL = "https://connect-fixture.convex.site";
const site = process.env.CONVEX_SITE_URL;
type Handler = { _handler(ctx: unknown, args: Record<string, unknown>): Promise<unknown> };
const signin = await import("../convex/authSignin.js");
class ConnectFixture extends BackendFixture {
  browserUser: string | null = null;
  grant = { _id: "grant", _creationTime: Date.now() - 1000, kind: "oauth", userId: "", clientId: "host", resource: `${site}/mcp`, scopes: [...OAUTH_SCOPES] as string[], name: "Unverified client" };
  validBearer = true;
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
      if (name === "projects:status") return (projects.status as unknown as Handler)._handler(ctx, args);
      throw new Error(`Unexpected query ${address || name}`);
    }) as MutationCtx["runQuery"];
    ctx.runMutation = (async (ref: unknown, args: Record<string, unknown>) => {
      const address = getFunctionAddress(ref).reference ?? "";
      if (address.endsWith("registration/startRegistrationForNewUser")) {
        // Component challenge response only: its background-worker scheduling
        // requires Convex function-handle syscalls, outside this fixture.
        this.challenges.push({ kind: "registration" });
        return { challenge: new Uint8Array(32).buffer, userHandle: new Uint8Array(64).buffer };
      }
      if (address.endsWith("grants/revoke")) { this.revokedGrants.push(String(args.grantId)); return null; }
      const name = getFunctionName(ref as never);
      if (name === "connect:finish") return (connect.finish as unknown as Handler)._handler(ctx, args);
      if (name === "connect:hostCancel") return (connect.hostCancel as unknown as Handler)._handler(ctx, args);
      if (name === "connect:confirmStatus") return (connect.confirmStatus as unknown as Handler)._handler(ctx, args);
      if (name === "attribution:recordHandshake") return null;
      throw new Error(`Unexpected mutation ${address || name}`);
    }) as MutationCtx["runMutation"];
    return ctx;
  }
  challenges: Record<string, unknown>[] = [];
  revokedGrants: string[] = [];
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
function request() { return { token: "", oauthBearer: "actual-access", backendId: "backend", projectId: "project", protocolVersion: 1, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], requestId: "domain_request" }; }
const rejected = (error: unknown) => !!error && typeof error === "object" && "data" in error;
const code = (expected: string) => (error: unknown) => rejected(error) && (error as { data: { code?: string } }).data.code === expected;
// Direct row seeding supplies listing volume only: no handler wrote these rows, they are
// registered metadata, and every protected operation still rechecks live authority. An
// explicit increasing _creationTime makes the simulated descending index order exact.
function seedConnections(f: ConnectFixture, userId: string, specs: { revoked?: boolean; expired?: boolean }[]) {
  return specs.map((spec, index) => f.seed("mcpConnections", { grantId: `seed_grant_${index}`, userId, backendId: "backend", projectId: "project", resource: `${site}/mcp`, clientId: "host", linkId: "seed_link", linkGeneration: 1, membershipId: "seed_membership", membershipGeneration: 1, sourceCredentialId: "agent", memberId: "agent", scopes: ["coord:read"], grantCreatedAt: Date.now() - 1000, absoluteExpiresAt: spec.expired ? Date.now() - 1 : Date.now() + CONNECTION_CAP_MS, ...(spec.revoked ? { revokedAt: Date.now() } : {}) }, Date.now() + index));
}
// Real owner installs, so each generation advance and its revocation sweep is authoritative.
async function installGenerations(f: ConnectFixture, userId: Doc<"users">["_id"], count: number, from = 2) {
  for (let generation = from; generation < from + count; generation++)
    await f.call(oauth.installLink, { id: `history_${generation}`, generation, userId, backendId: "backend", projectId: "project", sourceCredentialId: "agent", scopes: ["coord:read"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + 120_000 });
}
type Page = { complete: boolean; nextCursor: string | null } & Record<string, unknown>;
async function walk(key: "links" | "connections", fetch: (args: { cursor?: string; pageSize?: number }) => Promise<Page>, pageSize?: number) {
  const ids: string[] = [], pages: Record<string, unknown>[][] = [];
  const size = pageSize === undefined ? {} : { pageSize };
  let cursor: string | undefined, guard = 0;
  for (;;) {
    const page = await fetch({ ...size, ...(cursor === undefined ? {} : { cursor }) });
    const rows = page[key] as Record<string, unknown>[];
    pages.push(rows);
    for (const row of rows) ids.push(String(row[key === "links" ? "linkId" : "connectionId"]));
    if (page.complete) { assert.equal(page.nextCursor, null); break; }
    assert.equal(typeof page.nextCursor, "string"); cursor = page.nextCursor!;
    if (++guard > 400) assert.fail("cursor walk never completed");
  }
  return { ids, pages };
}
const connectionPage = (f: ConnectFixture) => (args: { cursor?: string; pageSize?: number }) => f.call(connect.connectionPage, args) as unknown as Promise<Page>;
const linkPage = (f: ConnectFixture) => (args: { cursor?: string; pageSize?: number }) => f.call(connect.linkPage, args) as unknown as Promise<Page>;
async function reviewed(f: ConnectFixture, link: { linkId: Doc<"identityLinks">["_id"]; generation: number }) {
  const pending = await handoff(f);
  const view = await f.call(connect.review, { handoffId: pending.handoffId, ...link }) as { digest: string };
  const done = await f.call(connect.complete, { handoffId: pending.handoffId, ...link, digest: view.digest }) as { state: string; projectId: string; absoluteExpiresAt: number };
  return { handoffId: pending.handoffId, digest: view.digest, ...done };
}
async function handoff(f: ConnectFixture) { return await f.call(connect.finish, { bearer: "actual-access" }) as { handoffId: string; state: string; url: string }; }
async function rpc(f: ConnectFixture, method: string, params: Record<string, unknown>) {
  return mcpIngress.handleMcp(f.context() as unknown as Parameters<typeof mcpIngress.handleMcp>[0], new Request(`${site}/mcp`, { method: "POST", headers: { Authorization: "Bearer actual-access", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
}

test("unconsented access exposes only onboarding tools; exact browser consent and host retry verify project status", async () => {
  const { f, link } = await setup();
  const listing = await (await rpc(f, "tools/list", {})).json() as { result: { tools: Array<{ name: string }> } };
  assert.deepEqual(listing.result.tools.map(tool => tool.name), ["coord_finish_connect", "coord_connect_status", "coord_cancel_connect"]);
  await assert.rejects(f.call(projects.status, request()), rejected);
  const pending = await handoff(f); assert.equal(pending.state, "pending"); assert(!pending.url.includes("actual-access"));
  assert.deepEqual(await handoff(f), pending);
  const own = await f.call(connect.identity, {}) as { links: unknown[] }; assert.equal(own.links.length, 1);
  const review = await f.call(connect.review, { handoffId: pending.handoffId, ...link }) as { digest: string; review: { grantId: string; scopes: string[] } };
  assert.equal(review.review.grantId, "grant");
  await assert.rejects(f.call(connect.complete, { handoffId: pending.handoffId, ...link, digest: "forged" }), rejected);
  const completed = await f.call(connect.complete, { handoffId: pending.handoffId, ...link, digest: review.digest }) as { state: string };
  assert.equal(completed.state, "authorized_awaiting_host");
  const finish = await (await rpc(f, "tools/call", { name: "coord_finish_connect", arguments: {} })).json() as { result: { content: Array<{ text: string }> } };
  assert.match(JSON.stringify(finish), /connected/);
  assert.match(JSON.stringify(finish), /re-list/);
  const relisted = await (await rpc(f, "tools/list", {})).json() as { result: { tools: Array<{ name: string }> } };
  assert(relisted.result.tools.some(tool => tool.name === "coord_status"));
  const status = await f.call(connect.status, { handoffId: pending.handoffId }) as { state: string }; assert.equal(status.state, "connected");
  assert.equal((await f.call(projects.status, request()) as { project: { id: string } }).project.id, "project");
  assert(!JSON.stringify([...f.rows.values()]).includes("actual-access"));
});

test("handoffs reject wrong browser user, invalid bearer, stale digest, source revoke, cancellation and expiry", async () => {
  for (const mode of ["wrong_user", "revoked_source", "cancelled", "expired", "scope_changed"] as const) {
    const { f, link } = await setup(); const pending = await handoff(f);
    const review = await f.call(connect.review, { handoffId: pending.handoffId, ...link }) as { digest: string };
    if (mode === "wrong_user") f.browserUser = await f.call(oauth.createUser, { method: { name: "fixture", profile: {} } }) as string;
    if (mode === "revoked_source") f.patch(f.find("credentials", "agent")._id, { revokedAt: Date.now() });
    if (mode === "cancelled") await f.call(connect.cancel, { handoffId: pending.handoffId });
    if (mode === "expired") f.patch(f.find("connectHandoffs", pending.handoffId)._id, { expiresAt: Date.now() - 1 });
    if (mode === "scope_changed") f.grant.scopes = ["coord:read"];
    const before = structuredClone(f.rows);
    await assert.rejects(f.call(connect.complete, { handoffId: pending.handoffId, ...link, digest: review.digest }), rejected);
    assert.deepEqual(f.rows, before);
  }
  const { f } = await setup(); f.validBearer = false;
  await assert.rejects(handoff(f), rejected);
});

test("cancel cannot disconnect established consent or revive a terminal handoff; scopes never expand past reviewed attempt", async () => {
  const { f, link } = await setup(); f.grant.scopes = ["coord:read"];
  const pending = await handoff(f);
  f.grant.scopes = [...OAUTH_SCOPES];
  const reviewed = await f.call(connect.review, { ...link, handoffId: pending.handoffId }) as { digest: string; review: { scopes: string[] } };
  assert.deepEqual(reviewed.review.scopes, ["coord:read"]);
  await f.call(connect.complete, { ...link, handoffId: pending.handoffId, digest: reviewed.digest });
  await f.call(connect.cancel, { handoffId: pending.handoffId });
  const connection = [...f.rows.values()].find(row => row._table === "mcpConnections")!;
  assert.deepEqual(connection.scopes, ["coord:read"]); assert.equal(connection.revokedAt, undefined);
  const other = await setup(), abandoned = await handoff(other.f);
  await other.f.call(connect.hostCancel, { bearer: "actual-access" });
  assert.equal((await handoff(other.f)).state, "cancelled");
  await assert.rejects(other.f.call(connect.complete, { ...other.link, handoffId: abandoned.handoffId, digest: reviewed.digest }), rejected);
});

test("protected owner state digest prevents stale replacement and uses existing install invariants", async () => {
  const { f, userId } = await setup();
  const selected = { userId, backendId: "backend", projectId: "project", sourceCredentialId: "agent" };
  const inspection = await f.call(connect.inspectOwnerLink, selected) as { digest: string; highestGeneration: number; review: { existing: unknown[] } };
  assert.equal(inspection.highestGeneration, 1); assert.equal(inspection.review.existing.length, 1);
  const input = { ...selected, id: "replacement", generation: 2, scopes: ["coord:read"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + 120_000, expectedStateDigest: inspection.digest };
  await f.call(oauth.revokeLink, { linkId: f.find("identityLinks", "link")._id, generation: 1 });
  await assert.rejects(f.call(connect.installOwnerLink, input), rejected);
  assert(![...f.rows.values()].some(row => row.id === "replacement"));
  const current = await f.call(connect.inspectOwnerLink, selected) as { digest: string };
  await f.call(connect.installOwnerLink, { ...input, expectedStateDigest: current.digest });
  assert.equal(f.find("identityLinks", "replacement").generation, 2);
});

test("supported installed passkey method emits registration ceremony only and validates username before writes", async () => {
  const f = new ConnectFixture();
  const invalid = await f.call(signin.startSignInWithUsernamePasskey, { username: "" }) as { success: boolean };
  assert.equal(invalid.success, false); assert.equal(f.challenges.length, 0);
  const start = await f.call(signin.startSignInWithUsernamePasskey, { username: "human_example" }) as { success: boolean; step: string; options: { authenticatorSelection: { userVerification: string; residentKey: string }; rp: { id: string } } };
  assert.equal(start.step, "register"); assert.equal(start.options.authenticatorSelection.userVerification, "required"); assert.equal(start.options.authenticatorSelection.residentKey, "required");
  assert.equal(start.options.rp.id, new URL(site).hostname); assert.equal(f.challenges.length, 1);
  assert.equal(f.rows.size, 0); // No Auth app identity, project membership or approval key exists before actual finish.
});

test("connected status rechecks current root and read scope rather than trusting the historical success receipt", async () => {
  for (const cutoff of ["root", "scope"] as const) {
    const { f, link } = await setup(), pending = await handoff(f);
    const view = await f.call(connect.review, { ...link, handoffId: pending.handoffId }) as { digest: string };
    await f.call(connect.complete, { ...link, handoffId: pending.handoffId, digest: view.digest });
    await rpc(f, "tools/call", { name: "coord_finish_connect", arguments: {} });
    assert.equal((await f.call(connect.status, { handoffId: pending.handoffId }) as { state: string }).state, "connected");
    if (cutoff === "scope") f.grant.scopes = ["coord:propose"];
    else {
      const connection = [...f.rows.values()].find(row => row._table === "mcpConnections")!;
      f.patch(f.find("credentials", String(connection.rootCredentialId))._id, { revokedAt: Date.now() });
    }
    await assert.rejects(f.call(connect.status, { handoffId: pending.handoffId }), rejected);
    await assert.rejects(f.call(connect.hostStatus, { bearer: "actual-access" }), rejected);
  }
});

test("terminal handoff races and completion replay preserve one exact consent and reauthorize its source", async () => {
  for (const winner of ["cancel", "complete"] as const) {
    const { f, link } = await setup(), pending = await handoff(f);
    const review = await f.call(connect.review, { ...link, handoffId: pending.handoffId }) as { digest: string };
    const completeArgs = { ...link, handoffId: pending.handoffId, digest: review.digest };
    const results = winner === "cancel"
      ? await Promise.allSettled([f.call(connect.cancel, { handoffId: pending.handoffId }), f.call(connect.complete, completeArgs)])
      : await Promise.allSettled([f.call(connect.complete, completeArgs), f.call(connect.cancel, { handoffId: pending.handoffId })]);
    assert.equal(results[0]!.status, "fulfilled");
    if (winner === "cancel") assert.equal(results[1]!.status, "rejected");
    else {
      const before = structuredClone(f.rows); await f.call(connect.complete, completeArgs); assert.deepEqual(f.rows, before);
      f.patch(f.find("credentials", "agent")._id, { revokedAt: Date.now() });
      await assert.rejects(f.call(connect.complete, completeArgs), rejected);
    }
  }
});

test("no public consent path can create project consent", async () => {
  assert.equal("consentGrant" in oauth, false, "no public un-ceilinged consent mutation is exported");
  // A valid bearer with no browser session reaches onboarding only.
  const bearerOnly = await setup();
  bearerOnly.f.browserUser = null;
  assert.equal((await handoff(bearerOnly.f)).state, "pending");
  await assert.rejects(bearerOnly.f.call(connect.identity, {}), code("UNAUTHORIZED"));
  assert(![...bearerOnly.f.rows.values()].some(row => row._table === "mcpConnections"));
  // A live browser session with no reviewed handoff of its own cannot reach one either.
  for (const state of ["absent", "pending", "cancelled", "expired"] as const) {
    const { f, link } = await setup();
    const pending = state === "absent" ? { handoffId: "a".repeat(64) } : await handoff(f);
    if (state === "cancelled") await f.call(connect.cancel, { handoffId: pending.handoffId });
    if (state === "expired") f.patch(f.find("connectHandoffs", pending.handoffId)._id, { expiresAt: Date.now() - 1 });
    const before = structuredClone(f.rows);
    const expected = state === "absent" ? "NOT_FOUND" : state === "pending" ? "IDEMPOTENCY_CONFLICT" : "FORBIDDEN";
    await assert.rejects(f.call(connect.complete, { handoffId: pending.handoffId, ...link, digest: "f".repeat(64) }), code(expected));
    assert.deepEqual(f.rows, before);
    assert(![...f.rows.values()].some(row => row._table === "mcpConnections"));
  }
  // Only connect.complete, with the exact server-recomputed digest, creates the record.
  const { f, link } = await setup(), pending = await handoff(f);
  const view = await f.call(connect.review, { handoffId: pending.handoffId, ...link }) as { digest: string };
  await assert.rejects(f.call(connect.complete, { handoffId: pending.handoffId, ...link, digest: `${view.digest[0] === "0" ? "1" : "0"}${view.digest.slice(1)}` }), code("IDEMPOTENCY_CONFLICT"));
  assert(![...f.rows.values()].some(row => row._table === "mcpConnections"));
  await f.call(connect.complete, { handoffId: pending.handoffId, ...link, digest: view.digest });
  assert.equal([...f.rows.values()].filter(row => row._table === "mcpConnections").length, 1);
});

test("a grandfathered handoff-less connection still binds and reads back", async () => {
  // Deliberate grandfathering of records written before the reviewed handoff flow existed.
  // Adopting one is NOT a claim that it passed the exact review and digest contract; no new
  // consent can be created this way, which the preceding test pins.
  const { f, link } = await setup();
  await reviewed(f, link);
  const handoffRow = [...f.rows.values()].find(row => row._table === "connectHandoffs")!;
  f.rows.delete(String(handoffRow._id));
  assert.equal((await f.call(connect.hostStatus, { bearer: "actual-access" }) as { state: string }).state, "authorized_awaiting_host");
  const bound = await f.call(connect.finish, { bearer: "actual-access" }) as { state: string; projectId: string };
  assert.equal(bound.state, "bound"); assert.equal(bound.projectId, "project");
  assert.equal((await f.call(connect.hostStatus, { bearer: "actual-access" }) as { state: string }).state, "connected");
  assert(![...f.rows.values()].some(row => row._table === "connectHandoffs"));
});

test("browser connected receipt obeys ordinary metadata, protocol and capability guards after host success", async () => {
  for (const change of [{ writersPaused: true }, { protocolVersion: 999 }, { requiredCapabilities: ["unknown_required_capability"] }] as const) {
    const { f, link } = await setup(), pending = await handoff(f);
    const reviewed = await f.call(connect.review, { ...link, handoffId: pending.handoffId }) as { digest: string };
    await f.call(connect.complete, { ...link, handoffId: pending.handoffId, digest: reviewed.digest });
    await rpc(f, "tools/call", { name: "coord_finish_connect", arguments: {} });
    assert.equal((await f.call(connect.status, { handoffId: pending.handoffId }) as { state: string }).state, "connected");
    const metadata = [...f.rows.values()].find(row => row._table === "metadata")!;
    f.patch(String(metadata._id), change);
    const before = structuredClone(f.rows);
    await assert.rejects(f.call(projects.status, request()), rejected);
    await assert.rejects(f.call(connect.status, { handoffId: pending.handoffId }), rejected);
    assert.deepEqual(f.rows, before);
  }
});

test("paginated link and connection listings cover unbounded history and reach every record exactly once", async () => {
  const { f, userId } = await setup();
  const historical = seedConnections(f, userId, Array.from({ length: 120 }, (_unused, index) => index % 2 ? { revoked: true } : { expired: true }));
  const current = seedConnections(f, userId, Array.from({ length: 7 }, () => ({})));
  await installGenerations(f, userId, 101);
  // identity NEVER refuses on volume. It takes 101 rows per table over the same stable
  // newest-first index ranges, returns at most 100, and the 101st row only flips a boolean.
  // No COVERAGE_INCOMPLETE cap survives anywhere in it, and it exposes no cursor at all.
  const own = await f.call(connect.identity, {}) as { userId: string; links: unknown[]; linksMore: boolean; connections: unknown[]; connectionsMore: boolean };
  assert.deepEqual(Object.keys(own).sort(), ["connections", "connectionsMore", "links", "linksMore", "userId"]);
  assert.equal(own.connectionsMore, true); assert.equal(own.linksMore, true);
  // The stale-tab contract: a no-argument read restores the pre-repair visible volume, so a
  // tab on old JavaScript sees up to 100 records per list rather than a 5-record first page.
  assert.equal(own.connections.length, 100);
  assert(own.links.length <= 100, "identity returns at most 100 link rows");
  assert.doesNotMatch(JSON.stringify(own), /COVERAGE_INCOMPLETE/);
  const connections = await walk("connections", connectionPage(f));
  assert.equal(connections.ids.length, 127); assert.equal(new Set(connections.ids).size, 127);
  assert.deepEqual([...connections.ids].sort(), [...historical, ...current].sort());
  const links = await walk("links", linkPage(f));
  assert.equal(links.ids.length, 102); assert.equal(new Set(links.ids).size, 102);
  assert(connections.pages.every(page => page.length <= 5) && links.pages.every(page => page.length <= 5));
  assert.equal(connections.pages.at(-1)!.length, 2); assert.equal(links.pages.at(-1)!.length, 2);
});

test("a current connection beyond the first page stays reachable and individually revocable", async () => {
  const { f, userId } = await setup();
  const seeded = seedConnections(f, userId, Array.from({ length: 7 }, () => ({})));
  const first = await f.call(connect.connectionPage, {}) as { connections: { connectionId: string }[]; complete: boolean; nextCursor: string | null };
  assert.equal(first.connections.length, 5); assert.equal(first.complete, false);
  const second = await f.call(connect.connectionPage, { cursor: first.nextCursor! }) as { connections: { connectionId: string; revoked: boolean; expired: boolean }[]; complete: boolean; nextCursor: string | null };
  assert.equal(second.connections.length, 2); assert.equal(second.complete, true); assert.equal(second.nextCursor, null);
  const target = second.connections[0]!;
  assert(!first.connections.some(row => row.connectionId === target.connectionId), "this current record is reachable only on page two");
  assert.equal(target.revoked, false); assert.equal(target.expired, false);
  await f.call(oauth.revokeConnection, { connectionId: target.connectionId as Doc<"mcpConnections">["_id"] });
  assert.deepEqual(f.revokedGrants, [String(f.rows.get(target.connectionId)!.grantId)]);
  const walked = await walk("connections", connectionPage(f));
  assert.deepEqual([...walked.ids].sort(), [...seeded].sort(), "the other records stay listed unchanged");
  const rows = walked.pages.flat() as { connectionId: string; revoked: boolean }[];
  assert.deepEqual(rows.filter(row => row.revoked).map(row => row.connectionId), [target.connectionId]);
});

test("a cursor stays usable when a record expires between pages and never restarts the listing", async () => {
  const { f, userId } = await setup();
  const seeded = seedConnections(f, userId, Array.from({ length: 8 }, () => ({})));
  const first = await f.call(connect.connectionPage, {}) as { connections: { connectionId: string }[]; nextCursor: string | null };
  const cursor = first.nextCursor!; assert.equal(typeof cursor, "string");
  // This is the amendment that motivated removing every time value from the paginated index
  // range: a record whose cap elapses after page one must not invalidate the cursor or
  // restart the listing. Expiry is patched onto the row rather than faking the clock.
  const later = seeded.filter(id => !first.connections.some(row => row.connectionId === id));
  f.patch(later[0]!, { absoluteExpiresAt: Date.now() - 1 });
  const second = await f.call(connect.connectionPage, { cursor }) as { connections: { connectionId: string; expired: boolean }[]; complete: boolean };
  assert.equal(second.connections.length, 3); assert.equal(second.complete, true);
  assert(!second.connections.some(row => first.connections.some(seen => seen.connectionId === row.connectionId)), "page two is not a restarted page one");
  assert.deepEqual(second.connections.filter(row => row.expired).map(row => row.connectionId), [later[0]]);
  assert.deepEqual([...first.connections.map(row => row.connectionId), ...second.connections.map(row => row.connectionId)].sort(), [...seeded].sort());
});

test("expiry and revocation are classified for display only and never confer or extend authority", async () => {
  const { f, userId, link } = await setup();
  const [plain, expiredOnly, revokedOnly, both] = seedConnections(f, userId, [{}, { expired: true }, { revoked: true }, { revoked: true, expired: true }]) as [string, string, string, string];
  const classify = (rows: { connectionId: string; revoked: boolean; expired: boolean }[]) => (id: string) => { const row = rows.find(candidate => candidate.connectionId === id); assert(row); return { revoked: row.revoked, expired: row.expired }; };
  const listed = classify((await f.call(connect.connectionPage, { pageSize: 25 }) as { connections: { connectionId: string; revoked: boolean; expired: boolean }[] }).connections);
  assert.deepEqual(listed(plain), { revoked: false, expired: false });
  assert.deepEqual(listed(expiredOnly), { revoked: false, expired: true });
  assert.deepEqual(listed(revokedOnly), { revoked: true, expired: false });
  assert.deepEqual(listed(both), { revoked: true, expired: true });
  const view = await reviewed(f, link);
  await rpc(f, "tools/call", { name: "coord_finish_connect", arguments: {} });
  assert.equal((await f.call(projects.status, request()) as { project: { id: string } }).project.id, "project");
  const real = [...f.rows.values()].find(row => row._table === "mcpConnections" && row.grantId === "grant")!;
  f.patch(String(real._id), { absoluteExpiresAt: Date.now() - 1 });
  const after = classify((await f.call(connect.connectionPage, { pageSize: 25 }) as { connections: { connectionId: string; revoked: boolean; expired: boolean }[] }).connections);
  assert.deepEqual(after(String(real._id)), { revoked: false, expired: true });
  // A listed expired record is still refused by every real protected operation.
  await assert.rejects(f.call(projects.status, request()), code("UNAUTHORIZED"));
  await assert.rejects(f.call(connect.status, { handoffId: view.handoffId }), code("UNAUTHORIZED"));
  await assert.rejects(f.call(connect.finish, { bearer: "actual-access" }), code("UNAUTHORIZED"));
});

test("omitting a cursor restarts page one, and empty or partial pages report completion", async () => {
  const { f, userId } = await setup();
  const fresh = await f.call(oauth.createUser, { method: { name: "fixture", profile: {} } }) as Doc<"users">["_id"];
  f.browserUser = fresh;
  const none = await f.call(connect.identity, {}) as Record<string, unknown>;
  // identity carries no cursor and no completion flag: only the two "more" booleans, which
  // stay false below 100 records. Cursors come from linkPage/connectionPage alone.
  assert.deepEqual(none, { userId: fresh, links: [], linksMore: false, connections: [], connectionsMore: false });
  assert.deepEqual(await f.call(connect.linkPage, {}), { links: [], complete: true, nextCursor: null });
  assert.deepEqual(await f.call(connect.connectionPage, {}), { connections: [], complete: true, nextCursor: null });
  f.browserUser = userId;
  seedConnections(f, userId, Array.from({ length: 7 }, () => ({})));
  const first = await f.call(connect.connectionPage, {}) as { connections: unknown[]; nextCursor: string | null };
  const second = await f.call(connect.connectionPage, { cursor: first.nextCursor! }) as { connections: unknown[]; complete: boolean; nextCursor: string | null };
  assert.equal(second.connections.length, 2); assert.equal(second.complete, true); assert.equal(second.nextCursor, null);
  // No cursor is remembered server-side: omitting it always restarts at page one.
  assert.deepEqual(await f.call(connect.connectionPage, {}), first);
});

test("every listing query refuses an absent browser session and a disabled identity", async () => {
  for (const state of ["absent", "disabled"] as const) {
    const { f, userId } = await setup();
    if (state === "absent") f.browserUser = null; else f.patch(userId, { enabled: false, disabledAt: Date.now() });
    for (const query of [connect.identity, connect.linkPage, connect.connectionPage])
      await assert.rejects(f.call(query as typeof connect.connectionPage, {}), code("UNAUTHORIZED"));
  }
});

test("page size is server-bounded and refused rather than clamped", async () => {
  const { f } = await setup();
  for (const pageSize of [0, 26, -1, 1.5])
    for (const query of [connect.linkPage, connect.connectionPage])
      await assert.rejects(f.call(query as typeof connect.connectionPage, { pageSize }), code("INVALID_INPUT"));
  assert.equal((await f.call(connect.linkPage, { pageSize: 1 }) as { links: unknown[]; complete: boolean }).links.length, 1);
  assert.equal((await f.call(connect.connectionPage, { pageSize: 25 }) as { complete: boolean }).complete, true);
  // identity takes no pageSize at all, so there is no size to clamp or refuse. This fixture
  // invokes _handler directly and therefore bypasses Convex's argument validator, so the
  // declared validator itself is asserted: an empty object validator rejects any argument,
  // including pageSize, before any handler code runs.
  const declaredArgs = (query: unknown) => (query as { exportArgs(): string }).exportArgs();
  assert.equal(declaredArgs(connect.identity), JSON.stringify({ type: "object", value: {} }));
  for (const query of [connect.linkPage, connect.connectionPage])
    assert.match(declaredArgs(query), /"pageSize":\{"fieldType":\{"type":"number"\},"optional":true\}/);
});

test("identity reads each listing table exactly once and never paginates", async () => {
  const { f, userId } = await setup();
  seedConnections(f, userId, Array.from({ length: 3 }, () => ({})));
  await installGenerations(f, userId, 3);
  // A reactive query journal is one opaque value per query function, so a second .paginate()
  // in the same function is unsafe. identity reads two tables, so it must not paginate at
  // all. The fixture counts index reads, which makes a second paginate directly detectable:
  // if identity regained one, probe.paginate would no longer be 0 here.
  f.probe = { paginate: 0, take: [] };
  const own = await f.call(connect.identity, {}) as Record<string, unknown>;
  assert.equal(f.probe.paginate, 0, "identity performs no pagination");
  assert.deepEqual(f.probe.take, ["identityLinks", "mcpConnections"], "exactly one bounded read per table");
  // The counter is a fixture simulation: it proves this handler calls no paginate, not that
  // the Convex runtime would reject a second one. That constraint is a runtime property.
  for (const key of ["linksCursor", "connectionsCursor", "linksComplete", "connectionsComplete", "nextCursor", "cursor"])
    assert.equal(Object.hasOwn(own, key), false, `identity exposes no ${key}`);
  for (const [query, table] of [[connect.linkPage, "identityLinks"], [connect.connectionPage, "mcpConnections"]] as const) {
    f.probe = { paginate: 0, take: [] };
    await f.call(query as typeof connect.connectionPage, {});
    assert.equal(f.probe.paginate, 1, `${table} page uses exactly one paginate`);
    assert.deepEqual(f.probe.take, [], "a page query takes nothing outside its paginated range");
  }
});

test("a degraded link listing never disables connections, and the no-argument first page keeps today's meaning", async () => {
  const { f, userId, link } = await setup();
  seedConnections(f, userId, Array.from({ length: 3 }, () => ({})));
  const before = await f.call(connect.identity, {}) as { userId: string; links: Record<string, unknown>[]; linksMore: boolean; connections: Record<string, unknown>[]; connectionsMore: boolean };
  assert.equal(before.userId, userId); assert.equal(before.links.length, 1);
  // Fewer than 100 records of either kind: both "more" flags stay false.
  assert.equal(before.linksMore, false); assert.equal(before.connectionsMore, false);
  assert.equal(Object.hasOwn(before.links[0]!, "selectable"), false, "identity keeps today's server-filtered link shape");
  assert.deepEqual(Object.keys(before.connections[0]!).sort(), ["absoluteExpiresAt", "connectionId", "expired", "projectId", "revoked"]);
  // Every link now fails its current-authority check, so identity's filtered list is empty.
  // The connections list is read independently in the same query and keeps listing normally.
  f.patch(link.linkId, { revokedAt: Date.now() });
  const degraded = await f.call(connect.identity, {}) as { userId: string; links: unknown[]; linksMore: boolean; connections: unknown[]; connectionsMore: boolean };
  assert.deepEqual(degraded.links, []); assert.equal(degraded.userId, userId); assert.equal(degraded.connections.length, 3);
  assert.equal(degraded.linksMore, false); assert.equal(degraded.connectionsMore, false);
  const listedLinks = await f.call(connect.linkPage, {}) as { links: { selectable: boolean }[] };
  assert.deepEqual(listedLinks.links.map(row => row.selectable), [false]);
  const listedConnections = await f.call(connect.connectionPage, {}) as { connections: unknown[]; complete: boolean };
  assert.equal(listedConnections.connections.length, 3); assert.equal(listedConnections.complete, true);
});

test("owner review lists the complete affected unrevoked set beyond the history preview and revokes all of it", async () => {
  const { f, userId } = await setup();
  await installGenerations(f, userId, 24);
  const stranded = f.find("identityLinks", "history_3")._id;
  // An older generation the replacement sweep never revoked. It falls outside the newest-20
  // history preview, so only the complete affected set can keep it reviewable.
  f.patch(stranded, { revokedAt: undefined });
  const selected = { userId, backendId: "backend", projectId: "project", sourceCredentialId: "agent" };
  const inspection = await f.call(connect.inspectOwnerLink, selected) as { digest: string; highestGeneration: number; review: { highestGeneration: number; affected: { id: string; generation: number }[]; existing: { generation: number }[]; existingTruncated: boolean } };
  assert.equal(inspection.highestGeneration, 25); assert.equal(inspection.review.highestGeneration, 25);
  assert.deepEqual(inspection.review.affected.map(row => row.generation), [3, 25]);
  assert.deepEqual(inspection.review.affected.map(row => row.id), ["history_25", "history_3"].sort((a, b) => Number(a.slice(8)) - Number(b.slice(8))));
  assert.deepEqual(inspection.review.existing.map(row => row.generation), Array.from({ length: 20 }, (_unused, index) => index + 6));
  assert.equal(inspection.review.existingTruncated, true);
  await f.call(connect.installOwnerLink, { ...selected, id: "history_26", generation: 26, scopes: ["coord:read"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + 120_000, expectedStateDigest: inspection.digest });
  assert.equal(typeof f.rows.get(stranded)!.revokedAt, "number", "the stranded older generation is revoked by the replacement");
  assert.equal(typeof f.find("identityLinks", "history_25").revokedAt, "number");
  assert.equal(f.find("identityLinks", "history_26").generation, 26);
});

test("a stale owner inspection or a changed affected set rejects installation", async () => {
  for (const change of ["generation", "affected"] as const) {
    const { f, userId } = await setup();
    await installGenerations(f, userId, 24);
    const stranded = f.find("identityLinks", "history_3")._id as Doc<"identityLinks">["_id"];
    f.patch(stranded, { revokedAt: undefined });
    const selected = { userId, backendId: "backend", projectId: "project", sourceCredentialId: "agent" };
    const stale = await f.call(connect.inspectOwnerLink, selected) as { digest: string };
    if (change === "generation") await installGenerations(f, userId, 1, 26);
    else await f.call(oauth.revokeLink, { linkId: stranded, generation: 3 });
    const current = await f.call(connect.inspectOwnerLink, selected) as { digest: string };
    assert.notEqual(current.digest, stale.digest, "a change to the affected set moves the reviewed state digest");
    const input = { ...selected, id: "replacement", generation: change === "generation" ? 27 : 26, scopes: ["coord:read"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + 120_000 };
    await assert.rejects(f.call(connect.installOwnerLink, { ...input, expectedStateDigest: stale.digest }), code("IDEMPOTENCY_CONFLICT"));
    assert(![...f.rows.values()].some(row => row.id === "replacement"));
    await f.call(connect.installOwnerLink, { ...input, expectedStateDigest: current.digest });
    assert.equal(f.find("identityLinks", "replacement").generation, input.generation);
  }
});

test("a change confined to already-revoked history outside the preview deliberately does not move the digest", async () => {
  const { f, userId } = await setup();
  await installGenerations(f, userId, 24);
  const selected = { userId, backendId: "backend", projectId: "project", sourceCredentialId: "agent" };
  const before = await f.call(connect.inspectOwnerLink, selected) as { digest: string; review: { existing: { generation: number }[]; affected: { id: string }[] } };
  assert.deepEqual(before.review.affected.map(row => row.id), ["history_25"]);
  assert(!before.review.existing.some(row => row.generation === 2), "generation 2 sits outside the newest-20 preview");
  // Deliberate, recorded bound: an already-revoked generation outside the preview is neither
  // affected nor displayed, so changing it cannot move the digest. Such a change only removes
  // authority; it can never revive a dead link, alter the next generation or permit reassignment.
  const outside = f.find("identityLinks", "history_2")._id;
  assert.equal(typeof f.rows.get(outside)!.revokedAt, "number");
  f.patch(outside, { expiresAt: Date.now() + 5, revokedAt: Date.now() + 1, active: false });
  const after = await f.call(connect.inspectOwnerLink, selected) as { digest: string };
  assert.equal(after.digest, before.digest);
});

test("generation monotonicity, link identity collisions and tombstone retention are preserved", async () => {
  const { f, userId } = await setup();
  const base = { userId, backendId: "backend", projectId: "project", sourceCredentialId: "agent", scopes: ["coord:read"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + 120_000 };
  let size = f.rows.size;
  const grew = () => { assert(f.rows.size >= size, "tombstones are never deleted, only added to"); size = f.rows.size; };
  await f.call(oauth.installLink, { ...base, id: "second", generation: 2 }); grew();
  for (const generation of [1, 2]) await assert.rejects(f.call(oauth.installLink, { ...base, id: `rejected_${generation}`, generation }), code("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(f.call(oauth.installLink, { ...base, id: "second", generation: 3 }), code("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(f.call(oauth.installLink, { ...base, id: "link", generation: 3 }), code("IDEMPOTENCY_CONFLICT"));
  grew();
  await f.call(oauth.installLink, { ...base, id: "third", generation: 3 }); grew();
  assert.equal(typeof f.find("identityLinks", "link").revokedAt, "number");
  assert.equal(typeof f.find("identityLinks", "second").revokedAt, "number");
  assert.equal(f.find("identityLinks", "third").revokedAt, undefined);
  assert.equal([...f.rows.values()].filter(row => row._table === "identityLinks").length, 3);
});

test("review and completion retry semantics keep their exact refusal codes", async () => {
  const { f, link } = await setup(), pending = await handoff(f);
  const selector = { handoffId: pending.handoffId, ...link };
  const view = await f.call(connect.review, selector) as { digest: string };
  await assert.rejects(f.call(connect.review, { ...selector, generation: 2 }), code("FORBIDDEN"));
  await assert.rejects(f.call(connect.complete, { ...selector, generation: 2, digest: view.digest }), code("FORBIDDEN"));
  await assert.rejects(f.call(connect.complete, { ...selector, digest: "f".repeat(64) }), code("IDEMPOTENCY_CONFLICT"));
  assert(![...f.rows.values()].some(row => row._table === "mcpConnections"));
  const completed = await f.call(connect.complete, { ...selector, digest: view.digest }) as { state: string };
  const settled = structuredClone(f.rows);
  assert.deepEqual(await f.call(connect.complete, { ...selector, digest: view.digest }), completed);
  assert.deepEqual(f.rows, settled, "completion replay writes nothing new");
  assert.equal([...f.rows.values()].filter(row => row._table === "mcpConnections").length, 1);
  for (const terminal of ["cancelled", "expired"] as const) {
    const other = await setup(), attempt = await handoff(other.f);
    const theirs = { handoffId: attempt.handoffId, ...other.link };
    const shown = await other.f.call(connect.review, theirs) as { digest: string };
    if (terminal === "cancelled") await other.f.call(connect.cancel, theirs);
    else other.f.patch(other.f.find("connectHandoffs", attempt.handoffId)._id, { expiresAt: Date.now() - 1 });
    await assert.rejects(other.f.call(connect.complete, { ...theirs, digest: shown.digest }), code("FORBIDDEN"));
    assert(![...other.f.rows.values()].some(row => row._table === "mcpConnections"));
  }
});

test("listings, refresh and rebinding never move the original cap, and replacement still denies descendants", async () => {
  const { f, userId, link } = await setup();
  const consent = await reviewed(f, link);
  await rpc(f, "tools/call", { name: "coord_finish_connect", arguments: {} });
  const connection = [...f.rows.values()].find(row => row._table === "mcpConnections")!;
  const cap = Number(connection.absoluteExpiresAt);
  assert.equal(cap, consent.absoluteExpiresAt);
  const root = f.find("credentials", String(connection.rootCredentialId));
  const childToken = "d".repeat(64);
  await f.context().db.insert("credentials", { id: "descendant", backendId: root.backendId, memberId: root.memberId, digest: await digest(childToken), role: "run", projectIds: ["project"], expiresAt: root.expiresAt - 1000, ...oauth.childLineage(root) });
  const childRequest = { token: childToken, backendId: "backend", projectId: "project", protocolVersion: 1, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], requestId: "descendant_request" };
  await f.call(handshake, childRequest);
  for (const listing of [connect.identity, connect.linkPage, connect.connectionPage]) await f.call(listing as typeof connect.connectionPage, {});
  await f.call(connect.finish, { bearer: "actual-access" });
  assert.equal(Number(f.rows.get(String(connection._id))!.absoluteExpiresAt), cap, "no listing, refresh or rebind moves the original cap");
  assert.equal((await f.call(connect.status, { handoffId: consent.handoffId }) as { absoluteExpiresAt: number }).absoluteExpiresAt, cap);
  await f.call(oauth.installLink, { id: "next", generation: 2, userId, backendId: "backend", projectId: "project", sourceCredentialId: "agent", scopes: ["coord:read"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + 120_000 });
  await assert.rejects(f.call(handshake, childRequest), code("UNAUTHORIZED"));
  await assert.rejects(f.call(projects.status, request()), code("UNAUTHORIZED"));
  await assert.rejects(f.call(connect.status, { handoffId: consent.handoffId }), code("UNAUTHORIZED"));
  assert.equal(Number(f.rows.get(String(connection._id))!.absoluteExpiresAt), cap);
});
