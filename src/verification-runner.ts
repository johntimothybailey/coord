import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import nativeFs, { chmod, lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { RuntimeConfig } from "./command-runtime.js";
import { runtimeDigest } from "./command-runtime.js";
import { requireGitMetadataIsolation } from "./git-transport.js";
import { CoordError } from "./protocol.js";
import type { FileEntry, VerificationEvidence } from "./protocol.js";

export const VERIFICATION_LIMITS = Object.freeze({ timeoutMs: 30_000, outputBytes: 1024 * 1024, files: 20_000, totalBytes: 64 * 1024 * 1024 });
export interface VerificationOptions { runtime: RuntimeConfig; repo: string; head: string; tree: string; base: string; environmentDigest: string }
const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const oid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function blocked(message: string): never { throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", message); }
function changed(): never { throw new CoordError("PUBLICATION_STALE", "Verification source is not the exact clean final head/tree/base; values withheld"); }

/** Fixed trusted subprocesses only; output is bounded and never placed in errors/evidence. */
async function execute(binary: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv, capture = false): Promise<{ code: number; output: Buffer }> {
  return new Promise((resolveResult, reject) => {
    let child: ReturnType<typeof childProcess.spawn>;
    try { child = childProcess.spawn(binary, argv, { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { reject(new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Verification subprocess is unavailable; output withheld")); return; }
    let bytes = 0, limited = false, settled = false; const chunks: Buffer[] = [];
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, code = -1) => { if (settled) return; settled = true; clearTimeout(timer); if (exitTimer) clearTimeout(exitTimer); if (error) reject(error); else resolveResult({ code, output: Buffer.concat(chunks) }); };
    const stop = () => {
      limited = true;
      try { child.kill("SIGKILL"); } catch { /* positive close remains required */ }
      // Production requires a private Linux PID namespace; no killpg containment claim.
      exitTimer ??= setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); finish(new CoordError("LAUNCH_UNCERTAIN", "Verification containment did not positively exit; private scratch retained")); }, 1000);
    };
    const timer = setTimeout(stop, VERIFICATION_LIMITS.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > VERIFICATION_LIMITS.outputBytes) stop(); else if (capture) chunks.push(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > VERIFICATION_LIMITS.outputBytes) stop(); });
    child.on("error", () => finish(new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Verification subprocess failed to start; output withheld")));
    child.on("close", code => finish(limited ? new CoordError("BLOCKED_ENV", "Verification exceeded its time/output bound; output withheld") : undefined, code ?? -1));
  });
}

async function trustedBinary(path: string, fixed = false): Promise<string> {
  const canonical = await nativeFs.realpath(path).catch(() => blocked("Required preinstalled native verification executable is unavailable"));
  const stat = await nativeFs.lstat(canonical);
  if (!stat.isFile() || !(stat.mode & 0o111) || (stat.mode & 0o022) || (fixed && (stat.uid !== 0 || (stat.mode & 0o6000)))) blocked("Native verification executable must be a protected regular executable");
  return canonical;
}
async function canonicalReference(path: string): Promise<string> {
  const parts: string[] = []; let current = resolve(path);
  for (;;) { try { return join(await realpath(current), ...parts); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const parent = dirname(current); if (parent === current) throw error; parts.unshift(current.slice(parent.length + (parent === sep ? 0 : 1))); current = parent; } }
}
function systemOrToolchainRoot(root: string): boolean {
  if (["/bin", "/usr/bin", "/usr/lib", "/usr/lib64", "/usr/libexec", "/usr/share", "/System/Library", "/Library/Apple/System/Library"].includes(root)) return true;
  return /^\/System\/Library\/(?:Frameworks|PrivateFrameworks|CoreServices|dyld)(?:\/|$)/.test(root)
    || /^\/(?:opt\/homebrew|usr\/local)\/Cellar\/[A-Za-z0-9@._+-]+\/[0-9][^/]*(?:\/(?:bin|lib|libexec|share))?$/.test(root)
    || /\/\.volta\/tools\/image\/node\/[0-9]+\.[0-9]+\.[0-9]+$/.test(root)
    || /\/\.nvm\/versions\/node\/v[0-9]+\.[0-9]+\.[0-9]+$/.test(root)
    || /^\/Library\/Developer\/CommandLineTools\/usr\/(?:bin|lib|libexec)$/.test(root);
}
async function readRoots(runtime: RuntimeConfig, repo: string): Promise<string[]> {
  const references = [runtime.workspaceRoot, runtime.worktreeRoot, runtime.stateDirectory, runtime.policy.workerHome, runtime.policy.githubHome, runtime.gitTransport.home, dirname(runtime.trustedRegistryPath), runtime.agentCredentialDirectory, dirname(runtime.verifierCredentialFile), ...(runtime.supervisorCredentialFile ? [dirname(runtime.supervisorCredentialFile)] : [])];
  const forbidden = await Promise.all(references.map(canonicalReference));
  const home = process.env.HOME ? await canonicalReference(process.env.HOME) : undefined;
  const roots: string[] = [];
  for (const candidate of runtime.policy.verification.readOnlyRoots) {
    const root = await realpath(candidate).catch(() => blocked("Verification read root is unavailable"));
    const stat = await lstat(root);
    if (!systemOrToolchainRoot(root) || root !== resolve(candidate) || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || [sep, "/usr", "/System", "/Library", "/Users", "/home", "/private", "/tmp", "/var", "/opt", "/opt/homebrew"].includes(root) || (home && within(home, root)) || overlaps(root, repo) || forbidden.some(control => overlaps(root, control))) blocked("Verification read roots must be narrow canonical toolchain/system directories, separated from source and credentials");
    if (roots.some(prior => overlaps(prior, root))) blocked("Verification read roots must not overlap");
    roots.push(root);
  }
  if (!roots.length || roots.length > 20) blocked("Verification requires bounded explicit read roots");
  return roots;
}
function requireQualification(runtime: RuntimeConfig): "manual" | "managed" {
  const checks = runtime.capability.checks.filter(check => check.checkId === "verification.sandbox"), check = checks[0], now = Date.now();
  const observed = check ? Date.parse(check.observedAt) : NaN;
  if (checks.length !== 1 || !check || check.kind !== "real" || check.status !== "PASS" || check.mode === "advisory" || !check.evidenceRef || !Number.isFinite(observed) || observed > now || now - observed > 86400_000 || check.configurationDigest !== runtimeDigest(runtime) || runtime.capability.key.configurationDigest !== runtimeDigest(runtime)) blocked("Current real verification.sandbox qualification is required; fixture or historical evidence cannot authorize commands");
  return check.mode;
}
async function commandBinary(argv: string[], roots: string[], searchPath: string): Promise<string> {
  const first = argv[0];
  if (!first || argv.length > 100 || argv.some(arg => typeof arg !== "string" || arg.includes("\0") || arg.length > 8192)) blocked("Invalid approved verification command");
  const candidates = isAbsolute(first) ? [first] : /^[A-Za-z0-9_.+-]+$/.test(first) ? searchPath.split(":").map(dir => join(dir, first)) : [];
  for (const path of candidates) {
    if (!isAbsolute(path)) continue;
    try { const canonical = await trustedBinary(path); if (roots.some(root => within(canonical, root))) return canonical; } catch { /* try next approved protected search entry */ }
  }
  blocked("Approved verification executable is outside explicit readable toolchain roots");
}

async function git(repo: string, args: string[], home: string): Promise<Buffer> {
  const binary = await trustedBinary(process.platform === "darwin" ? "/Library/Developer/CommandLineTools/usr/bin/git" : "/usr/bin/git", true);
  const result = await execute(binary, ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "-c", "core.sshCommand=/usr/bin/false", "-c", "core.askPass=/usr/bin/false", "-c", "credential.helper=", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], repo, { HOME: home, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_ALLOW_PROTOCOL: "", GIT_PROTOCOL_FROM_USER: "0", GIT_NO_LAZY_FETCH: "1", GIT_ASKPASS: "/usr/bin/false", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" }, true);
  if (result.code !== 0) changed(); return result.output;
}
async function finalTree(options: VerificationOptions, home: string): Promise<FileEntry[]> {
  const text = async (args: string[]) => (await git(options.repo, args, home)).toString("utf8").trim();
  if (await text(["rev-parse", "--verify", "HEAD"]) !== options.head || await text(["rev-parse", "--verify", "HEAD^{tree}"]) !== options.tree || await text(["rev-parse", "--verify", `${options.base}^{commit}`]) !== options.base) changed();
  const files = (await git(options.repo, ["ls-tree", "-rz", "--full-tree", options.tree], home)).toString("utf8").split("\0").filter(Boolean).map(row => {
    const tab = row.indexOf("\t"), [mode, type, hash] = row.slice(0, tab).split(" "), path = row.slice(tab + 1);
    if (tab < 0 || !hash || !oid(hash) || type !== "blob" || !mode || !["100644", "100755", "120000"].includes(mode) || !path || path.length > 8192 || isAbsolute(path) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) changed();
    return { path, mode, oid: hash, type: mode === "120000" ? "symlink" as const : "blob" as const };
  });
  if (files.length > VERIFICATION_LIMITS.files) blocked("Verification tree exceeds supported bound");
  const expected = files.map(file => `${file.mode} ${file.oid} 0\t${file.path}`).sort();
  const index = (await git(options.repo, ["ls-files", "--stage", "-z"], home)).toString("utf8").split("\0").filter(Boolean).sort();
  if (JSON.stringify(index) !== JSON.stringify(expected) || (await git(options.repo, ["ls-files", "--others", "--exclude-standard", "-z"], home)).length) changed();
  return files;
}
async function fileBytes(root: string, entry: FileEntry, maxBytes: number): Promise<Buffer> {
  const path = join(root, entry.path), parent = await realpath(dirname(path));
  if (!within(parent, root) || parent !== dirname(path)) changed();
  const before = await lstat(path);
  let bytes: Buffer;
  if (entry.type === "symlink") { if (!before.isSymbolicLink()) changed(); bytes = Buffer.from(await readlink(path)); }
  else {
    if (!before.isFile() || before.size > maxBytes || ((before.mode & 0o111) ? "100755" : "100644") !== entry.mode) changed();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await file.stat(); if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes) changed();
      const buffer = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1)); let length = 0;
      for (;;) { const { bytesRead } = await file.read(buffer, length, buffer.length - length); if (!bytesRead) break; length += bytesRead; if (length > maxBytes) changed(); }
      bytes = buffer.subarray(0, length); } finally { await file.close(); }
  }
  const after = await lstat(path);
  if (bytes.length > maxBytes || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || createHash(entry.oid.length === 40 ? "sha1" : "sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== entry.oid) changed();
  return bytes;
}
async function checkFiles(root: string, files: FileEntry[], maxBytes: number, destination?: string): Promise<void> {
  let total = 0;
  for (const file of files) {
    const bytes = await fileBytes(root, file, maxBytes); total += bytes.length;
    if (total > VERIFICATION_LIMITS.totalBytes) blocked("Verification artifact exceeds supported total size");
    if (destination) { const target = join(destination, file.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); if (file.type === "symlink") await symlink(bytes.toString("utf8"), target); else await writeFile(target, bytes, { flag: "wx", mode: file.mode === "100755" ? 0o500 : 0o400 }); }
  }
}

async function checkArtifact(root: string, files: FileEntry[], maxBytes: number): Promise<void> {
  await checkFiles(root, files, maxBytes);
  const expected = new Set(files.map(file => file.path)), directories = new Set<string>(); let count = 0;
  for (const file of files) for (let parent = dirname(file.path); parent !== "."; parent = dirname(parent)) directories.add(parent);
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 100_000) changed();
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!directories.has(path)) changed(); await visit(join(directory, entry.name), path); }
      else if (!expected.has(path)) changed();
    }
  }
  await visit(root, "");
}

interface Sandbox { binary: string; prefix: string[]; cwd: string; env: NodeJS.ProcessEnv; artifact: string; scratch: string; controlProbe: string; readOnlyProbe: string }
async function sandbox(runtime: RuntimeConfig, roots: string[], artifact: string, controlProbe: string, readOnlyProbe: string, searchPath: string): Promise<Sandbox> {
  const policy = runtime.policy.verification;
  if (policy.kind === "macos-sandbox-exec") blocked("macOS verification is blocked until concrete qualified parent-death containment is implemented; sandbox-exec alone is insufficient");
  if (process.platform !== "linux" || !["/usr/bin/bwrap", "/bin/bwrap"].includes(policy.executable)) blocked("Linux verification requires explicitly selected preinstalled system bubblewrap");
  const binary = await trustedBinary(policy.executable, true);
  if (!["/usr/bin/bwrap", "/bin/bwrap"].includes(binary)) blocked("System bubblewrap executable must not be redirected");
  const prefix = ["--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv"];
  const directories = new Set<string>();
  for (const root of roots) for (let parent = dirname(root); parent !== sep; parent = dirname(parent)) directories.add(parent);
  for (const directory of [...directories].sort((a, b) => a.length - b.length)) prefix.push("--dir", directory);
  for (const root of roots) prefix.push("--ro-bind", root, root);
  // Linux loader aliases are recreated only when their canonical target is explicitly mounted.
  for (const alias of ["/lib", "/lib64", "/bin"]) {
    const target = await realpath(alias).catch(() => "");
    if (target && target !== alias && roots.some(root => within(target, root))) prefix.push("--symlink", target, alias);
  }
  prefix.push("--proc", "/proc", "--dev", "/dev", "--dir", "/coord", "--ro-bind", artifact, "/coord/artifact", "--ro-bind", readOnlyProbe, "/coord/read-only-probe", "--tmpfs", "/tmp", "--dir", "/tmp/home", "--setenv", "HOME", "/tmp/home", "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", searchPath, "--setenv", "LC_ALL", "C", "--setenv", "TZ", "UTC", "--chdir", "/coord/artifact", "--");
  return { binary, prefix, cwd: artifact, env: {}, artifact: "/coord/artifact", scratch: "/tmp", controlProbe, readOnlyProbe: "/coord/read-only-probe" };
}

// Trusted literal probe; it never reads a real credential. Fixture tests mock the syscall only.
const PROBE = `const fs=require('node:fs'),cp=require('node:child_process');
const c=JSON.parse(process.argv[1]);
function denied(action){try{action();return false}catch(e){return ['EPERM','EACCES','ENOENT','EROFS'].includes(e.code)}}
if(!denied(()=>fs.readFileSync(c.control))||!denied(()=>fs.writeFileSync(c.readOnly,'overwrite'))||!denied(()=>fs.writeFileSync(c.artifact+'/.write-probe','write')))process.exit(81);
fs.writeFileSync(c.scratch+'/write-probe','ok');fs.accessSync(c.node,fs.constants.X_OK);{const fd=fs.openSync(c.node,'r');fs.readSync(fd,Buffer.alloc(1),0,1,0);fs.closeSync(fd)}
for(const k of Object.keys(process.env))if(!['HOME','TMPDIR','TMP','TEMP','PATH','LC_ALL','TZ','PWD'].includes(k))process.exit(82);
const child=cp.spawnSync(c.node,['-e','process.exit(0)'],{env:process.env,stdio:'ignore',timeout:1000});
if(child.error||child.status!==0||fs.readlinkSync('/proc/self/ns/pid')===c.pid||fs.readlinkSync('/proc/self/ns/net')===c.net)process.exit(84);
process.stdout.write('COORD_SANDBOX_PROBE_V1\\n');`;

export async function runVerification(options: VerificationOptions): Promise<VerificationEvidence> {
  options = { ...options, runtime: structuredClone(options.runtime) };
  if (![options.head, options.tree, options.base].every(oid) || !/^[a-f0-9]{64}$/.test(options.environmentDigest)) throw new CoordError("INVALID_INPUT", "Verification requires exact Git object identities and environment digest");
  const runtime = options.runtime;
  const mode = requireQualification(runtime);
  requireGitMetadataIsolation({ expectedKey: runtime.capability.key, capabilityEvidence: runtime.capability, mode });
  if (runtime.policy.copyEnvironment.length || runtime.policy.environment.some(requirement => requirement.modes.some(mode => mode !== "advisory"))) blocked("Verification does not support copied or required application/provider environment; cleared app environment is mandatory");
  const repo = await realpath(options.repo);
  if (repo !== resolve(options.repo)) blocked("Verification source must use its canonical path");
  options = { ...options, runtime, repo };
  const roots = await readRoots(runtime, repo);
  const searchDirectories = (runtime.policy.verification.searchPath ?? runtime.policy.searchPath).split(":");
  for (const directory of searchDirectories) { if (!isAbsolute(directory)) blocked("Verification PATH must contain explicit absolute toolchain directories"); const resolved = await realpath(directory).catch(() => blocked("Verification PATH directory is unavailable")); if (!roots.some(root => within(resolved, root))) blocked("Verification PATH escapes explicit toolchain roots"); }
  const searchPath = (await Promise.all(searchDirectories.map(directory => realpath(directory)))).join(":");
  if (!runtime.policy.verificationCommands.length || runtime.policy.verificationCommands.length > 50) blocked("A bounded protected verification command policy is required");
  const commands = await Promise.all(runtime.policy.verificationCommands.map(async argv => ({ argv: [...argv], binary: await commandBinary(argv, roots, searchPath) })));
  const node = await trustedBinary(process.execPath);
  if (!roots.some(root => within(node, root))) blocked("The fixed Node canary runtime must be in explicit toolchain roots");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "coord-verification-")));
  await chmod(directory, 0o700);
  const artifact = join(directory, "artifact"), scratch = join(directory, "scratch"), controlProbe = join(directory, "control-probe"), readOnlyProbe = join(directory, "read-only-probe");
  let uncertain = false;
  try {
    await mkdir(artifact, { mode: 0o700 }); await mkdir(scratch, { mode: 0o700 }); await mkdir(join(scratch, "home"), { mode: 0o700 });
    await writeFile(controlProbe, "synthetic-control-canary", { mode: 0o600, flag: "wx" }); await writeFile(readOnlyProbe, "synthetic-read-only-canary", { mode: 0o600, flag: "wx" });
    const files = await finalTree(options, directory), maxBytes = runtime.policy.capture.maxFileBytes ?? 5 * 1024 * 1024;
    await checkFiles(repo, files, maxBytes, artifact);
    const isolated = await sandbox(runtime, roots, artifact, controlProbe, readOnlyProbe, searchPath);
    // A failed baseline cannot be mistaken for sandbox fork denial.
    const baseline = await execute(node, ["-e", "process.exit(0)"], directory, { HOME: join(scratch, "home"), PATH: searchPath });
    if (baseline.code !== 0) blocked("Trusted Node baseline failed; sandbox denial cannot be qualified");
    const namespaces = process.platform === "linux" ? { pid: await nativeFs.readlink("/proc/self/ns/pid"), net: await nativeFs.readlink("/proc/self/ns/net") } : {};
    const probeArgs = { platform: process.platform, node, control: isolated.controlProbe, readOnly: isolated.readOnlyProbe, artifact: isolated.artifact, scratch: isolated.scratch, ...namespaces };
    const probe = await execute(isolated.binary, [...isolated.prefix, node, "-e", PROBE, JSON.stringify(probeArgs)], isolated.cwd, isolated.env, true);
    if (probe.code !== 0 || probe.output.toString("utf8") !== "COORD_SANDBOX_PROBE_V1\n") blocked("Actual native sandbox file/environment/network/containment probe did not pass; no verification commands ran");
    const evidence: VerificationEvidence = { head: options.head, tree: options.tree, base: options.base, environmentDigest: options.environmentDigest, commands: [], recordedAt: "" };
    for (const command of commands) {
      await finalTree(options, directory); await checkFiles(repo, files, maxBytes); await checkArtifact(artifact, files, maxBytes);
      const result = await execute(isolated.binary, [...isolated.prefix, command.binary, ...command.argv.slice(1)], isolated.cwd, isolated.env);
      await finalTree(options, directory); await checkFiles(repo, files, maxBytes); await checkArtifact(artifact, files, maxBytes);
      evidence.commands.push({ argv: command.argv, exitCode: result.code });
      if (result.code !== 0) throw new CoordError("PUBLICATION_STALE", "Approved sandboxed verification command failed; output withheld");
    }
    evidence.recordedAt = new Date().toISOString(); return evidence;
  } catch (error) { uncertain = error instanceof CoordError && error.code === "LAUNCH_UNCERTAIN"; throw error; }
  finally { if (!uncertain) await rm(directory, { recursive: true, force: true }); }
}
