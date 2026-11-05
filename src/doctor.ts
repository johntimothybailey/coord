import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir, platform, release, arch } from "node:os";
import { delimiter, join } from "node:path";
import { PROBE_VERSION, PROTOCOL_VERSION, REQUIRED_CHECKS, type CapabilityEvidence, type EvidenceStatus, type ExecutionMode, type Harness, type ProbeEvidence } from "./protocol.js";
import { codexAdapter } from "./adapters/codex.js";
import { antigravityAdapter } from "./adapters/antigravity.js";

export interface DoctorOptions { timeoutMs?: number; outputLimit?: number; fixtures?: boolean }
export interface CommandResult {
  argv: string[]; exitCode: number | null; outcome: "completed" | "missing" | "timeout" | "output-limit" | "error";
  outputBytes: number; errorCode?: string; result: string;
}
export interface DoctorReport {
  schemaVersion: 1; protocolVersion: number; generatedAt: string;
  host: { os: string; release: string; arch: string; node: string };
  capabilities: CapabilityEvidence[]; fixtures: ProbeEvidence[]; commandResults: CommandResult[];
  gates: { harness: Harness; mode: ExecutionMode; status: EvidenceStatus; missingChecks: string[] }[];
  blockers: string[];
}
interface CapturedCommand extends Omit<CommandResult, "result"> { output: string }
interface CommandOptions { timeoutMs: number; outputLimit: number; cwd?: string; env?: NodeJS.ProcessEnv }

// Raw output stays internal: help, login status and plugin listings can contain private settings.
async function capture(argv: string[], options: CommandOptions): Promise<CapturedCommand> {
  return new Promise(resolve => {
    let output = "", outputBytes = 0, settled = false;
    let outcome: CapturedCommand["outcome"] = "completed";
    let errorCode: string | undefined;
    let child: ReturnType<typeof spawn>;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); if (fallback) clearTimeout(fallback);
      resolve({ argv, exitCode, outcome, outputBytes, output, ...(errorCode ? { errorCode } : {}) });
    };
    const stop = () => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ }
      // A broken descendant must not keep doctor waiting on inherited pipes.
      fallback ??= setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); finish(null); }, 250);
    };
    const timer = setTimeout(() => { outcome = "timeout"; stop(); }, options.timeoutMs);
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch { outcome = "error"; finish(null); return; }
    const collect = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > options.outputLimit) { outcome = "output-limit"; stop(); return; }
      output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect); child.stderr?.on("data", collect);
    child.once("error", error => { const code = (error as NodeJS.ErrnoException).code; if (code && /^[A-Z0-9_]{1,30}$/.test(code)) errorCode = code; outcome = code === "ENOENT" ? "missing" : "error"; finish(null); });
    child.once("close", code => finish(code));
  });
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function succeeded(command: CapturedCommand): boolean { return command.outcome === "completed" && command.exitCode === 0; }
function version(output: string): string | undefined { return output.match(/(?:^|\n)(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._-]+)?)(?:\s|$)/)?.[1]; }
export async function probePackageManager(binary: "npm" | "pnpm" | "bun" | "yarn"): Promise<{ binary: string; version: string | null; status: EvidenceStatus; command: CommandResult }> {
  if (!["npm", "pnpm", "bun", "yarn"].includes(binary)) throw new Error("Unsupported package manager probe");
  const result = await capture([binary, "--version"], { timeoutMs: 5_000, outputLimit: 16 * 1024, env: { ...process.env, COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
  const observedVersion = succeeded(result) ? version(result.output) : undefined;
  return { binary, version: observedVersion ?? null, status: observedVersion ? "PASS" : "BLOCKED", command: { argv: result.argv, exitCode: result.exitCode, outcome: result.outcome, outputBytes: result.outputBytes, ...(result.errorCode ? { errorCode: result.errorCode } : {}), result: "Read-only version probe; raw output withheld" } };
}
function evidence(checkId: string, status: EvidenceStatus, configurationDigest: string, summary: string, command: string[] = [], kind: "real" | "fixture" = "real", mode: ExecutionMode = "managed"): ProbeEvidence {
  return { schemaVersion: 1, checkId, status, mode, observedAt: new Date().toISOString(), configurationDigest, command, summary, kind };
}

async function configMarker(path: string): Promise<{ state: string; modifiedMs?: number; bytes?: number }> {
  try { const info = await stat(path); return { state: "present-content-not-read", modifiedMs: info.mtimeMs, bytes: info.size }; }
  catch (error) { return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" }; }
}
async function binaryIdentifier(binary: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    try { const candidate = join(directory, binary); await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* next PATH entry */ }
  }
  return "unavailable";
}

/** Read-only host discovery plus optional disposable primitives. This never grants admission. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const timeoutMs = Math.min(30_000, Math.max(100, options.timeoutMs ?? 5_000));
  const outputLimit = Math.min(1024 * 1024, Math.max(1024, options.outputLimit ?? 256 * 1024));
  if (!Number.isFinite(timeoutMs) || !Number.isFinite(outputLimit)) throw new Error("Doctor bounds must be finite");
  const commands: CommandResult[] = [];
  const run = async (argv: string[], extra: Partial<CommandOptions> = {}) => {
    const result = await capture(argv, { timeoutMs, outputLimit, ...extra });
    commands.push({ argv: result.argv, exitCode: result.exitCode, outcome: result.outcome, outputBytes: result.outputBytes, ...(result.errorCode ? { errorCode: result.errorCode } : {}), result: `${result.outcome}; exit ${result.exitCode ?? "none"}; raw output withheld` });
    return result;
  };
  const host = { os: platform(), release: release(), arch: arch(), node: process.version };
  const capabilities: CapabilityEvidence[] = [];
  for (const harness of ["codex", "antigravity"] as const) {
    const binary = harness === "codex" ? "codex" : "agy";
    const adapterVersion = harness === "codex" ? codexAdapter.version : antigravityAdapter.version;
    const v = await run([binary, "--version"]);
    const detectedVersion = succeeded(v) ? version(v.output) : undefined;
    const help = await run([binary, "--help"]);
    const pluginHelp = await run([binary, "plugin", "--help"]);
    const mcpHelp = await run([binary, "mcp", "--help"]);
    const configuration = {
      host, harness, harnessVersion: detectedVersion ?? "unavailable", adapterVersion,
      binaryIdentifier: await binaryIdentifier(binary),
      // Metadata detects changes without reading or hashing credentials/config contents.
      config: harness === "codex" ? await configMarker(join(process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex"), "config.toml")) : { state: "effective-config-location-unverified" },
      permissionFlags: succeeded(help) ? ["--sandbox", "--ask-for-approval", "--dangerously-skip-permissions"].filter(flag => help.output.includes(flag)) : [],
      effectivePermissions: "unverified", credentialIsolation: "unverified", policy: "no-selected-git-host-policy",
    };
    const configurationDigest = digest(configuration);
    const checks = [
      evidence("harness.version", detectedVersion ? "PASS" : v.outcome === "missing" ? "BLOCKED" : "FAIL", configurationDigest, detectedVersion ? `Installed ${binary} ${detectedVersion}` : "Installed version could not be verified", [binary, "--version"], "real", "advisory"),
      evidence("harness.help", succeeded(help) ? "PASS" : "BLOCKED", configurationDigest, succeeded(help) ? "Read-only CLI help returned successfully" : "CLI help unavailable", [binary, "--help"], "real", "advisory"),
      evidence("plugin.command", succeeded(pluginHelp) ? "PASS" : "BLOCKED", configurationDigest, succeeded(pluginHelp) ? "Plugin command help is discoverable; installed coord plugin remains unverified" : "Plugin command unavailable", [binary, "plugin", "--help"], "real", "advisory"),
      evidence("mcp.command", succeeded(mcpHelp) ? "PASS" : "BLOCKED", configurationDigest, succeeded(mcpHelp) ? "MCP management command is discoverable; no backend round trip demonstrated" : "MCP management command unavailable", [binary, "mcp", "--help"], "real", "advisory"),
    ];
    if (succeeded(pluginHelp)) {
      // Both installed CLIs advertise a read-only list command. Never install or modify settings.
      const listing = await run(harness === "codex" ? [binary, "plugin", "list", "--json"] : [binary, "plugin", "list"]);
      checks.push(evidence("plugin.list", succeeded(listing) ? "PASS" : "BLOCKED", configurationDigest, succeeded(listing) ? "Read-only plugin listing completed; names and settings withheld" : "Read-only plugin listing unavailable", listing.argv, "real", "advisory"));
    }
    if (harness === "codex" && detectedVersion) {
      const status = await run([binary, "login", "status"]);
      const signedIn = succeeded(status) && /(?:^|\n)Logged in\b/i.test(status.output);
      checks.push(evidence("harness.authentication", signedIn ? "PASS" : "BLOCKED", configurationDigest, signedIn ? "Harness reports signed in; credential reachability and paid inference were not tested" : "Harness sign-in could not be verified without interactive authentication", status.argv, "real", "manual"));
    }
    const reasons: Record<string, string> = {
      "plugin.discovery": "Actual coord plugin activation and native hook delivery require the selected installed integration",
      "mcp.roundtrip": "No operator-selected deployed backend and authenticated end-to-end MCP session",
      "manual.registration": "No real participating manual session registered against a selected backend",
      "checkin.delivery": "No native harness session demonstrating receipt delivery",
      "harness.authentication": "Installed harness has no verified read-only authentication status probe; no paid session attempted",
      "credentials.tool-isolation": "Native tool credential file/helper/environment reachability is not demonstrated; sign-in is separate",
      "human.unlock": "Actual protected human unlock and cached credential denial have not been demonstrated",
      "git.permissions": "No selected Git-host policy/identity; native merge and deploy restrictions unproven",
      "process.identity": "Disposable process fixture cannot qualify the actual harness process identity",
      "process.stop": "Disposable process fixture cannot qualify stopping the actual harness process tree",
      "git.refs": "Disposable local refs do not establish selected remote permissions and ref policy",
    };
    for (const checkId of new Set(Object.values(REQUIRED_CHECKS).flat())) {
      if (!checks.some(c => c.checkId === checkId)) checks.push(evidence(checkId, "BLOCKED", configurationDigest, reasons[checkId] ?? "Real qualification evidence unavailable"));
    }
    capabilities.push({ key: { os: `${host.os}/${host.release}/${host.arch}`, harness, harnessVersion: detectedVersion ?? "unavailable", adapterVersion, probeVersion: PROBE_VERSION, configurationDigest, gitPolicyDigest: digest({ selected: false }) }, checks });
  }
  const fixtures = options.fixtures === false ? [] : await primitiveFixtures(run, digest(host));
  const gates = capabilities.flatMap(capability => (["advisory", "manual", "managed"] as const).map(mode => {
    const missingChecks = REQUIRED_CHECKS[mode].filter(id => !capability.checks.some(c => c.checkId === id && c.kind === "real" && c.status === "PASS"));
    return { harness: capability.key.harness, mode, status: missingChecks.length ? "BLOCKED" as const : "PASS" as const, missingChecks: [...missingChecks] };
  }));
  return { schemaVersion: 1, protocolVersion: PROTOCOL_VERSION, generatedAt: new Date().toISOString(), host, capabilities, fixtures, commandResults: commands, gates,
    blockers: ["No operator-selected Convex deployment", "No selected private pilot remote or native merge/deploy policy", "No second distinct machine", "Actual protected unlock and native credential isolation unverified", "No configuration is qualified for admission by discovery or disposable fixtures"] };
}

async function primitiveFixtures(run: (argv: string[], extra?: Partial<CommandOptions>) => Promise<CapturedCommand>, configurationDigest: string): Promise<ProbeEvidence[]> {
  const fixtures: ProbeEvidence[] = [];
  const directory = await mkdtemp(join(tmpdir(), "coord-doctor-"));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Coord Fixture", GIT_AUTHOR_EMAIL: "fixture@invalid", GIT_COMMITTER_NAME: "Coord Fixture", GIT_COMMITTER_EMAIL: "fixture@invalid" };
  try {
    const source = join(directory, "source"), remote = join(directory, "remote.git");
    await mkdir(source);
    const git = async (args: string[], cwd = source) => {
      const result = await run(["git", "-c", "core.hooksPath=", ...args], { cwd, env });
      if (!succeeded(result)) throw new Error("Disposable Git command failed");
      return result.output.trim();
    };
    try {
      const installed = await git(["--version"]);
      await git(["init", "--quiet"]);
      await git(["init", "--bare", "--quiet", remote]);
      await writeFile(join(source, "fixture.txt"), "coord disposable primitive\n");
      await git(["add", "--", "fixture.txt"]);
      const tree = await git(["write-tree"]);
      const commit = await git(["commit-tree", tree, "-m", "Disposable doctor primitive"]);
      if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid fixture object identity");
      const ref = "refs/coord/doctor/primitive";
      await git(["update-ref", ref, commit]);
      await git(["-c", "protocol.file.allow=always", "push", "--quiet", "--no-verify", remote, `${ref}:${ref}`]);
      const received = await git(["--git-dir", remote, "rev-parse", "--verify", ref]);
      const contents = await git(["--git-dir", remote, "show", `${ref}:fixture.txt`]);
      if (received !== commit || contents !== "coord disposable primitive") throw new Error("Fixture remote mismatch");
      fixtures.push(evidence("fixture.git.refs", "PASS", configurationDigest, `${installed.match(/git version [\w.+-]+/)?.[0] ?? "Git"}: disposable local ref push and exact object/file round trip verified; no host policy qualification`, ["git", "push", "<disposable-local-remote>", "refs/coord/doctor/primitive"], "fixture"));
    } catch { fixtures.push(evidence("fixture.git.refs", "FAIL", configurationDigest, "Disposable Git ref round trip did not complete; no user repository was modified", ["git", "push", "<disposable-local-remote>"], "fixture")); }
    fixtures.push(...await processFixture(directory, env, run, configurationDigest));
  } finally { await rm(directory, { recursive: true, force: true }); }
  return fixtures;
}

async function processFixture(directory: string, env: NodeJS.ProcessEnv, run: (argv: string[], extra?: Partial<CommandOptions>) => Promise<CapturedCommand>, configurationDigest: string): Promise<ProbeEvidence[]> {
  const checks: ProbeEvidence[] = [];
  if (process.platform === "win32") return [evidence("fixture.process.stop", "BLOCKED", configurationDigest, "POSIX process-group fixture is unavailable on Windows", [], "fixture")];
  let child: ReturnType<typeof spawn> | undefined;
  let exited = false;
  try {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: directory, env, detached: true, stdio: "ignore" });
    const exit = new Promise<void>(resolve => { child!.once("exit", () => { exited = true; resolve(); }); child!.once("error", () => { exited = true; resolve(); }); });
    if (!child.pid) throw new Error("Fixture process not started");
    let bootIdentity = "";
    if (process.platform === "linux") bootIdentity = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    else if (process.platform === "darwin") {
      const boot = await run(["sysctl", "-n", "kern.boottime"], { env });
      if (succeeded(boot)) bootIdentity = boot.output.trim();
    }
    const first = await run(["ps", "-p", String(child.pid), "-o", "pid=,pgid=,lstart="], { env });
    const second = await run(["ps", "-p", String(child.pid), "-o", "pid=,pgid=,lstart="], { env });
    const fields = first.output.trim().split(/\s+/);
    const identityAvailable = Boolean(bootIdentity) && succeeded(first) && succeeded(second);
    const identityVerified = identityAvailable && first.output === second.output && fields[0] === String(child.pid) && fields[1] === String(child.pid) && fields.length >= 7;
    checks.push(evidence("fixture.process.identity", identityVerified ? "PASS" : identityAvailable ? "FAIL" : "BLOCKED", configurationDigest, identityVerified ? "Boot identity read; disposable PID, process group and OS start identity stable across two observations; no actual harness qualification" : identityAvailable ? "Disposable process identity observations disagree" : "OS boot/process inspection is unavailable or denied in the current execution environment", ["ps", "-p", "<disposable-pid>", "-o", "pid=,pgid=,lstart="], "fixture"));
    process.kill(-child.pid, "SIGTERM");
    await Promise.race([exit, new Promise<void>(resolve => { const timer = setTimeout(resolve, 1_000); timer.unref(); })]);
    let groupGone = false;
    try { process.kill(-child.pid, 0); } catch (error) { groupGone = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    checks.push(evidence("fixture.process.stop", exited && groupGone ? "PASS" : "FAIL", configurationDigest, exited && groupGone ? "Disposable POSIX process-group termination and exit observed; actual harness descendants remain unqualified" : "Disposable group exit was not positively observed", ["kill", "-TERM", "<disposable-process-group>"], "fixture"));
  } catch { checks.push(evidence("fixture.process.stop", "FAIL", configurationDigest, "Disposable process fixture failed; actual harness remains unqualified", [], "fixture")); }
  finally {
    if (child?.pid && !exited) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
  }
  return checks;
}
