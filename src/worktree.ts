import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { captureDigest, git, gitText, snapshotCaptureOptions, verifyRemoteCheckpoint, verifySelectedRemote, type CaptureOptions, type PreparedCheckpoint } from "./checkpoint.js";
import { requireEnvironment, type EnvironmentReport } from "./environment.js";
import { CoordError, type ExecutionBase, type RunIdentity } from "./protocol.js";

export interface ResumeWorktreeOptions {
  capture: CaptureOptions; checkpoint: PreparedCheckpoint; identity: RunIdentity; projectId: string;
  worktreeRoot: string; trustedCommonGitDir: string;
  /** Authenticated backend lookup: exact immutable checkpoint must currently be ready and approved for this task. */
  assertReady(): Promise<void>;
  /** Effective destination environment; callers also run this before capacity reservation. */
  preflight(): Promise<EnvironmentReport>;
  /** Must validate the live admitted destination run grant and trusted repository association. */
  assertAdmission(): Promise<void>;
}
export interface ResumedWorktree { path: string; commonGitDir: string; head: string; tree: string; executionBase: ExecutionBase; sourceHead: string; identity: RunIdentity }
async function commonGitDir(repo: string, transport?: CaptureOptions["gitTransport"], metadataIsolation?: CaptureOptions["gitMetadataIsolation"]): Promise<string> { return realpath(resolve(repo, await gitText(repo, ["rev-parse", "--git-common-dir"], { transport, metadataIsolation }))); }
/** Allocates a fresh admitted branch/receipt. Never resets old directories, starts setup, or launches a harness. */
export async function createResumeWorktree(options: ResumeWorktreeOptions): Promise<ResumedWorktree> {
  options = { ...options, capture: snapshotCaptureOptions(options.capture), checkpoint: structuredClone(options.checkpoint), identity: structuredClone(options.identity) };
  const { identity, checkpoint, capture } = options;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(options.projectId) || !/^[A-Za-z0-9_-]{1,100}$/.test(identity.taskId) || !/^[A-Za-z0-9_-]{1,100}$/.test(identity.runId) || identity.taskId !== checkpoint.identity.taskId || !Number.isSafeInteger(identity.epoch) || identity.epoch < 1 || identity.goalRevision !== checkpoint.identity.goalRevision || !isAbsolute(options.worktreeRoot)) throw new CoordError("INVALID_INPUT", "Invalid destination project/run identity or worktree root");
  requireEnvironment(await options.preflight());
  await options.assertReady();
  const common = await commonGitDir(capture.repo, capture.gitTransport, capture.gitMetadataIsolation);
  if (common !== await realpath(options.trustedCommonGitDir)) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Source common Git directory differs from trusted association");
  await verifyRemoteCheckpoint(capture, checkpoint);
  await options.assertAdmission();
  requireEnvironment(await options.preflight());
  await mkdir(options.worktreeRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(options.worktreeRoot);
  if (root !== resolve(options.worktreeRoot)) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Worktree root must be canonical without symlink routing");
  const path = join(root, `${identity.taskId}-e${identity.epoch}-${identity.runId}`);
  try { await lstat(path); throw new CoordError("BLOCKED_CHECKPOINT", "Destination worktree already exists and will not be reset"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await options.assertAdmission();
  const branch = `coord/tasks/${identity.taskId}/e${identity.epoch}/${identity.runId}`;
  await git(capture.repo, ["worktree", "add", "--quiet", "-b", branch, "--", path, checkpoint.commit], { transport: capture.gitTransport, metadataIsolation: capture.gitMetadataIsolation });
  // Failures after allocation deliberately retain the new checkout as an inspectable orphan.
  if (await commonGitDir(path, capture.gitTransport, capture.gitMetadataIsolation) !== common) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Derived worktree does not share the trusted Git directory");
  await verifySelectedRemote({ repo: path, remote: capture.remote, gitTransport: capture.gitTransport, gitMetadataIsolation: capture.gitMetadataIsolation });
  const head = await gitText(path, ["rev-parse", "HEAD"], { transport: capture.gitTransport, metadataIsolation: capture.gitMetadataIsolation }), tree = await gitText(path, ["rev-parse", "HEAD^{tree}"], { transport: capture.gitTransport, metadataIsolation: capture.gitMetadataIsolation });
  if (head !== checkpoint.commit || tree !== checkpoint.tree || captureDigest(await gitText(path, ["status", "--porcelain=v1"], { transport: capture.gitTransport, metadataIsolation: capture.gitMetadataIsolation })) !== captureDigest("")) throw new CoordError("BLOCKED_CHECKPOINT", "Fresh worktree does not match the exact portable checkpoint");
  if (await gitText(path, ["branch", "--show-current"], { transport: capture.gitTransport, metadataIsolation: capture.gitMetadataIsolation }) !== branch) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Derived branch differs from admitted run identity");
  await options.assertAdmission();
  const local = join(path, ".coord-local"); await mkdir(local, { mode: 0o700 });
  const receipt = await open(join(local, "run.json"), "wx", 0o600);
  try { await receipt.writeFile(`${JSON.stringify({ projectId: options.projectId, commonGitDir: common, runId: identity.runId, taskId: identity.taskId, epoch: identity.epoch })}\n`); await receipt.sync(); } finally { await receipt.close(); }
  await options.assertReady(); await options.assertAdmission(); requireEnvironment(await options.preflight());
  return { path, commonGitDir: common, head, tree, executionBase: structuredClone(checkpoint.executionBase), sourceHead: checkpoint.sourceHead, identity: structuredClone(identity) };
}
