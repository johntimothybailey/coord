import { McpServer, tool } from "@convex-dev/mcp";
import type { HttpRouter } from "convex/server";
import type { McpUser, ToolCtx } from "@convex-dev/mcp";
import { httpRouter, httpActionGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { identityArgs } from "./authArgs.js";
import { OAUTH_SCOPES } from "./oauthPolicy.js";
import { repositoryMemorySource } from "./schema.js";

const { token: _token, oauthBearer: _bearer, ...requestArgs } = identityArgs;
function bearerFrom(request: Request): string | undefined {
  const value = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  return value && value.length <= 4096 ? value : undefined;
}
function toolsFor(bearer: string | undefined) {
  const forward = (ctx: ToolCtx, name: string, args: Record<string, unknown>, kind: "query" | "mutation") => {
    // The request-local closure never accepts identity claims from McpUser or
    // tool args as authority. The actual domain transaction verifies this bearer.
    const payload = { ...args, token: "", oauthBearer: bearer };
    return kind === "query" ? ctx.runQuery(makeFunctionReference<"query">(name), payload as never) : ctx.runMutation(makeFunctionReference<"mutation">(name), payload as never);
  };
  return {
    coord_bind: tool({ description: "Bind this live OAuth connection after authenticated browser project consent. Does not approve artifacts.", args: requestArgs, scope: "coord:read", annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }, handler: (ctx, args) => forward(ctx, "oauthAuthority:bind", args, "mutation") }),
    coord_status: tool({ description: "Read current project and goal status.", args: requestArgs, scope: "coord:read", annotations: { readOnlyHint: true, openWorldHint: false }, handler: (ctx, args) => forward(ctx, "projects:status", args, "query") }),
    coord_project_rules: tool({ description: "Read approved project rules.", args: requestArgs, scope: "coord:read", annotations: { readOnlyHint: true, openWorldHint: false }, handler: (ctx, args) => forward(ctx, "memories:projectRules", args, "query") }),
    coord_review_memories: tool({ description: "List proposed rules or learned lessons for advisory review.", args: { ...requestArgs, kind: v.union(v.literal("rule"), v.literal("lesson")), cursor: v.optional(v.string()) }, scope: "coord:read", annotations: { readOnlyHint: true, openWorldHint: false }, handler: (ctx, args) => forward(ctx, "memories:reviewList", args, "query") }),
    coord_review_memory: tool({ description: "Read canonical detail at one exact revision and hash. Expand every chunk before requesting approval.", args: { ...requestArgs, memoryId: v.string(), revision: v.number(), hash: v.string(), offset: v.optional(v.number()) }, scope: "coord:read", annotations: { readOnlyHint: true, openWorldHint: false }, handler: (ctx, args) => forward(ctx, "memories:reviewDetail", args, "query") }),
    coord_propose_rule: tool({ description: "Propose source-backed guidance; this grants no approval authority.", args: { ...requestArgs, memoryId: v.string(), content: v.string(), sources: v.array(repositoryMemorySource), applicability: v.array(v.string()), confidence: v.string() }, scope: "coord:propose", annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }, handler: (ctx, args) => forward(ctx, "memories:proposeRule", args, "mutation") }),
    coord_request_rule_approval: tool({ description: "Request exact human passkey approval and return its binding and status. A chat response is not approval.", args: { ...requestArgs, memoryId: v.string(), revision: v.number(), hash: v.string() }, scope: "coord:approval-request", annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }, handler: (ctx, args) => forward(ctx, "approvalRequests:requestRule", args, "mutation") }),
    coord_approval_request: tool({ description: "Read authoritative approval request status after pending or uncertain outcomes.", args: { ...requestArgs, approvalRequestId: v.string() }, scope: "coord:read", annotations: { readOnlyHint: true, openWorldHint: false }, handler: (ctx, args) => forward(ctx, "approvalRequests:get", args, "query") }),
    coord_cancel_approval_request: tool({ description: "Withdraw a pending approval request; completed decisions cannot be cancelled.", args: { ...requestArgs, approvalRequestId: v.string() }, scope: "coord:approval-request", annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }, handler: (ctx, args) => forward(ctx, "approvalRequests:cancel", args, "mutation") }),
  };
}
// Override only the supported public hook: read-only review must not depend on
// the package's optional stale-telemetry touch mutation.
class QueryOnlyMcpServer extends McpServer {
  override async authenticate(ctx: ToolCtx, request: Request): Promise<McpUser | null> {
    const bearer = bearerFrom(request); if (!bearer) return null;
    return ctx.runQuery(makeFunctionReference<"query">("oauthAuthority:inspectBearer"), { bearer }) as Promise<McpUser | null>;
  }
}
const options = {
  name: "coord", version: "0.1.0",
  consentUrl: process.env.COORD_OAUTH_CONSENT_URL ?? "",
  instructions: "Review and propose through scoped tools. Binding requires a live browser session, owner-installed project link and exact grant consent. Connect UI is not delivered by this foundation. Human approval requires the protected passkey page.",
  scopes: Object.fromEntries(OAUTH_SCOPES.map(scope => [scope, `Restrict existing Coord authority to ${scope.slice(6)} operations in the authenticated project consent.`])),
  accessTokenTtlMs: 5 * 60_000, deviceFlow: false,
};
class RequestScopedMcpServer extends QueryOnlyMcpServer {
  override registerRoutes(http: HttpRouter): void {
    const consentUrl = this.options.consentUrl;
    if (consentUrl && new URL(consentUrl).protocol !== "https:") throw new Error("Protected OAuth consent requires HTTPS");
    const routes = httpRouter();
    super.registerRoutes(routes);
    for (const [path, method, handler] of routes.getRoutes()) {
      http.route({ path, method, handler: path === `${this.path}/oauth/authorize` && !process.env.COORD_OAUTH_CONSENT_URL
        ? httpActionGeneric(async () => new Response("Protected OAuth consent is not configured. This foundation does not include a Connect UI.", { status: 503, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } }))
        : handler });
    }
  }
  override handleMcp(ctx: ToolCtx, request: Request): Promise<Response> {
    const scoped = new QueryOnlyMcpServer(components.mcp, { ...options, tools: toolsFor(bearerFrom(request)) });
    return scoped.handleMcp(ctx, request);
  }
}
export const mcpIngress = new RequestScopedMcpServer(components.mcp, { ...options, tools: toolsFor(undefined) });
