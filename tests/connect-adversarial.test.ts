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
  await assert.rejects(f.call(connect.review, { ...replacement, handoffId: pending.handoffId }), rejected);
  await assert.rejects(f.call(oauth.consentGrant, { ...replacement, grantId: "grant" }), rejected);
  await assert.rejects(handoff(f), rejected);
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
