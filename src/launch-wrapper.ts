import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { canonicalJson } from "./canonical.js";
import { CoordError, type LaunchReceipt, type ProcessIdentity, type RunIdentity } from "./protocol.js";
import { enterWrapperCgroup, readLinuxBootId, readLinuxProcessIdentity, type CgroupLaunchReceipt, type CgroupWrapperSpec, type WrapperCgroupHandle } from "./containment.js";

const execute = promisify(execFile);
export interface WrapperSpec {
  schemaVersion: 1; launchId: string; machineId: string; identity: RunIdentity; workspace: string; receiptDirectory: string;
  executable: string; argv: string[]; environment: Record<string, string>; allowedEnvironmentKeys: string[]; authorizationTimeoutMs: number;
  watchdogMs: number; timeoutMs: number; stopGraceMs: number;
  containment?: CgroupWrapperSpec;
}
export interface WrapperOutcome {
  schemaVersion: 1; launchId: string; state: "never_started" | "spawn_attempted" | "running" | "root_exited" | "wrapper_error" | "stop_unconfirmed";
  observedAt: string; reason?: string; childPid?: number; exitCode?: number | null; signal?: string | null;
}
export const receiptDigest = (receipt: LaunchReceipt): string => createHash("sha256").update(canonicalJson(receipt)).digest("hex");
export async function readNativeBootId(): Promise<string> {
  try {
    if (process.platform === "linux") {
      return await readLinuxBootId();
    } else if (process.platform === "darwin") {
      const { stdout } = await execute("/usr/sbin/sysctl", ["-n", "kern.boottime"], { timeout: 2_000, maxBuffer: 4096, env: {} });
      const match = stdout.match(/sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/);
      if (match) return `darwin:${match[1]}:${match[2]}`;
    }
  } catch { /* Unsupported/denied is never replaced by an inferred boot time. */ }
  throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Native OS boot identity is unavailable or denied");
}
export async function nativeProcessIdentity(pid: number, launchId: string): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647 || !/^[A-Za-z0-9_-]{1,128}$/.test(launchId)) throw new CoordError("INVALID_INPUT", "Invalid process identity request");
  try {
    if (process.platform === "linux") {
      return await readLinuxProcessIdentity(pid, launchId);
    } else if (process.platform === "darwin") {
      const bootId = await readNativeBootId();
      const { stdout } = await execute("/bin/ps", ["-p", String(pid), "-o", "lstart=,pgid="], { timeout: 2_000, maxBuffer: 4096, env: {} });
      const value = stdout.trim();
      if (/^[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}\s+\d+$/.test(value)) return { pid, bootId, startIdentity: `darwin-lstart-pgid:${value.replace(/\s+/g, " ")}`, launchId };
    }
  } catch { /* Never infer identity from PID existence alone. */ }
  throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Native OS process start identity is unavailable or denied");
}

/** Only explicit approved values are copied. This is environment hygiene, not filesystem/credential-helper isolation. */
export function approvedWorkerEnvironment(values: Record<string, string>, allowed: string[]): Record<string, string> {
  if (allowed.length > 128 || new Set(allowed).size !== allowed.length) throw new CoordError("INVALID_INPUT", "Invalid explicit worker environment allowlist");
  const environment: Record<string, string> = Object.create(null) as Record<string, string>;
  let bytes = 0;
  for (const [name, value] of Object.entries(values)) {
    const upper = name.toUpperCase();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || !allowed.includes(name) || typeof value !== "string" || value.includes("\0") || value.length > 64 * 1024 || /^(?:NODE_OPTIONS|NODE_PATH|NODE_CHANNEL_.*|LD_.*|DYLD_.*)$/.test(upper) || /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PRIVATE_KEY|SUPERVISOR|APPROVER|VERIFIER|HUMAN_CREDENTIAL|ADMIN_TOKEN|DEPLOY_TOKEN)/.test(upper) || /^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE|AWS|AZURE|VERCEL|CONVEX|GH|GITHUB|GITLAB)_.*(?:TOKEN|KEY|SECRET|PASSWORD)/.test(upper) || /^COORD_(?:AGENT|PROJECT|HUMAN|ADMIN|DEPLOY)_/.test(upper) || (upper.startsWith("GIT_") && upper !== "GIT_TERMINAL_PROMPT")) throw new CoordError("FORBIDDEN", "Worker environment contains an unapproved key, credential or loader override; values withheld");
    if (upper === "HOME" && !isAbsolute(value)) throw new CoordError("INVALID_INPUT", "Approved worker HOME must be absolute");
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes > 256 * 1024) throw new CoordError("INVALID_INPUT", "Approved worker environment exceeds the supported bound");
    environment[name] = value;
  }
  return environment;
}
async function privateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!isAbsolute(directory) || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || await realpath(directory) !== resolve(directory)) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Wrapper evidence directory must be canonical and private");
}
export async function writeWrapperEvidence(directory: string, name: "wrapper-receipt.json" | "wrapper-outcome.json", value: LaunchReceipt | WrapperOutcome, initial = false): Promise<void> {
  await privateDirectory(directory);
  const final = join(directory, name), temporary = initial ? final : join(directory, `${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); } finally { await file.close(); }
    if (!initial) await rename(temporary, final);
    const parent = await open(directory, "r"); try { await parent.sync(); } finally { await parent.close(); }
  } finally { if (!initial) await rm(temporary, { force: true }); }
}
export async function readWrapperEvidence<T extends LaunchReceipt | WrapperOutcome>(directory: string, name: "wrapper-receipt.json" | "wrapper-outcome.json"): Promise<T | undefined> {
  await privateDirectory(directory);
  let file;
  try { file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new CoordError("LAUNCH_UNCERTAIN", "Wrapper evidence cannot be read safely"); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024 || (info.mode & 0o077)) throw new CoordError("LAUNCH_UNCERTAIN", "Wrapper evidence permissions or size are invalid");
    const buffer = Buffer.alloc(Number(info.size) + 1); let read = 0;
    while (read < buffer.length) { const next = await file.read(buffer, read, buffer.length - read, read); if (!next.bytesRead) break; read += next.bytesRead; }
    if (read !== info.size) throw new CoordError("LAUNCH_UNCERTAIN", "Wrapper evidence changed during read");
    try { return JSON.parse(buffer.subarray(0, read).toString("utf8")) as T; } catch { throw new CoordError("LAUNCH_UNCERTAIN", "Wrapper evidence is not valid JSON"); }
  } finally { await file.close(); }
}
async function validateSpec(spec: WrapperSpec): Promise<void> {
  if (spec.schemaVersion !== 1 || ![spec.launchId, spec.machineId, spec.identity?.runId, spec.identity?.taskId].every(value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)) || !Number.isSafeInteger(spec.identity.epoch) || spec.identity.epoch < 1 || !Number.isSafeInteger(spec.identity.goalRevision) || spec.identity.goalRevision < 1 || !isAbsolute(spec.executable) || await realpath(spec.executable) !== spec.executable || !Array.isArray(spec.argv) || spec.argv.length > 100 || spec.argv.some(arg => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 128 * 1024) || !Number.isSafeInteger(spec.authorizationTimeoutMs) || spec.authorizationTimeoutMs < 100 || spec.authorizationTimeoutMs > 60_000) throw new CoordError("INVALID_INPUT", "Wrapper launch specification is invalid");
  if (await realpath(spec.workspace) !== spec.workspace) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Wrapper workspace must be canonical");
  if (![spec.watchdogMs, spec.timeoutMs, spec.stopGraceMs].every(value => Number.isSafeInteger(value) && value >= 20) || spec.watchdogMs > 300_000 || spec.timeoutMs > 86_400_000 || spec.stopGraceMs > 60_000) throw new CoordError("INVALID_INPUT", "Invalid independent wrapper watchdog policy");
  await privateDirectory(spec.receiptDirectory); approvedWorkerEnvironment(spec.environment, spec.allowedEnvironmentKeys);
}

/** Actual child entry point: no backend/supervisor credential is present in its IPC specification or inherited environment. */
export async function runLaunchWrapper(): Promise<void> {
  let spec: WrapperSpec | undefined, receipt: CgroupLaunchReceipt | undefined, child: ChildProcess | undefined;
  let cgroup: WrapperCgroupHandle | undefined;
  let aborted = false, spawnAttempted = false, spawnRejected = false;
  let release: ((message: unknown) => void) | undefined;
  let lastConfirmed = 0, releasedAt = 0, rootExited = false, stopping = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let escalationCompletion: Promise<void> | undefined;
  let requestStop: ((reason: string) => Promise<void>) | undefined;
  const started = new Promise<WrapperSpec>(resolveSpec => {
    process.on("message", message => {
      const value = message as { type?: string; spec?: WrapperSpec };
      if (value?.type === "start" && !spec && value.spec) { spec = value.spec; resolveSpec(spec); }
      else if (value?.type === "authorize") release?.(message);
      else if (value?.type === "renew") {
        const renewal = message as { launchId?: string; receiptDigest?: string; leaseUntil?: number };
        if (receipt && renewal.launchId === receipt.launchId && renewal.receiptDigest === receiptDigest(receipt) && Number.isFinite(renewal.leaseUntil) && renewal.leaseUntil! > Date.now() && !stopping) lastConfirmed = performance.now();
      }
      else if (value?.type === "abort") { aborted = true; release?.(message); void requestStop?.("supervisor_abort"); }
    });
    process.on("disconnect", () => { aborted = true; release?.({ type: "abort" }); if (!rootExited) void requestStop?.("supervisor_ipc_lost"); });
  });
  const send = (value: unknown) => { if (process.connected) { try { process.send?.(value, () => {}); } catch { aborted = true; } } };
  const outcome = async (state: WrapperOutcome["state"], fields: Partial<WrapperOutcome> = {}) => {
    const value: WrapperOutcome = { schemaVersion: 1, launchId: spec!.launchId, state, observedAt: new Date().toISOString(), ...fields };
    await writeWrapperEvidence(spec!.receiptDirectory, "wrapper-outcome.json", value); send({ type: "outcome", outcome: value });
  };
  requestStop = async reason => {
    if (stopping || !child) return;
    stopping = true;
    try { child.kill("SIGTERM"); } catch { /* no proof */ }
    escalationCompletion = new Promise<void>(resolveEscalation => { setTimeout(() => {
        // Evidence I/O may stall: it must never postpone containment signalling.
        void outcome("stop_unconfirmed", { reason: `${reason}_escalated`, childPid: child?.pid }).catch(() => {});
        if (cgroup) { try { cgroup.kill(); } catch { /* failed kernel stop remains unconfirmed; attempt the owned group below */ } }
        const group = receipt?.process.startIdentity.match(/(?:pgid:|\s)(\d+)$/)?.[1];
        // Best-effort stop only. Group absence is NEVER returned as positive descendant-tree evidence.
        if (process.platform !== "win32" && group === String(process.pid)) { try { process.kill(-process.pid, "SIGKILL"); } catch { /* failed stop remains held */ } }
        else { try { child?.kill("SIGKILL"); } catch { /* failed stop remains held */ } }
        resolveEscalation();
    }, spec!.stopGraceMs); });
    try { await outcome("stop_unconfirmed", { reason, childPid: child.pid }); } catch { /* failed evidence never implies exit */ }
  };
  try {
    spec = await started;
    await validateSpec(spec);
    const identity = await nativeProcessIdentity(process.pid, spec.launchId);
    if (spec.containment) cgroup = await enterWrapperCgroup(spec.containment, identity);
    receipt = { schemaVersion: 1, identity: spec.identity, launchId: spec.launchId, machineId: spec.machineId, workspace: spec.workspace, process: identity, recordedAt: new Date().toISOString(), ...(spec.containment ? { containment: spec.containment } : {}) };
    await writeWrapperEvidence(spec.receiptDirectory, "wrapper-receipt.json", receipt, true);
    const authorized = new Promise<boolean>(resolveAuthorization => {
      const timer = setTimeout(() => resolveAuthorization(false), spec!.authorizationTimeoutMs);
      release = message => {
        const value = message as { type?: string; launchId?: string; receiptDigest?: string; leaseUntil?: number };
        clearTimeout(timer);
        resolveAuthorization(!aborted && value?.type === "authorize" && value.launchId === spec!.launchId && value.receiptDigest === receiptDigest(receipt!) && Number.isFinite(value.leaseUntil) && value.leaseUntil! > Date.now());
      };
      if (aborted || !process.connected) { clearTimeout(timer); resolveAuthorization(false); }
    });
    send({ type: "receipt", receipt });
    if (!await authorized || aborted) { await outcome("never_started", { reason: "authorization_not_released" }); return; }
    releasedAt = performance.now(); lastConfirmed = releasedAt;
    watchdog = setInterval(() => {
      if (rootExited || stopping) return;
      const now = performance.now();
      if (now - releasedAt >= spec!.timeoutMs) void requestStop?.("wrapper_run_timeout");
      else if (now - lastConfirmed >= spec!.watchdogMs) void requestStop?.("wrapper_renewal_unconfirmed");
    }, Math.max(5, Math.min(1_000, spec.watchdogMs / 4, spec.timeoutMs / 4)));
    await outcome("spawn_attempted"); spawnAttempted = true;
    if (aborted) { await outcome("never_started", { reason: "aborted_before_spawn" }); return; }
    child = spawn(spec.executable, spec.argv, { cwd: spec.workspace, env: approvedWorkerEnvironment(spec.environment, spec.allowedEnvironmentKeys), stdio: "ignore", detached: false, windowsHide: true });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => child!.once("exit", (code, signal) => resolveExit({ code, signal })));
    const created = await new Promise<boolean>(resolveCreated => { child!.once("spawn", () => resolveCreated(true)); child!.once("error", () => resolveCreated(false)); });
    if (!created) { spawnRejected = true; await outcome("never_started", { reason: "os_rejected_spawn" }); return; }
    await outcome("running", { childPid: child.pid });
    if (aborted) { try { child.kill("SIGTERM"); } catch { /* no tree-exit inference */ } }
    const ended = await exit;
    rootExited = true;
    // Schedule signalling before any root-exit evidence I/O can stall; root exit alone is not tree exit.
    const cleanup = requestStop("root_exited_tree_stop");
    await outcome("root_exited", { childPid: child.pid, exitCode: ended.code, signal: ended.signal });
    await cleanup;
    await escalationCompletion;
  } catch {
    // Stop scheduling cannot depend on either success or failure of evidence writes.
    if (child && !spawnRejected) void requestStop("wrapper_error_tree_stop");
    if (spec) { try { await outcome(spawnAttempted ? "wrapper_error" : "never_started", { reason: receipt ? "wrapper_failed_after_receipt" : "native_identity_or_spec_unavailable" }); } catch { /* missing evidence stays uncertain */ } }
  } finally {
    if (child && !spawnRejected) { void requestStop("wrapper_finally_tree_stop"); await escalationCompletion; }
    if (watchdog) clearInterval(watchdog);
    if (cgroup) await cgroup.close();
    if (process.connected) process.disconnect();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runLaunchWrapper();
