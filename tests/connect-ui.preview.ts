/** Loopback-only UI fixture. No real authenticator, identity or backend. */
import { createServer } from "node:http";
import { connectHtml, connectCss } from "../convex/connectPage.js";
import { connectJs } from "../convex/connectAssets.generated.js";
const fixture = `"use strict";
const originalFetch=window.fetch.bind(window), token={accessToken:"fixture.access.signature",refreshToken:"fixture-only-refresh",refreshTokenExpiresAt:Date.now()+3600000,userId:"fixture-public-user"};
let active=false,state="pending",failNext=false;const revokedIds=new Set();
// Two pages per section, served through connect:linkPage / connect:connectionPage, so the
// independent Show more controls, the non-selectable link card and the expired-but-unrevoked
// record (which still offers Disconnect, because Coord's cap removes no host grant) are all
// visible. connect:identity serves no page and no cursor: it returns only the user ID plus a
// bounded non-failing list and a "more" boolean. Fixture data only; no authority.
// FIXTURE ONLY rehearsal switches make all three post-disconnect messages reachable:
// default (two pages) reports the live-cursor message naming Show more connections;
// ?fixture-connections=single collapses the listing to one page and reports the complete-set
// message; ?fixture-fail=connections fails the next connection page read exactly once after a
// disconnect, so the separate "could not be refreshed" message and Reload connections appear
// and the following reload recovers.
const params=new URLSearchParams(location.search),singlePage=params.get("fixture-connections")==="single",failReload=params.get("fixture-fail")==="connections";
const page=(all,cursor)=>{const index=cursor?Number(cursor):0,complete=index>=all.length-1;return{rows:all[index]||[],complete,nextCursor:complete?null:String(index+1)};};
const linkPages=()=>[[{linkId:"fixture-link",generation:2,backendId:"fixture-backend",projectId:"fixture-project",sourceCredentialId:"fixture-agent",scopes:["coord:read"],activationExpiresAt:Date.now()+600000,expiresAt:Date.now()+3600000,active,selectable:true}],[{linkId:"fixture-stale-link",generation:1,backendId:"fixture-backend",projectId:"fixture-project",sourceCredentialId:"fixture-agent",scopes:["coord:read"],activationExpiresAt:Date.now()-600000,expiresAt:Date.now()+3600000,active:false,selectable:false}]];
const connectionRow=(id,expired)=>({connectionId:id,projectId:"fixture-project",absoluteExpiresAt:expired?Date.now()-1000:Date.now()+3600000,revoked:revokedIds.has(id),expired});
// Connection records belong to the account, not to the handoff, so they are listed as soon
// as this fixture account is signed in: that is what makes the expired-but-unrevoked record
// and its Disconnect control actually visible in the rehearsal.
const connectionPages=()=>{const rows=[connectionRow("fixture-connection",false),connectionRow("fixture-expired-connection",true)];return singlePage?[rows]:[[rows[0]],[rows[1]]];};
Object.defineProperty(window,"PublicKeyCredential",{configurable:true,value:class{}});
const credential={id:"fixture-key",rawId:new Uint8Array([1]).buffer,response:{clientDataJSON:new Uint8Array([2]).buffer,attestationObject:new Uint8Array([3]).buffer,authenticatorData:new Uint8Array([4]).buffer,signature:new Uint8Array([5]).buffer,userHandle:null,getTransports:()=>["internal"]}};
Object.defineProperty(navigator,"credentials",{configurable:true,value:{create:async()=>credential,get:async()=>credential}});
window.fetch=async(input,options)=>{if(String(input)==="/connect/config")return Response.json({siteOrigin:location.origin,backendUrl:"https://fixture-connect.convex.cloud"});if(!String(input).startsWith("https://fixture-connect.convex.cloud/api/"))return originalFetch(input,options);const request=JSON.parse(options.body),args=request.args[0];let value;
switch(request.path){case"authSignin:startSignInWithUsernamePasskey":value={success:true,step:"register",options:{challenge:"AQ",rp:{id:"localhost",name:"FIXTURE"},user:{id:"Ag",name:"fixture",displayName:"fixture"},pubKeyCredParams:[{type:"public-key",alg:-7}],excludeCredentials:[]}};break;case"authSignin:finishSignUpWithUsernamePasskey":value={status:"complete",tokens:token};break;case"authCore:refreshSession":value={kind:"rotated",tokens:token};break;case"authCore:signOut":value=null;break;case"connect:identity":{const l=linkPages().flat(),c=connectionPages().flat();value={userId:"fixture-public-user",links:l.filter(r=>r.selectable!==false).slice(0,100).map(({selectable,...r})=>r),linksMore:l.length>100,connections:c.slice(0,100),connectionsMore:c.length>100};break;}case"connect:linkPage":{const l=page(linkPages(),args.cursor);value={links:l.rows,complete:l.complete,nextCursor:l.nextCursor};break;}case"connect:connectionPage":{if(failNext){failNext=false;value={connections:"fixture-unavailable",complete:true,nextCursor:null};break;}const c=page(connectionPages(),args.cursor);value={connections:c.rows,complete:c.complete,nextCursor:c.nextCursor};break;}case"oauthAuthority:activateLink":active=true;value={active};break;case"oauthAuthority:revokeConnection":revokedIds.add(args.connectionId);failNext=failReload;value={revoked:true};break;case"connect:status":value={state};break;case"connect:review":value={state,review:{handoffId:args.handoffId,grantId:"fixture-grant",userId:"fixture-public-user",clientId:"fixture-client",resource:"https://fixture-connect.convex.site/mcp",backendId:"fixture-backend",projectId:"fixture-project",sourceCredentialId:"fixture-agent",linkId:"fixture-link",generation:1,scopes:["coord:read"],absoluteExpiresAt:Date.now()+3600000},digest:"d".repeat(64)};break;case"connect:complete":state="authorized_awaiting_host";value={state};break;case"connect:cancel":state="cancelled";value={state};break;case"mcpConsent:getAuthRequest":value={kind:"redirect",clientName:"Fixture requesting client — unverified",clientId:"fixture-client",redirectUri:"http://127.0.0.1:4567/callback",scopes:["coord:read","coord:approval-request"],status:"pending"};break;case"mcpConsent:authorize":value={redirectUrl:"http://127.0.0.1:4567/callback?code=fixture-only"};break;default:throw Error("Unexpected fixture operation");}return Response.json({status:"success",value,logLines:[]});};`;
const server = createServer((request, response) => {
  const path = new URL(request.url!, "http://127.0.0.1").pathname;
  response.setHeader("Cache-Control", "no-store");
  if (path === "/connect") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(connectHtml.replace('<script src="/connect/app.js" defer>', '<script src="/fixture.js"></script><script src="/connect/app.js" defer>').replace('<main>', '<main><p role="note" style="padding:12px;border:2px solid #a65c00">FIXTURE ONLY · fake authenticator and RPC. No account, project authority or human qualification. Fixture-only rehearsal switches: ?fixture-connections=single and ?fixture-fail=connections.</p>')); }
  else if (path === "/fixture.js" || path === "/connect/app.js") { response.setHeader("Content-Type", "text/javascript"); response.end(path === "/fixture.js" ? fixture : connectJs); }
  else if (path === "/connect/style.css") { response.setHeader("Content-Type", "text/css"); response.end(connectCss); }
  else { response.statusCode = 404; response.end("Fixture route unavailable"); }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address(); if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}/connect?handoff=${"a".repeat(64)}`;
  console.log(`UI fixture only: ${base}`);
  // Each rehearsal of the three separate post-disconnect outcomes, all fixture data only.
  console.log(`UI fixture only (one connection page, complete-set disconnect message): ${base}&fixture-connections=single`);
  console.log(`UI fixture only (disconnect whose reload fails once): ${base}&fixture-fail=connections`);
});
