import { v } from "convex/values";
import { mutation } from "./server.js";
import { runArgs, authenticate, liveRun, replay, stableId, bounded, fail, canonical } from "./auth.js";
import { oid, verification, verifiedRun, publicationTask, currentPublicationArtifact, validateManifest, requireVerifiedScan } from "./artifacts.js";
export const request = mutation({ args: { ...runArgs, publicationId: v.string(), checkpointId: v.string(), targetBase: v.string(), verification }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["run"]); const { run } = await liveRun(ctx, args, actor); const task = await publicationTask(ctx, args.taskId, args.projectId);
  return replay(ctx, actor, "publications.request", args, async () => {
    if (run.mode === "replan") fail("FORBIDDEN", "Replanning runs cannot publish implementation code");
    stableId(args.publicationId); oid(args.targetBase);
    const checkpoint = await ctx.db.query("checkpoints").withIndex("by_stable_id", q => q.eq("id", args.checkpointId)).unique();
    if (!checkpoint || checkpoint.projectId !== args.projectId || checkpoint.taskId !== task.id || checkpoint.runId !== run.id || checkpoint.epoch !== run.epoch || checkpoint.state !== "ready" || checkpoint.progressRevision !== task.progressRevision) fail("PUBLICATION_STALE", "Publication requires the current ready audited snapshot");
    const manifest = JSON.parse(checkpoint.manifestJson); await validateManifest(manifest, task, run);
    requireVerifiedScan(task, manifest);
    if (!project.capturePolicyDigest || manifest.policyDigest !== project.capturePolicyDigest) fail("PUBLICATION_STALE", "Ready capture policy is no longer approved");
    if (args.verification.head !== checkpoint.commit || args.verification.tree !== checkpoint.tree || args.verification.base !== args.targetBase || !args.verification.commands.length || args.verification.commands.length > 50 || args.verification.commands.some(c => c.exitCode !== 0 || c.argv.length === 0 || c.argv.length > 100 || c.argv.some(a => a.length > 2048)) || !args.verification.environmentDigest || !Number.isFinite(Date.parse(args.verification.recordedAt)) || Date.parse(args.verification.recordedAt) > Date.now()) fail("PUBLICATION_STALE", "Verification must pass on the actual final review head/tree and relevant live base");
    if (await ctx.db.query("publications").withIndex("by_stable_id", q => q.eq("id", args.publicationId)).unique()) fail("IDEMPOTENCY_CONFLICT", "Publication ID already exists");
    const branch = `coord/reviews/${task.id}/e${run.epoch}/${args.publicationId}`;
    await ctx.db.insert("publications", { id: args.publicationId, projectId: args.projectId, taskId: task.id, runId: run.id, epoch: run.epoch, state: "requested", head: checkpoint.commit, tree: checkpoint.tree, executionBase: checkpoint.executionBase.sha, targetBase: args.targetBase, branch, evidenceJson: canonical({ checkpointId: checkpoint.id, manifestHash: checkpoint.manifestHash, verification: args.verification }), safeHistoryStrategy: "audited_snapshot" });
    return { publicationId: args.publicationId, branch, head: checkpoint.commit, state: "requested" as const };
  });
} });
export const verifyBranch = mutation({ args: { ...runArgs, publicationId: v.string(), head: v.string(), tree: v.string(), parent: v.union(v.string(), v.null()), parents: v.optional(v.array(v.string())), branch: v.string(), liveTargetBase: v.string(), evidenceRef: v.string() }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["artifact_verifier", "human"]); const { task, run } = await verifiedRun(ctx, args, actor); await publicationTask(ctx, args.taskId, args.projectId);
  return replay(ctx, actor, "publications.verifyBranch", args, async () => {
    const publication = await ctx.db.query("publications").withIndex("by_stable_id", q => q.eq("id", args.publicationId)).unique(); bounded(args.evidenceRef, 2048, "branch readback evidence");
    if (!publication || publication.projectId !== args.projectId || publication.runId !== args.runId || publication.epoch !== args.epoch || publication.state !== "requested" || publication.head !== args.head || publication.tree !== args.tree || publication.branch !== args.branch || publication.targetBase !== args.liveTargetBase) fail("PUBLICATION_STALE", "Review branch/base readback does not match the exact audited artifact");
    const artifact = await currentPublicationArtifact(ctx, publication, task, run, project);
    const parents = args.parents ?? (args.parent === null ? [] : [args.parent]);
    if (canonical(parents) !== canonical(artifact.checkpoint.actualParents ?? (artifact.checkpoint.parent === null ? [] : [artifact.checkpoint.parent]))) fail("PUBLICATION_STALE", "Review branch actual parentage differs from the audited snapshot");
    await ctx.db.patch(publication._id, { state: "branch_verified", evidenceJson: canonical({ ...JSON.parse(publication.evidenceJson), branchReadback: { head: args.head, tree: args.tree, parent: args.parent, branch: args.branch, liveTargetBase: args.liveTargetBase, evidenceRef: args.evidenceRef } }) }); return { publicationId: publication.id, state: "branch_verified" as const };
  });
} });
export const verifyPR = mutation({ args: { ...runArgs, publicationId: v.string(), head: v.string(), tree: v.string(), liveTargetBase: v.string(), repository: v.string(), headBranch: v.string(), targetBaseRef: v.string(), prId: v.string(), prUrl: v.string(), open: v.boolean(), evidenceRef: v.string() }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["artifact_verifier", "human"]); const { task, run } = await verifiedRun(ctx, args, actor); await publicationTask(ctx, args.taskId, args.projectId);
  return replay(ctx, actor, "publications.verifyPR", args, async () => {
    const publication = await ctx.db.query("publications").withIndex("by_stable_id", q => q.eq("id", args.publicationId)).unique(); bounded(args.evidenceRef, 2048, "PR readback evidence"); bounded(args.prId, 128, "PR identity"); bounded(args.prUrl, 2048, "PR URL");
    if (!publication || publication.projectId !== args.projectId || publication.runId !== args.runId || publication.epoch !== args.epoch || publication.state !== "branch_verified" || publication.head !== args.head || publication.tree !== args.tree || publication.targetBase !== args.liveTargetBase || args.repository !== project.repository || args.headBranch !== publication.branch || args.targetBaseRef !== project.defaultBranch || !args.open || !args.prUrl.startsWith("https://")) fail("PUBLICATION_STALE", "Open PR must bind exact verified head/tree and current target base");
    await currentPublicationArtifact(ctx, publication, task, run, project);
    await ctx.db.patch(publication._id, { state: "pr_verified", evidenceJson: canonical({ ...JSON.parse(publication.evidenceJson), prReadback: { head: args.head, tree: args.tree, liveTargetBase: args.liveTargetBase, repository: args.repository, headBranch: args.headBranch, targetBaseRef: args.targetBaseRef, evidenceRef: args.evidenceRef } }), prId: args.prId, prUrl: args.prUrl }); return { publicationId: publication.id, state: "pr_verified" as const };
  });
} });
export const accept = mutation({ args: { ...runArgs, publicationId: v.string(), liveTargetBase: v.string() }, handler: async (ctx, args) => {
  const { actor, project } = await authenticate(ctx, args, ["artifact_verifier", "human"]); const { task, run } = await verifiedRun(ctx, args, actor); await publicationTask(ctx, args.taskId, args.projectId);
  return replay(ctx, actor, "publications.accept", args, async () => {
    const publication = await ctx.db.query("publications").withIndex("by_stable_id", q => q.eq("id", args.publicationId)).unique();
    if (!publication || publication.projectId !== args.projectId || publication.runId !== run.id || publication.epoch !== run.epoch || publication.state !== "pr_verified" || publication.targetBase !== args.liveTargetBase) fail("PUBLICATION_STALE", "Publication is stale or lacks exact verified PR evidence");
    await currentPublicationArtifact(ctx, publication, task, run, project);
    const prEvidence = JSON.parse(publication.evidenceJson).prReadback as { repository: string; headBranch: string; targetBaseRef: string } | undefined;
    if (!prEvidence || prEvidence.repository !== project.repository || prEvidence.headBranch !== publication.branch || prEvidence.targetBaseRef !== project.defaultBranch) fail("PUBLICATION_STALE", "PR routing evidence no longer matches project routing");
    await ctx.db.patch(publication._id, { state: "accepted" }); await ctx.db.patch(task._id, { state: "review_ready", publicationId: publication.id }); await ctx.db.patch(run._id, { resultAccepted: true });
    return { publicationId: publication.id, taskId: task.id, state: "review_ready" as const, capacityHeld: run.capacityHeld };
  });
} });
