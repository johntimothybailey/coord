import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { mcpIngress } from "./mcpIngress.js";
import { components } from "./_generated/api.js";
import { query } from "./server.js";
import type { QueryCtx } from "./server.js";
import { fail } from "./auth.js";

const identityQuery = makeFunctionReference<"query", Record<string, never>, string | null>("oauthAuthority:browserIdentity");
// The SDK callback type exposes auth only, although its supported API passes
// the real query/mutation/action ctx. Authorize is an action, so resolve enabled
// application identity through a query rather than assuming ctx.db exists.
const sdk = mcpIngress.api({ getUserId: async ctx => {
  if (!("runQuery" in ctx) || typeof ctx.runQuery !== "function") return null;
  return (ctx.runQuery as QueryCtx["runQuery"])(identityQuery, {});
} });
export const authorize = sdk.authorize;
// The package's getAuthRequest helper is public by design. This application
// deliberately gates its component delegation on a live enabled browser user.
export const getAuthRequest = query({ args: { requestId: v.string() }, handler: async (ctx, args) => {
  if (!await ctx.runQuery(identityQuery, {})) fail("UNAUTHORIZED", "Live enabled browser identity required");
  return ctx.runQuery(components.mcp.oauth.getAuthRequest, args);
} });
