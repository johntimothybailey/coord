import { constants } from "node:fs";
import { open, realpath, rename, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { arch, platform, release } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { captureDigest } from "./checkpoint.js";
import { checkStoreDirectory, readSmallFile, writeNewPrivateFile } from "./credentials.js";
import { BackendClient } from "./client.js";
import { CLIENT_VERSION, CoordError, PROBE_VERSION, requireCapability, requireHandshake } from "./protocol.js";
import { codexAdapter } from "./adapters/codex.js";
import { antigravityAdapter } from "./adapters/antigravity.js";
import type { CapabilityEvidence, CapabilityKey, ExecutionMode, VersionHandshake } from "./protocol.js";
import type { WorkspaceConfig } from "./config.js";
import { checkEnvironment, inspectSetup, requireEnvironment } from "./environment.js";
import { approvedWorkerEnvironment } from "./launch-wrapper.js";

const text = z.string().min(1).max(8192).refine(value => !value.includes("\0"));
const absolute = text.refine(isAbsolute);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const key = z.object({ os: text, harness: z.enum(["codex", "antigravity"]), harnessVersion: text, adapterVersion: text, probeVersion: text, configurationDigest: text, gitPolicyDigest: text }).strict();
const check = z.object({ schemaVersion: z.literal(1), checkId: text, status: z.enum(["PASS", "FAIL", "BLOCKED"]), mode: z.enum(["advisory", "manual", "managed"]), observedAt: text, configurationDigest: text, command: z.array(text), summary: text, evidenceRef: text.optional(), kind: z.enum(["real", "fixture"]) }).strict();
const command = z.array(text).min(1).max(100);
const schema = z.object({
  schemaVersion: z.literal(1), workspaceRoot: absolute, stateDirectory: absolute, worktreeRoot: absolute, machineId: id, memberId: id,
  trustedRegistryPath: absolute, agentCredentialDirectory: absolute,
  harness: z.object({ kind: z.enum(["codex", "antigravity"]), executable: absolute }).strict(),
  capability: z.object({ key, checks: z.array(check).max(100) }).strict(),
  verifierCredentialFile: absolute, supervisorCredentialFile: absolute.optional(),
  gitTransport: z.object({ kind: z.literal("github-https"), executable: absolute, home: absolute, searchPath: text, url: text }).strict(),
  containment: z.object({ kind: z.literal("linux-cgroup-v2"), root: absolute }).strict().optional(),
  policy: z.object({
    capture: z.object({ allowedUntracked: z.array(text).max(1000), exclusions: z.array(z.object({ path: text, reason: text }).strict()).max(1000), requiredPaths: z.array(text).max(1000), forbiddenContent: z.array(text).max(100).optional(), maxFileBytes: z.number().int().positive().max(64 * 1024 * 1024).optional() }).strict(),
    environment: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), modes: z.array(z.enum(["advisory", "manual", "managed"])), type: z.enum(["string", "url", "integer", "boolean"]).optional() }).strict()).max(128),
    copyEnvironment: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(100),
    workerHome: absolute, githubHome: absolute, searchPath: text,
    setupCommands: z.array(command).max(20), verificationCommands: z.array(command).min(1).max(50),
    verification: z.object({ kind: z.enum(["linux-bubblewrap", "macos-sandbox-exec"]), executable: absolute, readOnlyRoots: z.array(absolute).min(1).max(20), searchPath: text.optional() }).strict(),
  }).strict(),
}).strict();
export type RuntimeConfig = z.infer<typeof schema>;
export function parseRuntime(value: unknown): RuntimeConfig {
  const result = schema.safeParse(value);
  if (!result.success) throw new CoordError("INVALID_INPUT", "Invalid protected runtime configuration; values withheld");
  if (result.data.harness.kind !== result.data.capability.key.harness) throw new CoordError("INVALID_INPUT", "Runtime harness differs from capability key");
  if (result.data.gitTransport.home !== result.data.policy.githubHome) throw new CoordError("INVALID_INPUT", "Git/GitHub provider HOME differs from selected protected account");
  const names = result.data.policy.copyEnvironment, declared = result.data.policy.environment.map(item => item.name);
  if (new Set(names).size !== names.length || names.some(name => /^(HOME|PATH|COORD_.*|NODE_.*|LD_.*|DYLD_.*|GIT_.*)$/i.test(name) || !declared.includes(name))) throw new CoordError("INVALID_INPUT", "Copied environment must contain distinct declared application prerequisites, without runtime control overrides");
  return result.data;
}
/** Policy and source references only. Never digest credential values or copied application environment contents. */
export function runtimeDigest(config: RuntimeConfig): string {
  const { capability: _capability, ...references } = config;
  return captureDigest({ clientVersion: CLIENT_VERSION, coordinatorNodeVersion: process.version, coordinatorExecutable: process.execPath, runtimeActionsVersion: 1, gitTransportVersion: 1, containmentVersion: 1, verificationVersion: 1, configuration: references });
}
export function requireRuntime(config: RuntimeConfig, mode: ExecutionMode): void {
  const expected: CapabilityKey = { ...config.capability.key, configurationDigest: runtimeDigest(config) };
  requireCapability(config.capability as CapabilityEvidence, expected, mode);
}
export async function verifyRuntime(config: RuntimeConfig, mode: ExecutionMode): Promise<CapabilityKey> {
  requireRuntime(config, mode);
  for (const home of [config.policy.workerHome, config.policy.githubHome]) if (await realpath(home).catch(() => "") !== home) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Selected worker/provider HOME must be a canonical existing directory");
  const adapter = config.harness.kind === "codex" ? codexAdapter : antigravityAdapter;
  if (config.capability.key.os !== `${platform()}/${release()}/${arch()}` || config.capability.key.adapterVersion !== adapter.version || config.capability.key.probeVersion !== PROBE_VERSION || await realpath(config.harness.executable) !== config.harness.executable) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Actual OS, executable or adapter/probe differs from qualified configuration");
  const observed = await new Promise<string>((resolveVersion, reject) => {
    const child = spawn(config.harness.executable, adapter.versionArgs, { env: { HOME: config.policy.workerHome, PATH: config.policy.searchPath }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = "", bytes = 0, stopped = false;
    const stop = (): void => { stopped = true; try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {} child.stdout.destroy(); child.stderr.destroy(); child.unref(); reject(new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Bounded harness version probe unavailable; output withheld")); };
    const timer = setTimeout(stop, 3000);
    const collect = (chunk: Buffer): void => { bytes += chunk.length; if (bytes > 16384) stop(); else output += chunk.toString("utf8"); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.once("error", () => { clearTimeout(timer); stop(); });
    child.once("close", code => { clearTimeout(timer); const version = output.match(/(?:^|\n)(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._-]+)?)(?:\s|$)/)?.[1]; if (!stopped && code === 0 && version) resolveVersion(version); else if (!stopped) stop(); });
  });
  if (observed !== config.capability.key.harnessVersion) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Installed harness version changed; qualification must be renewed");
  return { ...config.capability.key };
}
export async function readRuntime(path: string): Promise<RuntimeConfig> {
  try { return parseRuntime(JSON.parse(await readSmallFile(path, true))); }
  catch (error) {
    if (error instanceof CoordError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CoordError("BLOCKED_ENV", "Protected runtime configuration is not installed; an operator must select and qualify the runtime");
    throw new CoordError("BLOCKED_ENV", "Protected runtime configuration could not be read; values withheld");
  }
}
export function executionEnvironment(config: RuntimeConfig): Record<string, string> {
  const values: Record<string, string> = { HOME: config.policy.workerHome, PATH: config.policy.searchPath };
  for (const name of config.policy.copyEnvironment) if (process.env[name] !== undefined) values[name] = process.env[name]!;
  // Run grants are installed as scoped private session files, never inherited ambient credentials.
  return approvedWorkerEnvironment(values, Object.keys(values));
}
export async function effectivePreflight(config: RuntimeConfig, repo: string, mode: ExecutionMode) {
  const environment = executionEnvironment(config);
  const report = await checkEnvironment(config.policy.environment, mode, { processEnv: environment });
  requireEnvironment(report);
  const setup = await inspectSetup(repo, config.policy.setupCommands);
  if (config.policy.setupCommands.length) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Dependency setup requires an independently qualified isolated setup adapter; no privileged install scripts are executed");
  return { report, setup, environment, digest: captureDigest({ environment: report.configurationDigest, setup, policy: runtimeDigest(config) }) };
}
export async function roleClient(config: WorkspaceConfig, runtime: RuntimeConfig, role: "artifact_verifier" | "supervisor"): Promise<BackendClient> {
  const path = role === "artifact_verifier" ? runtime.verifierCredentialFile : runtime.supervisorCredentialFile;
  if (!path) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Separate supervisor credential is not configured");
  const credential = JSON.parse(await readSmallFile(path, true)) as Record<string, unknown>;
  if (credential.schemaVersion !== 1 || credential.backendId !== config.backendId || credential.backendUrl !== config.backendUrl || credential.role !== role || credential.machineId !== runtime.machineId || credential.memberId !== runtime.memberId || !Array.isArray(credential.projectIds) || !credential.projectIds.includes(config.projectId) || !Number.isSafeInteger(credential.expiresAt) || (credential.expiresAt as number) <= Date.now() || typeof credential.token !== "string" || !/^[a-f0-9]{64}$/.test(credential.token)) throw new CoordError("UNAUTHORIZED", "Runtime credential does not match selected role/backend/project/machine/member");
  const client = new BackendClient(config, credential.token);
  requireHandshake(await client.query("auth:handshake") as VersionHandshake);
  return client;
}

const MAX_STATE_BYTES = 1024 * 1024;
/** Durable request/artifact journal. State contains run-bound operation data, never approver/provider secrets. */
export class CommandStore {
  constructor(readonly directory: string) {}
  path(kind: string, operationId: string): string {
    if (!/^[a-z][a-z-]{0,31}$/.test(kind) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(operationId)) throw new CoordError("INVALID_INPUT", "Invalid command operation identity");
    return join(this.directory, `${kind}-${operationId}.json`);
  }
  async read<T>(kind: string, operationId: string): Promise<T | undefined> {
    const path = this.path(kind, operationId);
    await checkStoreDirectory(this.directory, true);
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_STATE_BYTES || (stat.mode & 0o077)) throw new CoordError("UNAUTHORIZED", "Invalid private command journal");
      const data = Buffer.alloc(MAX_STATE_BYTES + 1); let length = 0;
      for (;;) { const { bytesRead } = await file.read(data, length, data.length - length); if (!bytesRead) break; length += bytesRead; if (length > MAX_STATE_BYTES) throw new CoordError("INVALID_INPUT", "Command journal exceeds supported bound"); }
      const value = JSON.parse(data.subarray(0, length).toString("utf8")) as T;
      await file.sync();
      for (let dir = dirname(path);;) { const handle = await open(dir, "r"); try { await handle.sync(); } finally { await handle.close(); } const parent = dirname(dir); if (parent === dir) break; dir = parent; }
      return value;
    } finally { await file.close(); }
  }
  async write(kind: string, operationId: string, value: unknown, initial = false): Promise<void> {
    const contents = JSON.stringify(value);
    if (Buffer.byteLength(contents) > MAX_STATE_BYTES) throw new CoordError("INVALID_INPUT", "Command journal exceeds supported bound");
    const final = this.path(kind, operationId), temporary = initial ? final : `${final}.${randomUUID()}.tmp`;
    await checkStoreDirectory(this.directory, true);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    if (!initial) await rename(temporary, final);
    const directory = await open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); }
  }
  async lock<T>(kind: string, operationId: string, action: () => Promise<T>): Promise<T> {
    await checkStoreDirectory(this.directory, true);
    const path = `${this.path(kind, operationId)}.lock`;
    const file = await open(path, "wx", 0o600).catch(() => { throw new CoordError("LAUNCH_UNCERTAIN", "Existing command lock requires explicit inspection; no automatic stale-lock recovery"); });
    try { return await action(); } finally { await file.close(); await unlink(path); }
  }
}
export async function writeRoutingCopy(path: string, config: WorkspaceConfig): Promise<void> {
  const contents = JSON.stringify(config, null, 2) + "\n";
  try { await writeNewPrivateFile(path, contents, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (await readSmallFile(path) !== contents) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Resumed routing configuration differs from protected association"); }
}
