import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexToJson } from "convex/values";
import type { Value } from "convex/values";
import { BackendFixture } from "./backend.fixture.js";
import * as auth from "../convex/auth.js";
import * as passkeys from "../convex/approvalAuth.js";
import * as projects from "../convex/projects.js";
import { bootstrapArguments, createBundle, parseSetupPlan } from "../src/onboarding.js";
import { passkeySetupCommand } from "../src/passkey-setup.js";
import { CoordError } from "../src/protocol.js";

process.env.CONVEX_SITE_URL = "https://fixture.convex.site";
const password = "SYNTHETIC OPERATOR PASSPHRASE NEVER REAL";
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "coord-passkey-operator-"))), root = join(directory, "repository"); await mkdir(root);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, stdio: "ignore" }); execFileSync("git", ["remote", "add", "origin", "https://github.com/fixture/operator.git"], { cwd: root, stdio: "ignore" });
  const plan = parseSetupPlan({ schemaVersion: 1, deploymentName: "fixture", workspaceRoot: root, config: { schemaVersion: 1, backendId: "backend", backendUrl: "https://fixture.convex.cloud", projectId: "project", repository: "github.com/fixture/operator", remote: "https://github.com/fixture/operator.git", defaultBranch: "main", ruleTargets: ["AGENTS.md"] }, humanId: "human", agentId: "agent", credentialExpiresAt: Date.now() + 3600_000, policy: { allowedPaths: ["src"], excludedPaths: [], sharingApproved: true, capacity: 2, taskCap: 20 } });
  const planPath = join(directory, "plan.json"); await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 }); const vault = join(directory, "operator/vault.json"), bundle = await createBundle(plan, vault, password), f = new BackendFixture();await f.call(auth.bootstrap, bootstrapArguments(plan, bundle) as never);
  return { directory, planPath, vault, bundle, f };
}
const handlers = { "auth:handshake": auth.handshake, "projects:status": projects.status, "approvalAuth:beginEnrollment": passkeys.beginEnrollment, "approvalAuth:enrollmentStatus": passkeys.enrollmentStatus, "approvalAuth:finishEnrollment": passkeys.finishEnrollment };
async function wire(f: BackendFixture, run: () => Promise<void>, transform: (path: string, value: Value) => Value = (_path, value) => value, calls: string[] = []) {
  const original = globalThis.fetch; globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { path: keyof typeof handlers; args: unknown[] };
    calls.push(body.path);
    try { return new Response(JSON.stringify({ status: "success", value: convexToJson(transform(body.path, await f.call(handlers[body.path] as never, body.args[0] as never) as Value)), logLines: [] })); }
    catch (error) { if (!(error as {data?:unknown}).data)throw error;return new Response(JSON.stringify({status:"error",errorMessage:"Fixture rejected",errorData:(error as {data:Value}).data,logLines:[]})); }
  };
  try { await run(); } finally { globalThis.fetch = original; }
}

test("protected operator enrollment reports only an exactly confirmed backend key and refuses uncertain replies",async()=>{
 for(const corrupt of [false,true]){const x=await fixture(),shown:string[]=[],prompts:string[]=[];let id="",browserInput=false;
 try{await wire(x.f,async()=>{const operation=passkeySetupCommand([x.planPath,x.vault],{write:text=>{shown.push(text);},prompt:async(label,hidden)=>{prompts.push(label);if(label==="Browser's own fingerprint (43 characters, copied from the browser): "){assert.equal(hidden,false);assert(![...shown,...prompts].join("").includes("f".repeat(43)),"the staged fingerprint must not be disclosed before browser input");browserInput=true;return "f".repeat(43);}return hidden?password:label.slice(5,label.indexOf(" to approve exactly this:"));},openBrowser:async url=>{id=new URL(url).searchParams.get("enrollment")!;const row=[...x.f.rows.values()].find(row=>row._table==="approvalEnrollments"&&row.id===id)!;await x.f.context().db.patch(row._id as never,{credentialId:"Y3JlZGVudGlhbA",publicKeySpki:"cHVibGlj",fingerprint:"f".repeat(43),signCount:0});}});
 if(corrupt){await assert.rejects(operation,/enrollment reply unconfirmed/);assert(!shown.join("").includes("Passkey enrolled."));}else{await operation;assert(shown.join("").includes("Passkey enrolled."));}
 assert(browserInput,"enrollment requires independent browser fingerprint input");assert.equal(x.f.find("approvalEnrollments",id).enrolledAt!==undefined,true,"a lost reply does not roll back the backend effect");for(const secret of [password,x.bundle.humanToken,x.bundle.agentToken,"reply-secret-canary"])assert(!shown.join("").includes(secret));
 },(path,value)=>path==="approvalAuth:finishEnrollment"&&corrupt?{...value as Record<string,Value>,memberId:"wrong-human",secret:"reply-secret-canary"}:value);}finally{await rm(x.directory,{recursive:true,force:true});}}
});

test("enrollment refuses mismatched, missing, invalid or cancelled browser fingerprints before activation",async()=>{
 for(const scenario of ["mismatch","blank","invalid","browser-error","forged-stage","malformed-stage","cancel"]){
  const x=await fixture(),shown:string[]=[],prompts:string[]=[],calls:string[]=[];let id="",browserInput=false;
  try{await wire(x.f,async()=>{
   await assert.rejects(passkeySetupCommand([x.planPath,x.vault],{
    write:text=>{shown.push(text);},
    prompt:async(label,hidden)=>{prompts.push(label);if(label==="Browser's own fingerprint (43 characters, copied from the browser): "){browserInput=true;assert(![...shown,...prompts].join("").includes("f".repeat(43)));assert(![...shown,...prompts].join("").includes("g".repeat(43)));if(scenario==="cancel")throw new CoordError("NEEDS_HUMAN","Protected input cancelled");return scenario==="blank"?"":scenario==="invalid"?"!".repeat(43):scenario==="browser-error"?"Browser could not create a passkey":scenario==="mismatch"?"g".repeat(43):"f".repeat(43);}return hidden?password:label.slice(5,label.indexOf(" to approve exactly this:"));},
    openBrowser:async url=>{id=new URL(url).searchParams.get("enrollment")!;await x.f.context().db.patch(x.f.find("approvalEnrollments",id)._id,{credentialId:"Y3JlZGVudGlhbA",publicKeySpki:"cHVibGlj",fingerprint:"f".repeat(43),signCount:0});}
   }),error=>{const message=String(error);assert(!message.includes("f".repeat(43)));assert(!message.includes("g".repeat(43)));assert.match(message,scenario==="cancel"?/Protected input cancelled/:scenario==="malformed-stage"?/Invalid enrollment fingerprint/:scenario==="mismatch"||scenario==="forged-stage"?/Browser fingerprint did not match/:/Browser fingerprint must be exactly 43/);return true;});
   assert.equal(browserInput,scenario!=="malformed-stage",scenario);
   assert(!calls.includes("approvalAuth:finishEnrollment"),scenario);
   assert.equal(x.f.find("approvalEnrollments",id).enrolledAt,undefined,scenario);
   assert(![...x.f.rows.values()].some(row=>row._table==="approvalPasskeys"),scenario);
   assert(!shown.join("").includes("Passkey enrolled."),scenario);
   assert(![...shown,...prompts].join("").includes("f".repeat(43)),scenario);
   assert(![...shown,...prompts].join("").includes("g".repeat(43)),scenario);
  },(path,value)=>path==="approvalAuth:enrollmentStatus"&&(scenario==="forged-stage"||scenario==="malformed-stage")?{...value as Record<string,Value>,fingerprint:scenario==="forged-stage"?"g".repeat(43):"g".repeat(42)}:value,calls);
  }finally{await rm(x.directory,{recursive:true,force:true});}
 }
});

test("operator plan member mismatch blocks enrollment before opening a browser or activating a key",async()=>{
 const x=await fixture();try{await x.f.context().db.patch(x.f.find("credentials","human")._id,{memberId:"different-human"});let opened=false;await wire(x.f,async()=>{await assert.rejects(passkeySetupCommand([x.planPath,x.vault],{write:()=>{},prompt:async(label,hidden)=>hidden?password:label.slice(5,label.indexOf(" to approve exactly this:")),openBrowser:async()=>{opened=true;}}),/exact enrollment/);});assert.equal(opened,false);assert(![...x.f.rows.values()].some(row=>row._table==="approvalPasskeys"));}finally{await rm(x.directory,{recursive:true,force:true});}
});
