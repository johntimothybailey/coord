import { v } from "convex/values";
import { base } from "./schema.js";
import type { Doc, QueryCtx } from "./server.js";
import type { RunIdentity } from "./auth.js";
import { fail, path, bounded, canonical, digest, liveRun } from "./auth.js";
import { noConflicts, taskById } from "./tasks.js";
export const verification = v.object({ head: v.string(), tree: v.string(), base: v.string(), commands: v.array(v.object({ argv: v.array(v.string()), exitCode: v.number() })), environmentDigest: v.string(), recordedAt: v.string() });
export const manifestValidator = v.object({ schemaVersion: v.literal(1), checkpointId: v.string(), identity: v.object({ taskId: v.string(), runId: v.string(), epoch: v.number(), goalRevision: v.number() }), sourceHead: v.string(), executionBase: base, remoteParent: v.string(), tree: v.string(), commit: v.string(), ref: v.string(), files: v.array(v.object({ path: v.string(), mode: v.string(), type: v.union(v.literal("blob"), v.literal("symlink")), oid: v.string() })), exclusions: v.array(v.object({ path: v.string(), reason: v.string() })), progressHash: v.string(), evidence: v.array(verification), createdAt: v.string(), progressRevision: v.number(), policyDigest: v.string(), manifestDigest: v.string(), reusedCommit: v.boolean() });
export type Manifest = typeof manifestValidator.type;
export function oid(value: string): void { if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail("INVALID_INPUT", "Invalid Git object identity"); }
export async function progressHash(progress: string): Promise<string> { let value: unknown = progress; try { value = JSON.parse(progress); } catch { /* prose progress is canonicalized as a JSON string */ } return digest(canonical(value)); }
export async function validateManifest(manifest: Manifest, task: Doc<"tasks">, run: Doc<"runs">): Promise<void> {
  for (const value of [manifest.sourceHead, manifest.tree, manifest.commit, manifest.remoteParent]) oid(value);
  if (manifest.identity.taskId !== task.id || manifest.identity.runId !== run.id || manifest.identity.epoch !== run.epoch || manifest.identity.goalRevision !== task.goalRevision || canonical(manifest.executionBase) !== canonical(task.executionBase) || manifest.remoteParent !== task.executionBase.sha || manifest.progressRevision !== task.progressRevision || manifest.progressHash !== await progressHash(task.progress)) fail("CHECKPOINT_INCOMPLETE", "Manifest is not bound to the current execution base, progress and run identity");
  if (manifest.ref !== `refs/coord/checkpoints/${task.id}/e${run.epoch}/${manifest.checkpointId}` || !Number.isFinite(Date.parse(manifest.createdAt)) || manifest.files.length > 20_000 || manifest.exclusions.length > 1000 || manifest.evidence.length > 20) fail("INVALID_INPUT", "Invalid manifest bounds or checkpoint ref");
  const seen = new Set<string>();
  for (const file of manifest.files) { path(file.path); oid(file.oid); if (seen.has(file.path) || !["100644", "100755", "120000"].includes(file.mode) || (file.type === "symlink") !== (file.mode === "120000")) fail("INVALID_INPUT", "Invalid manifest file type, mode or duplicate path"); seen.add(file.path); }
  for (const exclusion of manifest.exclusions) { path(exclusion.path); bounded(exclusion.reason, 1024, "exclusion reason"); }
  const core = { identity: manifest.identity, sourceHead: manifest.sourceHead, executionBase: manifest.executionBase, tree: manifest.tree, files: manifest.files, exclusions: manifest.exclusions, progressHash: manifest.progressHash, policyDigest: manifest.policyDigest, progressRevision: manifest.progressRevision };
  if (manifest.manifestDigest !== await digest(canonical(core)) || !/^[a-f0-9]{64}$/.test(manifest.policyDigest)) fail("CHECKPOINT_INCOMPLETE", "Manifest digest or approved capture policy digest mismatch");
  if (new TextEncoder().encode(canonical(manifest)).length > 512 * 1024) fail("CHECKPOINT_INCOMPLETE", "Manifest requires a supported larger artifact transport");
}
export async function verifiedRun(ctx: Pick<QueryCtx, "db">, args: RunIdentity, actor: Doc<"credentials">) {
  const run = await ctx.db.query("runs").withIndex("by_stable_id", q => q.eq("id", args.runId)).unique();
  if (!run || run.projectId !== args.projectId || (actor.role !== "artifact_verifier" && actor.role !== "human") || (actor.role === "artifact_verifier" && (actor.machineId !== run.machineId || actor.memberId !== run.memberId))) fail("FORBIDDEN", "Independent project/machine verifier authority required");
  if (run.mode === "replan") fail("FORBIDDEN", "Replanning runs cannot verify or accept implementation code artifacts");
  const grant = await ctx.db.query("credentials").withIndex("by_stable_id", q => q.eq("id", run.grantId)).unique();
  if (!grant || grant.revokedAt !== undefined || grant.expiresAt <= Date.now()) fail("LEASE_REVOKED", "Artifact run grant is revoked");
  const live = await liveRun(ctx, args, grant, ["running"], ["running", "yielding", "review_ready"]);
  await noConflicts(ctx, live.task);
  return live;
}
export async function publicationTask(ctx: Pick<QueryCtx, "db">, taskId: string, projectId: string) {
  const task = await taskById(ctx, taskId, projectId);
  if (!task.coverageComplete || !task.scanRevision) fail("COVERAGE_INCOMPLETE", "Required scan coverage is incomplete");
  await noConflicts(ctx, task); return task;
}
export async function currentPublicationArtifact(ctx: Pick<QueryCtx, "db">, publication: Doc<"publications">, task: Doc<"tasks">, run: Doc<"runs">, project: Doc<"projects">) {
  const details = JSON.parse(publication.evidenceJson) as { checkpointId: string; verification: typeof verification.type };
  const checkpoint = await ctx.db.query("checkpoints").withIndex("by_stable_id", q => q.eq("id", details.checkpointId)).unique();
  if (!checkpoint || checkpoint.projectId !== project.id || checkpoint.taskId !== task.id || checkpoint.runId !== run.id || checkpoint.epoch !== run.epoch || checkpoint.state !== "ready" || checkpoint.commit !== publication.head || checkpoint.tree !== publication.tree || checkpoint.executionBase.sha !== publication.executionBase) fail("PUBLICATION_STALE", "Publication no longer matches its immutable ready artifact");
  const manifest = JSON.parse(checkpoint.manifestJson) as Manifest; await validateManifest(manifest, task, run);
  requireVerifiedScan(task, manifest);
  if (!project.capturePolicyDigest || manifest.policyDigest !== project.capturePolicyDigest || details.verification.head !== checkpoint.commit || details.verification.tree !== checkpoint.tree || details.verification.base !== publication.targetBase || !details.verification.commands.length || details.verification.commands.some(c => c.exitCode !== 0)) fail("PUBLICATION_STALE", "Capture policy or exact-revision verification no longer permits publication");
  return { checkpoint, manifest };
}

export function requireVerifiedScan(task: Doc<"tasks">, manifest: Pick<Manifest, "sourceHead" | "tree" | "identity">): void {
  const verified = task.verifiedScan;
  if (!task.coverageComplete || !verified || verified.revision !== task.scanRevision || verified.sourceHead !== task.scanSourceHead || verified.tree !== task.scanTree || verified.sourceHead !== manifest.sourceHead || verified.tree !== manifest.tree || verified.epoch !== manifest.identity.epoch || verified.epoch !== task.epoch) fail("COVERAGE_INCOMPLETE", "A trusted complete scan of this exact run/source head/tree is required");
}
