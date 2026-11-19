import { v } from "convex/values";
import { boundedMcpClientInfo } from "../src/protocol.js";
import type { McpClientInfo } from "../src/protocol.js";
import { components } from "./_generated/api.js";
import { digest, fail } from "./auth.js";
import { currentConnection, oauthResource } from "./oauthAuthority.js";
import { mcpClientInfo } from "./schema.js";
import { internalMutation } from "./server.js";
import type { Doc, QueryCtx } from "./server.js";

export function localClientObservation(info: McpClientInfo, credentialId: string) {
  const clientInfo = boundedMcpClientInfo(info);
  if (!clientInfo) fail("INVALID_INPUT", "Invalid bounded MCP client metadata");
  // Run/agent credentials cannot prove that their caller observed local stdio.
  return { provenance: "self_reported" as const, reportedOrigin: "local_mcp_initialize" as const, clientInfo, credentialId, observedAt: Date.now() };
}
export async function connectionObservation(ctx: Pick<QueryCtx, "db">, actor: Doc<"credentials">) {
  return actor.connectionId ? (await ctx.db.get(actor.connectionId))?.clientObservation : undefined;
}
/** Only the server's accepted initialize exchange may call this internal writer. */
export const recordHandshake = internalMutation({ args: { bearer: v.string(), clientInfo: mcpClientInfo }, handler: async (ctx, args) => {
  const clientInfo = boundedMcpClientInfo(args.clientInfo);
  if (!clientInfo || !args.bearer || args.bearer.length > 4096) fail("INVALID_INPUT", "Invalid MCP observation");
  const verified = await ctx.runQuery(components.mcp.tokens.verify, { hash: await digest(args.bearer), now: Date.now() });
  if (!verified || verified.kind !== "access" || verified.resource !== oauthResource()) fail("UNAUTHORIZED", "OAuth bearer unavailable");
  const connection = await ctx.db.query("mcpConnections").withIndex("by_grant", q => q.eq("grantId", verified.grantId)).unique();
  const state = await currentConnection(ctx, connection);
  if (state.connection.userId !== verified.userId || state.connection.clientId !== verified.clientId) fail("UNAUTHORIZED", "Foreign MCP connection");
  await ctx.db.patch(state.connection._id, { clientObservation: { provenance: "mcp_handshake", clientInfo, observedAt: Date.now() } });
  return { recorded: true };
} });
