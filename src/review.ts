import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { captureCheckpoint, captureDigest, git, gitText, pushImmutableSnapshot, snapshotCaptureOptions, validatePreparedCheckpoint, verifyRemoteCheckpoint, type CaptureOptions, type PreparedCheckpoint, type RemoteCheckpointReadback } from "./checkpoint.js";
import { CoordError, type VerificationEvidence } from "./protocol.js";

export { captureCheckpoint as prepareReviewArtifact };
export interface ReviewRecord { id: string; url: string; state: "open" | "closed" | "merged"; repositoryId: string; publicationId: string; headRef: string; headSha: string; baseRef: string; baseSha: string }
export interface ReviewLookup { repositoryId: string; publicationId: string; headRef: string; baseRef: string }
/** Selected host adapter is deliberately limited to create/find/read; no merge/deploy route. */
export interface ReviewHostAdapter {
  find(input: ReviewLookup): Promise<ReviewRecord[]>;
  create(input: ReviewLookup & { headSha: string; baseSha: string; title: string; body: string }): Promise<ReviewRecord>;
  read(id: string): Promise<ReviewRecord>;
}
export interface PublishReviewOptions {
  capture: CaptureOptions; artifact: PreparedCheckpoint; publicationId: string; repositoryId: string; targetRef: string;
  verification: VerificationEvidence[]; requiredCommands: string[][]; environmentDigest: string; host: ReviewHostAdapter;
  /** Must revalidate authoritative scope, coverage, conflicts, goal, run grant and qualified native permissions. */
  preflight(phase: string): Promise<void>;
  fault?(point: string): Promise<void>;
}
export interface PublishedReview { publicationId: string; artifact: PreparedCheckpoint; headRef: string; targetRef: string; targetSha: string; branchReadback: RemoteCheckpointReadback; verification: VerificationEvidence[]; review: ReviewRecord; status: "verified_external" }
interface Journal { schemaVersion: 1; fingerprint: string; state: "prepared" | "create_pending" | "created"; reviewId?: string }

async function liveTarget(options: PublishReviewOptions): Promise<string> {
  const ref = `refs/coord/internal/${randomUUID()}`;
  try {
    await git(options.capture.repo, ["fetch", "--no-tags", "--no-write-fetch-head", options.capture.remote.name, `${options.targetRef}:${ref}`]);
    return await gitText(options.capture.repo, ["rev-parse", `${ref}^{commit}`]);
  } finally { await git(options.capture.repo, ["update-ref", "-d", ref]); }
}
function verifyEvidence(options: PublishReviewOptions, base: string): void {
  if (!options.requiredCommands.length || options.requiredCommands.some(command => !command.length || command.some(arg => typeof arg !== "string" || arg.includes("\0")))) throw new CoordError("INVALID_INPUT", "Review requires explicit verification commands from approved project policy");
  if (!/^[a-f0-9]{64}$/.test(options.environmentDigest)) throw new CoordError("INVALID_INPUT", "Review requires a verified nonsecret environment digest");
  const exact = options.verification.filter(item => item.head === options.artifact.commit && item.tree === options.artifact.tree && item.base === base && item.environmentDigest === options.environmentDigest && Number.isFinite(Date.parse(item.recordedAt)) && Date.parse(item.recordedAt) <= Date.now() + 60_000 && item.commands.length && item.commands.every(command => command.exitCode === 0));
  if (exact.length !== options.verification.length || !exact.length || options.requiredCommands.some(required => !exact.some(item => item.commands.some(command => captureDigest(command.argv) === captureDigest(required))))) throw new CoordError("PUBLICATION_STALE", "Verification must pass on the exact final review commit/tree, current relevant target base and effective environment");
}
function matches(record: ReviewRecord, lookup: ReviewLookup, head: string, base: string): boolean {
  let url: URL;
  try { url = new URL(record.url); } catch { return false; }
  return /^[-A-Za-z0-9_]{1,100}$/.test(record.id) && ["open", "closed", "merged"].includes(record.state) && url.protocol === "https:" && !url.username && !url.password && record.repositoryId === lookup.repositoryId && record.publicationId === lookup.publicationId && record.headRef === lookup.headRef && record.baseRef === lookup.baseRef && record.headSha === head && record.baseSha === base;
}
async function saveJournal(path: string, journal: Journal): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(journal)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(resolve(path, ".."), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
async function hostFind(options: PublishReviewOptions, lookup: ReviewLookup): Promise<ReviewRecord[]> {
  try { return await options.host.find(lookup); } catch { throw new CoordError("PUBLICATION_STALE", "Selected host reconciliation unavailable; no blind PR create"); }
}
/** Publishes only an audited safe snapshot and reconciles durable PR identity. Never marks backend ready or releases a run. */
export async function publishReview(options: PublishReviewOptions): Promise<PublishedReview> {
  options = { ...options, capture: snapshotCaptureOptions(options.capture), artifact: structuredClone(options.artifact), verification: structuredClone(options.verification), requiredCommands: structuredClone(options.requiredCommands) };
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(options.publicationId) || !/^[A-Za-z0-9_./:-]{1,512}$/.test(options.repositoryId) || !options.targetRef.startsWith("refs/heads/")) throw new CoordError("INVALID_INPUT", "Invalid selected review repository, target or publication identity");
  await git(options.capture.repo, ["check-ref-format", options.targetRef]);
  await options.preflight("review.start");
  await validatePreparedCheckpoint(options.capture, options.artifact);
  const base = await liveTarget(options);
  verifyEvidence(options, base);
  const headRef = `coord/reviews/${options.artifact.identity.taskId}/e${options.artifact.identity.epoch}/${options.publicationId}`;
  const lookup: ReviewLookup = { repositoryId: options.repositoryId, publicationId: options.publicationId, headRef, baseRef: options.targetRef.slice("refs/heads/".length) };
  const fingerprint = captureDigest({ lookup, head: options.artifact.commit, tree: options.artifact.tree, base, manifestDigest: options.artifact.manifestDigest, environmentDigest: options.environmentDigest, requiredCommands: options.requiredCommands });
  const common = await realpath(resolve(options.capture.repo, await gitText(options.capture.repo, ["rev-parse", "--git-common-dir"])));
  const directory = join(common, "coord-publications"); await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Publication journal cannot traverse a symlink");
  const parentDirectory = await open(common, "r");
  try { await parentDirectory.sync(); } finally { await parentDirectory.close(); }
  const path = join(directory, `${captureDigest({ repositoryId: options.repositoryId, publicationId: options.publicationId })}.json`);
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new CoordError("PUBLICATION_STALE", "Another publication owns this identity; stale locks require explicit recovery"); });
  try {
    let journal: Journal = { schemaVersion: 1, fingerprint, state: "prepared" };
    try {
      const contents = await readFile(path, "utf8");
      if (contents.length > 16_384) throw new CoordError("PUBLICATION_STALE", "Publication journal is invalid");
      const prior = JSON.parse(contents) as Journal;
      if (prior.schemaVersion !== 1 || prior.fingerprint !== fingerprint || !["prepared", "create_pending", "created"].includes(prior.state)) throw new CoordError("IDEMPOTENCY_CONFLICT", "Publication identity is already bound to a different exact artifact or policy");
      journal = prior;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await saveJournal(path, journal); }
    await options.preflight("review.before-push");
    await pushImmutableSnapshot(options.capture, options.artifact, `refs/heads/${headRef}`);
    if (await liveTarget(options) !== base) throw new CoordError("PUBLICATION_STALE", "Live target moved; integration and base-sensitive verification must be refreshed");
    const candidates = await hostFind(options, lookup);
    if (candidates.length > 1 || candidates.some(item => !matches(item, lookup, options.artifact.commit, base))) throw new CoordError("PUBLICATION_STALE", "Host records do not reconcile to one exact publication identity");
    let review = candidates[0];
    if (!review) {
      if (journal.state !== "prepared") throw new CoordError("PUBLICATION_STALE", "PR creation is uncertain; pending journal blocks blind retry until host reconciliation");
      await options.preflight("review.before-create");
      await validatePreparedCheckpoint(options.capture, options.artifact);
      if (await liveTarget(options) !== base) throw new CoordError("PUBLICATION_STALE", "Target base changed before PR creation");
      journal = { ...journal, state: "create_pending" }; await saveJournal(path, journal);
      await options.fault?.("review.before-create");
      try {
        review = await options.host.create({ ...lookup, headSha: options.artifact.commit, baseSha: base, title: `Continue task ${options.artifact.identity.taskId}`, body: `Coord publication: ${options.publicationId}\n\nVerified snapshot: ${options.artifact.commit}\nTree: ${options.artifact.tree}\nExecution base: ${options.artifact.executionBase.sha}\nVerification target: ${base}\nManifest: ${options.artifact.manifestDigest}\n` });
      } catch {
        const recovered = await hostFind(options, lookup);
        if (recovered.length !== 1 || !matches(recovered[0]!, lookup, options.artifact.commit, base)) throw new CoordError("PUBLICATION_STALE", "PR create response uncertain; durable pending journal prevents duplicate blind create");
        review = recovered[0]!;
      }
    }
    if (!matches(review, lookup, options.artifact.commit, base)) throw new CoordError("PUBLICATION_STALE", "Host PR does not match exact publication identity");
    journal = { ...journal, state: "created", reviewId: review.id }; await saveJournal(path, journal);
    await options.fault?.("review.after-create");
    let readback: ReviewRecord;
    try { readback = await options.host.read(review.id); } catch { throw new CoordError("PUBLICATION_STALE", "Host PR read-back unavailable; publication remains unaccepted"); }
    if (!matches(readback, lookup, options.artifact.commit, base) || readback.state !== "open" || await liveTarget(options) !== base) throw new CoordError("PUBLICATION_STALE", "PR is closed, stale or does not match verified head/base");
    await validatePreparedCheckpoint(options.capture, options.artifact);
    verifyEvidence(options, base);
    await options.preflight("review.verified");
    const branchReadback = await verifyRemoteCheckpoint(options.capture, options.artifact, `refs/heads/${headRef}`);
    return { publicationId: options.publicationId, artifact: options.artifact, headRef, targetRef: options.targetRef, targetSha: base, branchReadback, verification: options.verification, review: readback, status: "verified_external" };
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
