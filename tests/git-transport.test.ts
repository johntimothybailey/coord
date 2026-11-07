import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { captureCheckpoint, captureDigest, git, gitText, publishCheckpoint, snapshotCaptureOptions, type CaptureOptions } from "../src/checkpoint.js";
import { requireGitMetadataIsolation, validateGitTransport, type GitTransport, type GitMetadataIsolation } from "../src/git-transport.js";
import { REQUIRED_CHECKS, type CapabilityKey } from "../src/protocol.js";

const approvedUrl = "https://github.com/fixture/coord-pilot-taskboard.git";
const canary = "FAKE_AMBIENT_SECRET_transport_784e21";
const key: CapabilityKey = { os: "SYSCALL-FIXTURE", harness: "codex", harnessVersion: "fixture-only", adapterVersion: "1", probeVersion: "1", configurationDigest: "a".repeat(64), gitPolicyDigest: "b".repeat(64) };
// Synthetic guard records never establish actual host write-denial or leave this disposable test.
function metadataProof(): GitMetadataIsolation { return { expectedKey: { ...key }, mode: "manual", capabilityEvidence: { key: { ...key }, checks: [...REQUIRED_CHECKS.manual, "git.metadata-write-isolation"].map(checkId => ({ schemaVersion: 1, checkId, status: "PASS", mode: "manual", observedAt: new Date().toISOString(), configurationDigest: key.configurationDigest, command: [], summary: "FIXTURE ONLY", evidenceRef: "fixture-only:no-host-qualification", kind: "real" })) } }; }
interface Observation { role: string; argv: string[]; environment: Record<string, string> }
interface Fixture { repo: string; directory: string; bare: string; transport: GitTransport; proof: GitMetadataIsolation; log: string; config: Buffer; gitExecPath: string; networkCalls(): Promise<Observation[]> }
async function fixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "coord-git-transport-FIXTURE-")));
  const repo = join(directory, "source"), bare = join(directory, "remote.git"), home = join(directory, "protected-gh-home"), bin = join(directory, "bin"), log = join(directory, "observations.jsonl");
  const realGit = await realpath(execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim());
  const node = await realpath(process.execPath);
  try {
    for (const path of [repo, home, bin]) await mkdir(path, { mode: 0o700 });
    await git(repo, ["init", "--quiet", "-b", "main"]); await git(repo, ["init", "--quiet", "--bare", bare]);
    await writeFile(join(repo, "source.txt"), "initial fixture source\n"); await git(repo, ["add", "source.txt"]);
    await git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "Establish transport fixture"]);
    await git(repo, ["remote", "add", "origin", bare]); await git(repo, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
    await git(repo, ["remote", "set-url", "origin", approvedUrl]);
    const gh = join(bin, "approved gh's fixture");
    await writeFile(gh, `#!${node}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({role:'gh',argv:process.argv.slice(2),environment:process.env})+'\\n');process.stdout.write('username=fixture\\npassword=FAKE_HELPER_TOKEN_ONLY\\n');\n`); await chmod(gh, 0o700);
    // This selected fake Git is the only fixture route. It rewrites the one approved URL to a disposable bare repository.
    // The credential-fill subcall exercises Git's real shell quoting/helper protocol, discards the fake credential output,
    // and performs no HTTP request or real login. This is not production transport qualification.
    const mutation = join(directory, "network-mutation.json");
    const script = `#!${node}\nconst fs=require('node:fs'),cp=require('node:child_process');let args=process.argv.slice(2),i=0;while(args[i]&&args[i].startsWith('-')){if(args[i]==='-c'){i+=2}else if(args[i]==='--no-optional-locks'||args[i]==='--literal-pathspecs'||args[i].startsWith('--git-dir=')){i++}else break}const verb=args[i];if(['fetch','push','ls-remote'].includes(verb)){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({role:'network-FIXTURE',argv:args,environment:process.env})+'\\n');if(!args.includes(${JSON.stringify(approvedUrl)}))process.exit(93);if(fs.existsSync(${JSON.stringify(mutation)})){const change=JSON.parse(fs.readFileSync(${JSON.stringify(mutation)},'utf8'));cp.execFileSync(${JSON.stringify(realGit)},['-C',${JSON.stringify(repo)},'config',change.key,change.value],{env:process.env});const probe=cp.spawnSync(${JSON.stringify(realGit)},[...args.slice(0,i),'config','--get',change.key],{env:process.env});if(probe.status!==1)process.exit(96)}const credential=cp.spawnSync(${JSON.stringify(realGit)},[...args.slice(0,i),'credential','fill'],{env:process.env,input:'protocol=https\\nhost=github.com\\npath=fixture/coord-pilot-taskboard.git\\n\\n',encoding:'utf8'});if(credential.status!==0)process.exit(94);args=args.map(value=>value===${JSON.stringify(approvedUrl)}?${JSON.stringify(bare)}:value)}const result=cp.spawnSync(${JSON.stringify(realGit)},args,{env:{...process.env,GIT_ALLOW_PROTOCOL:'file'},stdio:'inherit'});process.exit(result.status===null?95:result.status);\n`;
    await writeFile(join(bin, "git"), script); await chmod(join(bin, "git"), 0o700);
    const transport: GitTransport = { kind: "github-https", executable: gh, home, searchPath: [bin, dirname(realGit), "/usr/bin", "/bin"].join(delimiter), url: approvedUrl };
    const config = await readFile(join(repo, ".git", "config"));
    const gitExecPath = execFileSync(realGit, ["--exec-path"], { encoding: "utf8", env: { PATH: dirname(realGit) } }).trim();
    await run({ repo, directory, bare, transport, proof: metadataProof(), log, config, gitExecPath, networkCalls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Observation) });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("fixed GitHub transport uses only selected helper/home/path, TLS and exact URL; ambient secrets/proxies/loaders never reach children", async () => {
  await fixture(async f => {
    const previous = new Map<string, string | undefined>();
    const loader = join(f.directory, "ambient-loader.cjs"), marker = join(f.directory, "loader-ran");
    const globalConfig = join(f.transport.home, ".gitconfig"), globalContents = `[credential]\n helper = !touch '${marker}'\n`;
    await writeFile(globalConfig, globalContents);
    await writeFile(loader, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected loader execution')`);
    for (const name of ["GH_TOKEN", "OPENAI_API_KEY", "HTTPS_PROXY", "ALL_PROXY", "GIT_TRACE_CURL", "SYNTHETIC_VAULT_TOKEN", "NODE_OPTIONS"]) { previous.set(name, process.env[name]); process.env[name] = name === "NODE_OPTIONS" ? `--require=${loader}` : canary; }
    try {
      const result = await git(f.repo, ["ls-remote", "--refs", "origin", "refs/heads/main"], { transport: f.transport, metadataIsolation: f.proof });
      assert(!result.stdout.toString().includes(canary)); assert(!result.stdout.toString().includes("FAKE_HELPER_TOKEN"));
      const calls = await f.networkCalls(), network = calls.find(call => call.role === "network-FIXTURE")!, helper = calls.find(call => call.role === "gh")!;
      assert(network); assert(helper); assert.deepEqual(helper.argv, ["auth", "git-credential", "get"]);
      for (const call of calls) {
        assert.equal(call.environment.HOME, f.transport.home);
        assert.equal(call.environment.PATH, call.role === "gh" ? `${f.gitExecPath}${delimiter}${f.transport.searchPath}` : f.transport.searchPath);
        assert(!JSON.stringify(call.environment).includes(canary)); assert.equal(call.environment.NODE_OPTIONS, undefined);
      }
      for (const setting of ["credential.helper=", "credential.useHttpPath=true", "http.extraHeader=", "http.proxy=", "http.sslVerify=true", "http.followRedirects=false", "core.sshCommand=/usr/bin/false"]) assert(network.argv.includes(setting));
      for (const setting of ["extraHeader=", "proxy=", "sslVerify=true", "followRedirects=false"]) assert(network.argv.includes(`http.${approvedUrl}.${setting}`));
      assert(network.argv.includes(approvedUrl)); assert(!network.argv.includes("origin"));
      assert.equal(await stat(marker).then(() => true, () => false), false);
      assert.deepEqual(await readFile(join(f.repo, ".git", "config")), f.config);
      assert.equal(await readFile(globalConfig, "utf8"), globalContents);
    } finally { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
  });
});

test("repository shell/helper/include/filter/proxy/TLS overrides are rejected before any network or outside-canary read", async () => {
  await fixture(async f => {
    const outside = join(f.directory, "outside-worker-fake-vault"), marker = join(f.directory, "exfiltration-marker"), script = join(f.repo, "malicious-helper.sh");
    await writeFile(outside, canary); await writeFile(script, `#!/bin/sh\ncat '${outside}' > '${marker}'\nexit 1\n`); await chmod(script, 0o700);
    const include = join(f.directory, "injected.gitconfig"); await writeFile(include, `[credential]\n helper = !${script}\n`);
    const cases = [["core.sshCommand", script], ["credential.helper", `!${script}`], ["include.path", include], ["filter.fixture.clean", script], ["filter.fixture.smudge", script], ["http.proxy", "https://unapproved.invalid"], ["http.sslVerify", "false"], [`http.${approvedUrl}.extraHeader`, `Authorization: ${canary}`], ["url.ssh://unapproved.invalid/.insteadOf", "https://github.com/"], ["remote.origin.uploadpack", script], ["core.fsmonitor", script]];
    for (const [name, value] of cases) {
      await writeFile(join(f.repo, ".git", "config"), f.config); await git(f.repo, ["config", name!, value!]);
      await assert.rejects(git(f.repo, ["fetch", "--no-tags", "origin", "refs/heads/main:refs/coord/fixture"], { transport: f.transport, metadataIsolation: f.proof }), error => error instanceof Error && !error.message.includes(canary) && /unsupported|withheld/.test(error.message));
      assert.equal((await f.networkCalls()).length, 0); assert.equal(await stat(marker).then(() => true, () => false), false);
    }
    await writeFile(join(f.repo, ".git", "config"), f.config);
    await git(f.repo, ["remote", "set-url", "origin", "git@github.com:fixture/no-network.git"]);
    await git(f.repo, ["config", "core.sshCommand", script]);
    await assert.rejects(git(f.repo, ["fetch", "origin", "refs/heads/main"], { transport: f.transport, metadataIsolation: f.proof }));
    assert.equal(await stat(marker).then(() => true, () => false), false);
  });
});

test("alternate destinations, runtime helper snippets, env config injection and nonprivate provider homes fail closed", async () => {
  await fixture(async f => {
    await assert.rejects(git(f.repo, ["ls-remote", "https://github.com/unapproved/other.git"], { transport: f.transport, metadataIsolation: f.proof }));
    await assert.rejects(git(f.repo, ["credential", "fill"], { transport: f.transport, metadataIsolation: f.proof }));
    await assert.rejects(git(f.repo, ["rev-parse", "HEAD"], { transport: f.transport, metadataIsolation: f.proof, env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "!unapproved" } }), /Only internal/);
    await assert.rejects(validateGitTransport({ ...f.transport, helper: "arbitrary shell" } as GitTransport));
    await assert.rejects(validateGitTransport({ ...f.transport, url: "https://user:FAKE_TOKEN@github.com/fixture/repo.git" }));
    await chmod(f.transport.home, 0o755); await assert.rejects(validateGitTransport(f.transport)); await chmod(f.transport.home, 0o700);
    await writeFile(join(f.transport.home, ".netrc"), "FAKE_UNSELECTED_CREDENTIAL_SOURCE"); await assert.rejects(validateGitTransport(f.transport));
    assert.equal((await f.networkCalls()).length, 0);
  });
});

test("transport propagates through exact safe snapshot fetch/push/readback on a disposable fake HTTP route", async () => {
  await fixture(async f => {
    const base = await gitText(f.repo, ["rev-parse", "HEAD"]);
    await writeFile(join(f.repo, "private-history.txt"), canary); await git(f.repo, ["add", "private-history.txt"]);
    await git(f.repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "Keep private fixture ancestry local"]);
    await unlink(join(f.repo, "private-history.txt")); await git(f.repo, ["add", "-A"]);
    await git(f.repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "Delete fixture-only secret"]);
    await git(f.repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "tag", "-a", "private-fixture-tag", base, "-m", canary]);
    await writeFile(join(f.repo, "source.txt"), "portable fixture update\n");
    const options: CaptureOptions = { repo: f.repo, remote: { name: "origin", url: approvedUrl }, gitTransport: f.transport, gitMetadataIsolation: f.proof, checkpointId: "transport1", identity: { taskId: "task1", runId: "run1", epoch: 1, goalRevision: 1 }, executionBase: { sha: base, revision: 1, remoteRef: "refs/heads/main" }, progress: { nextStep: "Verify fixture" }, progressRevision: 1, createdAt: "2026-11-06T10:00:00Z", commitMessage: "Preserve approved fixture state\n\nConfidence: high", policy: { allowedUntracked: [], exclusions: [], requiredPaths: ["source.txt"] }, quietBoundary: async () => {}, readAuthority: async () => ({ identity: options.identity, executionBase: options.executionBase, progressRevision: 1, progressHash: captureDigest(options.progress), policyDigest: captureDigest(options.policy) }) };
    const manifest = await captureCheckpoint(options); await publishCheckpoint(options, manifest);
    assert.equal(await gitText(f.bare, ["show", `${manifest.ref}:source.txt`]), "portable fixture update");
    assert.equal(await gitText(f.bare, ["show", "-s", "--format=%P", manifest.ref]), base);
    assert.equal(await gitText(f.bare, ["rev-list", "--count", `${base}..${manifest.ref}`]), "1");
    assert.equal(await gitText(f.bare, ["for-each-ref", "--format=%(refname)", "refs/tags"]), "");
    for (const row of (await gitText(f.bare, ["rev-list", "--objects", "--all"])).split("\n")) {
      const oid = row.split(" ")[0]!;
      if (await gitText(f.bare, ["cat-file", "-t", oid]) === "blob") assert(!(await gitText(f.bare, ["cat-file", "blob", oid])).includes(canary));
    }
    const calls = (await f.networkCalls()).filter(call => call.role === "network-FIXTURE");
    assert(calls.some(call => call.argv.includes("fetch") && call.argv.includes("--no-recurse-submodules")));
    assert(calls.some(call => call.argv.includes("push") && call.argv.includes("--recurse-submodules=no") && call.argv.includes("--no-follow-tags")));
    assert(calls.every(call => call.argv.includes(approvedUrl)));
  });
});
test("ordinary linked worktrees remain supported and enabled worktree configuration is separately audited", async () => {
  await fixture(async f => {
    const linked = join(f.directory, "linked");
    await git(f.repo, ["worktree", "add", "--quiet", "--detach", linked, "HEAD"]);
    await git(linked, ["ls-remote", "--refs", "origin", "refs/heads/main"], { transport: f.transport, metadataIsolation: f.proof });
    const before = (await f.networkCalls()).filter(call => call.role === "network-FIXTURE").length;
    await git(f.repo, ["config", "extensions.worktreeConfig", "true"]);
    await git(linked, ["config", "--worktree", "http.sslVerify", "false"]);
    await assert.rejects(git(linked, ["ls-remote", "--refs", "origin", "refs/heads/main"], { transport: f.transport, metadataIsolation: f.proof }));
    assert.equal((await f.networkCalls()).filter(call => call.role === "network-FIXTURE").length, before);
  });
});
test("credentialed network commands ignore source configuration changed after the audit", async () => {
  await fixture(async f => {
    const marker = join(f.directory, "unapproved-pack-helper-ran"), helper = join(f.directory, "pack-helper.sh");
    await writeFile(helper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`); await chmod(helper, 0o700);
    await writeFile(join(f.directory, "network-mutation.json"), JSON.stringify({ key: "pack.packObjectsHook", value: helper }));
    const head = await gitText(f.repo, ["rev-parse", "HEAD"]);
    await git(f.repo, ["push", "--porcelain", "--no-verify", "--force-with-lease=refs/coord/checkpoints/task1/e1/race:", "origin", `${head}:refs/coord/checkpoints/task1/e1/race`], { transport: f.transport, metadataIsolation: f.proof });
    assert.equal(await stat(marker).then(() => true, () => false), false);
    assert.equal(await gitText(f.bare, ["rev-parse", "refs/coord/checkpoints/task1/e1/race"]), head);
    const call = (await f.networkCalls()).find(item => item.role === "network-FIXTURE")!;
    const directory = call.argv.find(arg => arg.startsWith("--git-dir="))!.slice("--git-dir=".length);
    assert(directory.startsWith(`${f.transport.home}/.coord-git-transport-`));
    assert.equal(await stat(directory).then(() => true, () => false), false);
    await assert.rejects(git(f.repo, ["status", "--porcelain"], { transport: f.transport, metadataIsolation: f.proof }), /unsupported/);
  });
});
test("missing, fixture or mismatched metadata isolation cannot authorize privileged local Git", async () => {
  await fixture(async f => {
    await assert.rejects(git(f.repo, ["status", "--porcelain"], { transport: f.transport }), /write-isolation evidence/);
    const proof = metadataProof(); proof.capabilityEvidence.checks.at(-1)!.kind = "fixture";
    assert.throws(() => requireGitMetadataIsolation(proof), /unqualified/);
    const changed = metadataProof(); changed.expectedKey = { ...changed.expectedKey, configurationDigest: "c".repeat(64) };
    assert.throws(() => requireGitMetadataIsolation(changed), /configuration changed/);
    assert.equal((await f.networkCalls()).length, 0);
  });
});
test("hostile executable owners, write modes and set-ID bits are rejected before any credential-bearing child", async () => {
  await fixture(async f => {
    await chmod(f.transport.executable, 0o770); await assert.rejects(validateGitTransport(f.transport));
    await chmod(f.transport.executable, 0o700);
    const original = fs.lstat;
    let target = f.transport.executable, specialBits = 0, hostileOwner = false;
    fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
      const info = await original(...args);
      // Metadata syscall fixtures avoid actually changing ownership or creating a set-ID executable.
      if (String(args[0]) === target) return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid: hostileOwner ? process.getuid?.() === 12345 ? 23456 : 12345 : info.uid, mode: Number(info.mode) | specialBits });
      return info;
    }) as typeof fs.lstat;
    syncBuiltinESMExports();
    try {
      for (const bits of [0o4000, 0o2000]) { specialBits = bits; await assert.rejects(validateGitTransport(f.transport)); }
      specialBits = 0; hostileOwner = true;
      await assert.rejects(validateGitTransport(f.transport));
      target = join(dirname(f.transport.executable), "git");
      await assert.rejects(git(f.repo, ["ls-remote", "--refs", "origin"], { transport: f.transport, metadataIsolation: f.proof }));
    } finally { fs.lstat = original; syncBuiltinESMExports(); }
    assert.equal((await f.networkCalls()).length, 0);
  });
});
test("caller mutation cannot change the snapshotted Git destination, argv or qualification proof", async () => {
  await fixture(async f => {
    const transport = { ...f.transport }, proof = metadataProof(), args = ["ls-remote", "--refs", "origin", "refs/heads/main"];
    const pending = git(f.repo, args, { transport, metadataIsolation: proof });
    transport.url = "https://github.com/unapproved/other.git"; proof.mode = "managed"; proof.capabilityEvidence.checks.at(-1)!.kind = "fixture"; args[2] = "https://unapproved.invalid/repo.git";
    await pending;
    const network = (await f.networkCalls()).find(call => call.role === "network-FIXTURE")!;
    assert(network.argv.includes(approvedUrl)); assert(!network.argv.includes(args[2]!));
    const original: CaptureOptions = { repo: f.repo, remote: { name: "origin", url: approvedUrl }, gitTransport: { ...f.transport }, gitMetadataIsolation: metadataProof(), checkpointId: "snapshot1", identity: { taskId: "task1", runId: "run1", epoch: 1, goalRevision: 1 }, executionBase: { sha: "a".repeat(40), revision: 1, remoteRef: "refs/heads/main" }, progress: {}, progressRevision: 1, createdAt: "2026-11-06T10:00:00Z", commitMessage: "Preserve fixture state", policy: { allowedUntracked: [], exclusions: [], requiredPaths: [] }, readAuthority: async () => { throw new Error("not called by pure snapshot"); }, quietBoundary: async () => {} };
    const snapshot = snapshotCaptureOptions(original);
    original.gitTransport!.url = transport.url; original.gitMetadataIsolation!.expectedKey.configurationDigest = "c".repeat(64); original.gitMetadataIsolation!.capabilityEvidence.checks.at(-1)!.status = "FAIL";
    assert.equal(snapshot.gitTransport?.url, approvedUrl); assert.equal(snapshot.gitMetadataIsolation?.expectedKey.configurationDigest, key.configurationDigest); assert.equal(snapshot.gitMetadataIsolation?.capabilityEvidence.checks.at(-1)?.status, "PASS");
  });
});
