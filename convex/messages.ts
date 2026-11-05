import { v } from "convex/values";
import { mutation, query } from "./server.js";
import { authenticate, liveRun, replay, runArgs, identityArgs, stableId, bounded, fail } from "./auth.js";
import { taskById } from "./tasks.js";
const receiptStates = ["queued", "delivered_to_bridge", "offered_to_turn", "injected_into_turn", "acknowledged_by_agent"] as const;
export function boundedRecords<T>(records: T[], maxBytes: number): { records: T[]; complete: boolean; bytes: number } {
  let bytes = 2; const selected: T[] = [];
  for (const record of records) { const size = new TextEncoder().encode(JSON.stringify(record)).length + 1; if (bytes + size > maxBytes) return { records: selected, complete: false, bytes }; selected.push(record); bytes += size; }
  return { records: selected, complete: true, bytes };
}
export const send = mutation({ args: { ...runArgs, messageId: v.string(), recipientTaskId: v.string(), recipientEpoch: v.number(), type: v.string(), payload: v.string(), conflict: v.boolean() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); const { task } = await liveRun(ctx, args, actor);
  return replay(ctx, actor, "messages.send", args, async () => {
    stableId(args.messageId); bounded(args.type, 128, "message type"); bounded(args.payload, 1536, "message payload");
    const recipient = await taskById(ctx, args.recipientTaskId, args.projectId);
    if (recipient.epoch !== args.recipientEpoch) fail("STALE_EPOCH", "Message recipient epoch changed");
    if (await ctx.db.query("messages").withIndex("by_stable_id", q => q.eq("id", args.messageId)).unique()) fail("IDEMPOTENCY_CONFLICT", "Message identity already used");
    await ctx.db.insert("messages", { id: args.messageId, projectId: args.projectId, senderTaskId: task.id, senderEpoch: task.epoch, recipientTaskId: recipient.id, recipientEpoch: recipient.epoch, type: args.type, payload: args.payload, conflict: args.conflict, state: "queued", attempts: 0 });
    return { messageId: args.messageId, state: "queued" as const };
  });
} });
export const read = query({ args: { ...runArgs, cursor: v.optional(v.string()) }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); const { task } = await liveRun(ctx, args, actor);
  const page = await ctx.db.query("messages").withIndex("by_recipient", q => q.eq("projectId", args.projectId).eq("recipientTaskId", task.id)).paginate({ cursor: args.cursor ?? null, numItems: 1 });
  const pending = page.page.filter(m => (m.recipientEpoch === task.epoch && m.state !== "acknowledged_by_agent") || (m.conflict && (m.resolution !== "accepted" || m.decisionRecipientEpoch !== task.epoch)));
  const full = boundedRecords(pending, 2048);
  const truncated = !full.complete;
  const stubs = pending.map(m => ({ id: m.id, senderTaskId: m.senderTaskId, senderEpoch: m.senderEpoch, recipientTaskId: m.recipientTaskId, recipientEpoch: m.recipientEpoch, type: m.type, state: m.state, conflict: m.conflict, resolution: m.resolution, decisionSenderEpoch: m.decisionSenderEpoch, decisionRecipientEpoch: m.decisionRecipientEpoch, payloadPreview: Array.from(m.payload).slice(0, 64).join(""), requiresExpansion: true }));
  const result = truncated ? boundedRecords(stubs, 2048) : full;
  return { messages: result.records, bytes: result.bytes, complete: page.isDone && result.complete && !truncated, nextCursor: page.isDone ? null : page.continueCursor };

} });
export const receipt = mutation({ args: { ...runArgs, messageId: v.string(), state: v.union(v.literal("delivered_to_bridge"), v.literal("offered_to_turn"), v.literal("injected_into_turn"), v.literal("acknowledged_by_agent")) }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); const { task } = await liveRun(ctx, args, actor);
  return replay(ctx, actor, "messages.receipt", args, async () => {
    const message = await ctx.db.query("messages").withIndex("by_stable_id", q => q.eq("id", args.messageId)).unique();
    if (!message || message.projectId !== args.projectId || message.recipientTaskId !== task.id || message.recipientEpoch !== task.epoch) fail("NOT_FOUND", "Message not found for current recipient epoch");
    const state = receiptStates.indexOf(args.state) > receiptStates.indexOf(message.state) ? args.state : message.state;
    await ctx.db.patch(message._id, { state, attempts: message.attempts + 1 }); return { messageId: message.id, state };
  });
} });
export const resolve = mutation({ args: { ...runArgs, messageId: v.string(), resolution: v.union(v.literal("accepted"), v.literal("declined"), v.literal("escalated")), decision: v.string() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); const { task } = await liveRun(ctx, args, actor);
  return replay(ctx, actor, "messages.resolve", args, async () => {
    bounded(args.decision, 2048, "coordination decision");
    const message = await ctx.db.query("messages").withIndex("by_stable_id", q => q.eq("id", args.messageId)).unique();
    if (!message || message.projectId !== args.projectId || message.recipientTaskId !== task.id) fail("NOT_FOUND", "Conflict is not addressed to this task");
    const sender = await taskById(ctx, message.senderTaskId, args.projectId);
    await ctx.db.patch(message._id, { resolution: args.resolution, decision: args.decision, decisionSenderEpoch: sender.epoch, decisionRecipientEpoch: task.epoch });
    return { messageId: message.id, resolution: args.resolution, senderEpoch: sender.epoch, recipientEpoch: task.epoch };
  });
} });

export const resolveBeforeAdmission = mutation({ args: { ...identityArgs, messageId: v.string(), senderEpoch: v.number(), recipientEpoch: v.number(), decision: v.string() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["human"]);
  return replay(ctx, actor, "messages.resolveBeforeAdmission", args, async () => {
    bounded(args.decision, 2048, "coordination decision");
    const message = await ctx.db.query("messages").withIndex("by_stable_id", q => q.eq("id", args.messageId)).unique();
    if (!message || message.projectId !== args.projectId || !message.conflict) fail("NOT_FOUND", "Conflict not found");
    const sender = await taskById(ctx, message.senderTaskId, args.projectId); const recipient = await taskById(ctx, message.recipientTaskId, args.projectId);
    if (sender.epoch !== args.senderEpoch || recipient.epoch !== args.recipientEpoch || recipient.ownerRunId || recipient.holdRunId || !["queued", "blocked"].includes(recipient.state)) fail("STALE_EPOCH", "Human pre-admission decision requires the current settled task epochs before admission");
    // The queued task's next admission increments its epoch; bind the decision to exactly that admission.
    await ctx.db.patch(message._id, { resolution: "accepted", decision: args.decision, decisionSenderEpoch: sender.epoch, decisionRecipientEpoch: recipient.epoch + 1 });
    return { messageId: message.id, resolution: "accepted" as const, recipientAdmissionEpoch: recipient.epoch + 1 };
  });
} });
export const expand = query({ args: { ...runArgs, messageId: v.string(), offset: v.number(), section: v.optional(v.union(v.literal("payload"), v.literal("decision"))) }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); const { task } = await liveRun(ctx, args, actor);
  const message = await ctx.db.query("messages").withIndex("by_stable_id", q => q.eq("id", args.messageId)).unique();
  if (!message || message.projectId !== args.projectId || (message.recipientTaskId !== task.id && message.senderTaskId !== task.id)) fail("NOT_FOUND", "Message is not visible to this task");
  const text = args.section === "decision" ? message.decision ?? "" : message.payload;
  if (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > text.length) fail("INVALID_INPUT", "Invalid expansion offset");
  if (args.offset > 0 && /[\uDC00-\uDFFF]/.test(text[args.offset] ?? "") && /[\uD800-\uDBFF]/.test(text[args.offset - 1] ?? "")) fail("INVALID_INPUT", "Offset splits a Unicode code point");
  let end = args.offset; let bytes = 0; for (const char of text.slice(args.offset)) { const size = new TextEncoder().encode(char).length; if (bytes + size > 1024) break; bytes += size; end += char.length; }
  return { messageId: message.id, section: args.section ?? "payload", payload: text.slice(args.offset, end), nextOffset: end < text.length ? end : null, complete: end === text.length };
} });
