import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { CoordError } from "./protocol.js";
import { readSmallFile } from "./credentials.js";

export interface WorkspaceConfig {
  schemaVersion: 1; backendId: string; backendUrl: string; projectId: string;
  repository: string; remote: string; defaultBranch: string; ruleTargets: string[];
}
export interface TrustedWorkspace extends WorkspaceConfig { root: string; commonGitDir: string; approvalReceipt: string; }
export interface ResolvedWorkspace { root: string; commonGitDir: string; config: WorkspaceConfig; trust: TrustedWorkspace; }
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new CoordError("INVALID_INPUT", "Expected configuration object"); return value as Record<string, unknown>; }
export function canonicalRemote(remote: string): string {
  if (!remote || /[\s\x00-\x1f]/u.test(remote)) throw new CoordError("INVALID_INPUT", "Invalid remote identity");
  const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(remote);
  if (scp && !remote.includes("://") && !remote.startsWith("/")) return `${scp[1]!.toLowerCase()}/${scp[2]!.replace(/\.git\/?$/, "").replace(/\/$/, "")}`;
  let url: URL;
  try { url = new URL(remote); } catch { throw new CoordError("INVALID_INPUT", "Remote must be a canonical network URL"); }
  if (!["https:", "ssh:"].includes(url.protocol) || url.password || (url.protocol === "https:" && url.username) || url.search || url.hash) throw new CoordError("INVALID_INPUT", "Remote URL must not embed credentials or query data");
  return `${url.host.toLowerCase()}${url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "")}`;
}
export function parseConfig(value: unknown): WorkspaceConfig {
  const obj = object(value);
  const keys = ["backendId", "backendUrl", "projectId", "repository", "remote", "defaultBranch"] as const;
  if (obj.schemaVersion !== 1 || keys.some(k => typeof obj[k] !== "string" || !(obj[k] as string).length) || !Array.isArray(obj.ruleTargets) || obj.ruleTargets.some(p => typeof p !== "string" || p.startsWith("/") || p.split(/[\\/]/).includes(".."))) throw new CoordError("INVALID_INPUT", "Invalid .coord.json schema");
  const url = new URL(obj.backendUrl as string);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Backend must be an exact HTTPS origin");
  if (canonicalRemote(obj.remote as string) !== obj.repository) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Repository identity differs from remote");
  return { schemaVersion: 1, backendId: obj.backendId as string, backendUrl: url.origin, projectId: obj.projectId as string, repository: obj.repository as string, remote: obj.remote as string, defaultBranch: obj.defaultBranch as string, ruleTargets: obj.ruleTargets as string[] };
}
export async function resolveWorkspace(cwd: string, registryPath = join(homedir(), ".config/coord/workspaces.json")): Promise<ResolvedWorkspace> {
  const root = await realpath(git(cwd, "rev-parse", "--show-toplevel"));
  const commonGitDir = await realpath(resolve(root, git(root, "rev-parse", "--git-common-dir")));
  const configPath = await realpath(join(root, ".coord.json"));
  if (dirname(configPath) !== root) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Configuration symlink escapes repository");
  const config = parseConfig(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  const registry = object(JSON.parse(await readFile(registryPath, "utf8")) as unknown);
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.workspaces)) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Missing trusted workspace registry");
  let trust: TrustedWorkspace | undefined;
  for (const raw of registry.workspaces) {
    const item = object(raw);
    if (typeof item.root !== "string" || typeof item.commonGitDir !== "string" || typeof item.approvalReceipt !== "string" || !item.approvalReceipt) continue;
    if (await realpath(item.commonGitDir).catch(() => "") !== commonGitDir) continue;
    const trustedConfig = parseConfig(item);
    if (JSON.stringify(trustedConfig) !== JSON.stringify(config)) continue;
    trust = { ...trustedConfig, root: await realpath(item.root), commonGitDir, approvalReceipt: item.approvalReceipt }; break;
  }
  if (!trust || canonicalRemote(git(root, "remote", "get-url", "origin")) !== config.repository) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Routing differs from the protected trusted association");
  if (root !== trust.root) {
    // Worktree inheritance also needs a run-specific local receipt, never just a shared .git directory.
    const receipt = object(JSON.parse(await readFile(join(root, ".coord-local/run.json"), "utf8")) as unknown);
    if (receipt.projectId !== config.projectId || receipt.commonGitDir !== commonGitDir || typeof receipt.runId !== "string" || typeof receipt.taskId !== "string" || !Number.isSafeInteger(receipt.epoch) || git(root, "branch", "--show-current") !== `coord/tasks/${receipt.taskId}/e${receipt.epoch}/${receipt.runId}`) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Derived worktree lacks matching admitted run identity");
  }
  return { root, commonGitDir, config, trust };
}
export function credentialKey(backendId: string, backendUrl: string): string { return createHash("sha256").update(JSON.stringify([backendId, backendUrl])).digest("hex"); }
export async function readAgentCredential(config: WorkspaceConfig, directory = join(homedir(), ".config/coord/credentials")): Promise<string> {
  const credential = object(JSON.parse(await readSmallFile(join(directory, `${credentialKey(config.backendId, config.backendUrl)}.json`), true)) as unknown);
  if (credential.schemaVersion !== 1 || credential.backendId !== config.backendId || credential.backendUrl !== config.backendUrl || credential.role !== "agent" || !Array.isArray(credential.projectIds) || !credential.projectIds.includes(config.projectId) || !Number.isSafeInteger(credential.expiresAt) || (credential.expiresAt as number) <= Date.now() || typeof credential.token !== "string" || !/^[a-f0-9]{64}$/.test(credential.token)) throw new CoordError("UNAUTHORIZED", "No matching project-agent credential");
  return credential.token;
}
