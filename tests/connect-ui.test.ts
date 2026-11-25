import test from "node:test";
import assert from "node:assert/strict";
import { httpRouter } from "convex/server";
import { registerConnectRoutes, connectHtml } from "../convex/connectPage.js";
import { connectJs } from "../convex/connectAssets.generated.js";
import { startConnect, creationOptions, requestOptions, credentialResponse, scopeDescription, expiryDescription } from "../web/connect.js";

const site = "https://connect-ui.convex.site", backend = "https://connect-ui.convex.cloud";
// Browser API and RPC fixtures only: no authenticator, signed JWT, live account
// or Convex deployment is qualified by these tests.
class Element {
  textContent = ""; open = false; hidden = false; disabled = false; value = ""; className = ""; type = ""; children: Element[] = [];
  parent?: Element;
  onclick?: () => void; onchange?: () => void; onsubmit?: (event: { preventDefault(): void }) => void;
  constructor(readonly tag: string) {}
  append(child: Element) { child.parent?.detach(child); child.parent = this; this.children.push(child); if (this.tag === "select" && !this.value) this.value = child.value; }
  detach(child: Element) { const index = this.children.indexOf(child); if (index >= 0) this.children.splice(index, 1); }
  replaceChildren() { for (const child of this.children) child.parent = undefined; this.children = []; this.value = ""; }
  removeAttribute(name: string) { if (name === "disabled") this.disabled = false; }
}
class Storage {
  items = new Map<string, string>();
  get length() { return this.items.size; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, value); }
  removeItem(key: string) { this.items.delete(key); }
}
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail("Browser fixture did not settle"); }
const content = (element: Element): string => [element.textContent, ...element.children.map(content)].join(" ");
const descend = (element: Element): Element[] => [element, ...element.children.flatMap(descend)];
const control = (element: Element, label: string) => descend(element).find(child => child.tag === "button" && child.textContent === label);
const cards = (element: Element) => element.children.filter(child => child.className === "item");
const selector = (card: Element, key: "connectionId" | "linkId") => String((JSON.parse(descend(card).find(child => child.tag === "pre")!.textContent) as Record<string, unknown>)[key]);
const tokens = { accessToken: "fixture.access.signature", refreshToken: "private-refresh-canary", refreshTokenExpiresAt: Date.now() + 600_000, userId: "public-user" };
type Row = Record<string, unknown>;
type Section = "links" | "connections";
async function browser(query = "", options: { existing?: boolean; nativeNull?: boolean; review?: () => Promise<unknown>; finish?: () => Promise<unknown>; listing?: { links?: Row[][]; connections?: Row[][]; malformed?: Section } } = {}) {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); };
  const elements = new Map<string, Element>(), all: Element[] = [];
  for (const match of connectHtml.matchAll(/<(\w+)[^>]*\bid="([^"]+)"([^>]*)>/g)) { const element = new Element(match[1]!); element.hidden = match[3]!.includes("hidden"); elements.set(match[2]!, element); all.push(element); }
  const storage = new Storage(), calls: { path: string; args: Record<string, unknown> }[] = [];
  const history: string[] = [], navigation: string[] = [];
  // Page rows always carry an explicit selectability verdict; links classify on it alone.
  const link = { linkId: "link", generation: 1, backendId: "backend", projectId: "project", sourceCredentialId: "agent", scopes: ["coord:read"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + 600_000, active: false, selectable: true };
  const connection = { connectionId: "connection", projectId: "project", absoluteExpiresAt: Date.now() + 600_000, revoked: false, expired: false };
  let state = "pending", nativeCalls = 0, failPage: Section | null = null;
  // Each section is an independent list of pages served by connect:linkPage /
  // connect:connectionPage. identity serves no page and no cursor at all.
  const pageOf = (key: Section, cursor: unknown) => {
    const all = options.listing?.[key] ?? [[key === "links" ? link : connection] as Row[]];
    const index = typeof cursor === "string" && cursor ? Number(cursor) : 0;
    const complete = index >= all.length - 1;
    return { rows: all[index] ?? [], complete, nextCursor: complete ? null : String(index + 1) };
  };
  const credential = { id: "public-key-id", rawId: new Uint8Array([1, 2]).buffer, response: { clientDataJSON: new Uint8Array([3]).buffer, attestationObject: new Uint8Array([4]).buffer, authenticatorData: new Uint8Array([5]).buffer, signature: new Uint8Array([6]).buffer, userHandle: null, getTransports: () => ["internal"] } };
  install("window", { isSecureContext: true, addEventListener() {}, removeEventListener() {} });
  install("PublicKeyCredential", class {});
  install("navigator", { credentials: { create: async () => { nativeCalls++; return options.nativeNull ? null : credential; }, get: async () => { nativeCalls++; return options.nativeNull ? null : credential; } } });
  install("document", { getElementById: (id: string) => elements.get(id), querySelectorAll: () => all.filter(element => element.tag === "button"), createElement: (tag: string) => { const element = new Element(tag); all.push(element); return element; } });
  install("sessionStorage", storage); install("history", { replaceState: (_a: unknown, _b: unknown, value: string) => history.push(value) });
  install("location", { origin: site, pathname: "/connect", search: query, assign: (value: string) => navigation.push(value) });
  install("fetch", async (input: string, init?: RequestInit) => {
    if (input === "/connect/config") return Response.json({ siteOrigin: site, backendUrl: backend });
    assert.ok(String(input).startsWith(backend + "/api/"));
    const payload = JSON.parse(String(init?.body)) as { path: string; args: Record<string, unknown>[] }; const args = payload.args[0]!; calls.push({ path: payload.path, args });
    let value: unknown;
    switch (payload.path) {
      case "authSignin:startSignInWithUsernamePasskey": value = { success: true, step: options.existing ? "authenticate" : "register", options: { challenge: "AQI", rp: { id: "connect-ui.convex.site", name: "Coord" }, rpId: "connect-ui.convex.site", user: { id: "Aw", name: "name", displayName: "name" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: [], allowCredentials: [], userVerification: "required" } }; break;
      case "authSignin:finishSignUpWithUsernamePasskey": case "authSignin:finishSignInWithUsernamePasskey": value = options.finish ? await options.finish() : { status: "complete", tokens }; break;
      case "authCore:refreshSession": value = { kind: "rotated", tokens }; break;
      case "authCore:signOut": value = null; break;
      case "connect:identity": {
        // New contract: no pagination, no cursor, no completion flag and no pageSize
        // argument. A bounded non-failing read of at most 100 rows per list plus a "more"
        // boolean, kept only so a tab on old JavaScript still sees its records. This client
        // reads userId and deliberately ignores both lists.
        assert.deepEqual(args, {}, "identity is called with no arguments");
        const links = (options.listing?.links ?? [[link] as Row[]]).flat();
        const connections = (options.listing?.connections ?? [[connection] as Row[]]).flat();
        const visible = links.filter(row => row.selectable !== false).slice(0, 100).map(({ selectable: _verdict, ...row }) => row);
        value = { userId: "public-user", links: visible, linksMore: links.length > 100, connections: connections.slice(0, 100), connectionsMore: connections.length > 100 };
        break;
      }
      // malformed makes one section's own page query return an unreadable listing. Rendering
      // comes from the page queries now, so this is where a broken section originates.
      case "connect:linkPage": { if (failPage === "links") throw new Error("Synthetic listing failure"); const page = pageOf("links", args.cursor); value = options.listing?.malformed === "links" ? { links: "unavailable", complete: true, nextCursor: null } : { links: page.rows, complete: page.complete, nextCursor: page.nextCursor }; break; }
      case "connect:connectionPage": { if (failPage === "connections") throw new Error("Synthetic listing failure"); const page = pageOf("connections", args.cursor); value = options.listing?.malformed === "connections" ? { connections: "unavailable", complete: true, nextCursor: null } : { connections: page.rows, complete: page.complete, nextCursor: page.nextCursor }; break; }
      case "oauthAuthority:activateLink": link.active = true; value = { active: true }; break;
      // Revocation marks the exact record the caller named, as the backend does, and deletes
      // nothing: a revoked connection stays listed as a tombstone on the next page read.
      case "oauthAuthority:revokeConnection": { if (args.connectionId === connection.connectionId) connection.revoked = true; for (const page of options.listing?.connections ?? []) for (const row of page) if (row.connectionId === args.connectionId) row.revoked = true; value = { revoked: true }; break; }
      case "connect:status": value = { state }; break;
      case "connect:review": value = options.review ? await options.review() : { state, review: { handoffId: args.handoffId, grantId: "grant", userId: "public-user", clientId: "client", resource: backend.replace(".cloud", ".site") + "/mcp", grantCreatedAt: Date.now() - 1_000, backendId: "backend", projectId: "project", sourceCredentialId: "agent", linkId: "link", generation: 1, scopes: ["coord:read"], absoluteExpiresAt: connection.absoluteExpiresAt }, digest: "d".repeat(64) }; break;
      case "connect:complete": state = "authorized_awaiting_host"; value = { state, projectId: "project", absoluteExpiresAt: connection.absoluteExpiresAt }; break;
      case "connect:cancel": state = "cancelled"; value = { state }; break;
      case "mcpConsent:getAuthRequest": value = { kind: "redirect", clientId: "client", clientName: "<img src=untrusted> declared client", redirectUri: "http://127.0.0.1:1234/callback", scopes: ["coord:read"], status: "pending" }; break;
      case "mcpConsent:authorize": value = { redirectUrl: "http://127.0.0.1:1234/callback?code=private-code-canary&state=private-state-canary" }; break;
      default: throw new Error("Unexpected fixture RPC " + payload.path);
    }
    return Response.json({ status: "success", value, logLines: [] });
  });
  const get = (id: string) => elements.get(id)!;
  await startConnect();
  const submit = async () => { get("signin-form").onsubmit!({ preventDefault() {} }); await until(() => !get("login").disabled); };
  return { get, calls, storage, navigation, history, all, link, connection, get nativeCalls() { return nativeCalls; }, setState(value: string) { state = value; }, setFailPage(value: Section | null) { failPage = value; }, submit, restore() { for (const [name, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, name, descriptor) : Reflect.deleteProperty(globalThis, name); } };
}

test("Connect routes derive public origins, preserve security headers and version fixed assets without changing approval routes", async () => {
  const previous = { site: process.env.CONVEX_SITE_URL, cloud: process.env.CONVEX_CLOUD_URL };
  process.env.CONVEX_SITE_URL = site; process.env.CONVEX_CLOUD_URL = backend;
  try {
    const router = httpRouter(); registerConnectRoutes(router);
    const get = async (path: string, origin = site) => { const route = router.lookup(path, "GET"); assert(route); return (route[0] as unknown as { _handler(ctx: unknown, request: Request): Promise<Response> })._handler({}, new Request(origin + path)); };
    const html = await get("/connect"); assert.equal(html.status, 200); assert.equal(html.headers.get("Cache-Control"), "no-store"); assert.equal(html.headers.get("Referrer-Policy"), "no-referrer"); assert.equal(html.headers.get("X-Frame-Options"), "DENY"); assert.match(html.headers.get("Content-Security-Policy")!, /connect-src 'self' https:\/\/connect-ui.convex.cloud/);
    assert.match(await html.text(), /app.js\?v=[a-f0-9]{64}" integrity="sha256-/);
    assert.deepEqual(await (await get("/connect/config")).json(), { siteOrigin: site, backendUrl: backend });
    assert.equal((await get("/connect", "https://foreign.example")).status, 403);
    assert.match(await (await get("/connect/third-party-notices.txt")).text(), /Apache License/); assert.equal(await (await get("/connect/app.js")).text(), connectJs); assert.equal(router.lookup("/approval", "GET"), null);
    delete process.env.CONVEX_CLOUD_URL; assert.equal((await get("/connect")).status, 503);
  } finally { if (previous.site === undefined) delete process.env.CONVEX_SITE_URL; else process.env.CONVEX_SITE_URL = previous.site; if (previous.cloud === undefined) delete process.env.CONVEX_CLOUD_URL; else process.env.CONVEX_CLOUD_URL = previous.cloud; }
});

test("native WebAuthn conversion uses only the installed method's wire fields", () => {
  assert.deepEqual([...new Uint8Array(creationOptions({ challenge: "AQI", user: { id: "Aw", name: "u", displayName: "u" }, excludeCredentials: [{ id: "BA", type: "public-key" }] }).challenge as Uint8Array<ArrayBuffer>)], [1, 2]);
  assert.equal(requestOptions({ challenge: "AQI", allowCredentials: [{ id: "Aw", type: "public-key" }] }).allowCredentials?.[0]?.type, "public-key");
  const response = credentialResponse({ id: "id", rawId: new Uint8Array([1]).buffer, response: { clientDataJSON: new Uint8Array([2]).buffer, authenticatorData: new Uint8Array([3]).buffer, signature: new Uint8Array([4]).buffer, userHandle: null } } as unknown as PublicKeyCredential, false);
  assert.deepEqual(response, { id: "id", rawId: "AQ", type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: "Ag", authenticatorData: "Aw", signature: "BA" } });
});

test("browser confirms account creation, activates exact own link, reviews binding and distinguishes awaiting host from connected", async () => {
  const f = await browser("?handoff=" + "a".repeat(64) + "&code=must-not-store&state=must-not-store");
  try {
    f.get("username").value = "new-user"; await f.submit();
    assert.match(f.get("status").textContent, /username is new/); assert.equal(f.get("login").textContent, "Create account with passkey"); assert.equal(f.nativeCalls, 0);
    await f.submit(); assert.equal(f.get("user-id").textContent, "public-user"); assert.equal(f.nativeCalls, 1); assert.equal(f.get("account").hidden, false);
    assert.match(content(f.get("links")), /Agent access source agent/); assert.match(content(f.get("links")), /UTC/); assert.match(content(f.get("links")), /Read project status/);
    assert.equal(f.get("links").children[0]!.children.find(child => child.tag === "details")!.open, false);
    assert.match(content(f.get("connection-list")), /Registered record — current authority is not confirmed/);
    f.get("links").children[0]!.children.find(child => child.tag === "button")!.onclick!(); await until(() => f.link.active && !f.get("refresh").disabled);
    f.get("review").onclick!(); await until(() => !f.get("complete").hidden); assert.match(f.get("binding").textContent, /"projectId": "project"/);
    const readable = content(f.get("binding-summary"));
    assert.match(readable, /Project project/); assert.match(readable, /Backend backend/); assert.match(readable, /Agent access source agent/); assert.match(readable, /UTC/); assert.match(readable, /browser-clock estimate/); assert.match(readable, /Read project status/);
    assert.equal(f.get("binding-details").hidden, false); assert.equal(f.get("binding-details").open, false);
    for (const field of ["grantId", "userId", "resource", "generation", "digest"]) assert.match(f.get("binding").textContent, new RegExp(field));
    assert.match(f.get("binding-boundary").textContent || connectHtml, /no human approval authority/);
    f.get("complete").onclick!(); await until(() => f.get("status").textContent.includes("awaiting the host")); assert.doesNotMatch(f.get("status").textContent, /^Connected/);
    assert.deepEqual(f.calls.find(call => call.path === "connect:complete")?.args, { handoffId: "a".repeat(64), linkId: "link", generation: 1, digest: "d".repeat(64) });
    f.setState("connected"); f.get("refresh").onclick!(); await until(() => f.get("status").textContent.startsWith("Connected:"));
    assert.deepEqual(f.history, ["/connect"]); assert(!JSON.stringify([...f.storage.items]).includes("must-not-store"));
    assert(!f.all.some(element => /private-refresh-canary|fixture.access.signature/.test(element.textContent)));
    f.storage.setItem("coord-connect:https://other-backend.convex.cloud:auth:keep", "unrelated-session");
    f.get("signout").onclick!(); await until(() => !f.get("login").disabled); assert.equal(f.storage.length, 1); assert.equal(f.storage.getItem("coord-connect:https://other-backend.convex.cloud:auth:keep"), "unrelated-session"); assert.equal(f.get("account").hidden, true); assert.equal(f.calls.find(call => call.path === "authCore:signOut")?.args.refreshToken, tokens.refreshToken);
  } finally { f.restore(); }
});

test("OAuth labels stay text, denial remains separate and authorization codes never enter DOM/storage", async () => {
  const f = await browser("?request=mcp_req_fixture", { existing: true });
  try {
    f.get("username").value = "existing"; await f.submit(); assert.equal(f.get("login").textContent, "Sign in with passkey"); await f.submit();
    assert.match(f.get("oauth-details").textContent, /<img src=untrusted>/); assert.match(content(f.get("oauth-summary")), /unverified label/); assert.match(content(f.get("oauth-summary")), /Read project status/); assert.match(content(f.get("oauth-summary")), /pending/); assert.equal(f.get("oauth-exact").open, false); f.get("oauth-deny").onclick!(); await until(() => !f.get("return-client").hidden);
    assert.match(f.get("status").textContent, /denied/); assert.equal(f.calls.find(call => call.path === "mcpConsent:authorize")?.args.approve, false);
    assert(!f.all.some(element => /private-code-canary|private-state-canary/.test(element.textContent))); assert(!JSON.stringify([...f.storage.items]).includes("private-code-canary"));
    f.get("return-client").onclick!(); assert.match(f.navigation[0]!, /code=private-code-canary/);
  } finally { f.restore(); }
});

test("a late sign-in result after cancellation cannot restore local identity or session", async () => {
  let finish!: (value: unknown) => void;
  const f = await browser("", { finish: () => new Promise(resolve => { finish = resolve; }) });
  try {
    f.get("username").value = "cancelled"; await f.submit(); f.get("signin-form").onsubmit!({ preventDefault() {} }); await until(() => typeof finish === "function");
    f.get("abort").onclick!(); finish({ status: "complete", tokens }); await until(() => f.calls.some(call => call.path === "authCore:signOut"));
    assert.equal(f.get("account").hidden, true); assert.equal(f.storage.length, 0); assert.match(f.get("status").textContent, /cancelled locally/);
  } finally { f.restore(); }
});


test("pending cancellation and expired readback never offer project authorization", async () => {
  const f = await browser("?handoff=" + "b".repeat(64));
  try {
    f.get("username").value = "cancel-attempt"; await f.submit(); await f.submit();
    f.get("cancel").onclick!(); await until(() => f.get("status").textContent.includes("cancelled"));
    assert.equal(f.get("review").hidden, true); assert.equal(f.get("complete").hidden, true); assert.equal(f.get("cancel").hidden, true);
    f.setState("expired"); f.get("refresh").onclick!(); await until(() => f.get("status").textContent.includes("expired"));
    assert.equal(f.get("review").hidden, true); assert.equal(f.get("complete").hidden, true);
    assert.equal(f.calls.some(call => call.path === "connect:complete"), false);
  } finally { f.restore(); }
});


test("a null native passkey result reports cancellation and a retry starts a fresh challenge", async () => {
  const f = await browser("", { nativeNull: true });
  try {
    f.get("username").value = "native-cancel"; await f.submit(); await f.submit();
    assert.match(f.get("status").textContent, /Passkey interaction cancelled/);
    assert.equal(f.calls.some(call => call.path.includes(":finishSign")), false); assert.equal(f.storage.length, 0);
    await f.submit(); assert.equal(f.calls.filter(call => call.path === "authSignin:startSignInWithUsernamePasskey").length, 2);
  } finally { f.restore(); }
});


test("a late project review cannot authorize a changed selection", async () => {
  let review!: (value: unknown) => void;
  const f = await browser("?handoff=" + "c".repeat(64), { review: () => new Promise(resolve => { review = resolve; }) });
  try {
    f.get("username").value = "selection-race"; await f.submit(); await f.submit();
    f.get("links").children[0]!.children.find(child => child.tag === "button")!.onclick!(); await until(() => f.link.active && !f.get("refresh").disabled);
    f.get("review").onclick!(); await until(() => typeof review === "function");
    f.get("project-choice").value = "another-selection"; f.get("project-choice").onchange!();
    review({ state: "pending", review: { projectId: "old-project" }, digest: "d".repeat(64) });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.get("complete").hidden, true); assert.equal(f.get("binding-details").hidden, true); assert.equal(f.get("binding-summary").hidden, true);
    assert.match(f.get("handoff-note").textContent, /selection changed/); assert.equal(f.calls.some(call => call.path === "connect:complete"), false);
  } finally { f.restore(); }
});


test("scope and expiry summaries explain permissions without inventing authority or an OAuth request deadline", () => {
  assert.match(scopeDescription("coord:approval-request"), /does not approve/);
  assert.match(scopeDescription("coord:run"), /separately admitted, qualified/);
  assert.match(scopeDescription("unknown"), /Unrecognized permission/);
  assert.match(expiryDescription(Date.UTC(2026, 10, 18, 5, 0), Date.UTC(2026, 10, 18, 4, 0)), /2026-11-18 05:00:00.000 UTC · about 1 hour 0 minutes remaining/);
  assert.match(expiryDescription(undefined), /Expiry unavailable/);
  assert.equal(connectHtml.includes('<details id="binding-details" open'), false);
  assert.equal(connectHtml.includes('<details id="oauth-exact" open'), false);
});

test("paged listings offer Show more only with a live cursor, append the next page and withhold actions from non-current records", async () => {
  const current = { connectionId: "connection-current", projectId: "project", absoluteExpiresAt: Date.now() + 600_000, revoked: false, expired: false };
  const expired = { connectionId: "connection-expired", projectId: "project", absoluteExpiresAt: Date.now() - 1_000, revoked: false, expired: true };
  const revoked = { connectionId: "connection-revoked", projectId: "project", absoluteExpiresAt: Date.now() + 600_000, revoked: true, expired: false };
  const active = { linkId: "active-link", generation: 2, backendId: "backend", projectId: "project", sourceCredentialId: "agent", scopes: ["coord:read"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + 600_000, active: true, selectable: true };
  const stale = { ...active, linkId: "stale-link", generation: 1, selectable: false };
  const f = await browser("", { listing: { links: [[active], [stale]], connections: [[current], [expired, revoked]] } });
  try {
    f.get("username").value = "paged"; await f.submit(); await f.submit();
    assert(control(f.get("links"), "Show more project links"), "a live link cursor offers Show more");
    assert(control(f.get("connection-list"), "Show more connections"), "a live connection cursor offers Show more");
    assert.equal(cards(f.get("connection-list")).length, 1);
    assert(control(f.get("connection-list"), "Disconnect this exact connection"), "an unrevoked record offers Disconnect");
    control(f.get("connection-list"), "Show more connections")!.onclick!();
    await until(() => cards(f.get("connection-list")).length === 3);
    // The second page appends; no record is replaced and the exhausted cursor drops the control.
    assert.deepEqual(cards(f.get("connection-list")).map(card => selector(card, "connectionId")), [current.connectionId, expired.connectionId, revoked.connectionId]);
    assert.equal(control(f.get("connection-list"), "Show more connections"), undefined);
    // Expiry is Coord's application cap, not grant revocation, so credential cleanup stays
    // offered on the expired record; only the revoked tombstone has nothing left to remove.
    assert.deepEqual(cards(f.get("connection-list")).filter(card => control(card, "Disconnect this exact connection")).map(card => selector(card, "connectionId")), [current.connectionId, expired.connectionId]);
    assert.match(content(f.get("connection-list")), /Coord access expired — this is not the same as the grant being revoked/);
    assert.match(content(f.get("connection-list")), /Revoked record — it was disconnected and its OAuth grant was removed/);
    // A non-selectable link is listed as a card with no Activate button and stays out of the select.
    assert.deepEqual(f.get("project-choice").children.map(option => option.value), ["active-link"]);
    control(f.get("links"), "Show more project links")!.onclick!();
    await until(() => cards(f.get("links")).length === 2);
    const listed = cards(f.get("links"));
    assert.deepEqual(listed.map(card => selector(card, "linkId")), ["active-link", "stale-link"]);
    assert.equal(control(listed[1]!, "Activate this project link"), undefined);
    assert.match(content(listed[1]!), /Not selectable — current authority unavailable/);
    assert.match(content(listed[1]!), /no project permission is implied/);
    assert.deepEqual(f.get("project-choice").children.map(option => option.value), ["active-link"]);
    assert.equal(control(f.get("links"), "Show more project links"), undefined);
  } finally { f.restore(); }
});

test("a failed listing page clears only its own section and offers a reload that re-reads page one", async () => {
  const first = { connectionId: "connection-one", projectId: "project", absoluteExpiresAt: Date.now() + 600_000, revoked: false, expired: false };
  const next = { connectionId: "connection-two", projectId: "project", absoluteExpiresAt: Date.now() + 600_000, revoked: false, expired: false };
  const f = await browser("", { listing: { connections: [[first], [next]] } });
  try {
    f.get("username").value = "failing"; await f.submit(); await f.submit();
    assert.equal(cards(f.get("connection-list")).length, 1);
    f.setFailPage("connections");
    control(f.get("connection-list"), "Show more connections")!.onclick!();
    await until(() => !!control(f.get("connection-list"), "Reload connections"));
    // The failed section discards its rows and its cursor, and claims nothing.
    assert.equal(cards(f.get("connection-list")).length, 0);
    assert.match(content(f.get("connection-list")), /The connection listing is unavailable or incomplete/);
    assert.match(content(f.get("connection-list")), /listing failure alone neither performs nor undoes a disconnect/);
    assert.equal(control(f.get("connection-list"), "Show more connections"), undefined);
    assert.equal(cards(f.get("links")).length, 1, "the link section is unaffected");
    assert.match(f.get("link-note").textContent, /Activate the exact pending generation/);
    f.setFailPage(null);
    const before = f.calls.length;
    control(f.get("connection-list"), "Reload connections")!.onclick!();
    await until(() => cards(f.get("connection-list")).length === 1);
    assert.deepEqual(f.calls.slice(before).filter(call => call.path === "connect:connectionPage").map(call => call.args), [{}], "recovery re-reads page one with no cursor");
    assert.deepEqual(cards(f.get("connection-list")).map(card => selector(card, "connectionId")), [first.connectionId]);
    assert(control(f.get("connection-list"), "Show more connections"), "the live cursor is offered again");
  } finally { f.restore(); }
});

test("an unreadable link listing leaves connections listed and Disconnect reachable", async () => {
  const f = await browser("", { listing: { malformed: "links" } });
  try {
    f.get("username").value = "degraded"; await f.submit(); await f.submit();
    assert.equal(cards(f.get("links")).length, 0);
    assert.match(f.get("link-note").textContent, /The project link listing is unavailable or incomplete/);
    assert.match(f.get("link-note").textContent, /No project permission is confirmed/);
    assert(control(f.get("links"), "Reload project links"));
    assert.equal(f.get("project-choice").children.length, 0);
    assert.equal(cards(f.get("connection-list")).length, 1);
    assert(control(f.get("connection-list"), "Disconnect this exact connection"), "Disconnect stays reachable when the link listing fails");
  } finally { f.restore(); }
});

test("an unreadable connection listing leaves the project links listed and selectable", async () => {
  // The symmetric case: a malformed connections listing must not disable the links section.
  const f = await browser("", { listing: { malformed: "connections" } });
  try {
    f.get("username").value = "degraded-connections"; await f.submit(); await f.submit();
    assert.equal(cards(f.get("connection-list")).length, 0);
    assert.match(content(f.get("connection-list")), /The connection listing is unavailable or incomplete/);
    assert.match(content(f.get("connection-list")), /listing failure alone neither performs nor undoes a disconnect/);
    assert(control(f.get("connection-list"), "Reload connections"));
    assert.equal(control(f.get("connection-list"), "Show more connections"), undefined);
    assert.equal(cards(f.get("links")).length, 1, "the link section stays rendered");
    assert.match(f.get("link-note").textContent, /Activate the exact pending generation/);
    assert(control(f.get("links"), "Activate this project link"), "the link section stays usable");
  } finally { f.restore(); }
});

// Revocation and the follow-up listing read are independent outcomes, so exactly one of
// three post-disconnect messages is reported. All three confirm the revocation and say the
// record is retained as a tombstone; they differ only in what they claim about the listing,
// and none may name a control this page does not render.
test("a successful disconnect whose reload leaves a live cursor names Show more connections", async () => {
  const target = { connectionId: "connection-page-one", projectId: "project", absoluteExpiresAt: Date.now() + 600_000, revoked: false, expired: false };
  const later = { connectionId: "connection-page-two", projectId: "project", absoluteExpiresAt: Date.now() + 600_000, revoked: false, expired: false };
  const f = await browser("", { listing: { connections: [[target], [later]] } });
  try {
    f.get("username").value = "disconnecting-paged"; await f.submit(); await f.submit();
    control(f.get("connection-list"), "Disconnect this exact connection")!.onclick!();
    await until(() => /revoked tombstone/.test(f.get("status").textContent));
    const status = f.get("status").textContent;
    assert.match(status, /This connection is now revoked: its next protected operation is refused/);
    assert.match(status, /record is retained as a revoked tombstone and was not deleted/);
    assert.match(status, /The connection listing restarted at page one/);
    // More records exist beyond page one, so the revoked record may not be visible there.
    assert.match(status, /if that revoked record is not shown there, choose Show more connections/);
    assert.doesNotMatch(status, /could not be refreshed/, "the reload succeeded");
    assert.doesNotMatch(status, /complete set of records/, "an unexhausted cursor shows no complete set");
    assert(control(f.get("connection-list"), "Show more connections"), "the named control is actually rendered");
    assert.equal(target.revoked, true);
    assert.match(content(f.get("connection-list")), /Revoked record — it was disconnected and its OAuth grant was removed/);
    assert.equal(control(f.get("connection-list"), "Disconnect this exact connection"), undefined, "a revoked record offers no Disconnect");
  } finally { f.restore(); }
});

test("a successful disconnect whose reload exhausts the listing states the complete set is shown", async () => {
  const f = await browser("");
  try {
    f.get("username").value = "disconnecting-single"; await f.submit(); await f.submit();
    control(f.get("connection-list"), "Disconnect this exact connection")!.onclick!();
    await until(() => /revoked tombstone/.test(f.get("status").textContent));
    const status = f.get("status").textContent;
    assert.match(status, /This connection is now revoked: its next protected operation is refused/);
    assert.match(status, /record is retained as a revoked tombstone and was not deleted/);
    assert.match(status, /restarted at page one and shows the complete set of records, so the revoked record is listed there/);
    // With one page there is no Show more control, so the note must not name one.
    assert.doesNotMatch(status, /Show more connections/);
    assert.doesNotMatch(status, /could not be refreshed/, "the reload succeeded");
    assert.equal(control(f.get("connection-list"), "Show more connections"), undefined);
    assert.equal(f.connection.revoked, true);
    assert.match(content(f.get("connection-list")), /Revoked record — it was disconnected and its OAuth grant was removed/);
    assert.equal(control(f.get("connection-list"), "Disconnect this exact connection"), undefined, "a revoked record offers no Disconnect");
  } finally { f.restore(); }
});

test("a confirmed disconnect whose reload fails reports both outcomes separately and claims no page one", async () => {
  const target = { connectionId: "connection-stale", projectId: "project", absoluteExpiresAt: Date.now() + 600_000, revoked: false, expired: false };
  // The page read fails only on the post-disconnect reload: the listing the human is looking
  // at was rendered from a good read, and the revoke itself already succeeded.
  const listing: { connections?: Row[][]; malformed?: Section } = { connections: [[target]] };
  const f = await browser("", { listing });
  try {
    f.get("username").value = "disconnect-stale"; await f.submit(); await f.submit();
    assert.equal(cards(f.get("connection-list")).length, 1);
    listing.malformed = "connections";
    control(f.get("connection-list"), "Disconnect this exact connection")!.onclick!();
    await until(() => /revoked tombstone/.test(f.get("status").textContent));
    const status = f.get("status").textContent;
    assert.match(status, /This connection is now revoked: its next protected operation is refused/);
    assert.match(status, /record is retained as a revoked tombstone and was not deleted/);
    assert.match(status, /Separately, the connection listing could not be refreshed, so this page is not showing current records/);
    assert.match(status, /choose Reload connections to read the first page again/);
    // A read that failed rendered no page one, so the note cannot claim one.
    assert.doesNotMatch(status, /restarted at page one/);
    assert.doesNotMatch(status, /complete set of records/);
    assert.doesNotMatch(status, /Show more connections/);
    assert.equal(target.revoked, true, "the revocation itself was confirmed");
    assert.equal(cards(f.get("connection-list")).length, 0);
    assert(control(f.get("connection-list"), "Reload connections"), "the only named control is rendered");
    assert.equal(control(f.get("connection-list"), "Show more connections"), undefined);
    // The failed section still claims nothing about the disconnect it did not read.
    assert.match(content(f.get("connection-list")), /listing failure alone neither performs nor undoes a disconnect/);
  } finally { f.restore(); }
});

test("an expired unrevoked connection keeps Disconnect for credential cleanup while a revoked one offers none", async () => {
  // absoluteExpiresAt is Coord's application cap: the host's OAuth grant and refresh
  // credentials can outlive it, so the one control that removes them must stay offered.
  const expired = { connectionId: "connection-expired", projectId: "project", absoluteExpiresAt: Date.now() - 1_000, revoked: false, expired: true };
  const revoked = { connectionId: "connection-revoked", projectId: "project", absoluteExpiresAt: Date.now() + 600_000, revoked: true, expired: false };
  const f = await browser("", { listing: { connections: [[expired, revoked]] } });
  try {
    f.get("username").value = "expired-unrevoked"; await f.submit(); await f.submit();
    const [expiredCard, revokedCard] = cards(f.get("connection-list")) as [Element, Element];
    assert.deepEqual([expiredCard, revokedCard].map(card => selector(card, "connectionId")), [expired.connectionId, revoked.connectionId]);
    assert.match(content(expiredCard), /Coord access expired — this is not the same as the grant being revoked/);
    assert.match(content(expiredCard), /Coord already refuses this connection/);
    assert.match(content(expiredCard), /may still exist at the authorization server, and Disconnect remains available to remove them/);
    assert(control(expiredCard, "Disconnect this exact connection"), "expiry alone never removes the host grant, so cleanup stays available");
    assert.doesNotMatch(content(expiredCard), /its OAuth grant was removed/, "an expired record makes no removal claim");
    assert.match(content(revokedCard), /Revoked record — it was disconnected and its OAuth grant was removed; Coord refuses it/);
    assert.equal(control(revokedCard, "Disconnect this exact connection"), undefined, "only a revoked record has nothing left to remove");
    assert.doesNotMatch(content(f.get("connection-list")), /nothing left to disconnect/);
    // Disconnecting the expired record is a real revocation, not a no-op.
    control(expiredCard, "Disconnect this exact connection")!.onclick!();
    await until(() => /revoked tombstone/.test(f.get("status").textContent));
    assert.deepEqual(f.calls.filter(call => call.path === "oauthAuthority:revokeConnection").map(call => call.args), [{ connectionId: expired.connectionId }]);
    assert.equal(expired.revoked, true);
    assert.equal(cards(f.get("connection-list")).filter(card => control(card, "Disconnect this exact connection")).length, 0);
  } finally { f.restore(); }
});

test("listed link rows that are not selectable never claim that no project link exists", async () => {
  const unusable = { linkId: "unusable-link", generation: 3, backendId: "backend", projectId: "project", sourceCredentialId: "agent", scopes: ["coord:read"], activationExpiresAt: Date.now() - 1_000, expiresAt: Date.now() + 600_000, active: false, selectable: false };
  const listed = await browser("", { listing: { links: [[unusable]] } });
  try {
    listed.get("username").value = "none-selectable"; await listed.submit(); await listed.submit();
    assert.equal(cards(listed.get("links")).length, 1, "the exact record is still listed");
    assert.match(listed.get("link-note").textContent, /listed, but none is currently selectable/);
    assert.doesNotMatch(listed.get("link-note").textContent, /No project link exists/);
    assert.equal(listed.get("project-choice").children.length, 0);
    assert.equal(control(listed.get("links"), "Activate this project link"), undefined);
    assert.equal(control(listed.get("links"), "Show more project links"), undefined);
  } finally { listed.restore(); }
  // "No project link exists" stays reserved for an account with no link row at all.
  const empty = await browser("", { listing: { links: [[]] } });
  try {
    empty.get("username").value = "no-links"; await empty.submit(); await empty.submit();
    assert.equal(cards(empty.get("links")).length, 0);
    assert.match(empty.get("link-note").textContent, /No project link exists/);
  } finally { empty.restore(); }
});
