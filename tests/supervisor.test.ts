import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { LaunchJournalStore, recordExitAndRelease, startLaunch, type LaunchJournal } from "../src/launch.js";
import { approvedWorkerEnvironment, nativeProcessIdentity, readNativeBootId, readWrapperEvidence, receiptDigest, writeWrapperEvidence, type WrapperOutcome, type WrapperSpec } from "../src/launch-wrapper.js";
import { createLaunchSupervisor, type QualifiedStopAdapter, type SupervisorOptions } from "../src/supervisor.js";
import { CoordError, REQUIRED_CHECKS, type CapabilityEvidence, type CapabilityKey, type LaunchReceipt } from "../src/protocol.js";

let nativeAvailable = true;
try { await nativeProcessIdentity(process.pid, "native-test-probe"); } catch { nativeAvailable = false; }
const nativeOnly = { skip: nativeAvailable ? false : "Current sandbox denies native boot/process inspection; qualification remains BLOCKED" };

// Synthetic authority fixtures exercise guard branches only; they are never persisted as real host qualification evidence.
const key: CapabilityKey = { os: "synthetic-fixture", harness: "codex", harnessVersion: "synthetic-node-fixture", adapterVersion: "fixture-1", probeVersion: "1", configurationDigest: "a".repeat(64), gitPolicyDigest: "b".repeat(64) };
function capability(): CapabilityEvidence { return { key, checks: REQUIRED_CHECKS.managed.map(checkId => ({ schemaVersion: 1, checkId, status: "PASS", mode: "managed", observedAt: new Date().toISOString(), configurationDigest: key.configurationDigest, command: [], summary: "Synthetic test authority only", evidenceRef: "fixture-only:not-host-qualification", kind: "real" })) }; }
async function fixture(body: (options: SupervisorOptions, directory: string, calls: { authorization: number; renewals: number; stops: string[]; holds: string[] }) => Promise<void>, script = "setInterval(() => {}, 1000)"): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "coord-supervisor-test-"));
  const directory = await realpath(temporary);
  const calls = { authorization: 0, renewals: 0, stops: [] as string[], holds: [] as string[] };
  const store = new LaunchJournalStore(join(directory, "journals"));
  const bootId = nativeAvailable ? await readNativeBootId() : "unsupported-native-fixture";
  const journal: LaunchJournal = { schemaVersion: 1, launchId: "launch1", identity: { taskId: "task1", runId: "run1", epoch: 1, goalRevision: 1 }, machineId: "machine1", workspace: directory, bootId, state: "starting" };
  const stopAdapter: QualifiedStopAdapter = { key, observe: async () => undefined, stop: async (_receipt, reason) => { calls.stops.push(reason); return undefined; } };
  const options: SupervisorOptions = { store, journal, expectedCapability: key, capabilityEvidence: capability(), checkCurrentConfiguration: async () => key, adapter: { harness: "codex", version: "fixture-1", binary: "node-fixture-only", versionArgs: ["--version"], launchArgs: () => ["-e", script] }, executable: await realpath(process.execPath), prompt: "", approvedEnvironment: { HOME: directory, FIXTURE_MARKER: join(directory, "worker-marker.json") }, allowedEnvironmentKeys: ["HOME", "FIXTURE_MARKER"], stopAdapter, markStarting: async () => {}, authorize: async receipt => { calls.authorization++; return { launchId: receipt.launchId, authorized: true, leaseUntil: Date.now() + 5_000 }; }, renew: async () => { calls.renewals++; return { runId: journal.identity.runId, epoch: journal.identity.epoch, leaseUntil: Date.now() + 5_000 }; }, hold: async reason => { calls.holds.push(reason); }, renewMs: 30, watchdogMs: 200, timeoutMs: 2_000, receiptTimeoutMs: 3_000, authorizationTimeoutMs: 500, stopTimeoutMs: 500, stopGraceMs: 40 };
  try { await body(options, directory, calls); }
  finally {
    const receipt = await readWrapperEvidence<LaunchReceipt>(join(store.root, journal.launchId), "wrapper-receipt.json").catch(() => undefined);
    if (receipt) {
      try { if (JSON.stringify(await nativeProcessIdentity(receipt.process.pid, receipt.launchId)) === JSON.stringify(receipt.process)) process.kill(-receipt.process.pid, "SIGKILL"); } catch { /* no matching owned process */ }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
async function until(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  throw new Error("Disposable process fixture did not reach its expected boundary");
}
async function within<T>(promise: Promise<T>, timeoutMs = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Disposable process boundary timed out")), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
test("explicit worker environment never copies ambient credentials and rejects credentials/loader overrides even if named in allowlist", () => {
  const prior = process.env.COORD_SUPERVISOR_TOKEN;
  process.env.COORD_SUPERVISOR_TOKEN = "FAKE_AMBIENT_SUPERVISOR_CANARY";
  try {
    const environment = approvedWorkerEnvironment({ SAFE_VALUE: "allowed" }, ["SAFE_VALUE"]);
    assert.deepEqual(Object.keys(environment), ["SAFE_VALUE"]);
    assert(!JSON.stringify(environment).includes("CANARY"));
    for (const name of ["COORD_SUPERVISOR_TOKEN", "OPENAI_API_KEY", "COORD_HUMAN_TOKEN", "COORD_ARTIFACT_VERIFIER_TOKEN", "NODE_OPTIONS", "LD_PRELOAD", "GITHUB_TOKEN"]) assert.throws(() => approvedWorkerEnvironment({ [name]: "FAKE_SECRET" }, [name]), /unapproved/);
    assert.throws(() => approvedWorkerEnvironment({ UNAPPROVED: "value" }, []), /unapproved/);
  } finally { if (prior === undefined) delete process.env.COORD_SUPERVISOR_TOKEN; else process.env.COORD_SUPERVISOR_TOKEN = prior; }
});
test("missing or changed real qualification rejects before any wrapper/backend launch side effect", async () => {
  await fixture(async (options, _directory, calls) => {
    options.capabilityEvidence.checks[0]!.kind = "fixture";
    await assert.rejects(createLaunchSupervisor(options), /capability evidence/);
    options.capabilityEvidence = capability(); options.checkCurrentConfiguration = async () => ({ ...key, configurationDigest: "c".repeat(64) });
    await assert.rejects(createLaunchSupervisor(options), /configuration changed/);
    assert.equal(calls.authorization, 0); assert.equal(calls.renewals, 0);
  });
});
test("mismatched disk-recovered receipt stays held without invoking a stop adapter on the wrong identity", async () => {
  await fixture(async (options, _directory, calls) => {
    let guards = 0, observations = 0;
    options.checkCurrentConfiguration = async () => {
      if (++guards === 3) {
        const wrong: LaunchReceipt = { schemaVersion: 1, launchId: "different-launch", machineId: "different-machine", identity: { ...options.journal.identity, runId: "different-run" }, workspace: options.journal.workspace, process: { pid: process.pid, launchId: "different-launch", bootId: options.journal.bootId, startIdentity: "not-the-owned-wrapper" }, recordedAt: new Date().toISOString() };
        await writeWrapperEvidence(join(options.store.root, options.journal.launchId), "wrapper-receipt.json", wrong, true);
      }
      return key;
    };
    options.stopAdapter.observe = async () => { observations++; return undefined; };
    const supervisor = await createLaunchSupervisor(options);
    await assert.rejects(startLaunch(options.store, options.journal, supervisor.effects), /reconciliation/);
    assert.equal((await supervisor.completion).state, "held");
    assert.equal((await supervisor.reconcile()).state, "held");
    assert.equal(observations, 0); assert.equal(calls.stops.length, 0); assert.equal(calls.authorization, 0);
    assert.equal((await options.store.read(options.journal.launchId))?.state, "uncertain");
  });
});
test("stalled wrapper observation resolves held on a bounded timeout without adapter action", async () => {
  await fixture(async (options, _directory, calls) => {
    let guards = 0, stalledReads = 0, observations = 0;
    const original = fs.open;
    options.stopTimeoutMs = 50;
    options.checkCurrentConfiguration = async () => {
      if (++guards === 3) {
        const wrong: LaunchReceipt = { schemaVersion: 1, launchId: "different-launch", machineId: "different-machine", identity: options.journal.identity, workspace: options.journal.workspace, process: { pid: process.pid, launchId: "different-launch", bootId: options.journal.bootId, startIdentity: "not-owned" }, recordedAt: new Date().toISOString() };
        await writeWrapperEvidence(join(options.store.root, options.journal.launchId), "wrapper-receipt.json", wrong, true);
        fs.open = ((...args: Parameters<typeof fs.open>) => {
          if (typeof args[0] === "string" && args[0].endsWith("wrapper-outcome.json")) { stalledReads++; return new Promise<Awaited<ReturnType<typeof original>>>(() => {}); }
          return original(...args);
        }) as typeof fs.open;
        syncBuiltinESMExports();
      }
      return key;
    };
    options.stopAdapter.observe = async () => { observations++; return undefined; };
    try {
      const supervisor = await createLaunchSupervisor(options);
      await assert.rejects(startLaunch(options.store, options.journal, supervisor.effects), /reconciliation/);
      assert.equal((await within(supervisor.completion, 500)).state, "held");
      assert.equal((await within(supervisor.reconcile(), 500)).state, "held");
      assert(stalledReads > 0); assert.equal(observations, 0); assert.equal(calls.stops.length, 0);
    } finally { fs.open = original; syncBuiltinESMExports(); }
  });
});
test("denied native identity yields durable never-started proof before any registered wrapper receipt", { skip: nativeAvailable ? "Native inspection available; denial branch exercised in restricted host run" : false }, async () => {
  await fixture(async (options, directory, calls) => {
    const supervisor = await createLaunchSupervisor(options);
    await assert.rejects(startLaunch(options.store, options.journal, supervisor.effects), /reconciliation/);
    const outcome = await supervisor.completion;
    assert.equal(outcome.state, "stopped");
    if (outcome.state === "stopped") {
      assert.equal(outcome.evidence.kind, "proven_never_started");
      let releases = 0;
      await recordExitAndRelease(options.store, options.journal.launchId, outcome.evidence, async () => { releases++; return "fixture-release"; });
      await recordExitAndRelease(options.store, options.journal.launchId, outcome.evidence, async () => { releases++; return "duplicate"; });
      assert.equal(releases, 1);
    }
    assert.equal(calls.authorization, 0);
    assert.equal(await stat(join(directory, "worker-marker.json")).then(() => true, () => false), false);
    await assert.rejects(startLaunch(options.store, options.journal, supervisor.effects), /Existing launch/);
  });
});
test("real wrapper fsyncs exact own identity before authorization and worker sees only explicit environment; root exit stays held", nativeOnly, async () => {
  await fixture(async (options, directory, calls) => {
    const authorize = options.authorize;
    options.authorize = async receipt => {
      const persisted = await readWrapperEvidence<LaunchReceipt>(join(options.store.root, receipt.launchId), "wrapper-receipt.json");
      assert.deepEqual(persisted, receipt);
      assert.equal((await stat(join(options.store.root, receipt.launchId, "wrapper-receipt.json"))).mode & 0o777, 0o600);
      assert.equal((await options.store.read(receipt.launchId))?.state, "receipt_recorded");
      assert.equal(await stat(join(directory, "worker-marker.json")).then(() => true, () => false), false);
      return authorize(receipt);
    };
    const supervisor = await createLaunchSupervisor(options);
    const started = await startLaunch(options.store, options.journal, supervisor.effects);
    assert.equal(started.state, "authorized");
    const outcome = await supervisor.completion;
    assert.equal(outcome.state, "held"); assert(calls.stops.length > 0);
    const environment = JSON.parse(await readFile(join(directory, "worker-marker.json"), "utf8")) as Record<string, string>;
    // macOS CoreFoundation may synthesize this noncredential encoding marker even with an explicit spawn env.
    if (environment.__CF_USER_TEXT_ENCODING !== undefined) assert.match(environment.__CF_USER_TEXT_ENCODING, /^0x[0-9a-f]+:0x[0-9a-f]+:0x[0-9a-f]+$/i);
    assert.deepEqual(Object.keys(environment).filter(name => name !== "__CF_USER_TEXT_ENCODING").sort(), ["FIXTURE_MARKER", "HOME"]);
    await assert.rejects(startLaunch(options.store, options.journal, supervisor.effects), /Existing launch/);
  }, "require('node:fs').writeFileSync(process.env.FIXTURE_MARKER, JSON.stringify(process.env))");
});
test("registered receipt plus denied authorization settles only through qualified exact wrapper-tree observation", nativeOnly, async () => {
  await fixture(async options => {
    options.authorize = async () => { throw new CoordError("LEASE_REVOKED", "fixture revoked grant"); };
    options.stopAdapter.observe = async (receipt, observation) => observation.wrapperExited && observation.outcome?.state === "never_started" ? { kind: "observed_tree_exit", launchId: receipt.launchId, machineId: receipt.machineId, process: receipt.process, observedAt: new Date().toISOString(), evidenceRef: observation.outcomePath } : undefined;
    const supervisor = await createLaunchSupervisor(options);
    await assert.rejects(startLaunch(options.store, options.journal, supervisor.effects), /reconciliation/);
    const outcome = await supervisor.completion;
    assert.equal(outcome.state, "stopped");
    if (outcome.state === "stopped") { assert.equal(outcome.evidence.kind, "observed_tree_exit"); await recordExitAndRelease(options.store, options.journal.launchId, outcome.evidence, async () => "fixture-release"); }
  });
});
test("parent watchdog attempts stop after unconfirmed renewal and never releases on root/group exit alone", nativeOnly, async () => {
  await fixture(async (options, _directory, calls) => {
    options.renewMs = 20; options.watchdogMs = 100; options.renew = async () => { calls.renewals++; throw new Error("fixture backend offline"); };
    const supervisor = await createLaunchSupervisor(options);
    await startLaunch(options.store, options.journal, supervisor.effects);
    const outcome = await supervisor.completion;
    assert.equal(outcome.state, "held"); assert(calls.renewals > 0); assert(calls.stops.some(reason => reason.includes("watchdog") || reason.includes("wrapper_exited")));
    assert.notEqual((await options.store.read(options.journal.launchId))?.state, "released");
  }, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
});

async function independentWrapper(disconnect: boolean, stallRootExitEvidence = false, rejectingEvidence?: "root_exited" | "running"): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "coord-independent-wrapper-")), directory = await realpath(temporary);
  const evidenceDirectory = join(directory, "evidence"); await mkdir(evidenceDirectory, { mode: 0o700 });
  const heartbeat = join(directory, "heartbeat"), pidFile = join(directory, "descendant.pid");
  const exitNow = join(directory, "root-exit-now");
  const descendant = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),10);`;
  const withDescendant = disconnect || stallRootExitEvidence || rejectingEvidence !== undefined;
  const root = withDescendant ? `const fs=require('node:fs'); require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',env:{}}); setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitNow)}))process.exit(0)},10);` : `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),10);`;
  // Fault seam lives only in this disposable process: production wrapper has no test/bypass flag.
  const targetState = rejectingEvidence ?? "root_exited";
  const waitForDescendant = rejectingEvidence === "running" ? `const deadline=Date.now()+2000;while(Date.now()<deadline){if(await fs.stat(${JSON.stringify(heartbeat)}).then(()=>true,()=>false))break;await new Promise(r=>setTimeout(r,5));}` : "";
  const injectedAction = rejectingEvidence ? `${waitForDescendant}throw new Error('fixture evidence write rejection')` : "return new Promise(()=>{})";
  const preload = `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.open; fs.open=async(...args)=>{const file=await original(...args); const write=file.writeFile.bind(file); file.writeFile=async value=>{if(typeof value==='string'&&value.includes('"state":"${targetState}"')){${injectedAction}} return write(value)};return file}; syncBuiltinESMExports();`;
  const wrapperArgs = [...(stallRootExitEvidence || rejectingEvidence ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`] : []), fileURLToPath(new URL("../src/launch-wrapper.js", import.meta.url))];
  const wrapper = spawn(process.execPath, wrapperArgs, { cwd: directory, env: { HOME: directory }, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let receipt: LaunchReceipt | undefined;
  let ownedDescendant: Awaited<ReturnType<typeof nativeProcessIdentity>> | undefined;
  try {
    const exited = new Promise<void>(resolveExit => wrapper.once("exit", () => resolveExit()));
    const receipted = new Promise<LaunchReceipt>(resolveReceipt => wrapper.on("message", message => { const value = message as { type?: string; receipt?: LaunchReceipt }; if (value.type === "receipt" && value.receipt) resolveReceipt(value.receipt); }));
    const spec: WrapperSpec = { schemaVersion: 1, launchId: "independent1", machineId: "machine1", identity: { taskId: "task1", runId: "run1", epoch: 1, goalRevision: 1 }, workspace: directory, receiptDirectory: evidenceDirectory, executable: await realpath(process.execPath), argv: ["-e", root], environment: { HOME: directory }, allowedEnvironmentKeys: ["HOME"], authorizationTimeoutMs: 1000, watchdogMs: disconnect ? 2000 : 120, timeoutMs: 3000, stopGraceMs: 60 };
    wrapper.send({ type: "start", spec });
    receipt = await within(receipted);
    wrapper.send({ type: "authorize", launchId: receipt.launchId, receiptDigest: receiptDigest(receipt), leaseUntil: Date.now() + 5_000 });
    await until(() => stat(heartbeat).then(() => true, () => false));
    if (withDescendant) {
      const descendantPid = Number(await readFile(pidFile, "utf8")); ownedDescendant = await nativeProcessIdentity(descendantPid, receipt.launchId).catch(() => undefined);
      if (disconnect) wrapper.disconnect();
      else await writeFile(exitNow, "exit root; leave TERM-ignoring descendant\n");
    }
    await within(exited);
    const after = await readFile(heartbeat, "utf8"); await delay(100); assert.equal(await readFile(heartbeat, "utf8"), after);
    const outcome = await readWrapperEvidence<WrapperOutcome>(evidenceDirectory, "wrapper-outcome.json");
    assert(outcome && ["stop_unconfirmed", "root_exited", "wrapper_error"].includes(outcome.state));
    // A stopped heartbeat is a disposable fixture assertion, not production descendant-tree evidence.
  } finally {
    if (receipt) { try { if (JSON.stringify(await nativeProcessIdentity(receipt.process.pid, receipt.launchId)) === JSON.stringify(receipt.process)) process.kill(-receipt.process.pid, "SIGKILL"); } catch { /* already stopped or changed identity */ } }
    if (ownedDescendant) { try { if (JSON.stringify(await nativeProcessIdentity(ownedDescendant.pid, ownedDescendant.launchId)) === JSON.stringify(ownedDescendant)) process.kill(ownedDescendant.pid, "SIGKILL"); } catch { /* not the owned descendant */ } }
    if (wrapper.connected) wrapper.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}
test("independent wrapper watchdog kills a TERM-ignoring fixture without parent renewal assistance", nativeOnly, () => independentWrapper(false));
test("parent IPC loss keeps escalation alive after root exits TERM so a TERM-ignoring descendant is stopped", nativeOnly, () => independentWrapper(true));
test("stalled root-exit evidence cannot prevent already scheduled descendant cleanup", nativeOnly, () => independentWrapper(false, true));
test("rejecting root-exit evidence cannot cancel pending descendant cleanup", nativeOnly, () => independentWrapper(false, false, "root_exited"));
test("rejecting running evidence still stops the spawned tree independently of disk errors", nativeOnly, () => independentWrapper(false, false, "running"));
