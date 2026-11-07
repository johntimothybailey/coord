import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, arch, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { convexToJson } from "convex/values";
import type { Value } from "convex/values";
import * as auth from "../convex/auth.js";
import * as projects from "../convex/projects.js";
import * as goals from "../convex/goals.js";
import * as tasks from "../convex/tasks.js";
import * as machines from "../convex/machines.js";
import * as lifecycle from "../convex/lifecycle.js";
import * as checkpoints from "../convex/checkpoints.js";
import * as scans from "../convex/scans.js";
import * as publications from "../convex/publications.js";
import * as dispatch from "../convex/dispatch.js";
import * as memories from "../convex/memories.js";
import { BackendFixture } from "./backend.fixture.js";
import { git, gitText, captureDigest } from "../src/checkpoint.js";
import { credentialKey, parseConfig } from "../src/config.js";
import { parseRuntime, runtimeDigest } from "../src/command-runtime.js";
import { CAPABILITIES, CLIENT_VERSION, REQUIRED_CHECKS } from "../src/protocol.js";
import { main } from "../src/cli.js";
import { connectWorkspace } from "../src/client.js";

/** Disposable taskboard + real Git transport + exported handlers. Synthetic evidence is never host qualification. */
export async function commandsFixture() {
  const originalHome = process.env.HOME, originalPath = process.env.PATH, originalFetch = globalThis.fetch, originalCwd = process.cwd(), originalLog = console.log;
  const directory = await realpath(await mkdtemp(join(tmpdir(), "coord-command-rehearsal-")));
  const repo = join(directory, "pilot"), bare = join(directory, "remote.git"), home = join(directory, "worker-home"), operator = join(directory, "operator"), bin = join(directory, "bin");
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(operator, { mode: 0o700 }), mkdir(bin, { mode: 0o700 })]);
  await mkdir(join(directory, "github-home"), { mode: 0o700 });
  const realGit = await realpath(existsSync("/opt/homebrew/bin/git") ? "/opt/homebrew/bin/git" : "/usr/bin/git"), remote = "https://github.com/fixture/coord-pilot-taskboard.git";
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const wrapper = `#!/bin/sh
export GIT_ALLOW_PROTOCOL=file
for coord_fixture_arg in "$@"; do
  case "$coord_fixture_arg" in
    fetch|push|ls-remote) exec ${quote(realGit)} -c protocol.file.allow=always -c ${quote(`url.${bare}.insteadOf=${remote}`)} "$@" ;;
  esac
done
exec ${quote(realGit)} "$@"
`;
  await writeFile(join(bin, "git"), wrapper); await chmod(join(bin, "git"), 0o755);
  await writeFile(join(bin, "codex"), `#!${process.execPath}\nimport{writeFileSync}from'node:fs';if(process.argv.includes('--version'))console.log('codex-cli 1.0.0');else writeFileSync('.coord-local/harness-start.json',JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),environmentNames:Object.keys(process.env)}));\n`); await chmod(join(bin, "codex"), 0o755);
  const gh = `#!${process.execPath}
import{readFileSync,writeFileSync,existsSync}from'node:fs';import{spawnSync}from'node:child_process';
const argv=process.argv.slice(2),route=argv.find(v=>v.startsWith('repos/'));if(!route)process.exit(1);
const file=process.env.HOME+'/fixture-reviews.json',all=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[];
const sha=ref=>{const r=spawnSync(${JSON.stringify(realGit)},['--git-dir',${JSON.stringify(bare)},'rev-parse',ref],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null'}});if(r.status!==0)process.exit(2);return r.stdout.trim()};
if(argv[argv.indexOf('--method')+1]==='POST'){const input=JSON.parse(readFileSync(0,'utf8')),n=all.length+1;const record={number:n,html_url:'https://github.com/fixture/coord-pilot-taskboard/pull/'+n,state:'open',merged_at:null,body:input.body,head:{ref:input.head,sha:sha('refs/heads/'+input.head),repo:{full_name:'fixture/coord-pilot-taskboard'}},base:{ref:input.base,sha:sha('refs/heads/'+input.base),repo:{full_name:'fixture/coord-pilot-taskboard'}}};all.push(record);writeFileSync(file,JSON.stringify(all),{mode:384});console.log(JSON.stringify(record));}
else if(route.includes('?'))console.log(JSON.stringify([all]));else console.log(JSON.stringify(all.find(v=>String(v.number)===route.split('/').at(-1))));
`;
  await writeFile(join(bin, "gh"), gh); await chmod(join(bin, "gh"), 0o755);
  process.env.HOME = home; process.env.PATH = `${bin}:${dirname(realGit)}:${originalPath ?? "/usr/bin:/bin"}`;
  await cp(join(originalCwd, "tests/pilot/taskboard"), repo, { recursive: true });
  const config = parseConfig({ schemaVersion: 1, backendId: "fixture_backend", backendUrl: "https://fixture.convex.cloud", projectId: "fixture_pilot", repository: "github.com/fixture/coord-pilot-taskboard", remote, defaultBranch: "main", ruleTargets: ["AGENTS.md"] });
  await writeFile(join(repo, ".coord.json"), JSON.stringify(config, null, 2) + "\n");
  await git(repo, ["init", "--quiet", "--initial-branch=main"]); await git(repo, ["init", "--quiet", "--bare", bare]);
  await git(repo, ["add", "-A"]); await git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "Establish disposable real taskboard baseline"]);
  await git(repo, ["remote", "add", "origin", remote]); await git(repo, ["push", "--quiet", bare, "HEAD:refs/heads/main"]);
  const base = await gitText(repo, ["rev-parse", "HEAD"]), commonGitDir = await realpath(join(repo, ".git"));
  const policy = { allowedUntracked: ["test/new.test.js"], exclusions: [], requiredPaths: ["store.js", "test/store.test.js"] };
  let runtime = parseRuntime({ schemaVersion: 1, trustedRegistryPath:join(home,".config/coord/workspaces.json"),agentCredentialDirectory:join(home,".config/coord/credentials"), workspaceRoot: repo, stateDirectory: join(operator, "state"), worktreeRoot: join(directory, "worktrees"), machineId: "fixture_machine", memberId: "agent", harness: { kind: "codex", executable: join(bin, "codex") }, capability: { key: { os: `${platform()}/${release()}/${arch()}`, harness: "codex", harnessVersion: "1.0.0", adapterVersion: "1", probeVersion: "1", configurationDigest: "pending", gitPolicyDigest: captureDigest({ fixtureOnly: true }) }, checks: [] }, gitTransport: {kind: "github-https",executable:join(bin,"gh"),home:join(directory,"github-home"),searchPath:`${bin}:${dirname(realGit)}:/usr/bin:/bin`,url:remote}, verifierCredentialFile: join(operator, "verifier.json"), supervisorCredentialFile: join(operator, "supervisor.json"), policy: { capture: policy, environment: [], copyEnvironment: [], workerHome: home, githubHome: join(directory, "github-home"), searchPath: `${dirname(process.execPath)}:/usr/bin`, setupCommands: [], verificationCommands: [[process.execPath, "--test-isolation=none", "--test", "test/store.test.js"]], verification: { kind: process.platform === "linux" ? "linux-bubblewrap" : "macos-sandbox-exec", executable: process.platform === "linux" ? "/usr/bin/bwrap" : "/usr/bin/sandbox-exec", readOnlyRoots: [dirname(process.execPath), "/usr/bin", "/usr/lib", "/System/Library"] } } });
  const nodeRoot = process.execPath.includes("/.volta/") || process.execPath.includes("/.nvm/") ? dirname(dirname(process.execPath)) : dirname(process.execPath);
  runtime.policy.verification.readOnlyRoots = [...new Set([nodeRoot, "/usr/bin", "/usr/lib", ...(existsSync("/System/Library") ? ["/System/Library"] : [])])];
  const configDigest = runtimeDigest(runtime); runtime.capability.key.configurationDigest = configDigest;
  runtime.capability.checks = [...REQUIRED_CHECKS.managed, "verification.sandbox", "process.cgroup-control-isolation", "git.metadata-write-isolation", "mcp.runtime-actions"].map(checkId => ({ schemaVersion: 1, checkId, status: "PASS", mode: "managed", observedAt: new Date(Date.now() - 1000).toISOString(), configurationDigest: configDigest, command: ["synthetic-test-fixture-only"], summary: "Synthetic handler/CLI fixture, not a host capability claim", evidenceRef: "fixture-only", kind: "real" }));
  runtime = parseRuntime(runtime);
  const runtimePath = join(operator, "runtime.json"); await writeFile(runtimePath, JSON.stringify(runtime), { mode: 0o600 });
  const humanToken = randomBytes(32).toString("hex"), agentToken = randomBytes(32).toString("hex"), verifierToken = randomBytes(32).toString("hex"), supervisorToken = randomBytes(32).toString("hex");
  const backend = new BackendFixture(); let serial = 0;
  const identity = (token = agentToken) => ({ token, backendId: config.backendId, projectId: config.projectId, protocolVersion: 1, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], requestId: `fixture_request_${++serial}` });
  const expiresAt = Date.now() + 86400_000;
  await backend.call(auth.bootstrap, { backendId: config.backendId, projectId: config.projectId, repository: config.repository, remote, defaultBranch: "main", allowedPaths: ["public", "test", "store.js", "server.js", "package.json", "README.md", ".coord.json", "seeds"], excludedPaths: [], ruleTargets: ["AGENTS.md"], humanId: "human", humanDigest: await auth.digest(humanToken), agentId: "agent", agentDigest: await auth.digest(agentToken), expiresAt });
  await backend.call(projects.configure, { ...identity(humanToken), repository: config.repository, remote, defaultBranch: "main", allowedPaths: ["public", "test", "store.js", "server.js", "package.json", "README.md", ".coord.json", "seeds"], excludedPaths: [], ruleTargets: ["AGENTS.md"], sharingApproved: true, capturePolicyDigest: captureDigest(policy), capacity: 2, taskCap: 20 });
  const goal = await backend.call(goals.propose, { ...identity(), goalId: "goal", expectedRevision: 0, content: "Improve real taskboard fixture validation", taskLimit: 20, runTimeoutMs: 1800_000 }) as { revision: number; hash: string };
  await backend.call(goals.approve, { ...identity(humanToken), goalId: "goal", ...goal });
  await backend.call(machines.provisionQualification, { backendId: config.backendId, projectId: config.projectId, memberId: "agent", machineId: runtime.machineId, capacity: 1, modes: ["manual", "managed"], key: runtime.capability.key, checks: runtime.capability.checks, evidenceRef: "fixture-only-never-real-qualification", expiresAt, supervisorId: "supervisor", supervisorToken, artifactVerifierId: "verifier", artifactVerifierToken: verifierToken });
  await backend.call(tasks.propose, { ...identity(), taskId: "task", goalId: "goal", goalRevision: 1, title: "Refine taskboard store through disposable CLI rehearsal", scope: ["store.js", "test"], dependencies: [], executionBase: { sha: base, revision: 1, remoteRef: "refs/heads/main" } });
  const credentialDir = join(home, ".config/coord/credentials"); await mkdir(credentialDir, { recursive: true, mode: 0o700 });
  await writeFile(join(credentialDir, `${credentialKey(config.backendId, config.backendUrl)}.json`), JSON.stringify({ schemaVersion: 1, backendId: config.backendId, backendUrl: config.backendUrl, role: "agent", memberId: "agent", projectIds: [config.projectId], expiresAt, token: agentToken }), { mode: 0o600 });
  await writeFile(join(home, ".config/coord/workspaces.json"), JSON.stringify({ schemaVersion: 1, workspaces: [{ ...config, root: repo, commonGitDir, approvalReceipt: "fixture-only-routing-no-human-proof" }] }), { mode: 0o600 });
  for (const [role, token] of [["artifact_verifier", verifierToken], ["supervisor", supervisorToken]] as const) await writeFile(role === "artifact_verifier" ? runtime.verifierCredentialFile : runtime.supervisorCredentialFile!, JSON.stringify({ schemaVersion: 1, backendId: config.backendId, backendUrl: config.backendUrl, role, memberId: "agent", machineId: runtime.machineId, projectIds: [config.projectId], expiresAt, token }), { mode: 0o600 });
  const modules = { auth, projects, goals, tasks, machines, lifecycle, checkpoints, scans, publications, dispatch, memories };
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  let loseOnce: string | undefined;
  let offline = false;
  let beforeCall: ((path: string, args: Record<string, unknown>) => Promise<void>) | undefined;
  globalThis.fetch = async (input, init) => {
    if (offline) throw new Error("Synthetic backend unavailable");
    if (new URL(String(input)).origin !== config.backendUrl) throw new Error("Unexpected external transport");
    const body = JSON.parse(String(init?.body)) as { path: string; args: Record<string, unknown>[] }, args = body.args[0]!;
    calls.push({ path: body.path, args });
    const [module, name] = body.path.split(":") as [keyof typeof modules, string];
    const handler = (modules[module] as Record<string, unknown>)[name] as typeof auth.handshake;
    try {
      await beforeCall?.(body.path, args);
      const value = await backend.call(handler, args as never);
      if (loseOnce === body.path) { loseOnce = undefined; throw new Error("Fixture lost successful reply"); }
      return new Response(JSON.stringify({ status: "success", value: convexToJson(value as Value), logLines: [] }));
    } catch (error) {
      if (!(error as { data?: unknown }).data) throw error;
      return new Response(JSON.stringify({ status: "error", errorMessage: "Fixture denied", errorData: (error as { data: Value }).data, logLines: [] }));
    }
  };
  const cliOutput: string[] = [];
  async function cli(cwd: string, argv: string[]): Promise<unknown> {
    const output: string[] = []; process.chdir(cwd); console.log = (...values: unknown[]) => { const text = values.map(String).join(" "); output.push(text); cliOutput.push(text); };
    try { await main(argv); return output.length ? JSON.parse(output.at(-1)!) as unknown : undefined; } finally { console.log = originalLog; process.chdir(originalCwd); }
  }
  return { directory, repo, bare, config, runtime, runtimePath, backend, calls, identity, cli, cliOutput, approveFixtureGoal(args: { goalId: string; revision: number; hash: string }) { return backend.call(goals.approve, { ...identity(humanToken), ...args }); }, setOffline(value: boolean) { offline = value; }, beforeCall(value: ((path: string, args: Record<string, unknown>) => Promise<void>) | undefined) { beforeCall = value; }, controlGoal(state: "paused" | "cancelled") { return backend.call(goals.control, { ...identity(humanToken), goalId: "goal", state }); }, connect(cwd: string) { return connectWorkspace(cwd, { registryPath: runtime.trustedRegistryPath, credentialDirectory: runtime.agentCredentialDirectory }); }, loseReply(path: string) { loseOnce = path; }, async saveRuntime() { await writeFile(runtimePath, JSON.stringify(runtime), { mode: 0o600 }); }, async restore() { globalThis.fetch = originalFetch; console.log = originalLog; process.chdir(originalCwd); if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; process.env.PATH = originalPath; await rm(directory, { recursive: true, force: true }); }, async contents(path: string) { return readFile(path, "utf8"); } };
}
