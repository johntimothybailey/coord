import test from "node:test";
import assert from "node:assert/strict";
import { getFunctionAddress, getFunctionName, httpRouter } from "convex/server";
import type { MutationCtx, Doc } from "../convex/server.js";
import { BackendFixture } from "./backend.fixture.js";
import * as auth from "../convex/auth.js";
import * as oauth from "../convex/oauthAuthority.js";
import * as goals from "../convex/goals.js";
import * as projects from "../convex/projects.js";
import * as tasks from "../convex/tasks.js";
import * as machines from "../convex/machines.js";
import * as approvalRequests from "../convex/approvalRequests.js";
import * as memories from "../convex/memories.js";
import * as messages from "../convex/messages.js";
import * as checkpoints from "../convex/checkpoints.js";
import * as lifecycle from "../convex/lifecycle.js";
import { verifiedRun } from "../convex/artifacts.js";
import { CONNECTION_CAP_MS, OAUTH_SCOPES, operationScope } from "../convex/oauthPolicy.js";
import { CAPABILITIES, CLIENT_VERSION, REQUIRED_CHECKS } from "../src/protocol.js";
import * as mcpConsent from "../convex/mcpConsent.js";
import { mcpIngress } from "../convex/mcpIngress.js";

// Real application + installed package handlers over synthetic serialized DBs.
// The fixture assumes Convex already verified ctx.auth's JWT. No live browser,
// issuance, cryptographic JWT verification, OCC or host qualification is claimed.
type ComponentRow = Record<string, unknown> & { _id: string; _creationTime: number };
type Handler = { _handler(ctx: unknown, args: Record<string, unknown>): Promise<unknown> };
const componentUrl = (name: "mcp" | "auth", file: string) => new URL(`./dist/component/${file}.js`, import.meta.resolve(`@convex-dev/${name}/package.json`));
const mcpTokens = await import(componentUrl("mcp", "tokens").href) as { verify: Handler };
const mcpGrants = await import(componentUrl("mcp", "grants").href) as { list: Handler; revoke: Handler };
const mcpOauth = await import(componentUrl("mcp", "oauth").href) as { getAuthRequest: Handler; decideAuthRequest: Handler };
const authPublic = await import(componentUrl("auth", "public").href) as { getSession: Handler };
process.env.CONVEX_SITE_URL = "https://oauth-foundation.convex.site";
const resource = `${process.env.CONVEX_SITE_URL}/mcp`;
const secrets = { agent: "1".repeat(64), human: "2".repeat(64), run: "3".repeat(64), supervisor: "4".repeat(64), verifier: "5".repeat(64), legacySupervisor: "6".repeat(64), legacyVerifier: "7".repeat(64) };
const key = { os: "fixture", harness: "codex" as const, harnessVersion: "fixture", adapterVersion: "fixture", probeVersion: "1", configurationDigest: "fixture", gitPolicyDigest: "fixture" };
let serial = 0;
function request(token = "", bearer = "access-one") { return { token, ...(token ? {} : { oauthBearer: bearer }), backendId: "backend", projectId: "project", protocolVersion: 1, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], requestId: `foundation_${++serial}` }; }
const denied = (error: unknown) => !!error && typeof error === "object" && "data" in error;
class ComponentFixture extends BackendFixture {
  componentRows = new Map<string, Map<string, ComponentRow>>();
  subject: string | null = "session";
  calls: string[] = [];
  table(name: string) { let rows = this.componentRows.get(name); if (!rows) { rows = new Map(); this.componentRows.set(name, rows); } return rows; }
  componentContext() {
    const f = this;
    return { db: {
      normalizeId(table: string, id: string) { return f.table(table).has(id) ? id : null; },
      async get(table: string, id: string) { return structuredClone(f.table(table).get(id) ?? null); },
      async patch(table: string, id: string, patch: Record<string, unknown>) { const row = f.table(table).get(id); assert(row); f.table(table).set(id, { ...row, ...patch }); },
      async delete(table: string, id: string) { f.table(table).delete(id); },
      query(table: string) {
        const predicates: Array<(row: ComponentRow) => boolean> = [];
        let direction = "asc";
        const query = {
          withIndex(_index: string, build: (q: unknown) => unknown) { const q = { eq(field: string, value: unknown) { predicates.push(row => row[field] === value); return q; } }; build(q); return query; },
          order(order: string) { direction = order; return query; },
          async take(n: number) { return [...f.table(table).values()].filter(row => predicates.every(p => p(row))).sort((a, b) => (a._creationTime - b._creationTime) * (direction === "desc" ? -1 : 1)).slice(0, n).map(row => structuredClone(row)); },
          async unique() { const rows = await query.take(2); assert(rows.length < 2); return rows[0] ?? null; },
        }; return query;
      },
    } };
  }
  override context(): MutationCtx {
    const ctx = super.context();
    ctx.auth = { getUserIdentity: async () => this.subject ? { subject: this.subject } : null } as MutationCtx["auth"];
    ctx.runQuery = (async (ref: unknown, args: Record<string, unknown>) => {
      const address = getFunctionAddress(ref).reference ?? "";
      this.calls.push(address);
      if (address.endsWith("tokens/verify")) return mcpTokens.verify._handler(this.componentContext(), args);
      if (address.endsWith("grants/list")) return mcpGrants.list._handler(this.componentContext(), args);
      if (address.endsWith("public/getSession")) return authPublic.getSession._handler(this.componentContext(), args);
      if (address.endsWith("oauth/getAuthRequest")) return mcpOauth.getAuthRequest._handler(this.componentContext(), args);
      const name = getFunctionName(ref as never);
      if (name === "oauthAuthority:browserIdentity") return (oauth.browserIdentity as unknown as Handler)._handler(this.context(), args);
      if (name === "oauthAuthority:inspectBearer") return this.call(oauth.inspectBearer, args as { bearer: string });
      if (name === "projects:status") return this.call(projects.status, args as ReturnType<typeof request>);
      throw new Error(`Unexpected fixture query ${address || name}`);
    }) as MutationCtx["runQuery"];
    ctx.runMutation = (async (ref: unknown, args: Record<string, unknown>) => {
      const address = getFunctionAddress(ref).reference ?? "";
      if (address.endsWith("oauth/decideAuthRequest")) return mcpOauth.decideAuthRequest._handler(this.componentContext(), args);
      if (address.endsWith("grants/revoke")) return mcpGrants.revoke._handler(this.componentContext(), args);
      throw new Error("Unexpected telemetry or mutation");
    }) as MutationCtx["runMutation"];
    return ctx;
  }
  patch(id: string, value: Record<string, unknown>) { const row = this.rows.get(id); assert(row); this.rows.set(id, { ...row, ...value }); }
}
async function foundation(grantAge = 1000) {
  const f = new ComponentFixture();
  await f.call(auth.bootstrap, { backendId: "backend", projectId: "project", repository: "https://example.test/repo", remote: "origin", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: [], humanId: "human", humanDigest: await auth.digest(secrets.human), agentId: "agent", agentDigest: await auth.digest(secrets.agent), expiresAt: Date.now() + 3 * CONNECTION_CAP_MS });
  const userId = await f.call(oauth.createUser, { method: { name: "fixture", profile: { email: "never-authority@example.test" } } }) as Doc<"users">["_id"];
  f.table("sessions").set("session", { _id: "session", _creationTime: Date.now(), userId });
  const link = await f.call(oauth.installLink, { id: "link", generation: 1, userId, backendId: "backend", projectId: "project", sourceCredentialId: "agent", scopes: [...OAUTH_SCOPES], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + 2 * CONNECTION_CAP_MS }) as { linkId: Doc<"identityLinks">["_id"]; generation: number };
  await f.call(oauth.activateLink, link);
  f.table("grants").set("grant", { _id: "grant", _creationTime: Date.now() - grantAge + 0.25, kind: "oauth", userId, clientId: "client", resource, scopes: [...OAUTH_SCOPES], name: "Fixture" });
  f.table("tokens").set("access", { _id: "access", _creationTime: Date.now(), hash: await auth.digest("access-one"), grantId: "grant", kind: "access", expiresAt: Date.now() + 300_000 });
  const consent = await f.call(oauth.consentGrant, { ...link, grantId: "grant" }) as { connectionId: Doc<"mcpConnections">["_id"]; absoluteExpiresAt: number };
  const binding = await f.call(oauth.bind, request()) as { credentialId: string; absoluteExpiresAt: number };
  return { f, userId, link, consent, binding };
}
async function runnable(grantAge = 1000) {
  const state = await foundation(grantAge), { f, binding } = state;
  await f.call(projects.configure, { ...request(secrets.human), repository: "https://example.test/repo", remote: "origin", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: [], sharingApproved: true, capturePolicyDigest: "d".repeat(64), capacity: 2, taskCap: 10 });
  const goal = await f.call(goals.propose, { ...request(), goalId: "goal", expectedRevision: 0, content: "Fixture", taskLimit: 5, runTimeoutMs: 1800_000 }) as { revision: number; hash: string };
  await f.call(goals.approve, { ...request(secrets.human), goalId: "goal", ...goal });
  const qualification = { backendId: "backend", projectId: "project", memberId: "agent", machineId: "machine", capacity: 1, modes: ["managed" as const], key, checks: REQUIRED_CHECKS.managed.map(checkId => ({ schemaVersion: 1 as const, checkId, status: "PASS" as const, mode: "managed" as const, observedAt: new Date(Date.now() - 1000).toISOString(), configurationDigest: "fixture", command: ["fixture-only"], summary: "Synthetic qualification only", evidenceRef: "fixture", kind: "real" as const })), evidenceRef: "fixture", expiresAt: Math.min(Date.now() + 600_000, binding.absoluteExpiresAt) };
  await f.call(machines.provisionQualification, { ...qualification, oauthParentCredentialId: binding.credentialId, supervisorId: "supervisor", supervisorToken: secrets.supervisor, artifactVerifierId: "verifier", artifactVerifierToken: secrets.verifier });
  await f.call(machines.provisionQualification, { ...qualification, supervisorId: "legacy_supervisor", supervisorToken: secrets.legacySupervisor, artifactVerifierId: "legacy_verifier", artifactVerifierToken: secrets.legacyVerifier });
  await f.call(tasks.propose, { ...request(), taskId: "task", goalId: "goal", goalRevision: 1, title: "Fixture", scope: ["src/work.ts"], dependencies: [], executionBase: { sha: "a".repeat(40), revision: 1, remoteRef: "refs/heads/main" } });
  const admission = { ...request(), taskId: "task", runId: "run", launchId: "launch", grantToken: secrets.run, machineId: "machine", harness: "codex" as const, capabilityKey: key };
  await f.call(tasks.claim, admission);
  const identity = { taskId: "task", runId: "run", epoch: 1, goalRevision: 1 };
  await f.call(lifecycle.starting, { ...request(secrets.run), ...identity });
  return { ...state, identity };
}

test("installed Auth session and MCP handlers drive activation, consent, binding and read without writes", async () => {
  const { f, userId, binding, consent } = await foundation();
  assert.deepEqual(await f.call(oauth.identity, {}), { userId });
  assert.equal(binding.absoluteExpiresAt, consent.absoluteExpiresAt);
  assert.equal(consent.absoluteExpiresAt, Number(f.table("grants").get("grant")!._creationTime) + CONNECTION_CAP_MS);
  const before = structuredClone(f.rows);
  const result = await f.call(auth.handshake, request()) as { backendProtocolVersion: number }; assert.equal(result.backendProtocolVersion, 1);
  assert.deepEqual(f.rows, before);
  assert(f.calls.some(call => call.endsWith("tokens/verify")) && f.calls.some(call => call.endsWith("grants/list")) && f.calls.some(call => call.endsWith("public/getSession")));
  assert(!JSON.stringify([...f.rows.values()]).includes("access-one"));
  // Revocation is actual installed getSession returning null on absent session.
  f.table("sessions").delete("session");
  await assert.rejects(f.call(oauth.identity, {}), denied);
  // Convex's expired JWT boundary is modeled by no authenticated identity.
  f.subject = null; await assert.rejects(f.call(oauth.activateLink, { linkId: f.find("identityLinks", "link")._id, generation: 1 }), denied);
});

test("installed verifier rejects expired access while admitted children survive routine rotation", async () => {
  const { f, identity, consent } = await runnable();
  const run = f.find("credentials", "grant_run");
  assert(run.parentCredentialId && run.connectionId === consent.connectionId);
  f.table("tokens").get("access")!.expiresAt = Date.now() - 1;
  await assert.rejects(f.call(auth.handshake, request()), denied);
  await f.call(tasks.renew, { ...request(secrets.run), ...identity });
  f.table("tokens").set("rotated", { _id: "rotated", _creationTime: Date.now(), hash: await auth.digest("access-two"), grantId: "grant", kind: "access", expiresAt: Date.now() + 300_000 });
  const rebound = await f.call(oauth.bind, request("", "access-two")) as { absoluteExpiresAt: number };
  assert.equal(rebound.absoluteExpiresAt, consent.absoluteExpiresAt);
  f.table("grants").get("grant")!.scopes = ["coord:read"];
  await assert.rejects(f.call(tasks.renew, { ...request(secrets.run), ...identity }), denied);
});

test("all scope families are explicit and unknown, human, dispatch and export operations deny", () => {
  const sample = { "coord:read": "projects.status", "coord:propose": "goals.propose", "coord:approval-request": "approvalRequests.requestRule", "coord:run": "tasks.renew", "coord:supervise": "lifecycle.authorizeLaunch", "coord:artifact": "scans.upload", "coord:verify": "scans.verify", "coord:message": "messages.send" };
  for (const [scope, operation] of Object.entries(sample)) assert.equal(operationScope(operation, "agent"), scope);
  for (const operation of [undefined, "new.operation", "goals.approve", "exports.page", "dispatch.runnable", "approvalAuth.finishEnrollment"]) assert.equal(operationScope(operation, "agent"), undefined);
});

test("legacy supervisors and verifiers cannot authorize a target with revoked OAuth ancestry", async () => {
  const { f, identity, consent } = await runnable();
  const process = { pid: 42, bootId: "fixture", startIdentity: "fixture", launchId: "launch" };
  f.patch(consent.connectionId, { revokedAt: Date.now() });
  await assert.rejects(f.call(lifecycle.authorizeLaunch, { ...request(secrets.legacySupervisor), ...identity, process }), denied);
  await assert.rejects(verifiedRun(f.context(), { ...request(secrets.legacyVerifier), ...identity }, f.find("credentials", "legacy_verifier")), denied);
  // Cleanup records uncertainty without treating dead target authority as live.
  await f.call(lifecycle.reportUncertain, { ...request(secrets.legacySupervisor), ...identity, reason: "Fixture cutoff" });
  const receipt = await f.call(lifecycle.confirmStopped, { ...request(secrets.legacySupervisor), ...identity, evidence: { kind: "proven_never_started", machineId: "machine", launchId: "launch", observedAt: new Date().toISOString(), evidenceRef: "fixture" } }) as { receipt: string };
  assert(receipt.receipt);
});

test("MCP forwards a request-local bearer into the domain transaction and read review needs no touch", async () => {
  const { f } = await foundation();
  const ctx = f.context() as unknown as Parameters<typeof mcpIngress.handleMcp>[0];
  const response = await mcpIngress.handleMcp(ctx, new Request(`${resource}`, { method: "POST", headers: { Authorization: "Bearer access-one", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "coord_status", arguments: Object.fromEntries(Object.entries(request()).filter(([key]) => key !== "token" && key !== "oauthBearer")) } }) }));
  assert.equal(response.status, 200);
  assert(!JSON.stringify(await response.json()).includes('"isError":true'));
  const token = f.table("tokens").get("access")!; token.expiresAt = Date.now() - 1;
  assert.equal((await mcpIngress.handleMcp(ctx, new Request(resource, { method: "POST", headers: { Authorization: "Bearer access-one" }, body: "{}" }))).status, 401);
});

test("narrowed target scope denies launch and artifact checks for legacy and other live connection callers", async () => {
  for (const caller of ["legacy", "other_connection"] as const) {
    const { f, identity, link, userId } = await runnable();
    let supervisor = secrets.legacySupervisor, verifier = secrets.legacyVerifier;
    if (caller === "other_connection") {
      f.table("grants").set("grant_two", { _id: "grant_two", _creationTime: Date.now(), kind: "oauth", userId, clientId: "client_two", resource, scopes: ["coord:read", "coord:supervise", "coord:verify"], name: "Other connection" });
      f.table("tokens").set("access_other", { _id: "access_other", _creationTime: Date.now(), hash: await auth.digest("access-other"), grantId: "grant_two", kind: "access", expiresAt: Date.now() + 300_000 });
      await f.call(oauth.consentGrant, { ...link, grantId: "grant_two" });
      const binding = await f.call(oauth.bind, request("", "access-other")) as { credentialId: string };
      supervisor = "8".repeat(64); verifier = "9".repeat(64);
      await f.call(machines.provisionQualification, { backendId: "backend", projectId: "project", memberId: "agent", oauthParentCredentialId: binding.credentialId, machineId: "machine", capacity: 1, modes: ["managed"], key, checks: REQUIRED_CHECKS.managed.map(checkId => ({ schemaVersion: 1 as const, checkId, status: "PASS" as const, mode: "managed" as const, observedAt: new Date(Date.now() - 1000).toISOString(), configurationDigest: "fixture", command: ["fixture"], summary: "Fixture", evidenceRef: "fixture", kind: "real" as const })), evidenceRef: "fixture", expiresAt: Date.now() + 300_000, supervisorId: "other_supervisor", supervisorToken: supervisor, artifactVerifierId: "other_verifier", artifactVerifierToken: verifier });
    }
    f.table("grants").get("grant")!.scopes = ["coord:read"];
    await assert.rejects(f.call(lifecycle.authorizeLaunch, { ...request(supervisor), ...identity, process: { pid: 42, bootId: "fixture", startIdentity: "fixture", launchId: "launch" } }), denied);
    const actor = f.find("credentials", caller === "legacy" ? "legacy_verifier" : "other_verifier");
    await assert.rejects(verifiedRun(f.context(), { ...request(verifier), ...identity }, actor), denied);
  }
});

test("accepted authority transitions audit once without bearer or profile data", async () => {
  const { f, link, binding } = await foundation();
  const before = [...f.rows.values()].filter(row => row._table === "audit").length;
  await f.call(oauth.activateLink, link);
  await f.call(oauth.consentGrant, { ...link, grantId: "grant" });
  assert.deepEqual(await f.call(oauth.bind, request()), binding);
  assert.equal([...f.rows.values()].filter(row => row._table === "audit").length, before);
  const serialized = JSON.stringify([...f.rows.values()]);
  assert(!serialized.includes("access-one") && !serialized.includes("never-authority@example.test"));
});

test("admission and renewal retain the original 24-hour cap through refresh and expiry", async t => {
  const { f, identity, consent } = await runnable(CONNECTION_CAP_MS - 60_000);
  const run = f.find("runs", "run"), grant = f.find("credentials", "grant_run");
  assert.equal(run.deadline, consent.absoluteExpiresAt);
  assert.equal(grant.expiresAt, consent.absoluteExpiresAt);
  assert(run.leaseUntil <= consent.absoluteExpiresAt);
  await f.call(tasks.renew, { ...request(secrets.run), ...identity });
  assert(f.find("runs", "run").leaseUntil <= consent.absoluteExpiresAt);
  t.mock.method(Date, "now", () => consent.absoluteExpiresAt + 1);
  await assert.rejects(f.call(tasks.renew, { ...request(secrets.run), ...identity }), denied);
  await assert.rejects(f.call(oauth.bind, request()), denied);
});

test("unconfigured consent returns a clear refusal and keeps protected approval routes", async () => {
  const router = httpRouter(); mcpIngress.registerRoutes(router);
  const route = router.getRoutes().find(([path, method]) => path === "/mcp/oauth/authorize" && method === "GET");
  assert(route);
  const response = await (route[2] as unknown as { _handler(ctx: unknown, req: Request): Promise<Response> })._handler({}, new Request(`${resource}/oauth/authorize`));
  assert.equal(response.status, 503); assert.match(await response.text(), /not configured/);
  const approvalRouter = (await import("../convex/http.js")).default;
  for (const path of ["/approval", "/approval/app.js", "/approval/style.css", "/approval/challenge", "/approval/review", "/approval/decide", "/approval/enrollment-options", "/approval/enrollment-candidate"]) assert(approvalRouter.getRoutes().some(([candidate]) => candidate === path));
});

test("browser authorization APIs require live enabled identity and delegate to installed SDK/component handlers", async () => {
  const { f, userId } = await foundation();
  f.table("clients").set("client", { _id: "client", _creationTime: Date.now(), clientId: "client", clientName: "Unverified client", redirectUris: ["https://client.example/callback"] });
  f.table("authRequests").set("request", { _id: "request", _creationTime: Date.now(), requestId: "request", kind: "redirect", clientId: "client", resource, scopes: ["coord:read"], redirectUri: "https://client.example/callback", status: "pending", expiresAt: Date.now() + 60_000 });
  const authorize = mcpConsent.authorize as unknown as Handler;
  for (const missing of ["identity", "session", "enabled"] as const) {
    f.subject = missing === "identity" ? null : "session";
    if (missing === "session") f.table("sessions").delete("session");
    else f.table("sessions").set("session", { _id: "session", _creationTime: Date.now(), userId });
    if (missing === "enabled") f.patch(userId, { enabled: false });
    await assert.rejects(f.call(mcpConsent.getAuthRequest, { requestId: "request" }));
    await assert.rejects(authorize._handler(f.context(), { requestId: "request", approve: true }));
    assert.equal(f.table("authRequests").get("request")!.status, "pending");
  }
  f.patch(userId, { enabled: true });
  const details = await f.call(mcpConsent.getAuthRequest, { requestId: "request" }) as { clientId: string };
  assert.equal(details.clientId, "client");
  const accepted = await authorize._handler(f.context(), { requestId: "request", approve: true }) as { redirectUrl: string };
  assert.equal(new URL(accepted.redirectUrl).origin, "https://client.example");
  const stored = f.table("authRequests").get("request")!;
  assert.equal(stored.userId, userId); assert.equal(stored.status, "approved");
  assert.equal(typeof stored.codeHash, "string");
  assert(!JSON.stringify(stored).includes(new URL(accepted.redirectUrl).searchParams.get("code")!));
});

const scopeDenied = (error: unknown) => denied(error) && (error as { data: { code?: string } }).data.code === "FORBIDDEN";
async function startRunnable() {
  const state = await runnable();
  await state.f.call(lifecycle.authorizeLaunch, { ...request(secrets.supervisor), ...state.identity, process: { pid: 42, bootId: "fixture", startIdentity: "fixture", launchId: "launch" } });
  return state;
}

test("OAuth approval-request scope permits exact proposed-rule request and current scope removal denies replay", async () => {
  const { f } = await runnable();
  const proposed = await f.call(memories.proposeRule, { ...request(), memoryId: "scope_rule", content: "Keep scoped work focused.", sources: [{ kind: "repository", repository: "https://example.test/repo", revision: "a".repeat(40), path: "src/work.ts", contentHash: "b".repeat(64) }], applicability: ["src/work.ts"], confidence: "Fixture declaration" }) as { memoryId: string; revision: number; hash: string };
  const exact = { ...request(), ...proposed };
  const view = await f.call(approvalRequests.requestRule, exact) as { state: string; authorityGranted: boolean };
  assert.equal(view.state, "pending"); assert.equal(view.authorityGranted, false);
  assert.equal(f.find("memories", proposed.memoryId).status, "proposed");
  f.table("grants").get("grant")!.scopes = OAUTH_SCOPES.filter(scope => scope !== "coord:approval-request");
  const before = structuredClone(f.rows);
  await assert.rejects(f.call(approvalRequests.requestRule, exact), scopeDenied);
  await assert.rejects(f.call(approvalRequests.cancel, { ...request(), approvalRequestId: exact.requestId }), scopeDenied);
  assert.deepEqual(f.rows, before);
});

test("OAuth message scope permits bound-run send/read/receipt and current scope removal denies reads and replay", async () => {
  const { f, identity } = await startRunnable();
  const input = { ...request(secrets.run), ...identity, messageId: "scope_message", recipientTaskId: "task", recipientEpoch: 1, type: "coordination", payload: "Fixture self-addressed coordination", conflict: false };
  assert.deepEqual(await f.call(messages.send, input), { messageId: "scope_message", state: "queued" });
  const page = await f.call(messages.read, { ...request(secrets.run), ...identity }) as { messages: Array<{ id: string }> };
  assert.deepEqual(page.messages.map(message => message.id), ["scope_message"]);
  await f.call(messages.receipt, { ...request(secrets.run), ...identity, messageId: "scope_message", state: "delivered_to_bridge" });
  assert.equal(f.find("messages", "scope_message").state, "delivered_to_bridge");
  f.table("grants").get("grant")!.scopes = OAUTH_SCOPES.filter(scope => scope !== "coord:message");
  const before = structuredClone(f.rows);
  await assert.rejects(f.call(messages.send, input), scopeDenied);
  await assert.rejects(f.call(messages.read, { ...request(secrets.run), ...identity }), scopeDenied);
  await assert.rejects(f.call(messages.receipt, { ...request(secrets.run), ...identity, messageId: "scope_message", state: "acknowledged_by_agent" }), scopeDenied);
  assert.deepEqual(f.rows, before);
});

test("OAuth artifact scope permits real checkpoint preparation and current scope removal denies replay", async () => {
  const { f, identity } = await startRunnable();
  await f.call(tasks.progress, { ...request(secrets.run), ...identity, expectedRevision: 0, progress: "Fixture checkpoint progress" });
  const task = f.find("tasks", "task");
  const progressHash = await auth.digest(auth.canonical(task.progress));
  const core = { identity, sourceHead: "b".repeat(40), executionBase: task.executionBase, tree: "c".repeat(40), files: [{ path: "src/work.ts", mode: "100644", type: "blob" as const, oid: "e".repeat(40) }], exclusions: [], progressHash, policyDigest: "d".repeat(64), progressRevision: task.progressRevision };
  const manifest = { schemaVersion: 1 as const, checkpointId: "scope_checkpoint", ...core, remoteParent: task.executionBase.sha, commit: "f".repeat(40), ref: "refs/coord/checkpoints/task/e1/scope_checkpoint", evidence: [], createdAt: new Date().toISOString(), manifestDigest: await auth.digest(auth.canonical(core)), reusedCommit: false };
  const input = { ...request(secrets.run), ...identity, manifest, summary: task.progress };
  const prepared = await f.call(checkpoints.prepare, input) as { checkpointId: string; state: string };
  assert.equal(prepared.checkpointId, "scope_checkpoint"); assert.equal(prepared.state, "prepared");
  assert.equal(f.find("checkpoints", "scope_checkpoint").runId, "run");
  const authority = await f.call(checkpoints.authority, { ...request(secrets.run), ...identity }) as { identity: typeof identity };
  assert.deepEqual(authority.identity, identity);
  f.table("grants").get("grant")!.scopes = OAUTH_SCOPES.filter(scope => scope !== "coord:artifact");
  const before = structuredClone(f.rows);
  await assert.rejects(f.call(checkpoints.prepare, input), scopeDenied);
  await assert.rejects(f.call(checkpoints.authority, { ...request(secrets.run), ...identity }), scopeDenied);
  assert.deepEqual(f.rows, before);
});

test("OAuth verifier scope is checked on its own live connection while target run retains run/artifact authority", async () => {
  const { f, identity, link, userId } = await startRunnable();
  f.table("grants").set("verifier_grant", { _id: "verifier_grant", _creationTime: Date.now(), kind: "oauth", userId, clientId: "verifier_client", resource, scopes: ["coord:read", "coord:supervise", "coord:verify"], name: "Separate verifier connection" });
  f.table("tokens").set("verifier_access", { _id: "verifier_access", _creationTime: Date.now(), hash: await auth.digest("verifier-access"), grantId: "verifier_grant", kind: "access", expiresAt: Date.now() + 300_000 });
  await f.call(oauth.consentGrant, { ...link, grantId: "verifier_grant" });
  const binding = await f.call(oauth.bind, request("", "verifier-access")) as { credentialId: string };
  const verifierToken = "a".repeat(64);
  await f.call(machines.provisionQualification, { backendId: "backend", projectId: "project", memberId: "agent", oauthParentCredentialId: binding.credentialId, machineId: "machine", capacity: 1, modes: ["managed"], key, checks: REQUIRED_CHECKS.managed.map(checkId => ({ schemaVersion: 1 as const, checkId, status: "PASS" as const, mode: "managed" as const, observedAt: new Date(Date.now() - 1000).toISOString(), configurationDigest: "fixture", command: ["fixture"], summary: "Fixture", evidenceRef: "fixture", kind: "real" as const })), evidenceRef: "fixture", expiresAt: Date.now() + 300_000, supervisorId: "scope_supervisor", supervisorToken: "b".repeat(64), artifactVerifierId: "scope_verifier", artifactVerifierToken: verifierToken });
  const input = { ...request(verifierToken), ...identity };
  const result = await f.call(checkpoints.authority, input) as { identity: typeof identity };
  assert.deepEqual(result.identity, identity);
  assert(!f.find("credentials", "scope_verifier").oauthScopes!.includes("coord:run"));
  f.table("grants").get("verifier_grant")!.scopes = ["coord:read", "coord:supervise"];
  assert((f.table("grants").get("grant")!.scopes as string[]).includes("coord:run"));
  assert((f.table("grants").get("grant")!.scopes as string[]).includes("coord:artifact"));
  const before = structuredClone(f.rows);
  await assert.rejects(f.call(checkpoints.authority, input), scopeDenied);
  assert.deepEqual(f.rows, before);
});
