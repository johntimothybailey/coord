import { httpRouter, makeFunctionReference } from "convex/server";
import { httpAction } from "./server.js";
import { siteOrigin } from "./approvalAuth.js";
import { approvalHtml, approvalJs, approvalCss } from "./approvalPage.js";

const router = httpRouter();
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", "Permissions-Policy": "publickey-credentials-create=(self), publickey-credentials-get=(self)", "Cross-Origin-Resource-Policy": "same-origin" };
async function versionedHtml(): Promise<string> {
  let html = approvalHtml;
  for (const [path, source] of [["/approval/app.js", approvalJs], ["/approval/style.css", approvalCss]]) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)));
    const version = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
    const integrity = `sha256-${btoa(String.fromCharCode(...hash))}`;
    html = html.replace(`"${path}"`, `"${path}?v=${version}" integrity="${integrity}"`);
  }
  return html;
}
async function input(request: Request): Promise<Record<string, unknown>> {
  if (new URL(request.url).origin !== siteOrigin() || request.headers.get("Origin") !== siteOrigin() || !request.headers.get("Content-Type")?.startsWith("application/json")) throw new Error("Origin rejected");
  const reader = request.body?.getReader(); if (!reader) throw new Error("Body required");
  const parts: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 32 * 1024) { await reader.cancel(); throw new Error("Body too large"); } parts.push(part.value); } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Object required");
  return value as Record<string, unknown>;
}
for (const [path, body, type] of [["/approval", approvalHtml, "text/html"], ["/approval/app.js", approvalJs, "text/javascript"], ["/approval/style.css", approvalCss, "text/css"]]) {
  router.route({ path: path!, method: "GET", handler: httpAction(async (_ctx, request) => {
    if (new URL(request.url).origin !== siteOrigin()) return new Response("Unavailable", { status: 403, headers });
    return new Response(path === "/approval" ? await versionedHtml() : body, { headers: { ...headers, "Content-Type": `${type}; charset=utf-8` } });
  }) });
}
const routes = { "/approval/challenge": "challenge", "/approval/review": "review", "/approval/decide": "decide", "/approval/enrollment-options": "enrollmentOptions", "/approval/enrollment-candidate": "stageEnrollment" } as const;
for (const [path, name] of Object.entries(routes)) {
  router.route({ path, method: "POST", handler: httpAction(async (ctx, request) => {
    try {
      const args = await input(request);
      const value = name === "enrollmentOptions"
        ? await ctx.runQuery(makeFunctionReference<"query">(`approvalAuth:${name}`), args as never)
        : await ctx.runMutation(makeFunctionReference<"mutation">(`approvalAuth:${name}`), args as never);
      return new Response(JSON.stringify(value), { headers: { ...headers, "Content-Type": "application/json" } });
    } catch { return new Response(JSON.stringify({ error: "Protected verification rejected. Check request status in chat or restart protected enrollment." }), { status: 403, headers: { ...headers, "Content-Type": "application/json" } }); }
  }) });
}
export default router;
