import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { CoordError, requireCapability, type CapabilityEvidence, type CapabilityKey } from "./protocol.js";

export interface GitTransport { kind: "github-https"; executable: string; home: string; searchPath: string; url: string }
export interface GitMetadataIsolation { expectedKey: CapabilityKey; capabilityEvidence: CapabilityEvidence; mode: "manual" | "managed" }
export interface GitOptions { env?: NodeJS.ProcessEnv; input?: Buffer | string; allowFailure?: boolean; maxBytes?: number; timeoutMs?: number; transport?: GitTransport; metadataIsolation?: GitMetadataIsolation }
export interface GitResult { code: number; stdout: Buffer }
interface Execution { executable: string; env: NodeJS.ProcessEnv; prefix: string[] }
const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
function fail(): never { throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Repository Git transport configuration is unsupported or differs from the exact approved HTTPS destination; values withheld"); }
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const overrideKeys = new Set(["GIT_INDEX_FILE", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE"]);
function overrides(values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(values)) {
    if (!overrideKeys.has(name) || typeof value !== "string" || value.includes("\0") || /[\r\n]/.test(value) || value.length > 8192 || (name === "GIT_INDEX_FILE" && (!isAbsolute(value) || resolve(value) !== value))) throw new CoordError("FORBIDDEN", "Only internal index and author fields may override the sanitized Git environment");
    result[name] = value;
  }
  return result;
}
function baseEnvironment(home: string | undefined, searchPath: string, values?: NodeJS.ProcessEnv, protocol = "file"): NodeJS.ProcessEnv {
  return { ...(home ? { HOME: home } : {}), PATH: searchPath, ...overrides(values), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: nullFile, GIT_CONFIG_SYSTEM: nullFile, GIT_ALLOW_PROTOCOL: protocol, GIT_PROTOCOL_FROM_USER: "0" };
}
const baseline = ["--no-optional-locks", "-c", `core.hooksPath=${nullFile}`, "-c", "core.fsmonitor=false", "-c", "core.sshCommand=/usr/bin/false", "-c", "core.askPass=/usr/bin/false", "-c", "commit.gpgsign=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "fetch.recurseSubmodules=false", "-c", "submodule.recurse=false"];

async function ownedPath(path: string, directory: boolean, privateMode = false): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || /[\0\r\n]/.test(path) || await realpath(path) !== path) fail();
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (info.mode & (privateMode ? 0o077 : 0o022)) || (privateMode && process.getuid && info.uid !== process.getuid()) || (!directory && ((info.mode & 0o6000) || (process.getuid && ![0, process.getuid()].includes(info.uid))))) fail();
  if (!directory) await access(path, constants.X_OK);
}
function transportShape(transport: GitTransport): void {
  if (!transport || Object.keys(transport).sort().join(",") !== "executable,home,kind,searchPath,url" || transport.kind !== "github-https" || [transport.executable, transport.home, transport.searchPath, transport.url].some(value => typeof value !== "string" || !value || value.includes("\0"))) fail();
  let url: URL; try { url = new URL(transport.url); } catch { fail(); }
  if (url.origin !== "https://github.com" || url.href !== transport.url || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(url.pathname)) fail();
  if (transport.searchPath.split(delimiter).some(path => !path || !isAbsolute(path) || resolve(path) !== path || /[\r\n]/.test(path))) fail();
}
/** The main runtime must additionally authenticate owner provenance and bind this key to its current protected configuration. */
export function requireGitMetadataIsolation(proof: GitMetadataIsolation | undefined): void {
  if (!proof || !["manual", "managed"].includes(proof.mode)) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Privileged Git operations require actual native Git-metadata write-isolation evidence");
  requireCapability(proof.capabilityEvidence, proof.expectedKey, proof.mode);
  const checks = proof.capabilityEvidence.checks.filter(check => check.checkId === "git.metadata-write-isolation"), check = checks[0];
  const observed = check ? Date.parse(check.observedAt) : NaN;
  if (checks.length !== 1 || !check || check.kind !== "real" || check.status !== "PASS" || !check.evidenceRef || check.configurationDigest !== proof.expectedKey.configurationDigest || !Number.isFinite(observed) || observed > Date.now() || Date.now() - observed > 86_400_000 || (check.mode !== proof.mode && !(check.mode === "managed" && proof.mode === "manual"))) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Worker denial of mutable Git configuration, attributes/filter sources and privileged path aliases is unqualified");
}
export async function validateGitTransport(transport: GitTransport): Promise<void> {
  transportShape(transport); await ownedPath(transport.executable, false); await ownedPath(transport.home, true, true);
  // A dedicated provider home must not add a second ambient credential source.
  for (const name of [".netrc", "_netrc"]) {
    try { await lstat(join(transport.home, name)); fail(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
async function selectedGit(searchPath: string): Promise<string> {
  for (const directory of searchPath.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, "git");
    try { await access(candidate, constants.X_OK); } catch (error) { if (["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; throw error; }
    const executable = await realpath(candidate); await ownedPath(executable, false); return executable;
  }
  throw new CoordError("BLOCKED_CHECKPOINT", "An approved Git executable is unavailable in the selected search path");
}

/** Bounded process primitive; output stays internal until its caller decides which nonsecret data is relevant. */
async function execute(repo: string, execution: Execution, args: string[], options: GitOptions): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(execution.executable, [...execution.prefix, ...args], { cwd: repo, env: execution.env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let bytes = 0, failed = false, settled = false;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number) => {
      if (settled) return; settled = true; clearTimeout(timer); if (fallback) clearTimeout(fallback);
      if (failed || (code !== 0 && !options.allowFailure)) reject(new CoordError("BLOCKED_CHECKPOINT", "Bounded Git operation did not complete successfully; command output withheld"));
      else resolveResult({ code, stdout: Buffer.concat(chunks) });
    };
    const stop = () => {
      failed = true;
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ }
      fallback ??= setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(-1); }, 250);
    };
    const timer = setTimeout(stop, options.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > (options.maxBytes ?? 16 * 1024 * 1024)) stop(); else chunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > (options.maxBytes ?? 16 * 1024 * 1024)) stop(); });
    child.stdin.on("error", () => {});
    child.once("error", () => { failed = true; finish(-1); });
    child.once("close", code => finish(code ?? -1));
    child.stdin.end(options.input);
  });
}
function harmlessConfig(key: string, value: string, url: string): boolean {
  if (/^core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/.test(key)) return /^(?:0|1|true|false)$/.test(value);
  if (key === "core.autocrlf" || key === "core.sparsecheckout" || key === "core.sparsecheckoutcone") return value === "false";
  if (key === "extensions.objectformat") return value === "sha1" || value === "sha256";
  if (key === "extensions.worktreeconfig") return value === "true" || value === "false";
  if (/^user\.(?:name|email)$/.test(key)) return value.length > 0 && !/[\0\r\n]/.test(value);
  const remote = key.match(/^remote\.([A-Za-z0-9][A-Za-z0-9._-]{0,100})\.(url|pushurl|fetch|mirror|tagopt)$/);
  if (remote) {
    if (remote[2] === "url" || remote[2] === "pushurl") return value === url;
    if (remote[2] === "mirror") return value === "false";
    if (remote[2] === "tagopt") return value === "--no-tags";
    return value === `+refs/heads/*:refs/remotes/${remote[1]}/*`;
  }
  if (/^branch\.[^\r\n\0]+\.remote$/.test(key)) return /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value);
  if (/^branch\.[^\r\n\0]+\.merge$/.test(key)) return /^refs\/heads\/[A-Za-z0-9_./-]+$/.test(value);
  if (/^branch\.[^\r\n\0]+\.rebase$/.test(key)) return ["true", "false", "merges", "interactive"].includes(value);
  if (key === "push.default") return ["nothing", "matching", "simple", "upstream", "current"].includes(value);
  if (key === "push.followtags" || key === "commit.gpgsign" || key === "submodule.recurse" || key === "fetch.recursesubmodules") return value === "false";
  if (key === "credential.usehttppath" || key === "http.sslverify") return value === "true";
  return false;
}
function configRows(output: Buffer, url: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of output.toString("utf8").split("\0").filter(Boolean)) {
    const index = row.indexOf("\n"), key = row.slice(0, index).toLowerCase(), value = row.slice(index + 1);
    if (index < 1 || !harmlessConfig(key, value, url)) fail();
    const values = result.get(key) ?? []; values.push(value); result.set(key, values);
  }
  return result;
}
async function auditRepository(repo: string, execution: Execution, transport: GitTransport): Promise<Map<string, string[]>> {
  const local = await execute(repo, execution, ["config", "--local", "--no-includes", "--null", "--list"], { maxBytes: 256 * 1024, timeoutMs: 5_000 });
  const combined = configRows(local.stdout, transport.url);
  if (combined.get("extensions.worktreeconfig")?.at(-1) === "true") {
    const worktree = await execute(repo, execution, ["config", "--worktree", "--no-includes", "--null", "--list"], { maxBytes: 256 * 1024, timeoutMs: 5_000 });
    for (const [key, values] of configRows(worktree.stdout, transport.url)) combined.set(key, values);
  }
  return combined;
}
function commandIndex(args: string[]): number {
  let index = 0;
  while (args[index]?.startsWith("-")) {
    if (args[index] === "--version") return index;
    if (args[index] === "--literal-pathspecs") { index++; continue; }
    if (args[index] === "-c" && (/^push\.followTags=false$/i.test(args[index + 1] ?? "") || /^remote\.[A-Za-z0-9._-]+\.mirror=false$/.test(args[index + 1] ?? ""))) { index += 2; continue; }
    fail();
  }
  return index;
}
function approvedCommand(args: string[], config: Map<string, string[]>, transport: GitTransport): string[] {
  const index = commandIndex(args), verb = args[index], result = [...args];
  const allowed = ["--version", "rev-parse", "remote", "ls-tree", "ls-files", "check-attr", "hash-object", "update-index", "read-tree", "write-tree", "commit-tree", "cat-file", "check-ref-format", "fetch", "push", "merge-base", "update-ref", "ls-remote", "worktree", "branch", "status", "diff", "rev-list", "show", "config"];
  if (!verb || !allowed.includes(verb)) fail();
  if (verb === "config" && !(args.length === index + 3 && args[index + 1] === "--get" && args[index + 2] === "core.autocrlf")) fail();
  if (verb === "remote" && !(args[index + 1] === "get-url" && args.slice(index + 2, -1).every(arg => ["--all", "--push"].includes(arg)) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(args.at(-1) ?? ""))) fail();
  if (verb === "fetch" || verb === "push" || verb === "ls-remote") {
    let target = index + 1;
    while (args[target]?.startsWith("-")) {
      const flag = args[target]!;
      if (flag === "--") { target++; break; }
      if (!["--no-tags", "--no-write-fetch-head", "--porcelain", "--quiet", "--refs", "--no-verify", "--no-follow-tags", "--no-recurse-submodules", "--recurse-submodules=no"].includes(flag) && !/^--force-with-lease=refs\/(?:coord\/checkpoints|heads\/coord\/reviews)\/[A-Za-z0-9_/-]+:$/.test(flag)) fail();
      target++;
    }
    const destination = args[target];
    if (!destination) fail();
    if (destination !== transport.url) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(destination) || !config.get(`remote.${destination.toLowerCase()}.url`)?.every(value => value === transport.url) || !config.has(`remote.${destination.toLowerCase()}.url`)) fail();
    }
    result[target] = transport.url;
    if (verb === "fetch") result.splice(index + 1, 0, "--no-recurse-submodules");
    if (verb === "push") result.splice(index + 1, 0, "--recurse-submodules=no", "--no-follow-tags");
  }
  return result;
}
async function privateNetwork(repo: string, execution: Execution, args: string[], options: GitOptions, config: Map<string, string[]>, transport: GitTransport): Promise<GitResult> {
  // Discovery performs no object read or network request. Source configuration is never used by the credential-bearing effect.
  const commonResult = await execute(repo, { ...execution, env: { ...execution.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" } }, ["rev-parse", "--git-common-dir"], { timeoutMs: 5_000, maxBytes: 16 * 1024 });
  const common = await realpath(resolve(repo, commonResult.stdout.toString("utf8").trim()));
  const objects = await realpath(join(common, "objects")), refs = await realpath(join(common, "refs"));
  const directory = await mkdtemp(join(transport.home, ".coord-git-transport-"));
  try {
    const format = config.get("extensions.objectformat")?.at(-1) ?? "sha1";
    const safeConfig = `[core]\n bare = true\n repositoryformatversion = ${format === "sha256" ? "1" : "0"}\n${format === "sha256" ? "[extensions]\n objectformat = sha256\n" : ""}`;
    await writeFile(join(directory, "config"), safeConfig, { flag: "wx", mode: 0o600 });
    await writeFile(join(directory, "HEAD"), "ref: refs/heads/coord-private-unused\n", { flag: "wx", mode: 0o600 });
    await symlink(objects, join(directory, "objects")); await symlink(refs, join(directory, "refs"));
    try { await lstat(join(common, "packed-refs")); await symlink(join(common, "packed-refs"), join(directory, "packed-refs")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    requireGitMetadataIsolation(options.metadataIsolation);
    await validateGitTransport(transport); await ownedPath(execution.executable, false);
    return await execute(repo, { ...execution, prefix: [...execution.prefix, `--git-dir=${directory}`] }, args, options);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Fixed transport only. No helper snippets or credential values are accepted from configuration. */
export async function runGit(repo: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new CoordError("INVALID_INPUT", "Invalid Git argument vector");
  args = [...args];
  options = { ...options, ...(options.env ? { env: { ...options.env } } : {}), ...(Buffer.isBuffer(options.input) ? { input: Buffer.from(options.input) } : {}), ...(options.transport ? { transport: structuredClone(options.transport) } : {}), ...(options.metadataIsolation ? { metadataIsolation: structuredClone(options.metadataIsolation) } : {}) };
  if (!options.transport) {
    const searchPath = process.env.PATH ?? "/usr/bin:/bin";
    return execute(repo, { executable: await selectedGit(searchPath), env: baseEnvironment(process.env.HOME, searchPath, options.env), prefix: baseline }, args, options);
  }
  requireGitMetadataIsolation(options.metadataIsolation);
  const transport = { ...options.transport }; await validateGitTransport(transport);
  const helper = `!${quote(transport.executable)} auth git-credential`;
  const execution: Execution = { executable: await selectedGit(transport.searchPath), env: baseEnvironment(transport.home, transport.searchPath, options.env, "https"), prefix: [...baseline,
    "-c", "credential.helper=", "-c", `credential.helper=${helper}`, "-c", "credential.useHttpPath=true", "-c", "credential.interactive=false",
    "-c", "http.extraHeader=", "-c", "http.proxy=", "-c", "http.sslVerify=true", "-c", "http.followRedirects=false", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
    "-c", `http.${transport.url}.extraHeader=`, "-c", `http.${transport.url}.proxy=`, "-c", `http.${transport.url}.sslVerify=true`, "-c", `http.${transport.url}.followRedirects=false`,
    "-c", "fetch.prune=false", "-c", "fetch.pruneTags=false", "-c", "fetch.writeCommitGraph=false", "-c", "push.followTags=false"] };
  const config = await auditRepository(repo, execution, transport);
  const approved = approvedCommand(args, config, transport), verb = approved[commandIndex(approved)];
  if (["fetch", "push", "ls-remote"].includes(verb ?? "")) return privateNetwork(repo, execution, approved, options, config, transport);
  return execute(repo, { ...execution, env: { ...execution.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" } }, approved, options);
}
