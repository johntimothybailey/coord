import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { BackendClient } from "./client.js";
import { canonicalJson } from "./canonical.js";
import { canonicalRemote, credentialKey, parseConfig } from "./config.js";
import type { WorkspaceConfig } from "./config.js";
import { checkStoreDirectory, decryptVault, encryptVault, generateToken, MAX_LOCAL_FILE_BYTES, readSmallFile, syncLocalFile, writeNewPrivateFile } from "./credentials.js";
import type { VaultBinding } from "./credentials.js";
import { CLIENT_VERSION, CoordError, requireHandshake } from "./protocol.js";
import type { VersionHandshake } from "./protocol.js";

export interface SetupPlan {
  schemaVersion: 1; deploymentName: string; workspaceRoot: string; config: WorkspaceConfig;
  humanId: string; agentId: string; credentialExpiresAt: number;
  policy: { allowedPaths: string[]; excludedPaths: string[]; sharingApproved: boolean; capacity: number; taskCap: number; capturePolicyDigest?: string; };
}
interface Bundle { schemaVersion: 1; planDigest: string; humanToken: string; agentToken: string; configureRequestId: string; vaultDigest?: string; }
interface ProjectView extends WorkspaceConfig { allowedPaths: string[]; excludedPaths: string[]; sharingApproved: boolean; capacity: number; taskCap: number; capturePolicyDigest?: string; }
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const planDigest = (plan: SetupPlan): string => digest(canonicalJson(plan));
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
function invalid(): never { throw new CoordError("INVALID_INPUT", "Invalid onboarding plan or credential bundle"); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: string[]): void { if (Object.keys(value).some(key => !keys.includes(key))) invalid(); }
function paths(value: unknown, required = false): value is string[] {
  return Array.isArray(value) && value.length <= 500 && (!required || value.length > 0) && new Set(value).size === value.length && value.every(p => typeof p === "string" && p.length > 0 && p.length <= 8192 && !/[\\\x00-\x1f\x7f]/u.test(p) && !p.startsWith("/") && !p.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git"));
}
export function parseSetupPlan(value: unknown): SetupPlan {
  const plan = record(value), policy = record(plan.policy), config = record(plan.config);
  exactKeys(plan, ["schemaVersion", "deploymentName", "workspaceRoot", "config", "humanId", "agentId", "credentialExpiresAt", "policy"]);
  exactKeys(config, ["schemaVersion", "backendId", "backendUrl", "projectId", "repository", "remote", "defaultBranch", "ruleTargets"]);
  exactKeys(policy, ["allowedPaths", "excludedPaths", "sharingApproved", "capacity", "taskCap", "capturePolicyDigest"]);
  const parsed = parseConfig(config);
  if (plan.schemaVersion !== 1 || typeof plan.deploymentName !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plan.deploymentName) || parsed.backendUrl !== `https://${plan.deploymentName}.convex.cloud` || typeof plan.workspaceRoot !== "string" || !isAbsolute(plan.workspaceRoot) || /[\x00-\x1f\x7f]/u.test(plan.workspaceRoot)) invalid();
  if (![parsed.backendId, parsed.projectId, plan.humanId, plan.agentId].every(id => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) || plan.humanId === plan.agentId) invalid();
  if (!Number.isSafeInteger(plan.credentialExpiresAt) || !paths(policy.allowedPaths, true) || !paths(policy.excludedPaths) || !paths(parsed.ruleTargets) || typeof policy.sharingApproved !== "boolean" || !Number.isSafeInteger(policy.capacity) || (policy.capacity as number) < 1 || (policy.capacity as number) > 100 || !Number.isSafeInteger(policy.taskCap) || (policy.taskCap as number) < 1 || (policy.taskCap as number) > 100 || (policy.capturePolicyDigest !== undefined && (typeof policy.capturePolicyDigest !== "string" || !/^[a-f0-9]{64}$/.test(policy.capturePolicyDigest)))) invalid();
  if (parsed.defaultBranch.length > 256 || /[\x00-\x20\x7f]/u.test(parsed.defaultBranch) || parsed.defaultBranch.startsWith("-")) invalid();
  return { ...plan, config: parsed } as unknown as SetupPlan;
}
export async function inspectPlan(plan: SetupPlan): Promise<{ root: string; commonGitDir: string }> {
  const root = await realpath(plan.workspaceRoot);
  if (root !== plan.workspaceRoot || root !== await realpath(git(root, "rev-parse", "--show-toplevel")) || canonicalRemote(git(root, "remote", "get-url", "origin")) !== plan.config.repository) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Plan does not match the canonical repository root and origin");
  git(root, "check-ref-format", "--branch", plan.config.defaultBranch);
  return { root, commonGitDir: await realpath(resolve(root, git(root, "rev-parse", "--git-common-dir"))) };
}
const binding = (plan: SetupPlan): VaultBinding => ({ backendId: plan.config.backendId, backendUrl: plan.config.backendUrl, projectId: plan.config.projectId, humanId: plan.humanId });
const snapshotPlan = (plan: SetupPlan): SetupPlan => parseSetupPlan(JSON.parse(canonicalJson(plan)));
function validateBundle(plan: SetupPlan, value: unknown): Bundle {
  const bundle = record(value);
  if (bundle.schemaVersion !== 1 || bundle.planDigest !== planDigest(plan) || typeof bundle.configureRequestId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(bundle.configureRequestId) || ![bundle.humanToken, bundle.agentToken].every(token => typeof token === "string" && /^[a-f0-9]{64}$/.test(token)) || bundle.humanToken === bundle.agentToken) invalid();
  return { ...bundle } as unknown as Bundle;
}
export async function unlockBundle(plan: SetupPlan, vaultPath: string, passphrase: string): Promise<Bundle> {
  plan = snapshotPlan(plan);
  const encoded = await readSmallFile(vaultPath, true);
  return { ...validateBundle(plan, await decryptVault(encoded, passphrase, binding(plan))), vaultDigest: digest(encoded) };
}
export async function createBundle(plan: SetupPlan, vaultPath: string, passphrase: string): Promise<Bundle> {
  plan = snapshotPlan(plan);
  if (plan.credentialExpiresAt <= Date.now() || plan.credentialExpiresAt > Date.now() + 365 * 86400_000) invalid();
  const bundle: Bundle = { schemaVersion: 1, planDigest: planDigest(plan), humanToken: generateToken(), agentToken: generateToken(), configureRequestId: randomUUID() };
  const encoded = await encryptVault(bundle, passphrase, binding(plan));
  await writeNewPrivateFile(vaultPath, encoded);
  return { ...bundle, vaultDigest: digest(encoded) };
}
export function bootstrapArguments(plan: SetupPlan, bundle: Bundle): Record<string, unknown> {
  plan = snapshotPlan(plan); bundle = validateBundle(plan, bundle);
  return { backendId: plan.config.backendId, projectId: plan.config.projectId, repository: plan.config.repository, remote: plan.config.remote, defaultBranch: plan.config.defaultBranch, allowedPaths: plan.policy.allowedPaths, excludedPaths: plan.policy.excludedPaths, ruleTargets: plan.config.ruleTargets, humanId: plan.humanId, agentId: plan.agentId, humanDigest: digest(bundle.humanToken), agentDigest: digest(bundle.agentToken), expiresAt: plan.credentialExpiresAt };
}
export async function runOwnerBootstrap(plan: SetupPlan, bundle: Bundle, vaultPath: string): Promise<void> {
  plan = snapshotPlan(plan); bundle = validateBundle(plan, bundle);
  if (typeof bundle.vaultDigest !== "string" || !/^[a-f0-9]{64}$/.test(bundle.vaultDigest)) invalid();
  // Re-establish durability even when a previous process left readable bytes before fsync.
  await syncLocalFile(vaultPath, bundle.vaultDigest);
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    // Only digests reach argv. Official CLI alone resolves owner authentication; never read its credential files.
    execFileSync(process.execPath, [join(sourceRoot, "node_modules/convex/bin/main.js"), "run", "auth:bootstrap", JSON.stringify(bootstrapArguments(plan, bundle)), "--deployment", plan.deploymentName], { cwd: sourceRoot, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 128 * 1024 });
  } catch { throw new CoordError("NEEDS_HUMAN", "Owner bootstrap unconfirmed; preserve vault and inspect selected deployment in your external operator terminal. Do not generate replacement credentials"); }
}
async function exactFile(path: string, contents: string, privateStore = true): Promise<void> {
  try { await writeNewPrivateFile(path, contents, privateStore); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = await lstat(path);
    if (!stat.isFile() || await readSmallFile(path, privateStore) !== contents) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Existing local setup differs; refusing to overwrite");
    await syncLocalFile(path, digest(contents), privateStore);
  }
}
async function checkExistingFile(path: string, contents: string, privateStore: boolean): Promise<void> {
  try {
    if (!(await lstat(path)).isFile() || await readSmallFile(path, privateStore) !== contents) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Existing local setup differs; refusing to overwrite");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
const agentContents = (plan: SetupPlan, bundle: Bundle): string => JSON.stringify({ schemaVersion: 1, backendId: plan.config.backendId, backendUrl: plan.config.backendUrl, role: "agent", memberId: plan.agentId, projectIds: [plan.config.projectId], expiresAt: plan.credentialExpiresAt, token: bundle.agentToken }) + "\n";
async function preflightLocal(plan: SetupPlan, bundle: Bundle, receipt: string, directory: string): Promise<void> {
  const { root, commonGitDir } = await inspectPlan(plan);
  await checkExistingFile(join(root, ".coord.json"), JSON.stringify(plan.config, null, 2) + "\n", false);
  await checkStoreDirectory(directory, true);
  await checkStoreDirectory(join(directory, "credentials"), true);
  await checkExistingFile(join(directory, "credentials", `${credentialKey(plan.config.backendId, plan.config.backendUrl)}.json`), agentContents(plan, bundle), true);
  try {
    const path = join(directory, "workspaces.json");
    if (!(await lstat(path)).isFile()) invalid();
    const registry = record(JSON.parse(await readSmallFile(path, true)));
    if (registry.schemaVersion !== 1 || !Array.isArray(registry.workspaces)) invalid();
    const trust = { ...plan.config, root, commonGitDir, approvalReceipt: receipt };
    for (const value of registry.workspaces) {
      const item = record(value);
      if ((item.root === root || item.commonGitDir === commonGitDir) && canonicalJson(value) !== canonicalJson(trust)) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Existing routing differs; use a separately reviewed migration");
    }
    const exists = registry.workspaces.some(value => canonicalJson(value) === canonicalJson(trust));
    const projected = { ...registry, workspaces: exists ? registry.workspaces : [...registry.workspaces, trust] };
    if (Buffer.byteLength(JSON.stringify(projected, null, 2) + "\n") > MAX_LOCAL_FILE_BYTES) throw new CoordError("INVALID_INPUT", "Trusted workspace registry exceeds local limit");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function persistRouting(plan: SetupPlan, receipt: string, directory: string): Promise<void> {
  const { root, commonGitDir } = await inspectPlan(plan);
  await exactFile(join(root, ".coord.json"), JSON.stringify(plan.config, null, 2) + "\n", false);
  await checkStoreDirectory(directory, true);
  const registryPath = join(directory, "workspaces.json"), lockPath = join(directory, "workspaces.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const temporary = join(directory, `workspaces-${randomUUID()}.tmp`);
  try {
    let registry: { schemaVersion: 1; workspaces: unknown[] } = { schemaVersion: 1, workspaces: [] };
    try {
      if (!(await lstat(registryPath)).isFile()) invalid();
      const loaded = record(JSON.parse(await readSmallFile(registryPath, true)));
      if (loaded.schemaVersion !== 1 || !Array.isArray(loaded.workspaces)) invalid();
      registry = loaded as unknown as typeof registry;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const trust = { ...plan.config, root, commonGitDir, approvalReceipt: receipt };
    const existing = registry.workspaces.filter(value => { const item = record(value); return item.root === root || item.commonGitDir === commonGitDir; });
    if (existing.some(value => canonicalJson(value) !== canonicalJson(trust))) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Existing routing differs; use a separately reviewed migration");
    if (!existing.length) registry.workspaces.push(trust);
    await writeNewPrivateFile(temporary, JSON.stringify(registry, null, 2) + "\n");
    await rename(temporary, registryPath);
    const dir = await open(directory, "r"); try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(temporary).catch(() => {}); await lock.close(); await unlink(lockPath); }
}
function verifyProject(plan: SetupPlan, value: unknown, requirePolicy: boolean): void {
  const status = record(value), project = record(status.project) as unknown as ProjectView & { id: string };
  if (project.id !== plan.config.projectId || project.backendId !== plan.config.backendId || project.repository !== plan.config.repository || project.remote !== plan.config.remote || project.defaultBranch !== plan.config.defaultBranch) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Backend project identity differs from protected plan");
  if (requirePolicy) {
    const actual = { allowedPaths: project.allowedPaths, excludedPaths: project.excludedPaths, sharingApproved: project.sharingApproved, capacity: project.capacity, taskCap: project.taskCap, ...(project.capturePolicyDigest ? { capturePolicyDigest: project.capturePolicyDigest } : {}) };
    if (canonicalJson(actual) !== canonicalJson(plan.policy) || canonicalJson(project.ruleTargets) !== canonicalJson(plan.config.ruleTargets)) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Backend project permissions differ from protected plan");
  }
}
export async function configureAndConnect(plan: SetupPlan, bundle: Bundle, directory = join(homedir(), ".config/coord")): Promise<void> {
  plan = snapshotPlan(plan); bundle = validateBundle(plan, bundle);
  await inspectPlan(plan);
  const receipt = `projects.configure:${bundle.configureRequestId}:${planDigest(plan)}`;
  await preflightLocal(plan, bundle, receipt, directory);
  const human = new BackendClient(plan.config, bundle.humanToken);
  requireHandshake(await human.query("auth:handshake") as VersionHandshake);
  verifyProject(plan, await human.query("projects:status"), false);
  await human.mutation("projects:configure", { repository: plan.config.repository, remote: plan.config.remote, defaultBranch: plan.config.defaultBranch, ruleTargets: plan.config.ruleTargets, ...plan.policy }, bundle.configureRequestId);
  verifyProject(plan, await human.query("projects:status"), true);
  const agent = new BackendClient(plan.config, bundle.agentToken);
  requireHandshake(await agent.query("auth:handshake") as VersionHandshake);
  verifyProject(plan, await agent.query("projects:status"), true);
  await persistRouting(plan, receipt, directory);
  await exactFile(join(directory, "credentials", `${credentialKey(plan.config.backendId, plan.config.backendUrl)}.json`), agentContents(plan, bundle));
}

export async function readProtectedLine(input: typeof process.stdin, write: (text: string) => void, hidden: boolean): Promise<string> {
  const wasRaw = input.isRaw, decoder = new StringDecoder("utf8");
  input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let result = "", finished = false;
    const cancelled = (): void => finish(new CoordError("NEEDS_HUMAN", "Protected input cancelled"));
    const finish = (error?: Error): void => { if (finished) return; finished = true; input.off("data", onData); input.off("end", cancelled); input.off("error", cancelled); input.setRawMode(wasRaw); input.pause(); write("\n"); error ? reject(error) : resolve(result); };
    const onData = (chunk: Buffer): void => {
      for (const character of decoder.write(chunk)) {
        if (character === "\u0003" || character === "\u0004") { finish(new CoordError("NEEDS_HUMAN", "Protected input cancelled")); return; }
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u007f" || character === "\b") { result = [...result].slice(0, -1).join(""); if (!hidden) write("\b \b"); }
        else if (character >= " " && character !== "\u007f") { result += character; if (!hidden) write(character); }
        if (Buffer.byteLength(result) > 1024) { finish(new CoordError("INVALID_INPUT", "Protected input exceeds limit")); return; }
      }
    };
    input.on("data", onData); input.on("end", cancelled); input.on("error", cancelled);
  });
}
async function prompt(label: string, hidden: boolean): Promise<string> {
  // TTY is an input capability check only. It never certifies human presence or a qualified host.
  if (!process.stdin.isTTY || !process.stderr.isTTY || process.env.COORD_LAUNCH_ID || process.env.COORD_SESSION_ID) throw new CoordError("NEEDS_HUMAN", "Run protected setup in your separate operator terminal, outside every agent/worker session");
  process.stderr.write(label);
  return readProtectedLine(process.stdin, text => { process.stderr.write(text); }, hidden);
}
export async function setupCommand(args: string[]): Promise<void> {
  const [action, planPath, vaultPath] = args;
  if (!planPath || !["inspect", "bootstrap", "connect"].includes(action ?? "") || (action === "inspect" ? args.length !== 2 : args.length !== 3 || !vaultPath || !isAbsolute(vaultPath))) throw new CoordError("INVALID_INPUT", "Usage: coord setup inspect <plan.json> | setup bootstrap|connect <plan.json> <absolute-encrypted-vault>");
  const plan = parseSetupPlan(JSON.parse(await readSmallFile(planPath)));
  await inspectPlan(plan);
  const hash = planDigest(plan);
  console.log(JSON.stringify({ clientVersion: CLIENT_VERSION, planDigest: hash, plan, qualification: "BLOCKED: operator unlock and worker isolation require independent real-host evidence" }, null, 2));
  if (action === "inspect") return;
  if (await prompt(`Type ${action} ${hash} to apply this exact plan: `, false) !== `${action} ${hash}`) throw new CoordError("NEEDS_HUMAN", "Exact plan confirmation did not match");
  let bundle: Bundle;
  if (action === "bootstrap") {
    const exists = await lstat(vaultPath!).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
    if (exists) bundle = await unlockBundle(plan, vaultPath!, await prompt("Vault passphrase (not cached): ", true));
    else {
      const passphrase = await prompt("New vault passphrase (16+ UTF-8 bytes; not cached): ", true);
      if (passphrase !== await prompt("Repeat passphrase: ", true)) throw new CoordError("INVALID_INPUT", "Passphrases differ");
      bundle = await createBundle(plan, vaultPath!, passphrase);
    }
    await runOwnerBootstrap(plan, bundle, vaultPath!);
    console.log(JSON.stringify({ bootstrap: "confirmed", backendId: plan.config.backendId, projectId: plan.config.projectId, next: "Run setup connect in this external operator session; host qualification remains blocked" }));
  } else {
    bundle = await unlockBundle(plan, vaultPath!, await prompt("Vault passphrase (not cached): ", true));
    await configureAndConnect(plan, bundle);
    console.log(JSON.stringify({ connected: true, backendId: plan.config.backendId, projectId: plan.config.projectId, authority: "project-agent only; host qualification remains blocked" }));
  }
}
