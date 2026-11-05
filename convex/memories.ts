import { v } from "convex/values";
import { mutation, query } from "./server.js";
import { authenticate, liveRun, replay, runArgs, identityArgs, stableId, bounded, path, fail, digest, canonical } from "./auth.js";
import { taskById } from "./tasks.js";
import { boundedRecords } from "./messages.js";
const source = v.object({ taskId: v.string(), revision: v.string(), evidenceRef: v.string() });
export const record = mutation({ args: { ...runArgs, memoryId: v.string(), kind: v.union(v.literal("lesson"), v.literal("decision"), v.literal("rule")), content: v.string(), sources: v.array(source), applicability: v.array(v.string()), confidence: v.string() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); await liveRun(ctx, args, actor);
  return replay(ctx, actor, "memories.record", args, async () => {
    stableId(args.memoryId); bounded(args.content, 4096, "memory"); bounded(args.confidence, 64, "confidence");
    if (!args.sources.length || args.sources.length > 20 || args.applicability.length > 50) fail("INVALID_INPUT", "Memory provenance/applicability bounds exceeded");
    for (const p of args.applicability) path(p);
    for (const s of args.sources) { await taskById(ctx, s.taskId, args.projectId); bounded(s.revision, 256, "source revision"); bounded(s.evidenceRef, 1024, "source evidence"); }
    if (await ctx.db.query("memories").withIndex("by_stable_id", q => q.eq("id", args.memoryId)).unique()) fail("IDEMPOTENCY_CONFLICT", "Memory identity already used");
    const hash = await digest(canonical({ kind: args.kind, content: args.content, sources: args.sources, applicability: args.applicability, confidence: args.confidence }));
    const status = args.kind === "rule" ? "proposed" as const : "active" as const;
    await ctx.db.insert("memories", { id: args.memoryId, projectId: args.projectId, kind: args.kind, content: args.content, revision: 1, hash, sources: args.sources, applicability: args.applicability, confidence: args.confidence, status });
    return { memoryId: args.memoryId, revision: 1, hash, status };
  });
} });
export const approveRule = mutation({ args: { ...identityArgs, memoryId: v.string(), revision: v.number(), hash: v.string() }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["human"]);
  return replay(ctx, actor, "memories.approveRule", args, async () => {
    const memory = await ctx.db.query("memories").withIndex("by_stable_id", q => q.eq("id", args.memoryId)).unique();
    if (!memory || memory.projectId !== project.id || memory.kind !== "rule" || memory.status !== "proposed" || memory.hash !== args.hash || memory.revision !== args.revision) fail("FORBIDDEN", "Approval must bind the exact proposed rule revision/hash");
    const records = await ctx.db.query("memories").withIndex("by_project_kind_status", q => q.eq("projectId", project.id).eq("kind", "rule").eq("status", "active")).take(201);
    const approved = records.filter(r => r.kind === "rule" && r.status === "active");
    const result = boundedRecords([...approved, { ...memory, status: "active", approvedBy: actor.memberId, approvedHash: memory.hash, policyVersion: project.policyVersion + 1 }], 12 * 1024);
    if (records.length > 200 || !result.complete) fail("COVERAGE_INCOMPLETE", "Approved rules exceed bounded complete briefing capacity");
    const policyVersion = project.policyVersion + 1;
    await ctx.db.patch(memory._id, { status: "active", approvedBy: actor.memberId, approvedHash: memory.hash, policyVersion }); await ctx.db.patch(project._id, { policyVersion });
    return { memoryId: memory.id, policyVersion, hash: memory.hash };
  });
} });
export const rules = query({ args: runArgs, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["run"]); await liveRun(ctx, args, actor);
  const records = await ctx.db.query("memories").withIndex("by_project_kind_status", q => q.eq("projectId", project.id).eq("kind", "rule").eq("status", "active")).take(201);
  const result = boundedRecords(records.filter(r => r.kind === "rule" && r.status === "active" && r.approvedHash === r.hash && !!r.approvedBy), 12 * 1024);
  return { rules: result.records, ruleTargets: project.ruleTargets, policyVersion: project.policyVersion, complete: records.length <= 200 && result.complete, bytes: result.bytes };
} });
export const context = query({ args: { ...runArgs, cursor: v.optional(v.string()) }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); const { task } = await liveRun(ctx, args, actor);
  const page = await ctx.db.query("memories").withIndex("by_project", q => q.eq("projectId", args.projectId)).paginate({ cursor: args.cursor ?? null, numItems: 1 });
  const related = page.page.filter(r => (r.status === "active" || r.status === "conflicting") && r.applicability.some(p => task.scope.some(s => p === s || p.startsWith(`${s}/`) || s.startsWith(`${p}/`))));
  const full = boundedRecords(related.map(memory => ({ ...memory, untrusted: memory.kind !== "rule", authoritative: memory.kind === "rule" && memory.approvedHash === memory.hash && !!memory.approvedBy })), 10 * 1024);
  const truncated = !full.complete;
  const selected = truncated ? boundedRecords(related.map(memory => ({ id: memory.id, revision: memory.revision, kind: memory.kind, status: memory.status, hash: memory.hash, contentPreview: Array.from(memory.content).slice(0, 128).join(""), sourceCount: memory.sources.length, untrusted: true, authoritative: false, requiresExpansion: true })), 10 * 1024) : full;
  const goalTasks = await ctx.db.query("tasks").withIndex("by_goal", q => q.eq("goalId", task.goalId)).take(101);
  const taskResult = boundedRecords(goalTasks.filter(t => t.id !== task.id).map(t => ({ id: t.id, title: t.title, scope: t.scope, state: t.state, latestCheckpointId: t.latestCheckpointId, publicationId: t.publicationId, codeAvailability: t.latestCheckpointId ? "published_reference_requires_verification" : "unavailable" })), 2 * 1024);
  return { memories: selected.records, tasks: taskResult.records, bytes: selected.bytes + taskResult.bytes, complete: page.isDone && goalTasks.length <= 100 && selected.complete && taskResult.complete && !truncated, nextCursor: page.isDone ? null : page.continueCursor };
} });
export const expand = query({ args: { ...runArgs, memoryId: v.string(), offset: v.number(), sourceOffset: v.optional(v.number()) }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["run"]); await liveRun(ctx, args, actor);
  const memory = await ctx.db.query("memories").withIndex("by_stable_id", q => q.eq("id", args.memoryId)).unique();
  if (!memory || memory.projectId !== args.projectId) fail("NOT_FOUND", "Memory is unavailable in this project");
  if (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > memory.content.length) fail("INVALID_INPUT", "Invalid expansion offset");
  if (args.offset > 0 && /[\uDC00-\uDFFF]/.test(memory.content[args.offset] ?? "") && /[\uD800-\uDBFF]/.test(memory.content[args.offset - 1] ?? "")) fail("INVALID_INPUT", "Offset splits a Unicode code point");
  const sourceOffset = args.sourceOffset ?? 0;
  if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0 || sourceOffset > memory.sources.length) fail("INVALID_INPUT", "Invalid source expansion offset");
  let end = args.offset; let bytes = 0;
  for (const char of memory.content.slice(args.offset)) { const size = new TextEncoder().encode(char).length; if (bytes + size > 1408) break; bytes += size; end += char.length; }
  const sources = boundedRecords(memory.sources.slice(sourceOffset), 1664);
  return { memoryId: memory.id, revision: memory.revision, status: memory.status, content: memory.content.slice(args.offset, end), nextOffset: end < memory.content.length ? end : null, complete: end === memory.content.length && sources.complete, sources: sources.records, sourceCoverageComplete: sources.complete, nextSourceOffset: sources.complete ? null : sourceOffset + sources.records.length };
} });
