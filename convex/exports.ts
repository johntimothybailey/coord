import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { authenticate, identityArgs, fail } from "./auth.js";
import { query } from "./server.js";

export const page = query({ args: { ...identityArgs, table: v.union(v.literal("goals"), v.literal("tasks"), v.literal("runs"), v.literal("scans"), v.literal("messages"), v.literal("memories"), v.literal("checkpoints"), v.literal("publications"), v.literal("audit")), pagination: paginationOptsValidator }, handler: async (ctx, args) => {
  const { project } = await authenticate(ctx, args, ["agent", "human"]);
  if (!Number.isSafeInteger(args.pagination.numItems) || args.pagination.numItems < 1 || args.pagination.numItems > 100) fail("INVALID_INPUT", "Export pages must contain 1–100 records");
  const records = await ctx.db.query(args.table).withIndex("by_project", q => q.eq("projectId", project.id)).paginate(args.pagination);
  // Credentials, invitations and idempotency storage are deliberately not in this allowlist.
  return { schemaVersion: 1, projectId: project.id, table: args.table, ...records };
} });
