import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync } from "node:fs";
import nativeFs, { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { parseRuntime, runtimeDigest } from "../src/command-runtime.js";
import { runVerification, VERIFICATION_LIMITS } from "../src/verification-runner.js";
import type { VerificationOptions } from "../src/verification-runner.js";
import { CoordError, REQUIRED_CHECKS } from "../src/protocol.js";

const fixedGit = process.platform === "darwin" ? "/Library/Developer/CommandLineTools/usr/bin/git" : "/usr/bin/git";
const nativeFixture = { skip: !["darwin", "linux"].includes(process.platform) && "POSIX syscall fixtures require supported source metadata primitives; no host qualification implied" };
const code = (expected: string) => (error: unknown) => error instanceof CoordError && error.code === expected;
async function fixture(t: TestContext): Promise<VerificationOptions> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "coord-runner-test-"))), repo = join(directory, "repo");
  t.after(() => rm(directory, { recursive: true, force: true })); await mkdir(repo); await mkdir(join(directory, "control"));
  const env = { HOME: directory, PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
  const git = (args: string[]) => execFileSync(fixedGit, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
  git(["init", "-q"]); await writeFile(join(repo, "test.js"), "// Synthetic repository; syscall fixtures never execute this source.\n"); git(["add", "test.js"]); git(["commit", "-qm", "Fixture baseline"]);
  const node = await realpath(process.execPath), nodeRoot = node.includes("/.volta/") || node.includes("/.nvm/") ? dirname(dirname(node)) : dirname(node);
  const roots = [...new Set([nodeRoot, "/usr/bin", "/usr/lib", ...(process.platform === "darwin" ? ["/System/Library"] : [])])];
  const runtime = parseRuntime({ schemaVersion: 1, workspaceRoot: repo, stateDirectory: join(directory, "control"), worktreeRoot: join(directory, "worktrees"), trustedRegistryPath: join(directory, "control", "registry.json"), agentCredentialDirectory: join(directory, "control", "agents"), machineId: "fixture", memberId: "fixture", harness: { kind: "codex", executable: node }, gitTransport: { kind: "github-https", executable: "/usr/bin/false", home: join(directory, "github-home"), searchPath: "/usr/bin", url: "https://github.com/example/fixture.git" }, capability: { key: { os: process.platform, harness: "codex", harnessVersion: "fixture", adapterVersion: "fixture", probeVersion: "1", configurationDigest: "placeholder", gitPolicyDigest: "fixture" }, checks: [] }, verifierCredentialFile: join(directory, "control", "verifier.json"), supervisorCredentialFile: join(directory, "control", "supervisor.json"), policy: { capture: { allowedUntracked: [], exclusions: [], requiredPaths: [] }, environment: [], copyEnvironment: [], workerHome: join(directory, "worker-home"), githubHome: join(directory, "github-home"), searchPath: dirname(node), setupCommands: [], verificationCommands: [[node, "--test-isolation=none", "--test", "test.js"]], verification: { kind: process.platform === "darwin" ? "macos-sandbox-exec" : "linux-bubblewrap", executable: process.platform === "darwin" ? "/usr/bin/sandbox-exec" : "/usr/bin/bwrap", readOnlyRoots: roots } } });
  runtime.capability.key.configurationDigest = runtimeDigest(runtime);
  // Deliberately synthetic input labelled real to exercise the guard. It is NOT host qualification.
  runtime.capability.checks = [...REQUIRED_CHECKS.manual, "git.metadata-write-isolation", "verification.sandbox"].map(checkId => ({ schemaVersion: 1, checkId, status: "PASS", mode: "manual", observedAt: new Date(Date.now() - 1000).toISOString(), configurationDigest: runtimeDigest(runtime), command: ["synthetic-syscall-fixture"], summary: "Fixture only: no native sandbox boundary proved", evidenceRef: "fixture-only", kind: "real" }));
  return { runtime, repo, head: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]), base: git(["rev-parse", "HEAD"]), environmentDigest: "a".repeat(64) };
}
function refreshDigest(options: VerificationOptions) { options.runtime.capability.key.configurationDigest = runtimeDigest(options.runtime); for (const check of options.runtime.capability.checks) check.configurationDigest = runtimeDigest(options.runtime); }
interface Call { binary: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv }
function syscallFixture(t: TestContext, behavior: { commandCode?: number; probeCode?: number; outputBytes?: number; noClose?: boolean; killCloses?: boolean; onCommand?(call: Call): Promise<void> } = {}) {
  const calls: Call[] = [], metadata: Call[] = [], original = childProcess.spawn, killed: boolean[] = [];
  t.mock.method(childProcess, "spawn", ((binary: string, argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
    if (binary === fixedGit || binary === "/usr/bin/git") { metadata.push({ binary, argv: [...argv], cwd: options.cwd, env: { ...options.env } }); return original(fixedGit, argv, options); }
    const call = { binary, argv: [...argv], cwd: options.cwd, env: { ...options.env } }; calls.push(call);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): boolean; unref(): void };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { killed.push(true); if (behavior.killCloses !== false) setImmediate(() => child.emit("close", null, "SIGKILL")); return true; }; child.unref = () => undefined;
    setImmediate(async () => {
      try {
        const probe = argv.some(arg => arg.includes("COORD_SANDBOX_PROBE_V1"));
        const command = binary === "/usr/bin/bwrap" && !probe;
        if (command) await behavior.onCommand?.(call);
        if (probe) child.stdout.emit("data", Buffer.from("COORD_SANDBOX_PROBE_V1\n"));
        if (command && behavior.outputBytes) child.stderr.emit("data", Buffer.alloc(behavior.outputBytes, 120));
        if (command && behavior.noClose) return;
        child.emit("close", probe ? behavior.probeCode ?? 0 : command ? behavior.commandCode ?? 0 : 0);
      } catch (error) { child.emit("error", error); }
    });
    return child;
  }) as typeof childProcess.spawn);
  return { calls, killed, metadata };
}

function linuxSyscallFixture(t: TestContext, options: VerificationOptions, behavior: Parameters<typeof syscallFixture>[1] = {}) {
  options.runtime.policy.verification.kind = "linux-bubblewrap"; options.runtime.policy.verification.executable = "/usr/bin/bwrap"; refreshDigest(options);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!; Object.defineProperty(process, "platform", { ...platform, value: "linux" }); t.after(() => { Object.defineProperty(process, "platform", platform); });
  const originalRealpath = nativeFs.realpath, originalLstat = nativeFs.lstat, originalReadlink = nativeFs.readlink;
  t.mock.method(nativeFs, "realpath", ((path: string) => path === "/usr/bin/bwrap" ? Promise.resolve(path) : originalRealpath(path)) as typeof nativeFs.realpath);
  t.mock.method(nativeFs, "lstat", ((path: string) => path === "/usr/bin/bwrap" ? Promise.resolve({ isFile: () => true, mode: 0o100755, uid: 0 }) : originalLstat(path)) as typeof nativeFs.lstat);
  t.mock.method(nativeFs, "readlink", ((path: string) => path.startsWith("/proc/self/ns/") ? Promise.resolve(`simulated-host:${path}`) : originalReadlink(path)) as typeof nativeFs.readlink);
  return syscallFixture(t, behavior);
}

test("runner rejects missing, stale and fixture qualification before executing commands", async t => {
  const options = await fixture(t); const syscall = syscallFixture(t);
  for (const kind of ["fixture", "stale", "missing"] as const) {
    const candidate = structuredClone(options);
    if (kind === "fixture") candidate.runtime.capability.checks.find(check => check.checkId === "verification.sandbox")!.kind = "fixture";
    if (kind === "stale") candidate.runtime.capability.checks.find(check => check.checkId === "verification.sandbox")!.observedAt = new Date(Date.now() - 86400_001).toISOString();
    if (kind === "missing") candidate.runtime.capability.checks = [];
    await assert.rejects(runVerification(candidate), code("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION"));
  }
  assert.equal(syscall.calls.length, 0);
});
test("runner rejects broad/credential roots and alternate sandbox executables", nativeFixture, async t => {
  const options = await fixture(t), syscall = linuxSyscallFixture(t, options);
  for (const root of ["/", process.env.HOME!, options.runtime.stateDirectory]) {
    const candidate = structuredClone(options); candidate.runtime.policy.verification.readOnlyRoots = [root]; refreshDigest(candidate);
    await assert.rejects(runVerification(candidate), code("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION"));
  }
  const candidate = structuredClone(options); candidate.runtime.policy.verification.executable = process.execPath; refreshDigest(candidate);
  await assert.rejects(runVerification(candidate), code("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION")); assert.equal(syscall.calls.length, 0);
});
test("syscall fixture proves fixed sandbox argv/env and exact artifact evidence, not host qualification", nativeFixture, async t => {
  const options = await fixture(t);
  const syscall = linuxSyscallFixture(t, options, { onCommand: async call => {
    assert.notEqual(call.cwd, options.repo); assert.equal(existsSync(join(call.cwd, ".git")), false); assert.equal((await readFile(join(call.cwd, "test.js"), "utf8")).includes("Synthetic"), true);
  } });
  const result = await runVerification(options);
  assert.deepEqual(result.commands, [{ argv: options.runtime.policy.verificationCommands[0], exitCode: 0 }]);
  assert.equal(result.head, options.head); assert.equal(result.tree, options.tree); assert.equal(result.base, options.base); assert.equal(result.environmentDigest, options.environmentDigest); assert(Number.isFinite(Date.parse(result.recordedAt)));
  const sandbox = syscall.calls.filter(call => call.binary === "/usr/bin/bwrap"); assert.equal(sandbox.length, 2);
  for (const call of sandbox) { for (const flag of ["--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session", "--cap-drop", "--clearenv", "--proc"]) assert(call.argv.includes(flag)); assert(!call.argv.includes("--share-net")); assert(!call.argv.includes(options.repo)); assert(!call.argv.includes(options.runtime.verifierCredentialFile)); assert.deepEqual(call.env, {}); }
});
test("dirty source, wrong head and failed native probe never execute policy commands", nativeFixture, async t => {
  const options = await fixture(t), syscall = linuxSyscallFixture(t, options, { probeCode: 71 });
  await assert.rejects(runVerification({ ...options, head: "f".repeat(40) }), code("PUBLICATION_STALE"));
  await writeFile(join(options.repo, "test.js"), "changed without commit"); await assert.rejects(runVerification(options), code("PUBLICATION_STALE"));
  await writeFile(join(options.repo, "test.js"), "// Synthetic repository; syscall fixtures never execute this source.\n");
  await assert.rejects(runVerification(options), code("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION"));
  assert.equal(syscall.calls.filter(call => call.binary === "/usr/bin/bwrap" && !call.argv.some(arg => arg.includes("COORD_SANDBOX_PROBE_V1"))).length, 0);
});
test("failed commands, changed source and output overflow cannot manufacture passing evidence", nativeFixture, async t => {
  await t.test("exit failure", async t => { const options = await fixture(t); linuxSyscallFixture(t, options, { commandCode: 1 }); await assert.rejects(runVerification(options), code("PUBLICATION_STALE")); });
  await t.test("source changes while command runs", async t => { const options = await fixture(t); linuxSyscallFixture(t, options, { onCommand: async () => { await writeFile(join(options.repo, "test.js"), "changed during verification"); } }); await assert.rejects(runVerification(options), code("PUBLICATION_STALE")); });
  await t.test("artifact copy changes while command runs", async t => { const options = await fixture(t); linuxSyscallFixture(t, options, { onCommand: async call => { const path = join(call.cwd, "test.js"); await chmod(path, 0o600); await writeFile(path, "changed isolated tree"); } }); await assert.rejects(runVerification(options), code("PUBLICATION_STALE")); });
  await t.test("untracked artifact additions", async t => { const options = await fixture(t); linuxSyscallFixture(t, options, { onCommand: async call => { await writeFile(join(call.cwd, "unexpected"), "not in final tree"); } }); await assert.rejects(runVerification(options), code("PUBLICATION_STALE")); });
  await t.test("bounded discarded output", async t => { const options = await fixture(t), syscall = linuxSyscallFixture(t, options, { outputBytes: VERIFICATION_LIMITS.outputBytes + 1 }); await assert.rejects(runVerification(options), code("BLOCKED_ENV")); assert.equal(syscall.killed.length, 1); });
});


test("macOS remains blocked even if caller supplies a passing record and syscall mocks could fake success", nativeFixture, async t => {
  const options = await fixture(t); options.runtime.policy.verification.kind = "macos-sandbox-exec"; options.runtime.policy.verification.executable = "/usr/bin/sandbox-exec"; refreshDigest(options);
  const syscall = syscallFixture(t);
  await assert.rejects(runVerification(options), error => code("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION")(error) && (error as Error).message.includes("parent-death"));
  assert.equal(syscall.calls.length, 0);
});
test("timeout requires positive sandbox close and unknown close retains private scratch", nativeFixture, async t => {
  await t.test("positive close after timeout", async t => {
    const options = await fixture(t); t.mock.timers.enable({ apis: ["setTimeout"] });
    let reached!: () => void; const command = new Promise<void>(resolve => { reached = resolve; });
    const syscall = linuxSyscallFixture(t, options, { noClose: true, onCommand: async () => { reached(); } });
    const result = runVerification(options); await command; await new Promise<void>(resolve => setImmediate(resolve)); t.mock.timers.tick(VERIFICATION_LIMITS.timeoutMs);
    await assert.rejects(result, code("BLOCKED_ENV")); assert.equal(syscall.killed.length, 1);
  });
  await t.test("unconfirmed exit", async t => {
    const options = await fixture(t); t.mock.timers.enable({ apis: ["setTimeout"] });
    let reached!: () => void; const command = new Promise<void>(resolve => { reached = resolve; });
    const syscall = linuxSyscallFixture(t, options, { outputBytes: VERIFICATION_LIMITS.outputBytes + 1, noClose: true, killCloses: false, onCommand: async () => { reached(); } });
    const result = runVerification(options); await command; await new Promise<void>(resolve => setImmediate(resolve)); t.mock.timers.tick(1000);
    await assert.rejects(result, code("LAUNCH_UNCERTAIN"));
    const artifact = syscall.calls.find(call => call.binary === "/usr/bin/bwrap" && !call.argv.some(arg => arg.includes("COORD_SANDBOX_PROBE_V1")))!.cwd;
    assert.equal(existsSync(artifact), true); await rm(dirname(artifact), { recursive: true, force: true });
  });
});

test("verification snapshots approved identity and argv before asynchronous work", nativeFixture, async t => {
  const options = await fixture(t); linuxSyscallFixture(t, options);
  const original = structuredClone(options), result = runVerification(options);
  options.tree = "f".repeat(40); options.base = "e".repeat(40); options.runtime.policy.verificationCommands[0] = ["/usr/bin/false"];
  const evidence = await result;
  assert.equal(evidence.tree, original.tree); assert.equal(evidence.base, original.base); assert.deepEqual(evidence.commands[0]?.argv, original.runtime.policy.verificationCommands[0]);
});

test("cleared-environment verification rejects required or copied app variables before commands", async t => {
  const options = await fixture(t), syscall = syscallFixture(t);
  for (const copied of [true, false]) {
    const candidate = structuredClone(options);
    if (copied) candidate.runtime.policy.copyEnvironment = ["DB_URL"];
    else candidate.runtime.policy.environment = [{ name: "DB_URL", modes: ["manual", "managed"], type: "url" }];
    refreshDigest(candidate);
    await assert.rejects(runVerification(candidate), error => code("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION")(error) && (error as Error).message.includes("environment"));
  }
  assert.equal(syscall.calls.length, 0);
});

test("actual provider HOME and startup credential sources cannot hide inside a toolchain read root", nativeFixture, async t => {
  const options = await fixture(t), syscall = syscallFixture(t), root = options.runtime.policy.verification.readOnlyRoots[0]!;
  for (const reference of ["transport", "agent", "registry"] as const) {
    const candidate = structuredClone(options);
    if (reference === "transport") candidate.runtime.gitTransport.home = join(root, "synthetic-provider-home");
    if (reference === "agent") candidate.runtime.agentCredentialDirectory = join(root, "synthetic-agent-credentials");
    if (reference === "registry") candidate.runtime.trustedRegistryPath = join(root, "synthetic-control", "registry.json");
    refreshDigest(candidate);
    await assert.rejects(runVerification(candidate), error => code("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION")(error) && (error as Error).message.includes("read roots"));
  }
  assert.equal(syscall.calls.length, 0);
});

test("explicit verification PATH excludes worker coord/control tools without adding readable roots", nativeFixture, async t => {
  const options = await fixture(t), narrowPath = options.runtime.policy.searchPath, controlBin = join(options.runtime.stateDirectory, "coord-bin"); await mkdir(controlBin); await writeFile(join(controlBin, "node"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  options.runtime.policy.searchPath = `${controlBin}:${narrowPath}`; options.runtime.policy.verification.searchPath = narrowPath; options.runtime.policy.verificationCommands[0]![0] = "node";
  const syscall = linuxSyscallFixture(t, options); const evidence = await runVerification(options); assert.equal(evidence.commands[0]?.argv[0], "node");
  for (const call of syscall.calls) {
    assert(!call.argv.includes(options.runtime.policy.searchPath));
    if (call.binary === "/usr/bin/bwrap") { const index = call.argv.findIndex((arg, position) => arg === "PATH" && call.argv[position - 1] === "--setenv"); assert.equal(call.argv[index + 1], narrowPath); }
    else assert.equal(call.env.PATH, narrowPath);
  }
  const count = syscall.calls.length;
  const bad = structuredClone(options); bad.runtime.policy.verification.searchPath = options.runtime.policy.searchPath; refreshDigest(bad);
  await assert.rejects(runVerification(bad), error => code("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION")(error) && (error as Error).message.includes("PATH"));
  delete bad.runtime.policy.verification.searchPath; refreshDigest(bad);
  await assert.rejects(runVerification(bad), error => code("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION")(error) && (error as Error).message.includes("PATH")); assert.equal(syscall.calls.length, count);
});

test("privileged metadata reads require qualification and disable lazy fetch, transports and helpers", nativeFixture, async t => {
  const options = await fixture(t), syscall = linuxSyscallFixture(t, options);
  const missing = structuredClone(options); missing.runtime.capability.checks = missing.runtime.capability.checks.filter(check => check.checkId !== "git.metadata-write-isolation");
  await assert.rejects(runVerification(missing), code("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION")); assert.equal(syscall.metadata.length, 0); assert.equal(syscall.calls.length, 0);
  await runVerification(options); assert(syscall.metadata.length > 0);
  for (const call of syscall.metadata) {
    assert.equal(call.env.GIT_NO_LAZY_FETCH, "1"); assert.equal(call.env.GIT_ALLOW_PROTOCOL, ""); assert.equal(call.env.GIT_PROTOCOL_FROM_USER, "0"); assert.equal(call.env.GIT_CONFIG_GLOBAL, "/dev/null"); assert.equal(call.env.GIT_CONFIG_SYSTEM, "/dev/null"); assert.equal(call.env.GIT_ASKPASS, "/usr/bin/false");
    assert(call.argv.includes("credential.helper=")); assert(call.argv.includes("core.sshCommand=/usr/bin/false")); assert(!call.argv.some(arg => ["fetch", "push", "ls-remote"].includes(arg)));
  }
});
