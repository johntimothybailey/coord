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
  onclick?: () => void; onchange?: () => void; onsubmit?: (event: { preventDefault(): void }) => void;
  constructor(readonly tag: string) {}
  append(child: Element) { this.children.push(child); if (this.tag === "select" && !this.value) this.value = child.value; }
  replaceChildren() { this.children = []; this.value = ""; }
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
const tokens = { accessToken: "fixture.access.signature", refreshToken: "private-refresh-canary", refreshTokenExpiresAt: Date.now() + 600_000, userId: "public-user" };
async function browser(query = "", options: { existing?: boolean; nativeNull?: boolean; review?: () => Promise<unknown>; finish?: () => Promise<unknown> } = {}) {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); };
  const elements = new Map<string, Element>(), all: Element[] = [];
  for (const match of connectHtml.matchAll(/<(\w+)[^>]*\bid="([^"]+)"([^>]*)>/g)) { const element = new Element(match[1]!); element.hidden = match[3]!.includes("hidden"); elements.set(match[2]!, element); all.push(element); }
  const storage = new Storage(), calls: { path: string; args: Record<string, unknown> }[] = [];
  const history: string[] = [], navigation: string[] = [];
  const link = { linkId: "link", generation: 1, backendId: "backend", projectId: "project", sourceCredentialId: "agent", scopes: ["coord:read"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + 600_000, active: false };
  const connection = { connectionId: "connection", projectId: "project", absoluteExpiresAt: Date.now() + 600_000, revoked: false };
  let state = "pending", nativeCalls = 0;
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
      case "connect:identity": value = { userId: "public-user", links: [link], connections: [connection] }; break;
      case "oauthAuthority:activateLink": link.active = true; value = { active: true }; break;
      case "oauthAuthority:revokeConnection": connection.revoked = true; value = { revoked: true }; break;
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
  return { get, calls, storage, navigation, history, all, link, connection, get nativeCalls() { return nativeCalls; }, setState(value: string) { state = value; }, submit, restore() { for (const [name, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, name, descriptor) : Reflect.deleteProperty(globalThis, name); } };
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
