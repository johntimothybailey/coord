import test from "node:test";
import assert from "node:assert/strict";
import { getFunctionAddress } from "convex/server";
import { BackendFixture } from "./backend.fixture.js";
import type { MutationCtx, Doc } from "../convex/server.js";
import * as auth from "../convex/auth.js";
import * as oauth from "../convex/oauthAuthority.js";
import * as goals from "../convex/goals.js";
import * as connect from "../convex/connect.js";
import { CAPABILITIES, CLIENT_VERSION } from "../src/protocol.js";
import { CONNECTION_CAP_MS } from "../convex/oauthPolicy.js";

// Exported application handlers with simulated component responses. These tests
// do not qualify the live SDK, Convex OCC, browser authentication or any host.
process.env.CONVEX_SITE_URL = "https://oauth-adversarial.convex.site";
const resource = `${process.env.CONVEX_SITE_URL}/mcp`;
const agentToken = "a".repeat(64), humanToken = "b".repeat(64), childToken = "c".repeat(64);
type Grant = { _id: string; _creationTime: number; kind: string; userId: string; clientId: string; resource: string; scopes: string[] };
type Access = { kind: string; userId: string; grantId: string; clientId: string; resource: string; scopes: string[] };
class OAuthFixture extends BackendFixture {
  browserUser: string | null = null;
  sessionLive = true;
  grants: Grant[] = [];
  tokens = new Map<string, Access>();
  verificationTimes: number[] = [];
  override context(): MutationCtx {
    const ctx = super.context();
    ctx.db.normalizeId = ((_table: string, id: string) => this.rows.has(id) ? id : null) as typeof ctx.db.normalizeId;
    ctx.auth = { getUserIdentity: async () => this.browserUser ? { subject: "synthetic-session" } : null } as MutationCtx["auth"];
    ctx.runQuery = (async (reference: unknown, args: Record<string, unknown>) => {
      const address = getFunctionAddress(reference).reference ?? "";
      if (address.endsWith("public/getSession")) return this.sessionLive && this.browserUser ? { userId: this.browserUser } : null;
      if (address.endsWith("grants/list")) return this.grants.filter(grant => grant.userId === args.userId).slice(0, 200);
      if (address.endsWith("tokens/verify")) {
        assert.equal(typeof args.now, "number");
        assert(Math.abs(Date.now() - Number(args.now)) < 1000, "verification uses current server time");
        this.verificationTimes.push(Number(args.now));
        return this.tokens.get(String(args.hash)) ?? null;
      }
      throw new Error(`Unexpected component query ${address}`);
    }) as MutationCtx["runQuery"];
    return ctx;
  }
  patch(id: string, patch: Record<string, unknown>) { const row = this.rows.get(id); assert(row); this.rows.set(id, { ...row, ...patch }); }
}
let serial = 0;
const request = (token = "", oauthBearer: string | undefined = token ? undefined : "synthetic-bearer") => ({ token, ...(oauthBearer === undefined ? {} : { oauthBearer }), protocolVersion: 1, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], backendId: "backend", projectId: "project", requestId: `adversarial_${++serial}` });
const denied = (code = "UNAUTHORIZED") => (error: unknown) => !!error && typeof error === "object" && "data" in error && (error.data as { code?: string }).code === code;
// Project consent has exactly one creator now: connect.complete after an exact
// server-recomputed review. This helper performs that real flow (finish -> review ->
// complete) and returns the old {connectionId, projectId, absoluteExpiresAt} shape.
async function reviewedConsent(f: OAuthFixture, args: { grantId: string; bearer: string; linkId: Doc<"identityLinks">["_id"]; generation: number }) {
  const prior = [...f.rows.values()].find(row => row._table === "connectHandoffs" && row.grantId === args.grantId);
  const handoffId = prior ? String(prior.id) : (await f.call(connect.finish, { bearer: args.bearer }) as { handoffId: string }).handoffId;
  const selector = { handoffId, linkId: args.linkId, generation: args.generation };
  const view = await f.call(connect.review, selector) as { digest: string };
  const done = await f.call(connect.complete, { ...selector, digest: view.digest }) as { projectId: string; absoluteExpiresAt: number };
  const connection = [...f.rows.values()].find(row => row._table === "mcpConnections" && row.grantId === args.grantId);
  assert(connection, "exact reviewed completion is the only writer of project consent");
  return { connectionId: String(connection._id) as Doc<"mcpConnections">["_id"], projectId: done.projectId, absoluteExpiresAt: done.absoluteExpiresAt };
}
const ownHandoffId = (f: OAuthFixture) => String([...f.rows.values()].find(row => row._table === "connectHandoffs")!.id);
async function setup(bind = true, fractionalTime = 0) {
  const f = new OAuthFixture();
  await f.call(auth.bootstrap, { backendId: "backend", projectId: "project", repository: "fixture/repo", remote: "origin", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: ["AGENTS.md"], humanId: "human", humanDigest: await auth.digest(humanToken), agentId: "agent", agentDigest: await auth.digest(agentToken), expiresAt: Date.now() + 3 * CONNECTION_CAP_MS });
  const userId = await (f.call(oauth.createUser, { method: { name: "fixture", profile: {} } }) as Promise<Doc<"users">["_id"]>);
  f.browserUser = userId;
  const link = await f.call(oauth.installLink, { id: "link", generation: 1, userId, backendId: "backend", projectId: "project", sourceCredentialId: "agent", scopes: ["coord:read", "coord:propose", "coord:run"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + 2 * CONNECTION_CAP_MS }) as { linkId: Doc<"identityLinks">["_id"]; generation: number };
  await f.call(oauth.activateLink, link);
  const grant: Grant = { _id: "grant", _creationTime: Date.now() - 1000 + fractionalTime, kind: "oauth", userId, clientId: "client", resource, scopes: ["coord:read", "coord:propose", "coord:run"] };
  f.grants.push(grant);
  const access = { ...grant, grantId: grant._id, kind: "access" };
  f.tokens.set(await auth.digest("synthetic-bearer"), access);
  const consent = await reviewedConsent(f, { grantId: grant._id, bearer: "synthetic-bearer", ...link });
  if (bind) await f.call(oauth.bind, request());
  return { f, userId, link, grant, access, consent };
}

test("browser identity and live session are required for activation, consent and identity", async () => {
  const { f, link, userId, consent } = await setup(false);
  const handoffId = ownHandoffId(f);
  for (const state of ["absent", "expired", "foreign"] as const) {
    f.browserUser = state === "absent" ? null : state === "foreign" ? await (f.call(oauth.createUser, { method: { name: "fixture", profile: {} } }) as Promise<Doc<"users">["_id"]>) : userId;
    f.sessionLive = state !== "expired";
    const before = structuredClone(f.rows);
    await assert.rejects(f.call(oauth.activateLink, link), denied());
    // MOVED from consentForSession: consent now exists only behind the exact reviewed
    // handoff, so a foreign browser session is refused by ownHandoff (NOT_FOUND) and an
    // absent or dead session by sessionUser (UNAUTHORIZED). The preserved invariant is
    // that no browser other than the owning one can turn this grant into project consent.
    const code = state === "foreign" ? "NOT_FOUND" : "UNAUTHORIZED";
    await assert.rejects(f.call(connect.review, { handoffId, ...link }), denied(code));
    await assert.rejects(f.call(connect.complete, { handoffId, ...link, digest: "f".repeat(64) }), denied(code));
    assert.deepEqual(f.rows, before);
  }
  // Bearer-only onboarding with no browser session at all still creates no consent.
  f.browserUser = null; f.sessionLive = true;
  f.rows.delete(consent.connectionId);
  assert.equal((await f.call(connect.finish, { bearer: "synthetic-bearer" }) as { handoffId: string }).handoffId, handoffId);
  assert(![...f.rows.values()].some(row => row._table === "mcpConnections"));
  await assert.rejects(f.call(oauth.identity, {}), denied());
});

test("consent rejects foreign grant, stale generation and wrong resource", async () => {
  const { f, link, grant, access } = await setup(false);
  const handoffId = ownHandoffId(f);
  const before = structuredClone(f.rows);
  // MOVED from consentForSession's FORBIDDEN identity mismatch: a stale generation is now
  // refused by reviewTuple, still FORBIDDEN, before any consent write.
  await assert.rejects(f.call(connect.review, { handoffId, ...link, generation: 2 }), denied("FORBIDDEN"));
  await assert.rejects(f.call(connect.complete, { handoffId, ...link, generation: 2, digest: "f".repeat(64) }), denied("FORBIDDEN"));
  // MOVED from currentGrant inside consentForSession: no caller can name a grant any more.
  // The handoff's grant comes from the verified bearer, so a foreign grant is refused by
  // verifiedAccess inside finish and no handoff for it is ever created.
  f.tokens.set(await auth.digest("foreign-bearer"), { ...access, grantId: "foreign" });
  await assert.rejects(f.call(connect.finish, { bearer: "foreign-bearer" }), denied());
  assert(![...f.rows.values()].some(row => row._table === "connectHandoffs" && row.grantId === "foreign"));
  // MOVED likewise: a grant whose resource is not this deployment's is refused in finish,
  // and the preserved handoff cannot complete against it either.
  grant.resource = "https://foreign.example/mcp";
  await assert.rejects(f.call(connect.finish, { bearer: "synthetic-bearer" }), denied());
  await assert.rejects(f.call(connect.complete, { handoffId, ...link, digest: "f".repeat(64) }), denied());
  assert.deepEqual(f.rows, before);
});

test("binding rejects forged bearer identity, kind, client, resource and project", async () => {
  for (const patch of [{ userId: "foreign" }, { kind: "refresh" }, { clientId: "foreign" }, { resource: "https://foreign.example/mcp" }, { grantId: "foreign" }]) {
    const { f, access } = await setup(false);
    Object.assign(access, patch);
    await assert.rejects(f.call(oauth.bind, request()), denied());
  }
  const { f } = await setup(false);
  await assert.rejects(f.call(oauth.bind, { ...request(), projectId: "foreign" }), denied());
  await assert.rejects(f.call(oauth.bind, { ...request(), token: agentToken }), denied());
});

test("scope intersection and human-only or unknown operations fail closed", async () => {
  const { f, access } = await setup();
  access.scopes = ["coord:read"];
  await f.call(auth.handshake, request());
  await assert.rejects(f.call(goals.propose, { ...request(), goalId: "blocked", expectedRevision: 0, content: "blocked", taskLimit: 1, runTimeoutMs: 60_000 }), denied("FORBIDDEN"));
  await assert.rejects(f.call(goals.approve, { ...request(), goalId: "blocked", revision: 1, hash: "0".repeat(64) }), denied("FORBIDDEN"));
  await assert.rejects(auth.authenticate(f.context(), request(), ["agent"], "invented.operation"), denied("FORBIDDEN"));
  await assert.rejects(auth.authenticate(f.context(), request(), ["agent"]), denied("FORBIDDEN"));
});

test("revoked and expired current authority blocks authenticated binding retries", async () => {
  for (const change of ["user", "membership", "source", "link", "connection", "grant", "cap"] as const) {
    const { f, userId, link, consent } = await setup();
    if (change === "user") f.patch(userId, { enabled: false });
    if (change === "membership") { const row = [...f.rows.values()].find(r => r._table === "memberships")!; f.patch(String(row._id), { revokedAt: Date.now() }); }
    if (change === "source") f.patch(f.find("credentials", "agent")._id, { revokedAt: Date.now() });
    if (change === "link") f.patch(link.linkId, { revokedAt: Date.now() });
    if (change === "connection") f.patch(consent.connectionId, { revokedAt: Date.now() });
    if (change === "grant") f.grants = [];
    if (change === "cap") f.patch(consent.connectionId, { absoluteExpiresAt: Date.now() - 1 });
    await assert.rejects(f.call(oauth.bind, request()), denied());
    await assert.rejects(f.call(auth.handshake, request()), denied());
  }
});

async function childFixture() {
  const setupResult = await setup(); const { f, consent } = setupResult;
  const connection = f.rows.get(consent.connectionId)!;
  const root = f.find("credentials", String(connection.rootCredentialId));
  const id = await f.context().db.insert("credentials", { id: "child", backendId: root.backendId, memberId: root.memberId, digest: await auth.digest(childToken), role: "run", projectIds: ["project"], expiresAt: root.expiresAt - 1000, ...oauth.childLineage(root) });
  return { ...setupResult, root, childId: id };
}

test("child requests reject missing, foreign, cyclic and outlived ancestors", async () => {
  for (const change of ["missing", "foreign", "cycle", "expiry", "absolute", "scope", "revoked"] as const) {
    const { f, root, childId } = await childFixture();
    if (change === "missing") f.patch(childId, { parentCredentialId: "missing" });
    if (change === "foreign") f.patch(root._id, { memberId: "foreign" });
    if (change === "cycle") f.patch(root._id, { parentCredentialId: "child" });
    if (change === "expiry") f.patch(childId, { expiresAt: root.expiresAt + 1 });
    if (change === "absolute") f.patch(childId, { absoluteExpiresAt: root.absoluteExpiresAt! + 1 });
    if (change === "scope") f.patch(root._id, { oauthScopes: ["coord:read"] });
    if (change === "revoked") f.patch(root._id, { revokedAt: Date.now() });
    await assert.rejects(f.call(auth.handshake, request(childToken, undefined)), denied());
  }
});

test("missing grant beyond newest 200 denies without claiming revocation or writing query state", async () => {
  const { f, grant, consent } = await setup();
  f.grants = Array.from({ length: 200 }, (_, i) => ({ ...grant, _id: `newer_${i}`, _creationTime: grant._creationTime + i + 1 })).concat(grant);
  const before = structuredClone(f.rows);
  await assert.rejects(f.call(auth.handshake, request()), denied());
  assert.deepEqual(f.rows, before);
  assert.equal(f.rows.get(consent.connectionId)?.revokedAt, undefined);
});

test("bearer rotation cannot reset original cap; valid queries perform no writes", async () => {
  const { f, access, consent, grant } = await setup();
  assert.equal(consent.absoluteExpiresAt, grant._creationTime + CONNECTION_CAP_MS);
  const before = structuredClone(f.rows);
  await f.call(auth.handshake, request());
  f.tokens.delete(await auth.digest("synthetic-bearer"));
  f.tokens.set(await auth.digest("refreshed-bearer"), access);
  await assert.rejects(f.call(auth.handshake, request()), denied());
  await f.call(auth.handshake, { ...request(), oauthBearer: "refreshed-bearer" });
  assert.deepEqual(f.rows, before);
  const rebound = await f.call(oauth.bind, { ...request(), oauthBearer: "refreshed-bearer" }) as { absoluteExpiresAt: number };
  assert.equal(rebound.absoluteExpiresAt, consent.absoluteExpiresAt);
  assert(f.verificationTimes.length >= 4);
});

test("malformed historical OAuth linkage cannot fall back to legacy credentials", async () => {
  const { f } = await setup();
  f.patch(f.find("credentials", "agent")._id, { parentCredentialId: "foreign" });
  await assert.rejects(f.call(auth.handshake, request(agentToken, undefined)), denied());
});

test("binding refuses incompatible protocol and paused writers before creating a credential", async () => {
  for (const state of ["protocol", "request", "paused"] as const) {
    const { f } = await setup(false);
    if (state === "paused") { const row = [...f.rows.values()].find(r => r._table === "metadata")!; f.patch(String(row._id), { writersPaused: true }); }
    const args = { ...request(), ...(state === "protocol" ? { protocolVersion: 999 } : state === "request" ? { requestId: "invalid/request" } : {}) };
    const before = structuredClone(f.rows);
    await assert.rejects(f.call(oauth.bind, args));
    assert.deepEqual(f.rows, before);
  }
});

test("link installation rejects non-finite timestamp limits", async () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    const { f, userId } = await setup(false);
    await assert.rejects(f.call(oauth.installLink, { id: "bad_limits", generation: 2, userId, backendId: "backend", projectId: "project", sourceCredentialId: "agent", scopes: ["coord:read"], activationExpiresAt: invalid, expiresAt: invalid }));
  }
});


test("fractional component creation timestamps preserve their exact cap", async () => {
  const { f, grant, consent } = await setup(true, 0.25);
  assert.equal(consent.absoluteExpiresAt, grant._creationTime + CONNECTION_CAP_MS);
  await f.call(auth.handshake, request());
});

test("all existing legacy roles remain usable with provenance-free historical rows", async () => {
  const { f } = await setup();
  const original = f.find("credentials", "agent");
  for (const [index, role] of (["human", "agent", "run", "supervisor", "artifact_verifier"] as const).entries()) {
    const token = String(index + 1).repeat(64);
    const { _id: omittedId, _creationTime: omittedTime, ...source } = original;
    void omittedId; void omittedTime;
    await f.context().db.insert("credentials", { ...source, id: `historical_${role}`, role, digest: await auth.digest(token) });
    await f.call(auth.handshake, request(token));
  }
});

test("a valid bearer cannot create its own missing browser consent", async () => {
  const { f, consent } = await setup(false);
  f.rows.delete(consent.connectionId);
  f.browserUser = null;
  const before = structuredClone(f.rows);
  await assert.rejects(f.call(oauth.bind, request()), denied());
  assert.deepEqual(f.rows, before);
});

test("an already elapsed grant cap cannot be revived by a new browser consent", async () => {
  const { f, consent, grant, link } = await setup(false);
  const handoffId = ownHandoffId(f);
  f.rows.delete(consent.connectionId);
  grant._creationTime = Date.now() - CONNECTION_CAP_MS - 1;
  const before = structuredClone(f.rows);
  // MOVED from consentForSession's expired-ceiling check: the elapsed cap is refused by
  // verifiedAccess inside finish, and the preserved handoff's own grant comparison refuses
  // replay. Either way an elapsed 24-hour cap can never be restarted by a browser.
  await assert.rejects(f.call(connect.finish, { bearer: "synthetic-bearer" }), denied());
  await assert.rejects(f.call(connect.complete, { handoffId, ...link, digest: "f".repeat(64) }), denied());
  assert.deepEqual(f.rows, before);
  assert(![...f.rows.values()].some(row => row._table === "mcpConnections"));
});

test("a revoked consent cannot be recreated by replaying its exact reviewed completion", async () => {
  const { f, consent, link } = await setup(false);
  const handoffId = ownHandoffId(f);
  const view = await f.call(connect.review, { handoffId, ...link }) as { digest: string };
  f.patch(consent.connectionId, { revokedAt: Date.now() });
  const before = structuredClone(f.rows);
  // The exact digest still matches, so the refusal comes from currentConnection on the
  // immutable prior record: a revoked consent is a tombstone, never a free slot.
  await assert.rejects(f.call(connect.complete, { handoffId, ...link, digest: view.digest }), denied());
  assert.deepEqual(f.rows, before);
  assert.equal([...f.rows.values()].filter(row => row._table === "mcpConnections").length, 1);
});

test("replacing a link generation cuts off an existing child and cannot reassign its grant", async () => {
  const { f, userId, link, grant, consent } = await childFixture();
  await f.call(auth.handshake, request(childToken));
  const originalConnection = structuredClone(f.rows.get(consent.connectionId));
  const replacement = await f.call(oauth.installLink, { id: "replacement_link", generation: 2, userId, backendId: "backend", projectId: "project", sourceCredentialId: "agent", scopes: ["coord:read", "coord:propose", "coord:run"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + CONNECTION_CAP_MS }) as { linkId: Doc<"identityLinks">["_id"]; generation: number };
  assert.equal(typeof f.rows.get(link.linkId)?.revokedAt, "number");
  await assert.rejects(f.call(auth.handshake, request(childToken)), denied());
  await f.call(oauth.activateLink, replacement);
  const handoffId = ownHandoffId(f);
  const beforeRetry = structuredClone(f.rows);
  // MOVED from consentForSession's immutable-consent check: the completed handoff's reviewed
  // tuple cannot change, so reassigning this grant to the replacement generation is refused
  // as IDEMPOTENCY_CONFLICT, and a fresh host finish still denies on the revoked link.
  await assert.rejects(f.call(connect.review, { handoffId, ...replacement }), denied("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(f.call(connect.complete, { handoffId, ...replacement, digest: "f".repeat(64) }), denied("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(f.call(connect.finish, { bearer: "synthetic-bearer" }), denied());
  await assert.rejects(f.call(auth.handshake, request(childToken)), denied());
  assert.deepEqual(f.rows, beforeRetry);
  assert.deepEqual(f.rows.get(consent.connectionId), originalConnection, "the original grant binding remains as a tombstone");
  assert.equal([...f.rows.values()].filter(row => row._table === "mcpConnections" && row.grantId === grant._id).length, 1);
});

test("successful domain mutation replay reauthorizes current grant and scopes", async () => {
  for (const cutoff of ["revoked", "narrowed"] as const) {
    const { f, grant } = await setup();
    const args = { ...request(), goalId: "replay_goal", expectedRevision: 0, content: "A previously authorized goal", taskLimit: 1, runTimeoutMs: 60_000 };
    const accepted = await f.call(goals.propose, args);
    assert.deepEqual(await f.call(goals.propose, args), accepted, "the same request replays while authority remains active");
    assert.equal(f.find("goals", args.goalId).revision, 1);
    assert.equal([...f.rows.values()].filter(row => row._table === "idempotency" && row.requestId === args.requestId).length, 1);
    if (cutoff === "revoked") f.grants = [];
    else grant.scopes = ["coord:read"];
    const beforeRetry = structuredClone(f.rows);
    await assert.rejects(f.call(goals.propose, args), denied(cutoff === "revoked" ? "UNAUTHORIZED" : "FORBIDDEN"));
    assert.deepEqual(f.rows, beforeRetry, "denied replay must not alter the goal or recorded result");
  }
});
