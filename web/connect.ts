import { AuthClient } from "@convex-dev/auth/browser";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";

type RecordValue = Record<string, unknown>;
type Link = { linkId: string; generation: number; backendId: string; projectId: string; sourceCredentialId: string; scopes: string[]; activationExpiresAt: number; expiresAt: number; active: boolean };
// Every rendered row comes from a page query and carries an explicit selectability verdict.
type PageLink = Link & { selectable: boolean };
type Connection = { connectionId: string; projectId: string; absoluteExpiresAt: number; revoked: boolean; expired: boolean };
// links/connections stay in identity's bounded result for already-open tabs running
// old JavaScript; this code path deliberately ignores them and renders page one from
// connect:linkPage / connect:connectionPage so it holds real cursors from the start.
type Identity = { userId: string; links: Link[]; linksMore: boolean; connections: Connection[]; connectionsMore: boolean };
type Section = "links" | "connections";
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
// Revocation and the follow-up listing read are independent outcomes: a confirmed revoke
// whose refresh failed must not claim a page-one restart, and no message may name a
// control this page does not render. Every variant says the record is retained, not deleted.
const revokedBase = "This connection is now revoked: its next protected operation is refused. Its record is retained as a revoked tombstone and was not deleted.";
const revokedNote = `${revokedBase} The connection listing restarted at page one; if that revoked record is not shown there, choose Show more connections to read far enough to see it again.`;
const revokedCompleteNote = `${revokedBase} The connection listing restarted at page one and shows the complete set of records, so the revoked record is listed there.`;
const revokedStaleNote = `${revokedBase} Separately, the connection listing could not be refreshed, so this page is not showing current records: choose Reload connections to read the first page again.`;
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
  let generation = 0, controller: AbortController | undefined;
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
  // Links and connections page independently: one section's failure or volume never
  // disables the other, and Disconnect stays reachable when link listing fails.
  const selectableLinks = new Map<string, Link>();
  const cursors: Record<Section, string | null> = { links: null, connections: null };
  const counts = { links: 0, usable: 0, connections: 0 };
  const footers: Record<Section, HTMLElement> = { links: document.createElement("div"), connections: document.createElement("div") };
  const connectionNote = document.createElement("p");
  for (const key of ["links", "connections"] as const) footers[key].className = "actions";
  connectionNote.hidden = true;
  const host = (key: Section) => $(key === "links" ? "links" : "connection-list");
  // The connections status line is created here so no page markup change is needed.
  const sectionNote = (key: Section, value: string) => { if (key === "links") { text("link-note", value); return; } connectionNote.textContent = value; connectionNote.hidden = !value; };
  const resetSection = (key: Section) => {
    cursors[key] = null; counts[key] = 0; footers[key].replaceChildren(); host(key).replaceChildren();
    if (key === "links") { counts.usable = 0; selectableLinks.clear(); $("project-choice").replaceChildren(); }
    else { sectionNote("connections", ""); host(key).append(connectionNote); }
  };
  const attachFooter = (key: Section) => { host(key).append(footers[key]); };
  const pageButton = (key: Section, label: string, cursor: string | null) => {
    footers[key].replaceChildren();
    const button = document.createElement("button"); button.type = "button"; button.className = "secondary"; button.textContent = label;
    button.onclick = () => { void attempt(async epoch => { await loadPage(key, cursor, epoch); }); };
    footers[key].append(button);
  };
  // A failed page discards its accumulated rows and stored cursor: recovery re-reads
  // page one rather than reusing a cursor whose listing is no longer trusted.
  const sectionFailure = (key: Section) => {
    resetSection(key); if (key === "links") hideReview();
    sectionNote(key, key === "links" ? "The project link listing is unavailable or incomplete, so no link is shown or selectable here. No project permission is confirmed. Existing connections below are unaffected; choose Reload project links to read the first page again." : "The connection listing is unavailable or incomplete, so no connection record is shown here. This listing failure alone neither performs nor undoes a disconnect, and confirms no permission. Choose Reload connections to read the first page again.");
    pageButton(key, key === "links" ? "Reload project links" : "Reload connections", null); attachFooter(key);
  };
  const linkNote = () => sectionNote("links", counts.usable ? "Activate the exact pending generation, or choose an active link below." : cursors.links ? "No selectable project link appears on the pages read so far. Choose Show more project links to continue reading your exact recorded links." : counts.links ? "Your recorded project links are listed, but none is currently selectable. Compare the exact generation with the owner receipt in your own protected terminal; no project permission is confirmed here." : "No project link exists. Ask for a nonsecret link plan, compare this user ID, and run the protected coord connect link command in your own operator terminal. Then Refresh status here.");
  const connectionsNote = () => { if (counts.connections) { sectionNote("connections", ""); return; } sectionNote("connections", cursors.connections ? "No connection record appears on the pages read so far. Choose Show more connections to continue reading your exact recorded connections." : "No connection record exists for this account. A host OAuth grant and exact project consent in this browser create one."); };
  function renderLink(link: PageLink, usable: boolean) {
    counts.links++;
    const fields: [string, string][] = [["Project", link.projectId], ["Backend", link.backendId], ["Agent access source", link.sourceCredentialId], ["Link status", usable ? link.active ? "Active project link" : "Pending activation" : "Not selectable — current authority unavailable"], ["Activation deadline", link.active ? "Already activated" : expiryDescription(link.activationExpiresAt)], ["Link access ends", expiryDescription(link.expiresAt)]];
    if (!usable) fields.push(["Why no action is offered", "This exact record is listed for completeness. Activation and project selection are withheld because its current authority is not confirmed here; no project permission is implied. Ask the deployment owner to inspect this exact generation."]);
    const activate = usable && !link.active;
    item($("links"), link, fields, link.scopes, activate ? "Activate this project link" : undefined, activate ? () => { void attempt(async turn => { await mutate("oauthAuthority:activateLink", { linkId: link.linkId, generation: link.generation }); if (turn === generation) await refresh(turn); }); } : undefined);
    if (usable) counts.usable++;
    if (!usable || !link.active) return;
    selectableLinks.set(link.linkId, link);
    const option = document.createElement("option"); option.value = link.linkId; option.textContent = `${link.projectId} · ${link.backendId} · generation ${link.generation}`; $("project-choice").append(option);
  }
  function renderConnection(connection: Connection) {
    counts.connections++;
    // absoluteExpiresAt is Coord's application cap, not component-grant revocation: the
    // host's OAuth grant and refresh credentials can still exist at the authorization
    // server after Coord stops honouring this record, and revokeConnection deliberately
    // remains available to the same user after expiry. Disconnect is that credential
    // cleanup only; it never extends expiry, revives authority or deletes a tombstone.
    const removable = !connection.revoked;
    const state = connection.revoked ? "Revoked record — it was disconnected and its OAuth grant was removed; Coord refuses it" : connection.expired ? "Coord access expired — this is not the same as the grant being revoked: the application cap has passed, so Coord already refuses this connection, but the host's OAuth grant and refresh credentials may still exist at the authorization server, and Disconnect remains available to remove them" : "Registered record — current authority is not confirmed by this listing";
    // Revoking a connection cannot change links, identity or handoff state, so only the
    // connections section is re-read: that is what keeps the sections independent.
    item($("connection-list"), connection, [["Project", connection.projectId], ["Recorded access deadline", expiryDescription(connection.absoluteExpiresAt)], ["Recorded state", state], ["Verify usable access", "Ask the host to read current project status. This record alone does not establish live authority; its exact selector is available below."]], undefined, removable ? "Disconnect this exact connection" : undefined, removable ? () => { void attempt(async turn => { await mutate("oauthAuthority:revokeConnection", { connectionId: connection.connectionId }); if (turn !== generation) return; const reloaded = await loadPage("connections", null, turn); if (turn !== generation) return; text("status", !reloaded ? revokedStaleNote : cursors.connections ? revokedNote : revokedCompleteNote); }); } : undefined);
  }
  function appendRows(key: Section, rows: unknown, complete: unknown, cursor: unknown) {
    if (!Array.isArray(rows)) throw new Error("Invalid listing");
    for (const value of rows) {
      const row = object(value);
      if (key === "links") renderLink(row as unknown as PageLink, row.selectable === true);
      else renderConnection(row as unknown as Connection);
    }
    cursors[key] = complete === true || typeof cursor !== "string" || !cursor ? null : cursor;
    if (cursors[key]) pageButton(key, key === "links" ? "Show more project links" : "Show more connections", cursors[key]); else footers[key].replaceChildren();
    if (key === "links") linkNote(); else connectionsNote();
    attachFooter(key);
  }
  // Reports whether this page was actually read and rendered. The failure is still
  // absorbed into sectionFailure here, so section independence is unchanged; the verdict
  // only lets a caller avoid describing a listing it did not read. A superseded epoch
  // reports false as well: nothing was rendered for this turn.
  async function loadPage(key: Section, cursor: string | null, epoch: number): Promise<boolean> {
    try {
      const result = object(await read(key === "links" ? "connect:linkPage" : "connect:connectionPage", cursor === null ? {} : { cursor }));
      if (epoch !== generation) return false;
      if (cursor === null) { resetSection(key); if (key === "links") hideReview(); }
      appendRows(key, result[key], result.complete, result.nextCursor);
      return true;
    } catch { if (epoch === generation) sectionFailure(key); return false; }
  }
  async function refresh(epoch: number, force = false) {
    // identity supplies only the user ID and the fact that these sections exist; each
    // listing then reads its own first page, so both start with a real cursor and
    // either section can fail without hiding the other or Disconnect.
    await attach(force); const current = await read("connect:identity") as Identity;
    if (epoch !== generation) return;
    text("user-id", current.userId); show("signin", false); show("account", true); show("projects", true); show("connections", true);
    text("status", "Signed in. Project access requires an exact owner-installed link; login grants no approval authority.");
    await loadPage("links", null, epoch);
    await loadPage("connections", null, epoch);
    if (epoch !== generation) return;
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
  $("signout").onclick = () => { generation++; controller?.abort(); controller = undefined; ceremony = undefined; reviewed = undefined; flow = {}; returnClientUrl = undefined; sessionStorage.removeItem(flowKey); client.clearAuth(); for (const id of ["account", "projects", "oauth", "handoff", "connections", "abort"]) show(id, false); text("user-id", ""); resetSection("links"); resetSection("connections"); text("link-note", "Loading your exact project links…"); text("binding", ""); text("oauth-details", ""); show("signin", true); busy(true); const signOut = auth.signOut(); clearTokens(); sessionChange = sessionChange.catch(() => undefined).then(() => signOut).finally(() => { clearTokens(); busy(false); }); text("status", "Signed out locally. This does not disconnect existing agent grants. Previously submitted actions may have completed; sign in again to inspect authoritative status."); };
  $("refresh").onclick = () => { void attempt(epoch => refresh(epoch, true)); };
  $("project-choice").onchange = () => { generation++; hideReview(); busy(false); text("handoff-note", "Project selection changed. Review this exact selection again. A request already submitted may have completed; refresh status if uncertain."); };
  $("review").onclick = () => { void attempt(async epoch => {
    const link = selectableLinks.get(($("project-choice") as HTMLSelectElement).value); if (!link || !link.active || !flow.handoff) throw new Error("Active project required");
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
