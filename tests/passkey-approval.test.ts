import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getFunctionName } from "convex/server";
import { bootstrap, canonical, digest, invite, redeem } from "../convex/auth.js";
import * as auth from "../convex/approvalAuth.js";
import * as requests from "../convex/approvalRequests.js";
import router from "../convex/http.js";
import { approvalJs, approvalCss } from "../convex/approvalPage.js";
import { BackendFixture } from "./backend.fixture.js";
import { createCoordMcpServer, type CoordBackend } from "../src/mcp.js";
import { CAPABILITIES, CLIENT_VERSION } from "../src/protocol.js";
import { bytesHash, encode64, decode64, passkeyFingerprint, randomChallenge, verifyPasskey } from "../src/passkeys.js";
import type { PasskeyAssertion } from "../src/passkeys.js";

// Software test authenticators and serialized handlers prove logic, not physical user/device qualification.
const origin = "https://fixture.convex.site";
process.env.CONVEX_SITE_URL = origin;
const agent = "a".repeat(64), human = "b".repeat(64), secondHuman = "c".repeat(64);
let serial = 0;
const identity = (token = agent) => ({ token, protocolVersion: 1, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], backendId: "backend", projectId: "project", requestId: `passkey_${++serial}` });
const code = (expected: string) => (error: unknown) => (error as { data?: { code?: string } }).data?.code === expected;
function asDer(raw: Uint8Array): Uint8Array {
  const integer = (value: Uint8Array) => { while (value.length > 1 && value[0] === 0) value = value.slice(1); if (value[0]! & 128) value = Uint8Array.from([0, ...value]); return Uint8Array.from([2, value.length, ...value]); };
  const a = integer(raw.slice(0, 32)), b = integer(raw.slice(32)); return Uint8Array.from([48, a.length + b.length, ...a, ...b]);
}
async function authenticator(memberId = "human", projectId = "project") {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = encode64(new Uint8Array(await crypto.subtle.exportKey("spki", key.publicKey))), id = randomChallenge();
  const userHandle = encode64(Uint8Array.from((await digest(`backend:${projectId}:${memberId}`)).match(/../g)!, byte => parseInt(byte, 16)));
  let counter = 0;
  return { id, spki, userHandle, async sign(challenge: string, changes: { origin?: string; rpId?: string; flags?: number; challenge?: string; type?: string; counter?: number; userHandle?: string | null } = {}): Promise<PasskeyAssertion> {
    const data = new TextEncoder().encode(JSON.stringify({ type: changes.type ?? "webauthn.get", challenge: changes.challenge ?? challenge, origin: changes.origin ?? origin, crossOrigin: false }));
    const authData = new Uint8Array(37); authData.set(await bytesHash(new TextEncoder().encode(changes.rpId ?? new URL(origin).hostname))); authData[32] = changes.flags ?? 5; new DataView(authData.buffer).setUint32(33, changes.counter ?? ++counter);
    const hash = await bytesHash(data), signed = new Uint8Array(authData.length + hash.length); signed.set(authData); signed.set(hash, authData.length);
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, signed));
    return { credentialId: id, clientDataJSON: encode64(data), authenticatorData: encode64(authData), signature: encode64(asDer(signature)), userHandle: changes.userHandle === undefined ? userHandle : changes.userHandle };
  } };
}
async function fixture() {
  const f = new BackendFixture();
  await f.call(bootstrap, { backendId: "backend", projectId: "project", repository: "github.com/fixture/passkeys", remote: "https://github.com/fixture/passkeys.git", defaultBranch: "main", allowedPaths: ["src"], excludedPaths: [], ruleTargets: ["AGENTS.md"], humanId: "human", humanDigest: await digest(human), agentId: "agent", agentDigest: await digest(agent), expiresAt: Date.now() + 3600_000 });
  const source = { kind: "rule" as const, content: "Use source-backed labels <script>not executable</script> \u202e hostile direction", sources: [{ taskId: "task", revision: "revision", evidenceRef: "fixture-evidence" }], applicability: ["src"], confidence: "fixture" };
  const target = { memoryId: "rule", revision: 1, hash: await digest(canonical(source)) };
  await f.context().db.insert("memories", { id: "rule", projectId: "project", ...source, revision: 1, hash: target.hash, status: "proposed" });
  return { f, source, target };
}
type Authenticator = Awaited<ReturnType<typeof authenticator>>;
async function enroll(f: BackendFixture, key: Authenticator, token = human) {
  const enrollmentId = `enrollment_${++serial}`;
  await f.call(auth.beginEnrollment, { ...identity(token), enrollmentId });
  const options = await f.call(auth.enrollmentOptions, { enrollmentId }) as { challenge: string; binding: string };
  const candidate = await f.call(auth.stageEnrollment, { enrollmentId, credentialId: key.id, publicKeySpki: key.spki, assertion: await key.sign(options.challenge) }) as { fingerprint: string };
  assert.equal(candidate.fingerprint, await passkeyFingerprint(key.id, key.spki, options.binding));
  await f.call(auth.finishEnrollment, { ...identity(token), enrollmentId, fingerprint: candidate.fingerprint });
  return { enrollmentId, candidate };
}
// A real second project human, joined through the one-use invite path rather than a hand-written credential row.
async function joinHuman(f: BackendFixture, memberId: string, token: string) {
  const inviteToken = "d".repeat(64);
  await f.call(invite, { ...identity(human), inviteToken, memberId, projectIds: ["project"], role: "human", expiresAt: Date.now() + 60_000 });
  const { token: _unused, ...join } = identity();
  const joined = await f.call(redeem, { ...join, inviteToken, newToken: token, credentialExpiresAt: Date.now() + 3600_000 }) as { joined: boolean };
  assert.equal(joined.joined, true);
}
async function pending(f: BackendFixture, target: { memoryId: string; revision: number; hash: string }, id = `intent_${++serial}`) {
  return f.call(requests.requestRule, { ...identity(), requestId: id, ...target }) as Promise<requests.ApprovalRequestView>;
}
async function reviewed(f: BackendFixture, key: Authenticator, request: Awaited<ReturnType<typeof pending>>) {
  const args = { approvalRequestId: request.envelope.id, requestDigest: request.requestDigest };
  const options = await f.call(auth.challenge, { ...args, phase: "review" }) as { challenge: string };
  await f.call(auth.review, { ...args, assertion: await key.sign(options.challenge) });
  return args;
}
const handlers = { challenge: auth.challenge, review: auth.review, decide: auth.decide, enrollmentOptions: auth.enrollmentOptions, stageEnrollment: auth.stageEnrollment };
async function http(f: BackendFixture, path: string, body?: unknown, headers: Record<string, string> = { Origin: origin, "Content-Type": "application/json" }) {
  const route = router.lookup(path, body === undefined ? "GET" : "POST"); assert(route);
  const ctx = { runMutation: (ref: unknown, args: unknown) => { const name = getFunctionName(ref as never).split(":")[1]!; return f.call(handlers[name as keyof typeof handlers] as never, args as never); }, runQuery: (ref: unknown, args: unknown) => { const name = getFunctionName(ref as never).split(":")[1]!; return f.call(handlers[name as keyof typeof handlers] as never, args as never); } };
  return (route[0] as unknown as { _handler: (ctx: unknown, request: Request) => Promise<Response> })._handler(ctx, new Request(origin + path, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}

test("passkey verifier requires exact origin/RP/challenge, UV/UP, account handle and signature", async () => {
  const key = await authenticator(), challenge = randomChallenge();
  assert.equal(await verifyPasskey(await key.sign(challenge), { spki: key.spki, origin, challenge, previousCounter: 0, userHandle: key.userHandle, requireUserHandle: true }), 1);
  for (const changes of [{ origin: "https://evil.example" }, { rpId: "evil.example" }, { challenge: randomChallenge() }, { type: "webauthn.create" }, { flags: 1 }, { flags: 4 }, { flags: 0x15 }, { userHandle: null }, { userHandle: randomChallenge() }]) {
    await assert.rejects(verifyPasskey(await key.sign(challenge, changes), { spki: key.spki, origin, challenge, previousCounter: 0, userHandle: key.userHandle, requireUserHandle: true }));
  }
  const invalid = await key.sign(challenge); const bytes = decode64(invalid.signature); bytes[bytes.length - 1]! ^= 1; invalid.signature = encode64(bytes);
  await assert.rejects(verifyPasskey(invalid, { spki: key.spki, origin, challenge, previousCounter: 0, userHandle: key.userHandle }));
});

test("passkey counters reject positive replay while zero-counter synced keys remain valid", async () => {
  const key = await authenticator(), challenge = randomChallenge(), proof = await key.sign(challenge, { counter: 4 });
  await assert.rejects(verifyPasskey(proof, { spki: key.spki, origin, challenge, previousCounter: 4, userHandle: key.userHandle }));
  assert.equal(await verifyPasskey(await key.sign(challenge, { counter: 0, flags: 0x1d }), { spki: key.spki, origin, challenge, previousCounter: 0, userHandle: key.userHandle }), 0);
});

test("public enrollment candidate never gains authority without exact human-only fingerprint confirmation", async () => {
  const { f } = await fixture(), key = await authenticator(), enrollmentId = "enrollment";
  await assert.rejects(f.call(auth.beginEnrollment, { ...identity(), enrollmentId }), code("FORBIDDEN"));
  await f.call(auth.beginEnrollment, { ...identity(human), enrollmentId });
  const options = await f.call(auth.enrollmentOptions, { enrollmentId }) as { challenge: string; binding: string };
  const candidate = await f.call(auth.stageEnrollment, { enrollmentId, credentialId: key.id, publicKeySpki: key.spki, assertion: await key.sign(options.challenge, { userHandle: null }) }) as { fingerprint: string };
  assert(![...f.rows.values()].some(row => row._table === "approvalPasskeys"));
  await assert.rejects(f.call(auth.finishEnrollment, { ...identity(), enrollmentId, fingerprint: candidate.fingerprint }), code("FORBIDDEN"));
  await assert.rejects(f.call(auth.finishEnrollment, { ...identity(human), enrollmentId, fingerprint: randomChallenge() }), code("FORBIDDEN"));
  assert(![...f.rows.values()].some(row => row._table === "approvalPasskeys"));
  await f.call(auth.finishEnrollment, { ...identity(human), enrollmentId, fingerprint: candidate.fingerprint });
  assert.equal(f.find("approvalPasskeys", key.id).memberId, "human");
});

test("a raced enrollment candidate cannot replace the browser's own confirmed key", async () => {
  const { f } = await fixture(), a = await authenticator(), b = await authenticator();
  await f.call(auth.beginEnrollment, { ...identity(human), enrollmentId: "race" }); const options = await f.call(auth.enrollmentOptions, { enrollmentId: "race" }) as { challenge: string };
  const candidate = await f.call(auth.stageEnrollment, { enrollmentId: "race", credentialId: a.id, publicKeySpki: a.spki, assertion: await a.sign(options.challenge) }) as { fingerprint: string };
  await assert.rejects(f.call(auth.stageEnrollment, { enrollmentId: "race", credentialId: b.id, publicKeySpki: b.spki, assertion: await b.sign(options.challenge) }), code("IDEMPOTENCY_CONFLICT"));
  assert.equal((await f.call(auth.enrollmentStatus, { ...identity(human), enrollmentId: "race" }) as { fingerprint: string }).fingerprint, candidate.fingerprint);
});

test("chat request -> protected HTTP review -> signed approval -> chat receipt completes end to end", async () => {
  const { f, target, source } = await fixture(), key = await authenticator(); await enroll(f, key);
  const backend: CoordBackend = { config: { schemaVersion: 1, backendId: "backend", backendUrl: "https://fixture.convex.cloud", projectId: "project", repository: "github.com/fixture/passkeys", remote: "https://github.com/fixture/passkeys.git", defaultBranch: "main", ruleTargets: ["AGENTS.md"] }, query: async (name, args) => { assert.equal(name, "approvalRequests:get"); return f.call(requests.get, { ...identity(), ...args } as never); }, mutation: async (name, args, requestId) => { assert.equal(name, "approvalRequests:requestRule"); return f.call(requests.requestRule, { ...identity(), ...args, requestId } as never); } };
  const server = createCoordMcpServer({ client: backend }), client = new Client({ name: "browser-handoff-fixture", version: "1" }, { capabilities: { elicitation: { url: {} } } });
  let signed: PasskeyAssertion | undefined, binding: { approvalRequestId: string; requestDigest: string } | undefined;
  client.setRequestHandler(ElicitRequestSchema, async request => {
    assert.equal(request.params.mode, "url"); assert("url" in request.params); const url = new URL(request.params.url); assert.equal(url.origin, origin); binding = { approvalRequestId: url.searchParams.get("request")!, requestDigest: url.searchParams.get("digest")! };
    const shell = await http(f, "/approval"); assert(!(await shell.text()).includes(source.content)); assert.equal(shell.headers.get("X-Frame-Options"), "DENY");
    const options = await (await http(f, "/approval/challenge", { ...binding, phase: "review" })).json();
    const review = await http(f, "/approval/review", { ...binding, assertion: await key.sign(options.challenge) }); assert.equal(review.status, 200); assert.equal((await review.json()).rule.content, source.content);
    const approveOptions = await (await http(f, "/approval/challenge", { ...binding, phase: "approve" })).json(); signed = await key.sign(approveOptions.challenge, { userHandle: null });
    const decided = await http(f, "/approval/decide", { ...binding, decision: "approve", assertion: signed }); assert.equal(decided.status, 200); assert.equal((await decided.json()).state, "approved");
    return { action: "accept" };
  });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    const result = await client.callTool({ name: "coord_request_rule_approval", arguments: { requestId: "full_flow", ...target } }); assert.ok(!result.isError); const view = JSON.parse((result.content as { text: string }[])[0]!.text);
    assert.equal(view.state, "approved"); assert.equal(view.approvedBy, "human"); assert.equal(view.approvedAt, f.find("memories", "rule").approvedAt); assert.equal(view.policyVersion, 2); assert.equal(f.find("projects", "project").policyVersion, 2);
    const before = structuredClone(f.rows); assert(binding && signed); const retry = await http(f, "/approval/decide", { ...binding, decision: "approve", assertion: signed }); assert.equal(retry.status, 200); assert.deepEqual(f.rows, before, "lost-reply retry must not advance policy, counter or audit again");
    await assert.rejects(f.call(requests.cancel, { ...identity(), requestId: "cancel_completed", approvalRequestId: "full_flow" }), code("FORBIDDEN"));
    assert(!JSON.stringify(result).includes(human) && !JSON.stringify(result).includes(agent));
  } finally { await client.close(); await server.close(); }
});

test("a forged native URL accept remains pending without any passkey decision", async () => {
  const { f, target } = await fixture();
  const backend: CoordBackend = { config: { schemaVersion: 1, backendId: "backend", backendUrl: "https://fixture.convex.cloud", projectId: "project", repository: "github.com/fixture/passkeys", remote: "https://github.com/fixture/passkeys.git", defaultBranch: "main", ruleTargets: ["AGENTS.md"] }, query: async (_name, args) => f.call(requests.get, { ...identity(), ...args } as never), mutation: async (_name, args, requestId) => f.call(requests.requestRule, { ...identity(), ...args, requestId } as never) };
  const server = createCoordMcpServer({ client: backend }), client = new Client({ name: "forged-host", version: "1" }, { capabilities: { elicitation: { url: {} } } }); client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept" })); const [a, b] = InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  try { const result = await client.callTool({ name: "coord_request_rule_approval", arguments: { requestId: "forged", ...target } }); const view = JSON.parse((result.content as { text: string }[])[0]!.text);assert.equal(view.state, "pending");assert.equal(view.approved, false);assert.equal(f.find("memories", "rule").status, "proposed"); } finally { await client.close(); await server.close(); }
});

test("approval requires prior private review and the same enrolled human key", async () => {
  const { f, target } = await fixture(), a = await authenticator(), b = await authenticator();await enroll(f, a);await enroll(f, b);const request=await pending(f,target), args={approvalRequestId:request.envelope.id,requestDigest:request.requestDigest};
  await assert.rejects(f.call(auth.challenge,{...args,phase:"approve"}),code("FORBIDDEN"));await reviewed(f,a,request);const challenge=await f.call(auth.challenge,{...args,phase:"approve"}) as { challenge: string };
  const reviewChallenge=await f.call(auth.challenge,{...args,phase:"review"}) as {challenge:string};const before=structuredClone(f.rows);await assert.rejects(f.call(auth.decide,{...args,decision:"approve",assertion:await a.sign(reviewChallenge.challenge)}));assert.deepEqual(f.rows,before,"a review signature cannot authorize approval");await assert.rejects(f.call(auth.decide,{...args,decision:"approve",assertion:await b.sign(challenge.challenge)}),code("FORBIDDEN"));assert.deepEqual(f.rows,before);
});

test("a second project human cannot take the review slot the first reviewer already holds", async () => {
  const { f, target } = await fixture(), first = await authenticator(), second = await authenticator("human2");
  await enroll(f, first); await joinHuman(f, "human2", secondHuman); await enroll(f, second, secondHuman);
  const request = await pending(f, target), args = await reviewed(f, first, request);
  const options = await f.call(auth.challenge, { ...args, phase: "review" }) as { challenge: string }; const before = structuredClone(f.rows);
  await assert.rejects(f.call(auth.review, { ...args, assertion: await second.sign(options.challenge) }), code("IDEMPOTENCY_CONFLICT"));
  assert.deepEqual(f.rows, before, "a raced review must not move the slot or advance the second key's counter");
  assert.equal(f.find("approvalRequests", request.envelope.id).reviewedBy, "human");
  const approve = await f.call(auth.challenge, { ...args, phase: "approve" }) as { challenge: string };
  const decided = await f.call(auth.decide, { ...args, decision: "approve", assertion: await first.sign(approve.challenge) }) as requests.ApprovalRequestView;
  assert.equal(decided.state, "approved"); assert.equal(decided.approvedBy, "human");
});

test("denial consumes only the request and returns its actual human actor/time", async()=>{
 const {f,target}=await fixture(),key=await authenticator();await enroll(f,key);const request=await pending(f,target),args=await reviewed(f,key,request),options=await f.call(auth.challenge,{...args,phase:"deny"}) as { challenge: string };const before=f.find("projects","project").policyVersion;
 const result=await f.call(auth.decide,{...args,decision:"deny",assertion:await key.sign(options.challenge)}) as requests.ApprovalRequestView;assert.equal(result.state,"denied");assert.equal(result.decidedBy,"human");assert.equal(result.approved,false);assert.equal(f.find("memories","rule").status,"proposed");assert.equal(f.find("projects","project").policyVersion,before);
});

test("expired, cancelled and stale requests cannot accept a valid old signature", async()=>{
 for(const fault of ["expired","cancelled","stale"]){const {f,target}=await fixture(),key=await authenticator();await enroll(f,key);const request=await pending(f,target),args=await reviewed(f,key,request),options=await f.call(auth.challenge,{...args,phase:"approve"}) as { challenge: string },proof=await key.sign(options.challenge);const row=f.find("approvalRequests",request.envelope.id);
 const originalNow=Date.now;if(fault==="expired")Date.now=()=>request.envelope.expiresAt+1;
 if(fault==="cancelled")await f.call(requests.cancel,{...identity(),approvalRequestId:row.id});if(fault==="stale")await f.context().db.patch(f.find("memories","rule")._id,{content:"changed"});
 const before=structuredClone(f.rows);try{await assert.rejects(f.call(auth.decide,{...args,decision:"approve",assertion:proof}));assert.deepEqual(f.rows,before);assert.equal(f.find("memories","rule").status,"proposed");}finally{Date.now=originalNow;}}
});

test("revoked key, expired human credential and foreign project cannot authenticate a decision",async()=>{
 for(const fault of ["key","human","project"]){const {f,target}=await fixture(),key=await authenticator();await enroll(f,key);const request=await pending(f,target),args=await reviewed(f,key,request),options=await f.call(auth.challenge,{...args,phase:"approve"}) as { challenge: string },proof=await key.sign(options.challenge);
 if(fault==="key")await f.call(auth.revokePasskey,{...identity(human),credentialId:key.id});if(fault==="human")await f.context().db.patch(f.find("credentials","human")._id,{expiresAt:0});if(fault==="project")await f.context().db.patch(f.find("approvalPasskeys",key.id)._id,{projectId:"foreign"});
 const before=structuredClone(f.rows);await assert.rejects(f.call(auth.decide,{...args,decision:"approve",assertion:proof}));assert.deepEqual(f.rows,before);}
});

test("HTTP rejects cross-origin, oversized and model-authority inputs without exposing private source",async()=>{
 const {f}=await fixture();const before=structuredClone(f.rows);
 const shell=await http(f,"/approval"),html=await shell.text();assert.equal(shell.headers.get("Cache-Control"),"no-store");assert(html.includes("Repository references and file digests are declarations; check them against the actual revision before approving."));
 for(const [path,source] of [["/approval/app.js",approvalJs],["/approval/style.css",approvalCss]]){const hash=await bytesHash(new TextEncoder().encode(source));const version=Array.from(hash,b=>b.toString(16).padStart(2,"0")).join("");const integrity="sha256-"+btoa(String.fromCharCode(...hash));assert(html.includes('"'+path+'?v='+version+'" integrity="'+integrity+'"'));assert.equal(await (await http(f,path!)).text(),source);}
 for(const headers of [{Origin:"https://evil.example","Content-Type":"application/json"},{"Content-Type":"application/json"}] as Record<string,string>[]){const response=await http(f,"/approval/decide",{approved:true,memberId:"human",token:human},headers);assert.equal(response.status,403);assert(!(await response.text()).includes(human));}
 const huge=await http(f,"/approval/challenge",{padding:"x".repeat(33000)});assert.equal(huge.status,403);assert.deepEqual(f.rows,before);
});


test("enrollment operator identity cannot drift between begin and public-key activation", async()=>{
 const {f}=await fixture();const key=await authenticator();const begin=await f.call(auth.beginEnrollment,{...identity(human),enrollmentId:"identity_drift"}) as {memberId:string};assert.equal(begin.memberId,"human");
 const options=await f.call(auth.enrollmentOptions,{enrollmentId:"identity_drift"}) as {challenge:string};
 const candidate=await f.call(auth.stageEnrollment,{enrollmentId:"identity_drift",credentialId:key.id,publicKeySpki:key.spki,assertion:await key.sign(options.challenge)}) as {fingerprint:string};
 await f.context().db.patch(f.find("credentials","human")._id,{memberId:"other_human"});const before=structuredClone(f.rows);
 await assert.rejects(f.call(auth.enrollmentStatus,{...identity(human),enrollmentId:"identity_drift"}),code("FORBIDDEN"));
 await assert.rejects(f.call(auth.finishEnrollment,{...identity(human),enrollmentId:"identity_drift",fingerprint:candidate.fingerprint}),code("FORBIDDEN"));assert.deepEqual(f.rows,before);
});


test("served browser script binds its own enrollment fingerprint and safely renders the real signed flow",async()=>{
 const {f,target}=await fixture(),key=await authenticator();const enrollmentId="browser_script";await f.call(auth.beginEnrollment,{...identity(human),enrollmentId});
 type Element={textContent:string;hidden:boolean;disabled:boolean;onclick:(()=>Promise<void>)|null};
 function page(search:string){const elements=new Map<string,Element>();const element=(id:string)=>{let e=elements.get(id);if(!e){e={textContent:"",hidden:false,disabled:false,onclick:null};elements.set(id,e);}return e;};
 const context={document:{getElementById:element,querySelectorAll:()=>[...elements.values()]},window:{PublicKeyCredential:function(){}},location:{search},URLSearchParams,URL,Uint8Array,TextEncoder,atob,btoa,crypto,navigator:{credentials:{create:async()=>({rawId:decode64(key.id).buffer,response:{getPublicKey:()=>decode64(key.spki).buffer,getPublicKeyAlgorithm:()=>-7}}),get:async({publicKey}:{publicKey:{challenge:Uint8Array}})=>{const proof=await key.sign(encode64(publicKey.challenge));return{rawId:decode64(proof.credentialId).buffer,response:{clientDataJSON:decode64(proof.clientDataJSON).buffer,authenticatorData:decode64(proof.authenticatorData).buffer,signature:decode64(proof.signature).buffer,userHandle:decode64(proof.userHandle!).buffer}};}}},fetch:async(path:string,init:{body:string})=>http(f,path,JSON.parse(init.body))};
 runInNewContext(approvalJs,context);return{element};}
 const setup=page("?enrollment="+enrollmentId);await setup.element("create").onclick!();
 const status=await f.call(auth.enrollmentStatus,{...identity(human),enrollmentId}) as {fingerprint:string};assert(setup.element("fingerprint").textContent.includes(status.fingerprint),setup.element("status").textContent);
 assert(![...f.rows.values()].some(row=>row._table==="approvalPasskeys"));await f.call(auth.finishEnrollment,{...identity(human),enrollmentId,fingerprint:status.fingerprint});
 const request=await pending(f,target);const review=page("?request="+request.envelope.id+"&digest="+request.requestDigest);await review.element("start").onclick!();
 assert.equal(review.element("review").hidden,false,review.element("status").textContent);assert(!review.element("details").textContent.includes("\u202e"));assert(review.element("details").textContent.includes("\\u202e"));
 await review.element("approve").onclick!();assert.equal(f.find("approvalRequests",request.envelope.id).state,"approved",review.element("status").textContent);assert(review.element("status").textContent.includes("was approved"));
});
