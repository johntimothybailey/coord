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

test("public foundation consent cannot bypass any existing Connect handoff and no-handoff clients remain compatible", async () => {
  for (const state of ["pending", "cancelled", "expired"] as const) {
    const { f, link } = await setup(), pending = await handoff(f);
    if (state === "cancelled") await f.call(connect.cancel, { handoffId: pending.handoffId });
    if (state === "expired") f.patch(f.find("connectHandoffs", pending.handoffId)._id, { expiresAt: Date.now() - 1 });
    await assert.rejects(f.call(oauth.consentGrant, { ...link, grantId: "grant" }), rejected);
    assert.equal((await handoff(f)).state, state);
    assert(![...f.rows.values()].some(row => row._table === "mcpConnections"));
  }
  const { f, link } = await setup();
  await f.call(oauth.consentGrant, { ...link, grantId: "grant" });
  assert.equal((await f.call(connect.hostStatus, { bearer: "actual-access" }) as { state: string }).state, "authorized_awaiting_host");
  await f.call(connect.finish, { bearer: "actual-access" });
  assert.equal((await f.call(connect.hostStatus, { bearer: "actual-access" }) as { state: string }).state, "connected");
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
