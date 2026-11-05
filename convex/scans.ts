import { v } from "convex/values";
import { verifiedRun } from "./artifacts.js";
import { mutation } from "./server.js";
import { authenticate, liveRun, replay, runArgs, paths, bounded, integer, digest, canonical, fail } from "./auth.js";
export const upload = mutation({ args: { ...runArgs, revision: v.string(), sourceHead: v.string(), tree: v.string(), chunk: v.number(), paths: v.array(v.string()), digest: v.string(), expectedChunks: v.number(), expectedPaths: v.number() }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["run"]); const { task } = await liveRun(ctx, args, actor);
  return replay(ctx, actor, "scans.upload", args, async () => {
    bounded(args.revision, 128, "scan revision"); if (![args.sourceHead, args.tree].every(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))) fail("INVALID_INPUT", "Scan must bind exact Git head/tree"); integer(args.expectedChunks, 1, 1000); integer(args.expectedPaths, 0, 500_000); integer(args.chunk, 0, args.expectedChunks - 1); if (args.paths.length) paths(args.paths); else if (args.expectedPaths !== 0 || args.expectedChunks !== 1) fail("INVALID_INPUT", "Only an explicitly empty one-chunk scan may omit paths");
    if (new TextEncoder().encode(canonical(args.paths)).length > 100 * 1024 || await digest(canonical(args.paths)) !== args.digest) fail("INVALID_INPUT", "Scan chunk digest/size mismatch");
    if (args.paths.some(p => !task.scope.some(scope => p === scope || p.startsWith(`${scope}/`)))) fail("FORBIDDEN", "Scan paths exceed the task's reserved scope");
    if (args.paths.some(p => !project.allowedPaths.some(a => p === a || p.startsWith(`${a}/`)) || project.excludedPaths.some(a => p === a || p.startsWith(`${a}/`)))) fail("FORBIDDEN", "Scan paths exceed approved project routing");
    const existing = await ctx.db.query("scans").withIndex("by_scan", q => q.eq("taskId", task.id).eq("revision", args.revision)).take(1001);
    if (existing.length > 1000 || existing.some(c => c.epoch !== task.epoch || c.sourceHead !== args.sourceHead || c.tree !== args.tree || c.expectedChunks !== args.expectedChunks || c.expectedPaths !== args.expectedPaths)) fail("IDEMPOTENCY_CONFLICT", "Scan revision metadata changed");
    const old = existing.find(c => c.chunk === args.chunk);
    if (old && old.digest !== args.digest) fail("IDEMPOTENCY_CONFLICT", "Scan chunk identity changed");
    if (!old) await ctx.db.insert("scans", { projectId: project.id, taskId: task.id, epoch: task.epoch, revision: args.revision, sourceHead: args.sourceHead, tree: args.tree, chunk: args.chunk, paths: args.paths, digest: args.digest, expectedChunks: args.expectedChunks, expectedPaths: args.expectedPaths, complete: false });
    const all = old ? existing : [...existing, { paths: args.paths, chunk: args.chunk }];
    let complete = all.length === args.expectedChunks;
    if (complete) {
      const seen = new Set<string>(); for (const chunk of all) for (const p of chunk.paths) { if (seen.has(p)) fail("INVALID_INPUT", "Scan paths overlap across chunks"); seen.add(p); }
      if (seen.size !== args.expectedPaths) fail("COVERAGE_INCOMPLETE", "Scan path count does not match completion metadata");
      for (const c of existing) await ctx.db.patch(c._id, { complete: true });
      if (!old) { const inserted = await ctx.db.query("scans").withIndex("by_scan", q => q.eq("taskId", task.id).eq("revision", args.revision).eq("chunk", args.chunk)).unique(); if (inserted) await ctx.db.patch(inserted._id, { complete: true }); }
      await ctx.db.patch(task._id, { scanRevision: args.revision, scanSourceHead: args.sourceHead, scanTree: args.tree, coverageComplete: false });
    } else { complete = false; await ctx.db.patch(task._id, { coverageComplete: false }); }
    return { revision: args.revision, complete, receivedChunks: all.length, expectedChunks: args.expectedChunks };
  });
} });

// This is an attestation from the independently qualified local Git verifier, not a worker upload.
export const verify = mutation({ args: { ...runArgs, revision: v.string(), sourceHead: v.string(), tree: v.string(), pathsDigest: v.string(), expectedPaths: v.number(), evidenceRef: v.string() }, handler: async (ctx, args) => {
  const { actor } = await authenticate(ctx, args, ["artifact_verifier", "human"]); const { task, run } = await verifiedRun(ctx, args, actor);
  return replay(ctx, actor, "scans.verify", args, async () => {
    bounded(args.evidenceRef, 2048, "trusted Git scan evidence"); integer(args.expectedPaths, 0, 500_000);
    if (args.revision !== task.scanRevision || args.sourceHead !== task.scanSourceHead || args.tree !== task.scanTree) fail("COVERAGE_INCOMPLETE", "Trusted scan does not match the completed upload revision/head/tree");
    const chunks = await ctx.db.query("scans").withIndex("by_scan", q => q.eq("taskId", task.id).eq("revision", args.revision)).take(1001);
    const first = chunks[0];
    if (!first || chunks.length > 1000 || chunks.length !== first.expectedChunks || chunks.some(c => !c.complete || c.epoch !== run.epoch || c.sourceHead !== args.sourceHead || c.tree !== args.tree || c.expectedPaths !== args.expectedPaths || c.expectedChunks !== first.expectedChunks) || new Set(chunks.map(c => c.chunk)).size !== first.expectedChunks) fail("COVERAGE_INCOMPLETE", "Every declared scan chunk must be complete for the current run");
    const actual = chunks.flatMap(c => c.paths).sort();
    if (actual.length !== args.expectedPaths || new Set(actual).size !== actual.length || actual.some(p => !task.scope.some(scope => p === scope || p.startsWith(`${scope}/`))) || await digest(canonical(actual)) !== args.pathsDigest) fail("COVERAGE_INCOMPLETE", "Trusted actual Git path count/digest differs from the complete in-scope upload");
    const verifiedScan = { revision: args.revision, sourceHead: args.sourceHead, tree: args.tree, pathsDigest: args.pathsDigest, expectedPaths: args.expectedPaths, epoch: run.epoch, evidenceRef: args.evidenceRef };
    await ctx.db.patch(task._id, { coverageComplete: true, verifiedScan });
    return { revision: args.revision, coverageComplete: true, sourceHead: args.sourceHead, tree: args.tree, pathsDigest: args.pathsDigest };
  });
} });
