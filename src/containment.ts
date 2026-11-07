import { constants, writeSync } from "node:fs";
import { access, lstat, mkdir, open, readlink, realpath, rename, rm, statfs, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { canonicalJson } from "./canonical.js";
import { LaunchJournalStore } from "./launch.js";
import { CoordError, requireCapability, type CapabilityEvidence, type CapabilityKey, type LaunchReceipt, type ProcessIdentity, type StopEvidence } from "./protocol.js";
import type { QualifiedStopAdapter } from "./supervisor.js";

const CGROUP2_MAGIC = 0x63677270n;
const ISOLATION_CHECK = "process.cgroup-control-isolation";
const hash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
function fail(message: string): never { throw new CoordError("LAUNCH_UNCERTAIN", message); }
function unsupported(message: string): never { throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", message); }
function identifier(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new CoordError("INVALID_INPUT", "Invalid containment launch identity"); }
function pathValue(value: string): void { if (!isAbsolute(value) || resolve(value) !== value || /[\s\\\0]/.test(value)) throw new CoordError("INVALID_INPUT", "Containment paths must be canonical absolute paths without escapes"); }
async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new CoordError("LAUNCH_UNCERTAIN", "Containment I/O timed out; ownership remains held")), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
export interface CgroupWrapperSpec {
  kind: "linux-cgroup-v2"; launchId: string; path: string; device: string; inode: string;
  mountPoint: string; membershipPath: string; namespaceId: string; bootId: string; keyDigest: string;
}
export interface CgroupLaunchReceipt extends LaunchReceipt { containment?: CgroupWrapperSpec }
export interface CgroupPreflight { kind: "linux-cgroup-v2"; root: string; mountPoint: string; membershipPath: string; namespaceId: string; bootId: string; device: string; inode: string }
export interface CgroupOptions {
  root: string; key: CapabilityKey; metadataRoot: string; capabilityEvidence: CapabilityEvidence;
  checkCurrentConfiguration(): Promise<CapabilityKey>; timeoutMs?: number; pollMs?: number;
  /** Cleanup only: this trusted callback validates protected historical owner provenance locally, never via the backend. */
  lifecycleOnly?: boolean;
  verifyLifecycleOwnership?(receipt: LaunchReceipt): Promise<CapabilityKey>;
}
export interface CgroupControl {
  preflight(): Promise<CgroupPreflight>; prepare(launchId: string): Promise<CgroupWrapperSpec>;
  /** Confirms wrapper self-attachment. This method never writes a PID or migrates a process. */
  attach(receipt: LaunchReceipt): Promise<void>;
  adapter: QualifiedStopAdapter; close(): Promise<void>;
}
export interface WrapperCgroupHandle { kill(): void; close(): Promise<void> }
interface Binding { schemaVersion: 1; launchId: string; keyDigest: string; state: "intent" | "prepared" | "attached"; spec?: CgroupWrapperSpec; receipt?: CgroupLaunchReceipt; receiptDigest?: string }
interface Pinned { directory: FileHandle; spec: CgroupWrapperSpec }

export async function readLinuxBootId(): Promise<string> {
  if (process.platform !== "linux") unsupported("Linux kernel boot identity is unavailable on this host");
  const value = (await smallRead("/proc/sys/kernel/random/boot_id")).trim();
  if (!/^[a-f0-9-]{36}$/.test(value)) unsupported("Linux kernel boot identity is malformed");
  return `linux:${value}`;
}
export async function readLinuxProcessIdentity(pid: number, launchId: string): Promise<ProcessIdentity> {
  identifier(launchId);
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) throw new CoordError("INVALID_INPUT", "Invalid Linux process identity request");
  const bootId = await readLinuxBootId(), contents = await smallRead(`/proc/${pid}/stat`), close = contents.lastIndexOf(")");
  const fields = contents.slice(close + 2).trim().split(/\s+/);
  if (close < 0 || !contents.startsWith(`${pid} (`) || !/^\d+$/.test(fields[19] ?? "") || !/^\d+$/.test(fields[2] ?? "")) fail("Linux process start identity could not be established");
  return { pid, bootId, startIdentity: `linux-start-ticks:${fields[19]}:pgid:${fields[2]}`, launchId };
}
const nativeBoot = readLinuxBootId;
const nativeIdentity = readLinuxProcessIdentity;
async function smallRead(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(256 * 1024 + 1); let length = 0;
    while (length < buffer.length) { const read = await file.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length === buffer.length) fail("Containment control data exceeds its supported bound");
    return buffer.subarray(0, length).toString("utf8");
  } finally { await file.close(); }
}
function unifiedMembership(contents: string): string {
  const lines = contents.trim().split("\n").filter(line => line.startsWith("0::"));
  if (lines.length !== 1 || !lines[0]!.slice(3).startsWith("/") || /[\s\\\0]/.test(lines[0]!.slice(3))) fail("Unified cgroup membership is unavailable or ambiguous");
  return lines[0]!.slice(3);
}
function populated(contents: string): 0 | 1 {
  const entries = contents.trim().split("\n").map(line => line.trim().split(/\s+/)).filter(fields => fields[0] === "populated");
  if (entries.length !== 1 || entries[0]!.length !== 2 || !["0", "1"].includes(entries[0]![1]!)) fail("Kernel cgroup populated state is unavailable or malformed");
  return entries[0]![1] === "0" ? 0 : 1;
}
async function canonicalDirectory(path: string, privateMode = false): Promise<void> {
  pathValue(path); const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || (privateMode && ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())))) fail("Containment directory identity or private ownership is invalid");
}
async function pin(spec: CgroupWrapperSpec): Promise<Pinned> {
  await canonicalDirectory(spec.path);
  const directory = await open(spec.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await directory.stat({ bigint: true });
    if (String(info.dev) !== spec.device || String(info.ino) !== spec.inode || (await statfs(spec.path, { bigint: true })).type !== CGROUP2_MAGIC) fail("Containment kernel directory differs from its prepared identity");
    return { directory, spec };
  } catch (error) { await directory.close(); throw error; }
}
async function checkPinned(pinned: Pinned): Promise<void> {
  await canonicalDirectory(pinned.spec.path);
  const [opened, named] = await Promise.all([pinned.directory.stat({ bigint: true }), lstat(pinned.spec.path, { bigint: true })]);
  if (String(opened.dev) !== pinned.spec.device || String(opened.ino) !== pinned.spec.inode || opened.dev !== named.dev || opened.ino !== named.ino) fail("Containment path was removed or replaced; no other group may be targeted");
}
const controlPath = (pinned: Pinned, name: string): string => `/proc/self/fd/${pinned.directory.fd}/${name}`;
async function readControl(pinned: Pinned, name: string): Promise<string> { await checkPinned(pinned); return smallRead(controlPath(pinned, name)); }
async function openControl(pinned: Pinned, name: "cgroup.kill" | "cgroup.procs"): Promise<FileHandle> {
  await checkPinned(pinned);
  return open(controlPath(pinned, name), constants.O_WRONLY | constants.O_NOFOLLOW);
}
async function writeControl(pinned: Pinned, name: "cgroup.kill" | "cgroup.procs", value: "0\n" | "1\n"): Promise<void> {
  const file = await openControl(pinned, name);
  try { const data = Buffer.from(value); if ((await file.write(data, 0, data.length, null)).bytesWritten !== data.length) fail("Kernel containment write was incomplete"); }
  finally { await file.close(); }
}
async function syncDirectory(path: string): Promise<void> { const file = await open(path, "r"); try { await file.sync(); } finally { await file.close(); } }
async function writePrivate(directory: string, name: string, value: unknown, initial = false): Promise<void> {
  await canonicalDirectory(directory, true);
  const final = join(directory, name), temporary = initial ? final : join(directory, `${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); } finally { await file.close(); }
    if (!initial) await rename(temporary, final);
    await syncDirectory(directory);
  } finally { if (!initial) await rm(temporary, { force: true }); }
}
async function readPrivate<T>(directory: string, name: string): Promise<T> {
  await canonicalDirectory(directory, true);
  const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || info.size > 256 * 1024 || (process.getuid && info.uid !== process.getuid())) fail("Private containment state is not an owned bounded regular file");
    const data = Buffer.alloc(info.size + 1); let count = 0;
    while (count < data.length) { const read = await file.read(data, count, data.length - count, null); if (!read.bytesRead) break; count += read.bytesRead; }
    if (count !== info.size) fail("Private containment state changed during read");
    try { return JSON.parse(data.subarray(0, count).toString("utf8")) as T; } catch { fail("Private containment state is malformed"); }
  } finally { await file.close(); }
}
function validateSpec(spec: CgroupWrapperSpec): void {
  identifier(spec.launchId); pathValue(spec.path); pathValue(spec.mountPoint);
  if (spec.kind !== "linux-cgroup-v2" || !/^\d+$/.test(spec.device) || !/^\d+$/.test(spec.inode) || !/^cgroup:\[\d+\]$/.test(spec.namespaceId) || !/^linux:[a-f0-9-]{36}$/.test(spec.bootId) || !/^[a-f0-9]{64}$/.test(spec.keyDigest) || !spec.membershipPath.startsWith("/") || /[\s\\\0]/.test(spec.membershipPath) || relative(spec.mountPoint, spec.path).startsWith("..") || join(spec.mountPoint, spec.membershipPath.slice(1)) !== spec.path || !spec.path.endsWith(`/coord-${spec.launchId}`)) fail("Prepared wrapper containment specification is invalid");
}

/** Wrapper-only migration: kernel PID zero means the writing process, avoiding a parent PID lookup/write race. */
export async function enterWrapperCgroup(spec: CgroupWrapperSpec, identity: ProcessIdentity): Promise<WrapperCgroupHandle> {
  if (process.platform !== "linux") unsupported("Native cgroup-v2 containment requires Linux");
  validateSpec(spec);
  if (identity.pid !== process.pid || identity.launchId !== spec.launchId || identity.bootId !== spec.bootId || await nativeBoot() !== spec.bootId || await readlink("/proc/self/ns/cgroup") !== spec.namespaceId) fail("Wrapper identity or cgroup namespace differs from the prepared containment");
  const pinned = await pin(spec); let killFile: FileHandle | undefined;
  try {
    if ((await readControl(pinned, "cgroup.type")).trim() !== "domain" || populated(await readControl(pinned, "cgroup.events")) !== 0 || (await readControl(pinned, "cgroup.procs")).trim()) fail("Wrapper cannot enter an occupied or invalid containment");
    killFile = await openControl(pinned, "cgroup.kill");
    await writeControl(pinned, "cgroup.procs", "0\n");
    if (unifiedMembership(await smallRead("/proc/self/cgroup")) !== spec.membershipPath || !(await readControl(pinned, "cgroup.procs")).trim().split(/\s+/).includes(String(process.pid))) fail("Kernel did not confirm wrapper self-attachment");
    return { kill: () => { const data = Buffer.from("1\n"); if (writeSync(killFile!.fd, data, 0, data.length, null) !== data.length) fail("Kernel cgroup kill write was incomplete"); }, close: async () => { await killFile!.close(); await pinned.directory.close(); } };
  } catch (error) { if (killFile) await killFile.close(); await pinned.directory.close(); throw error; }
}

export async function createCgroupControl(input: CgroupOptions): Promise<CgroupControl> {
  const options = { ...input, key: structuredClone(input.key), capabilityEvidence: structuredClone(input.capabilityEvidence) };
  pathValue(options.root); pathValue(options.metadataRoot);
  if (options.lifecycleOnly && !options.verifyLifecycleOwnership) unsupported("Cleanup-only containment requires a protected historical ownership verifier");
  const timeoutMs = options.timeoutMs ?? 3_000, pollMs = options.pollMs ?? 50;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 30_000 || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1_000) throw new CoordError("INVALID_INPUT", "Invalid containment timing bounds");
  const keyDigest = hash(options.key), groups = new Map<string, Pinned>(), owned = new Map<string, string>();
  const guard = async () => {
    if (options.lifecycleOnly) unsupported("Cleanup-only containment cannot qualify, prepare or attach execution");
    if (process.platform !== "linux") unsupported("Native cgroup-v2 containment requires Linux; this host is unsupported");
    if (!same(await bounded(options.checkCurrentConfiguration(), timeoutMs), options.key)) unsupported("Containment qualification configuration changed");
    requireCapability(options.capabilityEvidence, options.key, "managed");
    const checks = options.capabilityEvidence.checks.filter(check => check.checkId === ISOLATION_CHECK), check = checks[0];
    const observed = check ? Date.parse(check.observedAt) : NaN;
    if (checks.length !== 1 || !check || check.kind !== "real" || check.status !== "PASS" || check.mode !== "managed" || check.configurationDigest !== options.key.configurationDigest || !check.evidenceRef || !Number.isFinite(observed) || observed > Date.now() || Date.now() - observed > 86_400_000) unsupported("Actual worker denial of cgroup and supervision-state control has not been qualified");
  };
  const inspect = async (): Promise<CgroupPreflight> => {
    await guard(); await canonicalDirectory(options.root);
    if ((await statfs(options.root, { bigint: true })).type !== CGROUP2_MAGIC) unsupported("Selected containment root is not a cgroup-v2 filesystem");
    const mounts = (await smallRead("/proc/self/mountinfo")).trim().split("\n").map(line => line.split(" ")).filter(fields => fields[fields.indexOf("-") + 1] === "cgroup2");
    if (mounts.length !== 1 || mounts[0]![3] !== "/") unsupported("Containment requires one visible cgroup-v2 mount rooted at the hierarchy root");
    const mountPoint = mounts[0]![4]!; await canonicalDirectory(mountPoint);
    const rel = relative(mountPoint, options.root);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || options.metadataRoot === mountPoint || options.metadataRoot.startsWith(`${mountPoint}/`)) unsupported("Containment root must be a delegated non-root subtree with metadata outside cgroupfs");
    const membershipPath = `/${rel}`, current = unifiedMembership(await smallRead("/proc/self/cgroup"));
    if (current !== membershipPath && !current.startsWith(`${membershipPath}/`)) unsupported("Supervisor must already run inside the selected delegated subtree");
    if (current.slice(membershipPath.length + 1).split("/")[0]?.startsWith("coord-")) unsupported("Supervisor cannot run inside a launch containment");
    if ((await smallRead(join(options.root, "cgroup.type"))).trim() !== "domain") unsupported("Threaded or invalid cgroup domains are unsupported");
    const controllers = (await smallRead(join(options.root, "cgroup.controllers"))).trim();
    if (controllers && !controllers.split(/\s+/).every(controller => /^[a-z_]+$/.test(controller))) unsupported("Cgroup controller discovery is invalid");
    populated(await smallRead(join(options.root, "cgroup.events")));
    await access(options.root, constants.W_OK | constants.X_OK);
    for (const name of ["cgroup.procs", "cgroup.kill"]) { const file = await open(join(options.root, name), constants.O_WRONLY | constants.O_NOFOLLOW); await file.close(); }
    const info = await lstat(options.root, { bigint: true }), namespaceId = await readlink("/proc/self/ns/cgroup"), bootId = await nativeBoot();
    if (!/^cgroup:\[\d+\]$/.test(namespaceId)) unsupported("Current cgroup namespace is unavailable");
    return { kind: "linux-cgroup-v2", root: options.root, mountPoint, membershipPath, namespaceId, bootId, device: String(info.dev), inode: String(info.ino) };
  };
  const preflight = () => bounded(inspect(), timeoutMs);
  const directory = (launchId: string) => { identifier(launchId); return join(options.metadataRoot, launchId); };
  const load = async (receipt: LaunchReceipt): Promise<Binding & { spec: CgroupWrapperSpec }> => {
    if (process.platform !== "linux") unsupported("Native cgroup-v2 containment requires Linux; this host is unsupported");
    identifier(receipt.launchId);
    const record = await bounded(readPrivate<Binding>(directory(receipt.launchId), "cgroup-binding.json"), timeoutMs);
    if (record.schemaVersion !== 1 || record.launchId !== receipt.launchId || record.keyDigest !== keyDigest || !record.spec) fail("Containment has no complete prepared ownership record");
    validateSpec(record.spec);
    if (record.spec.path !== join(options.root, `coord-${receipt.launchId}`) || record.spec.keyDigest !== keyDigest || record.spec.launchId !== receipt.launchId || record.spec.bootId !== receipt.process.bootId || !same((receipt as CgroupLaunchReceipt).containment, record.spec)) fail("Receipt does not match the prepared kernel containment");
    const journal = await bounded(new LaunchJournalStore(options.metadataRoot).read(receipt.launchId), timeoutMs);
    if (!journal?.receipt || !same(journal.receipt, receipt) || journal.machineId !== receipt.machineId || journal.bootId !== receipt.process.bootId || journal.workspace !== receipt.workspace || !same(journal.identity, receipt.identity)) fail("Containment receipt is not bound to the durable reserved launch journal");
    if (record.state === "attached" && (!record.receipt || !same(record.receipt, receipt) || record.receiptDigest !== hash(receipt))) fail("Attached containment metadata differs from the exact original receipt");
    return record as Binding & { spec: CgroupWrapperSpec };
  };
  const loadOwned = async (receipt: LaunchReceipt): Promise<(Binding & { spec: CgroupWrapperSpec }) | undefined> => {
    const record = await load(receipt);
    if (record.state !== "attached") return undefined;
    const receiptHash = hash(receipt), known = owned.get(receipt.launchId);
    if (known && known !== receiptHash) fail("Containment cleanup differs from the exact established owner");
    if (!known) {
      if (!options.lifecycleOnly || !options.verifyLifecycleOwnership) fail("Restart cleanup requires protected historical owner provenance");
      const originalKey = await bounded(options.verifyLifecycleOwnership(structuredClone(receipt)), timeoutMs);
      if (!same(originalKey, options.key)) fail("Historical ownership does not bind this exact containment key");
      owned.set(receipt.launchId, receiptHash);
    }
    return record;
  };
  const pinnedFor = async (spec: CgroupWrapperSpec): Promise<Pinned> => {
    let pinned = groups.get(spec.launchId);
    if (!pinned) { pinned = await bounded(pin(spec), timeoutMs); groups.set(spec.launchId, pinned); }
    if (!same(pinned.spec, spec)) fail("Retained containment handle differs from durable ownership");
    await bounded(checkPinned(pinned), timeoutMs); return pinned;
  };
  const localGroup = async (spec: CgroupWrapperSpec): Promise<Pinned> => {
    await bounded(canonicalDirectory(options.root), timeoutMs);
    if ((await bounded(statfs(options.root, { bigint: true }), timeoutMs)).type !== CGROUP2_MAGIC) fail("Owned containment root is no longer a cgroup-v2 filesystem");
    const pinned = await pinnedFor(spec);
    if ((await bounded(readControl(pinned, "cgroup.type"), timeoutMs)).trim() !== "domain") fail("Owned containment is no longer its original domain type");
    return pinned;
  };
  const prepare = async (launchId: string): Promise<CgroupWrapperSpec> => {
    identifier(launchId); const host = await preflight(), dir = directory(launchId);
    await canonicalDirectory(options.metadataRoot, true); await canonicalDirectory(dir, true);
    const intent: Binding = { schemaVersion: 1, launchId, keyDigest, state: "intent" };
    await bounded(writePrivate(dir, "cgroup-binding.json", intent, true), timeoutMs).catch(() => fail("Containment identity already has state or cannot be durably reserved; reconcile instead of reuse"));
    const path = join(options.root, `coord-${launchId}`);
    try { await bounded(mkdir(path, { mode: 0o700 }), timeoutMs); } catch { fail("Containment group already exists or delegation failed; it will not be reused"); }
    const info = await bounded(lstat(path, { bigint: true }), timeoutMs);
    const spec: CgroupWrapperSpec = { kind: "linux-cgroup-v2", launchId, path, device: String(info.dev), inode: String(info.ino), mountPoint: host.mountPoint, membershipPath: `${host.membershipPath}/coord-${launchId}`, namespaceId: host.namespaceId, bootId: host.bootId, keyDigest };
    const pinned = await bounded(pin(spec), timeoutMs); groups.set(launchId, pinned);
    if ((await bounded(readControl(pinned, "cgroup.type"), timeoutMs)).trim() !== "domain" || populated(await bounded(readControl(pinned, "cgroup.events"), timeoutMs)) !== 0 || (await bounded(readControl(pinned, "cgroup.procs"), timeoutMs)).trim()) fail("New containment is unexpectedly occupied or invalid");
    const kill = await bounded(openControl(pinned, "cgroup.kill"), timeoutMs); await kill.close();
    await bounded(writePrivate(dir, "cgroup-binding.json", { ...intent, spec, state: "prepared" }), timeoutMs);
    return spec;
  };
  const attach = async (receipt: LaunchReceipt): Promise<void> => {
    await guard();
    const record = await load(receipt);
    if (!["prepared", "attached"].includes(record.state)) fail("Containment was not prepared for self-attachment");
    const pinned = await localGroup(record.spec);
    if (await bounded(nativeBoot(), timeoutMs) !== record.spec.bootId || await bounded(readlink("/proc/self/ns/cgroup"), timeoutMs) !== record.spec.namespaceId) fail("Containment boot or namespace changed before attachment confirmation");
    const before = await bounded(nativeIdentity(receipt.process.pid, receipt.launchId), timeoutMs);
    if (!same(before, receipt.process) || unifiedMembership(await bounded(smallRead(`/proc/${receipt.process.pid}/cgroup`), timeoutMs)) !== record.spec.membershipPath || !(await bounded(readControl(pinned, "cgroup.procs"), timeoutMs)).trim().split(/\s+/).includes(String(receipt.process.pid)) || populated(await bounded(readControl(pinned, "cgroup.events"), timeoutMs)) !== 1 || !same(await bounded(nativeIdentity(receipt.process.pid, receipt.launchId), timeoutMs), receipt.process)) fail("Wrapper native identity and exact self-attached membership could not be confirmed");
    if (record.state !== "attached") await bounded(writePrivate(directory(receipt.launchId), "cgroup-binding.json", { ...record, state: "attached", receipt, receiptDigest: hash(receipt) }), timeoutMs);
    owned.set(receipt.launchId, hash(receipt));
  };
  const evidence = async (receipt: LaunchReceipt, record: Binding & { spec: CgroupWrapperSpec }, kind: "observed_tree_exit" | "verified_reboot", bootId?: string): Promise<StopEvidence> => {
    const value: StopEvidence = { kind, launchId: receipt.launchId, machineId: receipt.machineId, process: bootId ? { ...receipt.process, bootId } : receipt.process, observedAt: new Date().toISOString(), evidenceRef: join(directory(receipt.launchId), "cgroup-stop.json") };
    await bounded(writePrivate(directory(receipt.launchId), "cgroup-stop.json", { schemaVersion: 1, receiptDigest: hash(receipt), spec: record.spec, evidence: value }), timeoutMs); return value;
  };
  const observe = async (receipt: LaunchReceipt): Promise<StopEvidence | undefined> => {
    const record = await loadOwned(receipt); if (!record) return undefined;
    const bootId = await bounded(nativeBoot(), timeoutMs);
    if (bootId !== record.spec.bootId) return evidence(receipt, record, "verified_reboot", bootId);
    if (await bounded(readlink("/proc/self/ns/cgroup"), timeoutMs) !== record.spec.namespaceId) fail("Cgroup namespace changed; containment is not observable");
    const pinned = await localGroup(record.spec);
    if (populated(await bounded(readControl(pinned, "cgroup.events"), timeoutMs)) !== 0) return undefined;
    return evidence(receipt, record, "observed_tree_exit");
  };
  const adapter: QualifiedStopAdapter = { key: options.key, observe: receipt => observe(receipt), stop: async receipt => {
    const record = await loadOwned(receipt); if (!record) return undefined;
    const bootId = await bounded(nativeBoot(), timeoutMs);
    if (bootId !== record.spec.bootId) return evidence(receipt, record, "verified_reboot", bootId);
    const journal = await bounded(new LaunchJournalStore(options.metadataRoot).read(receipt.launchId), timeoutMs);
    if (journal?.state === "released") fail("Released containments cannot be targeted by stop");
    const current = unifiedMembership(await bounded(smallRead("/proc/self/cgroup"), timeoutMs));
    if (current === record.spec.membershipPath || current.startsWith(`${record.spec.membershipPath}/`)) fail("Supervisor is inside the target containment; refusing a parent/self kill");
    if (await bounded(readlink("/proc/self/ns/cgroup"), timeoutMs) !== record.spec.namespaceId) fail("Containment namespace changed before stop");
    const pinned = await localGroup(record.spec);
    await bounded(writeControl(pinned, "cgroup.kill", "1\n"), timeoutMs);
    const deadline = performance.now() + timeoutMs;
    do { const stopped = await observe(receipt); if (stopped) return stopped; await delay(pollMs); } while (performance.now() < deadline);
    return undefined;
  } };
  return { preflight, prepare, attach, adapter, close: async () => { for (const pinned of groups.values()) await pinned.directory.close(); groups.clear(); } };
}
