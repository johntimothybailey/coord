import { AuthClient } from "@convex-dev/auth/browser";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";

type RecordValue = Record<string, unknown>;
type Link = { linkId: string; generation: number; backendId: string; projectId: string; sourceCredentialId: string; scopes: string[]; activationExpiresAt: number; expiresAt: number; active: boolean };
type Identity = { userId: string; links: Link[]; connections: { connectionId: string; projectId: string; absoluteExpiresAt: number; revoked: boolean }[] };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const object = (value: unknown): RecordValue => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid response"); return value as RecordValue; };
const show = (id: string, visible: boolean) => { $(id).hidden = !visible; };
const text = (id: string, value: string) => { $(id).textContent = value; };
const display = (value: unknown) => JSON.stringify(value, null, 2).replace(/[\p{Cc}\p{Cf}]/gu, character => character === "\n" ? character : `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
export function decode64(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), c => c.charCodeAt(0)); }
const encode64 = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
export function creationOptions(value: unknown): PublicKeyCredentialCreationOptions {
  const options = object(value), user = object(options.user);
  const descriptors = (items: unknown) => (items as RecordValue[]).map(item => ({ ...item, id: decode64(String(item.id)) }));
  return { ...options, challenge: decode64(String(options.challenge)), user: { ...user, id: decode64(String(user.id)) }, excludeCredentials: descriptors(options.excludeCredentials ?? []) } as unknown as PublicKeyCredentialCreationOptions;
}
export function requestOptions(value: unknown): PublicKeyCredentialRequestOptions {
  const options = object(value);
  return { ...options, challenge: decode64(String(options.challenge)), allowCredentials: ((options.allowCredentials ?? []) as RecordValue[]).map(item => ({ ...item, id: decode64(String(item.id)) })) } as unknown as PublicKeyCredentialRequestOptions;
}
export function credentialResponse(credential: PublicKeyCredential, register: boolean): RecordValue {
  const base = { id: credential.id, rawId: encode64(credential.rawId), type: "public-key", clientExtensionResults: {} };
  if (register) { const response = credential.response as AuthenticatorAttestationResponse; return { ...base, response: { clientDataJSON: encode64(response.clientDataJSON), attestationObject: encode64(response.attestationObject), ...(response.getTransports ? { transports: response.getTransports() } : {}) } }; }
  const response = credential.response as AuthenticatorAssertionResponse;
  return { ...base, response: { clientDataJSON: encode64(response.clientDataJSON), authenticatorData: encode64(response.authenticatorData), signature: encode64(response.signature), ...(response.userHandle ? { userHandle: encode64(response.userHandle) } : {}) } };
}
export function scopeDescription(scope: string): string {
  const descriptions: Record<string, string> = {
    "coord:read": "Read project status, rules, reviewable guidance, checkpoint artifacts and machine capability information.",
    "coord:propose": "Draft goals, tasks and source-backed rules; proposals still require applicable approvals.",
    "coord:approval-request": "Request or cancel exact rule approval; this does not approve a rule.",
    "coord:run": "Participate in separately admitted, qualified tasks: admit eligible tasks, renew leases, record progress and lessons, propose or replan subtasks, and request finalization or resume.",
    "coord:supervise": "Authorize launches, monitor managed runs and report or confirm stops within machine and supervisor role limits.",
    "coord:artifact": "Prepare checkpoints, upload file scans and request publication for authorized runs.",
    "coord:verify": "Independently verify scans, checkpoints and publications; mark artifacts ready and accept verified publications within verifier role limits.",
    "coord:message": "Send, read, acknowledge and resolve coordination messages for authorized runs.",
  };
  return descriptions[scope] ?? `Unrecognized permission: ${scope}. Review the exact request; no additional authority is implied.`;
}
export function expiryDescription(value: unknown, now = Date.now()): string {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) return "Expiry unavailable — refresh authoritative status before continuing.";
  const deadline = new Date(value).toISOString().replace("T", " ").replace("Z", " UTC");
  const minutes = Math.ceil((value - now) / 60_000);
  const unit = (count: number, label: string) => `${count} ${label}${count === 1 ? "" : "s"}`;
  const relative = minutes <= 0 ? "deadline reached by this browser's clock" : minutes >= 60 ? `about ${unit(Math.floor(minutes / 60), "hour")} ${unit(minutes % 60, "minute")} remaining` : `about ${unit(minutes, "minute")} remaining`;
  return `${deadline} · ${relative} (browser-clock estimate)`;
}
function stateMessage(state: string): string {
  const states: Record<string, string> = { pending: "Pending: review and authorize the exact project connection.", authorized_awaiting_host: "Project authorized; awaiting the host. Return to chat and retry finish-connect. This is not connected yet.", connected: "Connected: the host bound this exact project and completed a real status read.", cancelled: "This pending connection was cancelled. It cannot be revived; start a new attempt in chat.", expired: "This attempt expired or its authority is unavailable. Start a new attempt in chat.", revoked: "This connection is revoked. Its next protected operation is refused." };
  return states[state] ?? "Connection state is uncertain. Refresh authoritative status before retrying.";
}
export async function startConnect(): Promise<void> {
  const configResponse = await fetch("/connect/config", { cache: "no-store", credentials: "omit" });
  if (!configResponse.ok) throw new Error("Connect origin unavailable");
  const config = object(await configResponse.json());
  if (config.siteOrigin !== location.origin || typeof config.backendUrl !== "string" || new URL(config.backendUrl).protocol !== "https:" || new URL(config.backendUrl).origin !== config.backendUrl) throw new Error("Invalid connection origin");
  text("origin", String(config.siteOrigin));
  const namespace = `coord-connect:${config.backendUrl}:`, query = new URLSearchParams(location.search);
  const flowKey = `${namespace}flow`;
  let flow: { request?: string; handoff?: string } = {};
  if (query.has("request") || query.has("handoff")) {
    const request = query.get("request"), handoff = query.get("handoff");
    if (request && request.length <= 256 && /^[A-Za-z0-9_-]+$/.test(request)) flow.request = request;
    if (handoff && handoff.length <= 256 && /^[A-Za-z0-9_-]+$/.test(handoff)) flow.handoff = handoff;
    sessionStorage.setItem(flowKey, JSON.stringify(flow));
  } else { try { flow = object(JSON.parse(sessionStorage.getItem(flowKey) ?? "{}")); } catch { sessionStorage.removeItem(flowKey); } }
  // Capture only opaque flow selectors; authorization codes/state never enter storage or DOM.
  history.replaceState(null, "", location.pathname);
  const anonymous = new ConvexHttpClient(config.backendUrl, { logger: false }), client = new ConvexHttpClient(config.backendUrl, { logger: false });
  const publicMutation = (name: string, args: Record<string, Value>) => anonymous.mutation(makeFunctionReference<"mutation">(name), args);
  const tokenPrefix = `${namespace}auth:`;
  const tokenStorage = { getItem: (key: string) => sessionStorage.getItem(tokenPrefix + key), setItem: (key: string, value: string) => sessionStorage.setItem(tokenPrefix + key, value), removeItem: (key: string) => sessionStorage.removeItem(tokenPrefix + key) };
  const clearTokens = () => { for (let i = sessionStorage.length - 1; i >= 0; i--) { const key = sessionStorage.key(i); if (key?.startsWith(tokenPrefix)) sessionStorage.removeItem(key); } };
  const revokeSession = async (refreshToken: string) => {
    let cancel = () => {};
    try { await Promise.race([publicMutation("authCore:signOut", { refreshToken }).catch(() => undefined), new Promise<void>(resolve => { const timeout = setTimeout(resolve, 2_000); cancel = () => clearTimeout(timeout); })]); }
    finally { cancel(); }
  };
  const auth = new AuthClient({ mode: "spa", storage: tokenStorage, storageNamespace: "session", authApi: { refreshSession: refreshToken => publicMutation("authCore:refreshSession", { refreshToken }) as ReturnType<import("@convex-dev/auth/browser").SpaAuthApi["refreshSession"]>, signOut: revokeSession } });
  let sessionChange = Promise.resolve();
  let returnClientUrl: string | undefined;
  let generation = 0, controller: AbortController | undefined, identity: Identity | undefined;
  let ceremony: { username: string; step: "register" | "authenticate"; options: unknown } | undefined;
  let reviewed: { linkId: string; generation: number; digest: string } | undefined;
  const busy = (value: boolean) => { for (const button of document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button,input,select")) button.disabled = value; $("signout").removeAttribute("disabled"); if (controller) $("abort").removeAttribute("disabled"); };
  const attach = async (force = false) => { const token = await auth.fetchAccessToken({ forceRefreshToken: force }); if (!token) throw new Error("Sign in required"); client.setAuth(token); };
  const read = async (name: string, args: Record<string, Value> = {}) => { await attach(); return client.query(makeFunctionReference<"query">(name), args); };
  const mutate = async (name: string, args: Record<string, Value>) => { await attach(); return client.mutation(makeFunctionReference<"mutation">(name), args); };
  const action = async (name: string, args: Record<string, Value>) => { await attach(); return client.action(makeFunctionReference<"action">(name), args); };
  const attempt = async (operation: (epoch: number) => Promise<void>) => {
    const epoch = generation; busy(true);
    try { await operation(epoch); }
    catch { if (epoch === generation) text("status", "Outcome uncertain or request unavailable. No new permission is confirmed here. Refresh status before retrying; a submitted action may already have completed."); }
    finally { if (epoch === generation) busy(false); }
  };
  function item(parent: HTMLElement, details: unknown, fields: [string, string][], scopes: unknown, label?: string, callback?: () => void) {
    const card = document.createElement("div"); card.className = "item";
    const readable = document.createElement("div"); readable.className = "summary"; decisionSummary(readable, fields, scopes); card.append(readable);
    const exact = document.createElement("details"), title = document.createElement("summary"), pre = document.createElement("pre");
    title.textContent = "Exact record selectors and limits"; pre.textContent = display(details); exact.append(title); exact.append(pre); card.append(exact);
    if (label && callback) { const button = document.createElement("button"); button.type = "button"; button.className = "secondary"; button.textContent = label; button.onclick = callback; card.append(button); }
    parent.append(card);
  }
  function decisionSummary(target: string | HTMLElement, fields: [string, string][], scopes: unknown) {
    const parent = typeof target === "string" ? $(target) : target; parent.replaceChildren();
    const list = document.createElement("dl");
    for (const [label, value] of fields) { const term = document.createElement("dt"), detail = document.createElement("dd"); term.textContent = label; detail.textContent = value.replace(/[\p{Cc}\p{Cf}]/gu, character => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`); list.append(term); list.append(detail); }
    parent.append(list);
    if (scopes === undefined) return;
    const heading = document.createElement("h3"); heading.textContent = "Permitted operations";
    const permissions = document.createElement("ul");
    for (const scope of Array.isArray(scopes) ? scopes : []) { const item = document.createElement("li"); item.textContent = scopeDescription(String(scope)).replace(/[\p{Cc}\p{Cf}]/gu, character => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`); permissions.append(item); }
    if (!permissions.children.length) { const item = document.createElement("li"); item.textContent = "No operations are listed. Refresh authoritative status before continuing."; permissions.append(item); }
    parent.append(heading); parent.append(permissions);
  }
  const hideReview = () => { reviewed = undefined; show("binding-summary", false); show("binding-boundary", false); show("binding-details", false); ($("binding-details") as HTMLDetailsElement).open = false; show("complete", false); };
  async function refresh(epoch: number, force = false) {
    await attach(force); const current = await read("connect:identity") as Identity;
    if (epoch !== generation) return;
    identity = current; text("user-id", current.userId); show("signin", false); show("account", true); show("projects", true); show("connections", true);
    text("status", "Signed in. Project access requires an exact owner-installed link; login grants no approval authority.");
    $("links").replaceChildren(); $("project-choice").replaceChildren(); $("connection-list").replaceChildren(); hideReview();
    text("link-note", current.links.length ? "Activate the exact pending generation, or choose an active link below." : "No project link exists. Ask for a nonsecret link plan, compare this user ID, and run the protected coord connect link command in your own operator terminal. Then Refresh status here.");
    for (const link of current.links) {
      item($("links"), link, [["Project", link.projectId], ["Backend", link.backendId], ["Agent access source", link.sourceCredentialId], ["Link status", link.active ? "Active project link" : "Pending activation"], ["Activation deadline", link.active ? "Already activated" : expiryDescription(link.activationExpiresAt)], ["Link access ends", expiryDescription(link.expiresAt)]], link.scopes, link.active ? undefined : "Activate this project link", () => { void attempt(async turn => { await mutate("oauthAuthority:activateLink", { linkId: link.linkId, generation: link.generation }); if (turn === generation) await refresh(turn); }); });
      if (link.active) { const option = document.createElement("option"); option.value = link.linkId; option.textContent = `${link.projectId} · ${link.backendId} · generation ${link.generation}`; $("project-choice").append(option); }
    }
    for (const connection of current.connections) item($("connection-list"), connection, [["Project", connection.projectId], ["Recorded access deadline", expiryDescription(connection.absoluteExpiresAt)], ["Recorded state", connection.revoked ? "Revoked record" : "Registered record — current authority is not confirmed by this listing"], ["Verify usable access", "Ask the host to read current project status. This record alone does not establish live authority; its exact selector is available below."]], undefined, connection.revoked ? undefined : "Disconnect this exact connection", () => { void attempt(async turn => { await mutate("oauthAuthority:revokeConnection", { connectionId: connection.connectionId }); if (turn === generation) await refresh(turn); }); });
    if (flow.request) {
      const request = await read("mcpConsent:getAuthRequest", { requestId: flow.request }); if (epoch !== generation) return;
      show("oauth", true); show("return-client", false);
      if (!request) { text("oauth-details", "This agent request is unavailable or expired. Start again from the host."); show("oauth-approve", false); show("oauth-deny", false); }
      else { const details = object(request); decisionSummary("oauth-summary", [["Requesting client (unverified label)", typeof details.clientName === "string" ? details.clientName : "No client label supplied"], ["Request status", String(details.status)], ["Callback destination", typeof details.redirectUri === "string" ? details.redirectUri : "No redirect supplied"]], details.scopes); ($("oauth-exact") as HTMLDetailsElement).open = false; text("oauth-details", display(details)); show("oauth-approve", details.status === "pending"); show("oauth-deny", details.status === "pending"); if (details.status !== "pending") text("status", `Agent authorization is ${String(details.status)}. OAuth approval alone does not establish a project connection.`); }
    }
    if (flow.handoff) {
      const status = object(await read("connect:status", { handoffId: flow.handoff })); if (epoch !== generation) return;
      show("handoff", true); text("handoff-note", stateMessage(String(status.state))); text("status", stateMessage(String(status.state)));
      show("review", status.state === "pending"); show("project-choice", status.state === "pending"); show("cancel", status.state === "pending");
    }
  }
  $("signin-form").onsubmit = event => { event.preventDefault(); void attempt(async epoch => {
    const username = $("username") as HTMLInputElement;
    if (!ceremony || ceremony.username !== username.value) {
      const start = object(await publicMutation("authSignin:startSignInWithUsernamePasskey", { username: username.value })); if (epoch !== generation) return;
      if (start.success !== true || !["register", "authenticate"].includes(String(start.step))) throw new Error("Sign in unavailable");
      ceremony = { username: username.value, step: start.step as "register" | "authenticate", options: start.options };
      text("login", ceremony.step === "register" ? "Create account with passkey" : "Sign in with passkey");
      text("status", ceremony.step === "register" ? "This username is new. Confirm it is correct, then choose Create account with passkey. The new account will have no project authority." : "This username has an account. Choose Sign in with passkey to open your authenticator."); return;
    }
    const selected = ceremony; ceremony = undefined; controller = new AbortController(); show("abort", true); $("abort").removeAttribute("disabled");
    try {
      const credential = selected.step === "register" ? await navigator.credentials.create({ publicKey: creationOptions(selected.options), signal: controller.signal }) : await navigator.credentials.get({ publicKey: requestOptions(selected.options), signal: controller.signal });
      if (epoch !== generation) return;
      if (!credential) { text("status", "Passkey interaction cancelled. No new session or project permission was confirmed; Continue with passkey starts a fresh challenge."); return; }
      const response = credentialResponse(credential as PublicKeyCredential, selected.step === "register");
      const result = object(await publicMutation(selected.step === "register" ? "authSignin:finishSignUpWithUsernamePasskey" : "authSignin:finishSignInWithUsernamePasskey", { response: response as Value, ...(selected.step === "register" ? { username: selected.username } : {}) }));
      if (result.status !== "complete") throw new Error("Verification unavailable");
      const tokens = result.tokens as Parameters<AuthClient["setSession"]>[0];
      if (epoch !== generation) { if ("refreshToken" in tokens) void revokeSession(tokens.refreshToken); return; }
      sessionChange = sessionChange.catch(() => undefined).then(async () => { if (epoch !== generation) { if ("refreshToken" in tokens) await revokeSession(tokens.refreshToken); return; } await auth.setSession(tokens); if (epoch !== generation) await auth.signOut(); });
      await sessionChange; if (epoch !== generation) return; await refresh(epoch);
    } finally { if (epoch === generation) { controller = undefined; show("abort", false); text("login", "Continue with passkey"); } }
  }); };
  $("abort").onclick = () => { generation++; controller?.abort(); controller = undefined; ceremony = undefined; show("abort", false); text("login", "Continue with passkey"); busy(false); text("status", "Passkey interaction cancelled locally. A finish request already sent may have completed; sign in again to inspect your account. No project permission is confirmed."); };
  $("signout").onclick = () => { generation++; controller?.abort(); controller = undefined; ceremony = undefined; identity = undefined; reviewed = undefined; flow = {}; returnClientUrl = undefined; sessionStorage.removeItem(flowKey); client.clearAuth(); for (const id of ["account", "projects", "oauth", "handoff", "connections", "abort"]) show(id, false); text("user-id", ""); $("links").replaceChildren(); $("connection-list").replaceChildren(); text("binding", ""); text("oauth-details", ""); show("signin", true); busy(true); const signOut = auth.signOut(); clearTokens(); sessionChange = sessionChange.catch(() => undefined).then(() => signOut).finally(() => { clearTokens(); busy(false); }); text("status", "Signed out locally. This does not disconnect existing agent grants. Previously submitted actions may have completed; sign in again to inspect authoritative status."); };
  $("refresh").onclick = () => { void attempt(epoch => refresh(epoch, true)); };
  $("project-choice").onchange = () => { generation++; hideReview(); busy(false); text("handoff-note", "Project selection changed. Review this exact selection again. A request already submitted may have completed; refresh status if uncertain."); };
  $("review").onclick = () => { void attempt(async epoch => {
    const link = identity?.links.find(link => link.linkId === ($("project-choice") as HTMLSelectElement).value && link.active); if (!link || !flow.handoff) throw new Error("Active project required");
    const result = object(await read("connect:review", { handoffId: flow.handoff, linkId: link.linkId, generation: link.generation })); if (epoch !== generation) return;
    text("handoff-note", stateMessage(String(result.state)));
    if (result.state !== "pending" || typeof result.digest !== "string") { reviewed = undefined; show("complete", false); return; }
    reviewed = { linkId: link.linkId, generation: link.generation, digest: result.digest }; const tuple = object(result.review);
    decisionSummary("binding-summary", [["Project", String(tuple.projectId)], ["Backend", String(tuple.backendId)], ["Agent access source", String(tuple.sourceCredentialId)], ["Access ends — absolute deadline", expiryDescription(tuple.absoluteExpiresAt)]], tuple.scopes);
    text("binding", display({ ...tuple, digest: result.digest })); show("binding-summary", true); show("binding-boundary", true); show("binding-details", true); ($("binding-details") as HTMLDetailsElement).open = false; show("complete", true);
  }); };
  $("complete").onclick = () => { void attempt(async epoch => { if (!reviewed || !flow.handoff) throw new Error("Exact review required"); const result = object(await mutate("connect:complete", { handoffId: flow.handoff, ...reviewed })); if (epoch !== generation) return; reviewed = undefined; show("complete", false); show("review", false); show("cancel", false); text("status", stateMessage(String(result.state))); text("handoff-note", stateMessage(String(result.state))); }); };
  $("cancel").onclick = () => { void attempt(async epoch => { if (!flow.handoff) return; await mutate("connect:cancel", { handoffId: flow.handoff }); if (epoch === generation) await refresh(epoch); }); };
  for (const [id, approve] of [["oauth-approve", true], ["oauth-deny", false]] as const) $(id).onclick = () => { void attempt(async epoch => {
    if (!flow.request) return; const result = object(await action("mcpConsent:authorize", { requestId: flow.request, approve })); if (epoch !== generation) return;
    show("oauth-approve", false); show("oauth-deny", false);
    text("status", approve ? "OAuth request authorized. Return to the host for code exchange, then ask it to finish-connect. Project access is not connected yet." : "Agent request denied. No project connection was authorized.");
    if (typeof result.redirectUrl === "string") { const url = new URL(result.redirectUrl); if (!["https:", "http:"].includes(url.protocol) || (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Unexpected return URL"); returnClientUrl = url.href; show("return-client", true); }
  }); };
  $("return-client").onclick = () => { if (returnClientUrl) location.assign(returnClientUrl); };
  if (!window.isSecureContext || typeof PublicKeyCredential === "undefined") { text("status", "Passkeys require a supported secure browser. Open this exact HTTPS page in a browser that supports your authenticator; no sign-in is available here."); busy(true); return; }
  await auth.init();
  if (auth.getSnapshot().isAuthenticated) await attempt(epoch => refresh(epoch));
  else text("status", "Sign in or create an account with a passkey. No project authority is granted by login.");
  window.addEventListener("pagehide", () => { generation++; controller?.abort(); auth.dispose(); });
}
if (typeof document !== "undefined") void startConnect().catch(() => { text("status", "Connect is unavailable. Use the exact protected link from your trusted deployment and retry; no permission is confirmed."); });
