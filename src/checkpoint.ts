import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CoordError, DEFAULTS, type CheckpointManifest, type ExecutionBase, type FileEntry, type RunIdentity } from "./protocol.js";
import { canonicalJson } from "./canonical.js";
import { runGit, type GitOptions, type GitResult, type GitTransport, type GitMetadataIsolation } from "./git-transport.js";
export type { GitOptions, GitResult } from "./git-transport.js";

export interface CapturePolicy {
  allowedUntracked: string[];
  exclusions: { path: string; reason: string }[];
  requiredPaths: string[];
  forbiddenContent?: string[];
  maxFileBytes?: number;
}
export interface CaptureAuthority {
  identity: RunIdentity; executionBase: ExecutionBase; progressRevision: number; progressHash: string; policyDigest: string;
}
export interface CaptureOptions {
  repo: string; remote: { name: string; url: string }; checkpointId: string; identity: RunIdentity;
  executionBase: ExecutionBase; progress: unknown; progressRevision: number; createdAt: string;
  commitMessage: string; policy: CapturePolicy;
  gitTransport?: GitTransport;
  gitMetadataIsolation?: GitMetadataIsolation;
  /** Must read current authoritative backend state, not cached model claims. Backend ready acceptance rechecks independently. */
  readAuthority(phase: string): Promise<CaptureAuthority>;
  quietBoundary(): Promise<void>;
  fault?(point: string): Promise<void>;
}
export interface PreparedCheckpoint extends CheckpointManifest {
  createdAt: string; progressRevision: number; policyDigest: string; manifestDigest: string; reusedCommit: boolean;
}
export interface RemoteCheckpointReadback { commit: string; tree: string; parent: string | null; parents: string[]; ref: string; manifestHash: string; progressHash: string; policyDigest: string; verifiedAt: string }
interface Snapshot { files: FileEntry[]; exclusions: { path: string; reason: string }[]; stamp: string }

/** Fixed argv, no shell, no command output in errors, bounded time/output and descendant cleanup. */
export async function git(repo: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  return runGit(repo, args, options);
}
export async function gitText(repo: string, args: string[], options: GitOptions = {}): Promise<string> { return (await git(repo, args, options)).stdout.toString("utf8").trim(); }
type GitContext = Pick<CaptureOptions, "repo" | "gitTransport" | "gitMetadataIsolation">;
const captureGit = (options: GitContext, args: string[], extra: GitOptions = {}): Promise<GitResult> => git(options.repo, args, { ...extra, transport: options.gitTransport, metadataIsolation: options.gitMetadataIsolation });
const captureGitText = async (options: GitContext, args: string[], extra: GitOptions = {}): Promise<string> => (await captureGit(options, args, extra)).stdout.toString("utf8").trim();
function canonical(value: unknown): string {
  try { return canonicalJson(value); } catch { throw new CoordError("INVALID_INPUT", "Capture data must contain finite plain JSON records"); }
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function captureDigest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function validPath(path: string): void {
  if (!path || isAbsolute(path) || path.includes("\0") || path.includes("\\") || path.split("/").some(part => part === ".." || part === "." || part === "" || part.toLowerCase() === ".git")) throw new CoordError("INVALID_INPUT", "Capture policy contains an unsafe repository path");
}
export function validateCapturePolicy(policy: CapturePolicy): void {
  for (const path of [...policy.allowedUntracked, ...policy.requiredPaths, ...policy.exclusions.map(item => item.path)]) validPath(path);
  if (new Set(policy.exclusions.map(item => item.path)).size !== policy.exclusions.length || policy.exclusions.some(item => !item.reason.trim())) throw new CoordError("INVALID_INPUT", "Exclusions must be distinct and explained");
  const maxBytes = policy.maxFileBytes ?? DEFAULTS.fileBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024 || policy.forbiddenContent?.some(value => !value)) throw new CoordError("INVALID_INPUT", "Invalid file screening policy");
}
function validIdentity(identity: RunIdentity, checkpointId: string): void {
  if (![identity.taskId, identity.runId, checkpointId].every(value => /^[A-Za-z0-9_-]{1,100}$/.test(value)) || !Number.isSafeInteger(identity.epoch) || identity.epoch < 1 || !Number.isSafeInteger(identity.goalRevision) || identity.goalRevision < 1) throw new CoordError("INVALID_INPUT", "Invalid capture identity");
}
function validateOptions(options: CaptureOptions): void {
  if (options.gitTransport && options.gitTransport.url !== options.remote.url) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Capture destination differs from its fixed Git transport");
  validIdentity(options.identity, options.checkpointId);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.executionBase.sha) || !Number.isSafeInteger(options.executionBase.revision) || options.executionBase.revision < 1 || !options.executionBase.remoteRef.startsWith("refs/")) throw new CoordError("INVALID_INPUT", "Invalid execution base");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(options.remote.name) || !options.remote.url || /[\0\r\n]/.test(options.remote.url) || /:\/\/[^/]*@/.test(options.remote.url)) throw new CoordError("INVALID_INPUT", "Selected remote must have a nonsecret fixed identity");
  if (!Number.isFinite(Date.parse(options.createdAt)) || !options.commitMessage.trim() || options.commitMessage.length > 16_384 || !Number.isSafeInteger(options.progressRevision) || options.progressRevision < 1) throw new CoordError("INVALID_INPUT", "Invalid capture metadata");
  validateCapturePolicy(options.policy);
  auditContent(Buffer.from(canonical(options.progress)), options.policy);
}
export function snapshotCaptureOptions(options: CaptureOptions): CaptureOptions {
  validateOptions(options);
  return { ...options, remote: { ...options.remote }, identity: structuredClone(options.identity), executionBase: structuredClone(options.executionBase), policy: structuredClone(options.policy), progress: structuredClone(options.progress), ...(options.gitTransport ? { gitTransport: { ...options.gitTransport } } : {}), ...(options.gitMetadataIsolation ? { gitMetadataIsolation: structuredClone(options.gitMetadataIsolation) } : {}) };
}
async function authority(options: CaptureOptions, phase: string): Promise<void> {
  const current = await options.readAuthority(phase);
  const expected: CaptureAuthority = { identity: options.identity, executionBase: options.executionBase, progressRevision: options.progressRevision, progressHash: captureDigest(options.progress), policyDigest: captureDigest(options.policy) };
  if (captureDigest(current) !== captureDigest(expected)) throw new CoordError("STALE_EPOCH", "Capture authority, execution base, progress or sharing policy changed");
}
export async function verifySelectedRemote(options: Pick<CaptureOptions, "repo" | "remote" | "gitTransport" | "gitMetadataIsolation">): Promise<void> {
  const urls = (await captureGitText(options, ["remote", "get-url", "--all", options.remote.name])).split("\n");
  const pushUrls = (await captureGitText(options, ["remote", "get-url", "--push", "--all", options.remote.name])).split("\n");
  if (urls.length !== 1 || pushUrls.length !== 1 || urls[0] !== options.remote.url || pushUrls[0] !== options.remote.url) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Selected remote does not match its approved fetch/push identity");
}
async function verifyBase(options: CaptureOptions, sourceHead: string): Promise<void> {
  await verifySelectedRemote(options);
  if (await captureGitText(options, ["rev-parse", "--is-shallow-repository"]) !== "false") throw new CoordError("BLOCKED_CHECKPOINT", "Shallow source provenance requires a full verified history before capture");
  const grafts = resolve(options.repo, await captureGitText(options, ["rev-parse", "--git-path", "info/grafts"]));
  try { if ((await lstat(grafts)).size) throw new CoordError("BLOCKED_CHECKPOINT", "Legacy Git grafts prevent trustworthy remote ancestry verification"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await captureGit(options, ["check-ref-format", options.executionBase.remoteRef]);
  const fetchRef = `refs/coord/internal/${randomUUID()}`;
  try {
    await captureGit(options, ["fetch", "--no-tags", "--no-write-fetch-head", options.remote.name, `${options.executionBase.remoteRef}:${fetchRef}`]);
    const remoteContains = await captureGit(options, ["merge-base", "--is-ancestor", options.executionBase.sha, fetchRef], { allowFailure: true });
    const sourceContains = await captureGit(options, ["merge-base", "--is-ancestor", options.executionBase.sha, sourceHead], { allowFailure: true });
    if (remoteContains.code !== 0 || sourceContains.code !== 0) throw new CoordError("BLOCKED_CHECKPOINT", "Exact execution base is not present on selected remote or incorporated by source HEAD");
  } finally { await captureGit(options, ["update-ref", "-d", fetchRef]); }
}
function parseTree(output: Buffer): FileEntry[] {
  return output.toString("utf8").split("\0").filter(Boolean).map(row => {
    const tab = row.indexOf("\t"), fields = row.slice(0, tab).split(" ");
    const path = row.slice(tab + 1); validPath(path);
    if (tab < 0 || fields.length !== 3 || fields[1] !== "blob" || !["100644", "100755", "120000"].includes(fields[0]!)) throw new CoordError("BLOCKED_CHECKPOINT", "Unsupported Git tree entry, submodule or file mode");
    return { path, mode: fields[0]!, type: fields[0] === "120000" ? "symlink" as const : "blob" as const, oid: fields[2]! };
  }).sort((a, b) => compare(a.path, b.path));
}
export async function readTree(repo: string, tree: string, transport?: GitTransport, metadataIsolation?: GitMetadataIsolation): Promise<FileEntry[]> { return parseTree((await git(repo, ["ls-tree", "-rz", "--full-tree", tree], { transport, metadataIsolation })).stdout); }
function auditContent(content: Buffer, policy: CapturePolicy): void {
  const text = content.toString("utf8");
  if ((policy.forbiddenContent ?? []).some(value => text.includes(value)) || /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{32,})\b/.test(text)) throw new CoordError("BLOCKED_CHECKPOINT", "Required portable content failed the selected credential screening policy; values withheld");
}
function auditPath(path: string): void {
  const name = path.split("/").at(-1)!;
  if (path.split("/").includes(".coord-local") || /^\.env(?:\.(?:local|production|development|test)(?:\.local)?)?$/.test(name) || /^(?:id_rsa|id_ed25519|credentials\.json|auth\.json)$/.test(name) || /\.(?:pem|p12|pfx)$/.test(name)) throw new CoordError("BLOCKED_CHECKPOINT", "Reserved coordinator credential directory or suspected local credential file requires an explicit selected exclusion; no content published");
}
async function attributes(options: CaptureOptions, paths: string[]): Promise<string> {
  const autocrlf = await captureGitText(options, ["config", "--get", "core.autocrlf"], { allowFailure: true });
  if (autocrlf && autocrlf !== "false") throw new CoordError("BLOCKED_CHECKPOINT", "Git EOL normalization is unsupported by this capture implementation");
  let observation = autocrlf;
  for (let start = 0; start < paths.length; start += 100) {
    const data = (await captureGit(options, ["--literal-pathspecs", "check-attr", "-z", "filter", "text", "eol", "working-tree-encoding", "--", ...paths.slice(start, start + 100)])).stdout.toString("utf8").split("\0");
    for (let index = 0; index + 2 < data.length; index += 3) {
      if (!["unspecified", "unset"].includes(data[index + 2]!)) throw new CoordError("BLOCKED_CHECKPOINT", "Git filters, LFS, explicit text conversion or encoded worktrees are unsupported");
    }
    observation += data.join("\0");
  }
  return observation;
}
async function snapshot(options: CaptureOptions, sourceHead: string): Promise<Snapshot> {
  const original = await readTree(options.repo, sourceHead, options.gitTransport, options.gitMetadataIsolation);
  const staged = (await captureGit(options, ["ls-files", "--stage", "-z"])).stdout.toString("utf8").split("\0").filter(Boolean).map(row => {
    const tab = row.indexOf("\t"), fields = row.slice(0, tab).split(" ");
    if (fields[2] !== "0" || fields[0] === "160000") throw new CoordError("BLOCKED_CHECKPOINT", "Unmerged indexes and submodules are unsupported");
    return row.slice(tab + 1);
  });
  const untracked = (await captureGit(options, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.toString("utf8").split("\0").filter(Boolean);
  const names = [...new Set([...original.map(file => file.path), ...staged, ...untracked])].sort();
  names.forEach(validPath);
  const excluded = new Map(options.policy.exclusions.map(item => [item.path, item.reason]));
  for (const path of untracked) if (!options.policy.allowedUntracked.includes(path) && !excluded.has(path)) excluded.set(path, "Untracked file not permitted by selected sharing policy");
  const selected = names.filter(path => !excluded.has(path));
  for (const required of options.policy.requiredPaths) if (!selected.includes(required)) throw new CoordError("BLOCKED_CHECKPOINT", "Required source/asset is excluded, ignored or unavailable");
  const attributeState = await attributes(options, selected);
  const indexPath = await captureGitText(options, ["rev-parse", "--git-path", "index"]);
  let indexHash = "absent";
  try { indexHash = createHash("sha256").update(await readFile(resolve(options.repo, indexPath))).digest("hex"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const files: FileEntry[] = [], stamps: unknown[] = [];
  for (const path of selected) {
    const file = join(options.repo, path);
    let before;
    try { before = await lstat(file, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { stamps.push([path, "deleted"]); continue; } throw error; }
    if (await realpath(dirname(file)) !== resolve(dirname(file))) throw new CoordError("BLOCKED_CHECKPOINT", "Portable path traverses a symlink directory");
    if (!before.isFile() && !before.isSymbolicLink()) throw new CoordError("BLOCKED_CHECKPOINT", "Unsupported portable file type");
    if (before.size > BigInt(options.policy.maxFileBytes ?? DEFAULTS.fileBytes)) throw new CoordError("BLOCKED_CHECKPOINT", "Portable file exceeds selected size limit");
    let content: Buffer;
    if (before.isSymbolicLink()) {
      const target = await readlink(file);
      const targetRelative = relative(options.repo, resolve(dirname(file), target));
      if (isAbsolute(target) || targetRelative === ".." || targetRelative.startsWith(`..${sep}`)) throw new CoordError("BLOCKED_CHECKPOINT", "Nonportable symlink target escapes repository");
      content = Buffer.from(target);
    } else {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat({ bigint: true });
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new CoordError("CHECKPOINT_INCOMPLETE", "Portable file was replaced before read");
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let read = 0;
        while (read < buffer.length) { const next = await handle.read(buffer, read, buffer.length - read, read); if (!next.bytesRead) break; read += next.bytesRead; }
        if (read > Number(before.size)) throw new CoordError("CHECKPOINT_INCOMPLETE", "Portable file grew during bounded read");
        content = buffer.subarray(0, read);
      } finally { await handle.close(); }
    }
    const after = await lstat(file, { bigint: true });
    const stamp = (info: typeof before) => [info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs].map(String);
    if (canonical(stamp(before)) !== canonical(stamp(after))) throw new CoordError("CHECKPOINT_INCOMPLETE", "Source changed during manifest read");
    auditPath(path); auditContent(content, options.policy);
    const oid = await captureGitText(options, ["hash-object", "-w", "--no-filters", "--stdin"], { input: content });
    files.push({ path, mode: before.isSymbolicLink() ? "120000" : (before.mode & 0o111n) !== 0n ? "100755" : "100644", type: before.isSymbolicLink() ? "symlink" : "blob", oid });
    stamps.push([path, ...stamp(after), oid]);
  }
  for (const required of options.policy.requiredPaths) if (!files.some(file => file.path === required)) throw new CoordError("BLOCKED_CHECKPOINT", "Required source/asset is missing");
  const exclusions = [...excluded].map(([path, reason]) => ({ path, reason })).sort((a, b) => compare(a.path, b.path));
  files.sort((a, b) => compare(a.path, b.path));
  return { files, exclusions, stamp: captureDigest({ sourceHead, files, exclusions, stamps, attributeState, indexHash }) };
}
function manifestDigest(manifest: Pick<PreparedCheckpoint, "identity" | "sourceHead" | "executionBase" | "tree" | "files" | "exclusions" | "progressHash" | "policyDigest" | "progressRevision">): string {
  return captureDigest({ identity: manifest.identity, sourceHead: manifest.sourceHead, executionBase: manifest.executionBase, tree: manifest.tree, files: manifest.files, exclusions: manifest.exclusions, progressHash: manifest.progressHash, policyDigest: manifest.policyDigest, progressRevision: manifest.progressRevision });
}
function snapshotMessage(options: CaptureOptions, manifest: PreparedCheckpoint): string { return `${options.commitMessage.trim()}\n\nCoord-Checkpoint: ${options.checkpointId}\nCoord-Manifest: ${manifest.manifestDigest}\nCoord-Progress: ${manifest.progressHash}\n`; }
async function snapshotCommit(options: CaptureOptions, manifest: PreparedCheckpoint): Promise<string> {
  const message = snapshotMessage(options, manifest);
  auditContent(Buffer.from(message), options.policy);
  return captureGitText(options, ["commit-tree", manifest.tree, "-p", options.executionBase.sha], { input: message, env: { GIT_AUTHOR_NAME: "Coord", GIT_AUTHOR_EMAIL: "coord@localhost", GIT_COMMITTER_NAME: "Coord", GIT_COMMITTER_EMAIL: "coord@localhost", GIT_AUTHOR_DATE: options.createdAt, GIT_COMMITTER_DATE: options.createdAt } });
}
async function auditTree(options: CaptureOptions, tree: string, expected: Snapshot): Promise<void> {
  const files = await readTree(options.repo, tree, options.gitTransport, options.gitMetadataIsolation);
  if (captureDigest(files) !== captureDigest(expected.files)) throw new CoordError("CHECKPOINT_INCOMPLETE", "Candidate tree does not equal the intended complete portable manifest");
  if (options.policy.requiredPaths.some(path => !files.some(file => file.path === path)) || files.some(file => options.policy.exclusions.some(item => item.path === file.path))) throw new CoordError("BLOCKED_CHECKPOINT", "Actual candidate violates required-path or explicit-exclusion policy");
  for (const file of files) {
    auditPath(file.path);
    const size = Number(await captureGitText(options, ["cat-file", "-s", file.oid]));
    if (!Number.isSafeInteger(size) || size > (options.policy.maxFileBytes ?? DEFAULTS.fileBytes)) throw new CoordError("BLOCKED_CHECKPOINT", "Candidate tree contains oversized content");
    const content = (await captureGit(options, ["cat-file", "blob", file.oid], { maxBytes: (options.policy.maxFileBytes ?? DEFAULTS.fileBytes) + 1024 })).stdout;
    auditContent(content, options.policy);
    if (file.type === "symlink") {
      const target = content.toString("utf8"), targetRelative = relative(options.repo, resolve(options.repo, dirname(file.path), target));
      if (isAbsolute(target) || targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || target.includes("\0")) throw new CoordError("BLOCKED_CHECKPOINT", "Actual candidate has a nonportable symlink target");
    }
    if (file.path.split("/").at(-1) === ".gitattributes" && content.toString("utf8").split(/\r?\n/).some(line => line.trim() && !line.trim().startsWith("#"))) throw new CoordError("BLOCKED_CHECKPOINT", "Portable Git attribute files require a supported normalization policy; executable filters are never run");
  }
}

/** Creates only a prepared local snapshot. It never claims backend readiness or publishes history. */
export async function captureCheckpoint(options: CaptureOptions): Promise<PreparedCheckpoint> {
  options = snapshotCaptureOptions(options);
  const repo = await realpath(options.repo);
  if (repo !== await captureGitText(options, ["rev-parse", "--show-toplevel"])) throw new CoordError("INVALID_INPUT", "Capture must target the canonical repository root");
  options = { ...options, repo };
  const lockPath = resolve(repo, await captureGitText(options, ["rev-parse", "--git-path", "coord-capture.lock"]));
  const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new CoordError("CHECKPOINT_INCOMPLETE", "Another capture owns this worktree; stale locks require explicit recovery"); });
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "coord-capture-")); await chmod(directory, 0o700);
    await options.quietBoundary();
    for (let attempt = 0; attempt < DEFAULTS.captureAttempts; attempt++) {
      const index = join(directory, `index-${attempt}`); // Deliberately nonexistent until read-tree.
      const env = { GIT_INDEX_FILE: index };
      try {
        await authority(options, "capture.start");
        const sourceHead = await captureGitText(options, ["rev-parse", "--verify", "HEAD^{commit}"]);
        await verifyBase(options, sourceHead);
        const before = await snapshot(options, sourceHead);
        await options.fault?.("capture.after-manifest");
        await captureGit(options, ["read-tree", sourceHead], { env });
        const sourceFiles = await readTree(repo, sourceHead, options.gitTransport, options.gitMetadataIsolation);
        for (const path of sourceFiles.map(file => file.path).filter(path => !before.files.some(file => file.path === path))) await captureGit(options, ["--literal-pathspecs", "update-index", "--force-remove", "--", path], { env });
        for (const file of before.files) await captureGit(options, ["update-index", "--add", "--cacheinfo", `${file.mode},${file.oid},${file.path}`], { env });
        const tree = await captureGitText(options, ["write-tree"], { env });
        await options.fault?.("capture.after-index");
        await auditTree(options, tree, before);
        await options.fault?.("capture.before-final-validation");
        const after = await snapshot(options, sourceHead);
        if (before.stamp !== after.stamp || await captureGitText(options, ["rev-parse", "HEAD"]) !== sourceHead) throw new CoordError("CHECKPOINT_INCOMPLETE", "Source changed during capture; progress must match stable code");
        await authority(options, "capture.validated");
        const prepared: PreparedCheckpoint = { schemaVersion: 1, checkpointId: options.checkpointId, identity: { ...options.identity }, sourceHead, executionBase: { ...options.executionBase }, remoteParent: options.executionBase.sha, tree, commit: "", ref: `refs/coord/checkpoints/${options.identity.taskId}/e${options.identity.epoch}/${options.checkpointId}`, files: before.files, exclusions: before.exclusions, progressHash: captureDigest(options.progress), evidence: [], createdAt: options.createdAt, progressRevision: options.progressRevision, policyDigest: captureDigest(options.policy), manifestDigest: "", reusedCommit: false };
        prepared.manifestDigest = manifestDigest(prepared);
        const baseTree = await captureGitText(options, ["rev-parse", `${options.executionBase.sha}^{tree}`]);
        if (baseTree === tree) { prepared.commit = options.executionBase.sha; prepared.reusedCommit = true; }
        else {
          prepared.commit = await snapshotCommit(options, prepared);
        }
        return prepared;
      } catch (error) {
        if (!(error instanceof CoordError) || error.code !== "CHECKPOINT_INCOMPLETE" || attempt === DEFAULTS.captureAttempts - 1) throw error;
      }
    }
    throw new CoordError("CHECKPOINT_INCOMPLETE", "Capture exhausted bounded consistency retries");
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); await lock.close(); await rm(lockPath, { force: true }); }
}

export async function validatePreparedCheckpoint(options: CaptureOptions, manifest: PreparedCheckpoint): Promise<void> {
  options = snapshotCaptureOptions(options); manifest = structuredClone(manifest);
  validateManifestBinding(options, manifest);
  const rawCommit = (await captureGit(options, ["cat-file", "-p", manifest.commit])).stdout;
  auditContent(rawCommit, options.policy);
  const commit = rawCommit.toString("utf8");
  const headers = commit.split("\n\n")[0]!;
  const parents = headers.split("\n").filter(line => line.startsWith("parent ")).map(line => line.slice(7));
  if (!headers.split("\n").includes(`tree ${manifest.tree}`) || (manifest.reusedCommit ? manifest.commit !== options.executionBase.sha : parents.length !== 1 || parents[0] !== options.executionBase.sha || !commit.includes(`\nCoord-Manifest: ${manifest.manifestDigest}\n`))) throw new CoordError("BLOCKED_CHECKPOINT", "Snapshot tree, sole verified execution-base parent or metadata digest mismatch");
  if (!manifest.reusedCommit && manifest.commit !== await snapshotCommit(options, manifest)) throw new CoordError("BLOCKED_CHECKPOINT", "Actual commit does not equal the intended checkpoint/progress metadata and fixed identity");
  await auditTree(options, manifest.tree, { files: manifest.files, exclusions: manifest.exclusions, stamp: "" });
}
function validateManifestBinding(options: CaptureOptions, manifest: PreparedCheckpoint): void {
  if (![manifest.commit, manifest.tree, manifest.sourceHead].every(oid => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) || manifest.createdAt !== options.createdAt || manifest.schemaVersion !== 1 || manifest.checkpointId !== options.checkpointId || captureDigest(manifest.identity) !== captureDigest(options.identity) || captureDigest(manifest.executionBase) !== captureDigest(options.executionBase) || manifest.progressHash !== captureDigest(options.progress) || manifest.progressRevision !== options.progressRevision || manifest.policyDigest !== captureDigest(options.policy) || manifest.manifestDigest !== manifestDigest(manifest) || manifest.remoteParent !== options.executionBase.sha || manifest.ref !== `refs/coord/checkpoints/${options.identity.taskId}/e${options.identity.epoch}/${options.checkpointId}`) throw new CoordError("BLOCKED_CHECKPOINT", "Prepared manifest does not match exact capture identity, policy and progress");
}
/** Fetches and validates exact remote content; does not mark backend ready. */
export async function verifyRemoteCheckpoint(options: CaptureOptions, manifest: PreparedCheckpoint, ref = manifest.ref): Promise<RemoteCheckpointReadback> {
  options = snapshotCaptureOptions(options); manifest = structuredClone(manifest);
  validateManifestBinding(options, manifest);
  validatePublicationRef(manifest, ref);
  await verifySelectedRemote(options);
  const fetched = `refs/coord/internal/${randomUUID()}`;
  try {
    await captureGit(options, ["fetch", "--no-tags", "--no-write-fetch-head", options.remote.name, `${ref}:${fetched}`]);
    if (await captureGitText(options, ["rev-parse", fetched]) !== manifest.commit) throw new CoordError("BLOCKED_CHECKPOINT", "Remote checkpoint ref does not match exact prepared commit");
    await validatePreparedCheckpoint(options, manifest);
    const parents = (await captureGitText(options, ["cat-file", "-p", manifest.commit])).split("\n\n")[0]!.split("\n").filter(line => line.startsWith("parent ")).map(line => line.slice(7));
    return { commit: manifest.commit, tree: manifest.tree, parent: parents.length === 1 ? parents[0]! : null, parents, ref, manifestHash: manifest.manifestDigest, progressHash: manifest.progressHash, policyDigest: manifest.policyDigest, verifiedAt: new Date().toISOString() };
  } finally { await captureGit(options, ["update-ref", "-d", fetched]); }
}
/** Immutable ref publication with same-ID reconciliation. Backend ready acceptance is a separate authenticated operation. */
export async function publishCheckpoint(options: CaptureOptions, manifest: PreparedCheckpoint): Promise<PreparedCheckpoint> {
  return pushImmutableSnapshot(options, manifest, manifest.ref);
}
function validatePublicationRef(manifest: PreparedCheckpoint, ref: string): void {
  const review = `refs/heads/coord/reviews/${manifest.identity.taskId}/e${manifest.identity.epoch}/`;
  if (ref !== manifest.ref && !(ref.startsWith(review) && /^[A-Za-z0-9_-]{1,100}$/.test(ref.slice(review.length)))) throw new CoordError("FORBIDDEN", "Publication ref is outside this exact task/epoch artifact identity");
}
export async function pushImmutableSnapshot(options: CaptureOptions, manifest: PreparedCheckpoint, ref: string): Promise<PreparedCheckpoint> {
  options = snapshotCaptureOptions(options); manifest = structuredClone(manifest);
  validatePublicationRef(manifest, ref);
  await authority(options, "publish.start");
  await validatePreparedCheckpoint(options, manifest);
  await verifyBase(options, manifest.sourceHead);
  const existing = await captureGit(options, ["ls-remote", "--refs", options.remote.name, ref]);
  const line = existing.stdout.toString("utf8").trim();
  if (line && line.split(/\s+/)[0] !== manifest.commit) throw new CoordError("IDEMPOTENCY_CONFLICT", "Immutable checkpoint ref already contains different content");
  if (!line) {
    await authority(options, "publish.before-push");
    // Empty expected old ref is an atomic create-only lease: it cannot replace even an ancestor.
    const pushed = await captureGit(options, ["-c", "push.followTags=false", "-c", `remote.${options.remote.name}.mirror=false`, "push", "--porcelain", "--no-verify", "--no-follow-tags", `--force-with-lease=${ref}:`, options.remote.name, `${manifest.commit}:${ref}`], { allowFailure: true });
    // A failed/lost push response is reconciled by exact remote read-back, never a forced retry.
    if (pushed.code !== 0) await verifyRemoteCheckpoint(options, manifest, ref);
    await options.fault?.("publish.after-push");
  }
  await verifyRemoteCheckpoint(options, manifest, ref);
  await options.fault?.("publish.after-verify");
  await authority(options, "publish.verified");
  return manifest;
}
