import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync, { constants } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson } from "../src/canonical.js";
import { createCgroupControl, enterWrapperCgroup, readLinuxProcessIdentity, type CgroupControl, type CgroupLaunchReceipt, type CgroupOptions } from "../src/containment.js";
import { LaunchJournalStore, recordExitAndRelease, type LaunchJournal } from "../src/launch.js";
import { REQUIRED_CHECKS, type CapabilityEvidence, type CapabilityKey } from "../src/protocol.js";

const key: CapabilityKey = { os: "linux/SYSCALL-FIXTURE", harness: "codex", harnessVersion: "fixture-only", adapterVersion: "1", probeVersion: "1", configurationDigest: "a".repeat(64), gitPolicyDigest: "b".repeat(64) };
function capability(): CapabilityEvidence {
  // These synthetic records test validation only; they never become qualification output.
  return { key, checks: [...REQUIRED_CHECKS.managed, "process.cgroup-control-isolation"].map(checkId => ({ schemaVersion: 1, checkId, status: "PASS", mode: "managed", observedAt: new Date().toISOString(), configurationDigest: key.configurationDigest, command: [], summary: "SYSCALL FIXTURE ONLY", evidenceRef: "fixture-only:never-host-qualification", kind: "real" })) };
}
interface Fixture {
  options: CgroupOptions; control: CgroupControl; writes: { path: string; value: string }[]; root: string;
  attach(launchId?: string): Promise<CgroupLaunchReceipt>; event(group: string, value: string): Promise<void>;
  boot(value: string): void; start(value: string): void; hangEvents(value: boolean): void; populatedAfterKill(value: boolean): void;
  backendAvailable(value: boolean): void; admissionCalls(): number;
}

/** Explicit syscall fixture: no real cgroup/PID migration, signal, policy or host qualification occurs. */
async function fixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const original = { open: fs.open, mkdir: fs.mkdir, statfs: fs.statfs, readlink: fs.readlink, writeFile: fs.writeFile, readFile: fs.readFile, writeSync: fsSync.writeSync, writeFileSync: fsSync.writeFileSync };
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "coord-cgroup-SYSCALL-FIXTURE-")));
  const mount = join(directory, "mount"), root = join(mount, "coord"), metadataRoot = join(directory, "journals"), proc = join(directory, "proc");
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(proc); await fs.mkdir(metadataRoot, { mode: 0o700 });
  const writes: Fixture["writes"] = [], dirFds = new Map<number, string>(), controllerFds = new Map<number, string>();
  let bootId = "11111111-1111-1111-1111-111111111111", start = "444", selfMembership = "/coord", targetMembership = "/coord", hang = false, remainPopulated = false, backendAvailable = true, admissionCalls = 0;
  const seed = async (path: string) => {
    await original.writeFile(join(path, "cgroup.type"), "domain\n"); await original.writeFile(join(path, "cgroup.controllers"), "cpu memory pids\n");
    await original.writeFile(join(path, "cgroup.events"), "populated 0\nfrozen 0\n"); await original.writeFile(join(path, "cgroup.procs"), ""); await original.writeFile(join(path, "cgroup.kill"), "");
  };
  await seed(root);
  const applyWrite = (path: string, value: string) => {
    writes.push({ path, value });
    if (path.endsWith("/cgroup.procs")) {
      assert.equal(value, "0\n", "Only wrapper self-migration is permitted; no supplied PID write");
      targetMembership = `/coord/${dirname(path).split("/").at(-1)}`; selfMembership = targetMembership;
      original.writeFileSync(join(dirname(path), "cgroup.procs"), `${process.pid}\n`);
      original.writeFileSync(join(dirname(path), "cgroup.events"), "populated 1\nfrozen 0\n");
    } else {
      assert.equal(value, "1\n");
      original.writeFileSync(path, value);
      if (!remainPopulated) { original.writeFileSync(join(dirname(path), "cgroup.events"), "populated 0\nfrozen 0\n"); original.writeFileSync(join(dirname(path), "cgroup.procs"), ""); }
    }
  };
  const mapProc = async (path: string): Promise<string> => {
    const target = join(proc, Buffer.from(path).toString("hex"));
    let contents: string;
    if (path === "/proc/self/mountinfo") contents = `29 23 0:99 / ${mount} rw - cgroup2 cgroup rw\n`;
    else if (path === "/proc/sys/kernel/random/boot_id") contents = `${bootId}\n`;
    else if (path === "/proc/self/cgroup") contents = `0::${selfMembership}\n`;
    else if (path === `/proc/${process.pid}/cgroup`) contents = `0::${targetMembership}\n`;
    else if (path === `/proc/${process.pid}/stat`) { const fields = Array.from({ length: 25 }, () => "0"); fields[0] = "S"; fields[2] = String(process.pid); fields[19] = start; contents = `${process.pid} (fixture) ${fields.join(" ")}\n`; }
    else throw Object.assign(new Error("Unknown fixture proc path"), { code: "ENOENT" });
    await original.writeFile(target, contents); return target;
  };
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  fs.mkdir = (async (...args: Parameters<typeof fs.mkdir>) => {
    const result = await original.mkdir(...args); const path = String(args[0]);
    if (path.startsWith(`${root}/coord-`)) await seed(path);
    return result;
  }) as typeof fs.mkdir;
  fs.statfs = (async (...args: Parameters<typeof fs.statfs>) => ({ ...await original.statfs(...args), type: args[1]?.bigint ? 0x63677270n : 0x63677270 })) as typeof fs.statfs;
  fs.readlink = (async (...args: Parameters<typeof fs.readlink>) => args[0] === "/proc/self/ns/cgroup" ? "cgroup:[111111]" : original.readlink(...args)) as typeof fs.readlink;
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    let path = String(args[0]);
    const pinned = path.match(/^\/proc\/self\/fd\/(\d+)\/(cgroup\.[a-z_]+)$/);
    if (pinned) { const dir = dirFds.get(Number(pinned[1])); if (!dir) throw new Error("Unknown retained fixture descriptor"); path = join(dir, pinned[2]!); }
    else if (path.startsWith("/proc/")) path = await mapProc(path);
    if (hang && path.endsWith("/cgroup.events")) return new Promise<Awaited<ReturnType<typeof fs.open>>>(() => {});
    const file = await original.open(path, ...args.slice(1) as [Parameters<typeof fs.open>[1], Parameters<typeof fs.open>[2]]);
    const info = await file.stat(), close = file.close.bind(file);
    if (info.isDirectory()) dirFds.set(file.fd, path);
    if (typeof args[1] === "number" && (args[1] & constants.O_WRONLY) && /\/cgroup\.(?:procs|kill)$/.test(path)) {
      controllerFds.set(file.fd, path);
      file.write = (async (buffer: Buffer, offset = 0, length = buffer.length) => { applyWrite(path, buffer.subarray(offset, offset + length).toString()); return { bytesWritten: length, buffer }; }) as typeof file.write;
    }
    const fd = file.fd;
    file.close = async () => { dirFds.delete(fd); controllerFds.delete(fd); await close(); };
    return file;
  }) as typeof fs.open;
  fsSync.writeSync = ((...args: unknown[]) => {
    const path = controllerFds.get(Number(args[0]));
    if (!path) return (original.writeSync as (...values: unknown[]) => number)(...args);
    const buffer = args[1] as Buffer, offset = Number(args[2] ?? 0), length = Number(args[3] ?? buffer.length);
    applyWrite(path, buffer.subarray(offset, offset + length).toString()); return length;
  }) as typeof fsSync.writeSync;
  syncBuiltinESMExports();
  const options: CgroupOptions = { root, key, metadataRoot, capabilityEvidence: capability(), checkCurrentConfiguration: async () => { admissionCalls++; if (!backendAvailable) throw new Error("fixture backend unavailable"); return key; }, timeoutMs: 100, pollMs: 5 };
  let control: CgroupControl | undefined;
  try {
    control = await createCgroupControl(options);
    const store = new LaunchJournalStore(metadataRoot);
    const attach = async (launchId = "launch1") => {
      const journal: LaunchJournal = { schemaVersion: 1, launchId, identity: { taskId: "task1", runId: "run1", epoch: 1, goalRevision: 1 }, machineId: "machine1", workspace: directory, bootId: `linux:${bootId}`, state: "starting" };
      await store.write(journal, true);
      const spec = await control!.prepare(launchId), identity = await readLinuxProcessIdentity(process.pid, launchId);
      const wrapper = await enterWrapperCgroup(spec, identity);
      const receipt: CgroupLaunchReceipt = { schemaVersion: 1, identity: journal.identity, launchId, machineId: journal.machineId, workspace: directory, process: identity, recordedAt: new Date().toISOString(), containment: spec };
      await store.write({ ...journal, state: "receipt_recorded", receipt });
      selfMembership = "/coord";
      await control!.attach(receipt); await wrapper.close(); return receipt;
    };
    await run({ options, control, writes, root, attach, event: (group, value) => original.writeFile(join(group, "cgroup.events"), value), boot: value => { bootId = value; }, start: value => { start = value; }, hangEvents: value => { hang = value; }, populatedAfterKill: value => { remainPopulated = value; }, backendAvailable: value => { backendAvailable = value; }, admissionCalls: () => admissionCalls });
  } finally {
    if (control) await control.close();
    fs.open = original.open; fs.mkdir = original.mkdir; fs.statfs = original.statfs; fs.readlink = original.readlink; fsSync.writeSync = original.writeSync;
    Object.defineProperty(process, "platform", platform); syncBuiltinESMExports();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("actual non-Linux host fails closed before containment files or qualification are accessed", { skip: process.platform === "linux" }, async () => {
  let reads = 0;
  const control = await createCgroupControl({ root: "/not-a-real-cgroup", metadataRoot: "/not-real-metadata", key, capabilityEvidence: capability(), checkCurrentConfiguration: async () => { reads++; return key; } });
  await assert.rejects(control.preflight(), /requires Linux/); assert.equal(reads, 0); await control.close();
});
test("SYSCALL FIXTURE: self-attach precedes bound acknowledgment; recursive kernel populated state proves only the owned tree", async () => {
  await fixture(async f => {
    assert.equal((await f.control.preflight()).kind, "linux-cgroup-v2");
    const receipt = await f.attach();
    assert.deepEqual(f.writes.map(write => write.value), ["0\n"]);
    // Empty direct procs must not hide a live nested descendant.
    await fs.writeFile(join(receipt.containment!.path, "cgroup.procs"), "");
    assert.equal(await f.control.adapter.observe(receipt, { wrapperExited: true, wrapperExitCode: 0, receiptPath: "fixture", outcomePath: "fixture" }), undefined);
    const stopped = await f.control.adapter.stop(receipt, "fixture stop", { wrapperExited: false, wrapperExitCode: null, receiptPath: "fixture", outcomePath: "fixture" });
    assert.equal(stopped?.kind, "observed_tree_exit"); assert.deepEqual(stopped?.process, receipt.process);
    assert.equal(f.writes[1]?.path, join(receipt.containment!.path, "cgroup.kill")); assert.equal(f.writes[1]?.value, "1\n");
    const proof = JSON.parse(await fs.readFile(stopped!.evidenceRef, "utf8"));
    assert.equal(proof.spec.inode, receipt.containment!.inode); assert.equal((await fs.stat(stopped!.evidenceRef)).mode & 0o777, 0o600);
  });
});
test("SYSCALL FIXTURE: collisions, changed identity and unbound receipts never migrate or kill another group", async () => {
  await fixture(async f => {
    const receipt = await f.attach(); const count = f.writes.length;
    await assert.rejects(f.control.prepare(receipt.launchId), /reconcile/);
    f.start("445"); await assert.rejects(f.control.attach(receipt), /native identity/); f.start("444");
    await assert.rejects(f.control.adapter.stop({ ...receipt, process: { ...receipt.process, pid: process.pid + 1 } }, "wrong PID", { wrapperExited: true, wrapperExitCode: 0, receiptPath: "", outcomePath: "" }));
    assert.equal(f.writes.length, count);
    const original = receipt.containment!.path;
    await fs.rename(original, `${original}-old`); await fs.mkdir(original);
    await assert.rejects(f.control.adapter.stop(receipt, "replaced path", { wrapperExited: true, wrapperExitCode: 0, receiptPath: "", outcomePath: "" }), /replaced|differs/);
    assert.equal(f.writes.length, count);
  });
});
test("SYSCALL FIXTURE: an empty prepared or preexisting group is never accepted as attached ownership", async () => {
  await fixture(async f => {
    const store = new LaunchJournalStore(f.options.metadataRoot), host = await f.control.preflight();
    const journal: LaunchJournal = { schemaVersion: 1, launchId: "prepared1", identity: { taskId: "task1", runId: "run1", epoch: 1, goalRevision: 1 }, machineId: "machine1", workspace: f.root, bootId: host.bootId, state: "starting" };
    await store.write(journal, true);
    const spec = await f.control.prepare(journal.launchId), identity = await readLinuxProcessIdentity(process.pid, journal.launchId);
    const receipt: CgroupLaunchReceipt = { schemaVersion: 1, identity: journal.identity, launchId: journal.launchId, machineId: journal.machineId, workspace: journal.workspace, process: identity, recordedAt: new Date().toISOString(), containment: spec };
    await store.write({ ...journal, state: "receipt_recorded", receipt });
    const observation = { wrapperExited: true, wrapperExitCode: 0, receiptPath: "", outcomePath: "" };
    assert.equal(await f.control.adapter.observe(receipt, observation), undefined);
    assert.equal(await f.control.adapter.stop(receipt, "unattached", observation), undefined);
    await assert.rejects(f.control.attach(receipt), /membership could not be confirmed/);
    const collision = { ...journal, launchId: "unowned1" }; await store.write(collision, true);
    await fs.mkdir(join(f.root, "coord-unowned1"));
    await assert.rejects(f.control.prepare("unowned1"), /already exists/);
    assert.equal(f.writes.length, 0);
  });
});
test("SYSCALL FIXTURE: absent isolation/current config and bounded unknown stop preserve holds", async () => {
  await fixture(async f => {
    const noProof = await createCgroupControl({ ...f.options, capabilityEvidence: { ...capability(), checks: capability().checks.filter(check => check.checkId !== "process.cgroup-control-isolation") } });
    await assert.rejects(noProof.preflight(), /has not been qualified/); await noProof.close();
    const changed = await createCgroupControl({ ...f.options, checkCurrentConfiguration: async () => ({ ...key, configurationDigest: "c".repeat(64) }) });
    await assert.rejects(changed.preflight(), /configuration changed/); await changed.close();
    const receipt = await f.attach(); f.populatedAfterKill(true);
    assert.equal(await f.control.adapter.stop(receipt, "unconfirmed", { wrapperExited: true, wrapperExitCode: 0, receiptPath: "", outcomePath: "" }), undefined);
    f.hangEvents(true); const start = performance.now();
    await assert.rejects(f.control.adapter.observe(receipt, { wrapperExited: true, wrapperExitCode: 0, receiptPath: "", outcomePath: "" }), /timed out/);
    assert(performance.now() - start < 1_000); f.hangEvents(false);
  });
});
test("SYSCALL FIXTURE: restart uses exact durable journal/binding and verified reboot, never a caller attached claim", async () => {
  await fixture(async f => {
    const receipt = await f.attach();
    const recovered = await createCgroupControl({ ...f.options, lifecycleOnly: true, verifyLifecycleOwnership: async value => { assert.deepEqual(value, receipt); return { ...key }; } });
    try {
      assert.equal(await recovered.adapter.observe(receipt, { wrapperExited: true, wrapperExitCode: 0, receiptPath: "", outcomePath: "" }), undefined);
      f.boot("22222222-2222-2222-2222-222222222222");
      const reboot = await recovered.adapter.observe(receipt, { wrapperExited: false, wrapperExitCode: null, receiptPath: "", outcomePath: "" });
      assert.equal(reboot?.kind, "verified_reboot"); assert.notEqual(reboot?.process?.bootId, receipt.process.bootId);
      assert.equal(canonicalJson(reboot?.process?.launchId), canonicalJson(receipt.launchId));
    } finally { await recovered.close(); }
  });
});
test("SYSCALL FIXTURE: crashed wrapper and backend outage cannot prevent exact owned subtree kill or local exit recording", async () => {
  await fixture(async f => {
    const receipt = await f.attach(), store = new LaunchJournalStore(f.options.metadataRoot);
    const journal = (await store.read(receipt.launchId))!;
    await store.write({ ...journal, state: "authorized" });
    // The registered wrapper is gone/reused; the kernel still reports a live nested descendant.
    f.start("999"); await fs.writeFile(join(receipt.containment!.path, "cgroup.procs"), "");
    f.backendAvailable(false);
    const before = f.admissionCalls(), observation = { wrapperExited: true, wrapperExitCode: 1, receiptPath: "fixture", outcomePath: "fixture" };
    assert.equal(await f.control.adapter.observe(receipt, observation), undefined);
    const stopped = await f.control.adapter.stop(receipt, "wrapper crashed while backend offline", observation);
    assert.equal(stopped?.kind, "observed_tree_exit"); assert.equal(f.admissionCalls(), before);
    assert.equal(f.writes.at(-1)?.path, join(receipt.containment!.path, "cgroup.kill")); assert.equal(f.writes.at(-1)?.value, "1\n");
    assert.equal(JSON.parse(await fs.readFile(stopped!.evidenceRef, "utf8")).evidence.kind, "observed_tree_exit");
    await assert.rejects(recordExitAndRelease(store, receipt.launchId, stopped!, async () => { throw new Error("fixture backend still offline"); }), /still offline/);
    const local = await store.read(receipt.launchId);
    assert.equal(local?.state, "exit_recorded"); assert(local?.releaseRequestId); assert.equal(local?.releaseReceipt, undefined);
    await assert.rejects(f.control.preflight(), /backend unavailable/);
    await assert.rejects(f.control.prepare("new-offline-run"), /backend unavailable/);
    await assert.rejects(f.control.attach(receipt), /backend unavailable/);
    assert.equal(await fs.stat(join(f.root, "coord-new-offline-run")).then(() => true, () => false), false);
  });
});
test("SYSCALL FIXTURE: historical cleanup provenance works offline but cannot authorize execution or an unbound group", async () => {
  await fixture(async f => {
    const receipt = await f.attach(), ownerPath = join(f.options.metadataRoot, receipt.launchId, "owner-control-FIXTURE.json");
    const owner = { schemaVersion: 1, machineId: receipt.machineId, identity: receipt.identity, launchId: receipt.launchId, key, verifiedAt: "2020-01-01T00:00:00Z" };
    await fs.writeFile(ownerPath, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    f.backendAvailable(false);
    const historical = structuredClone(f.options.capabilityEvidence); for (const check of historical.checks) check.observedAt = "2020-01-01T00:00:00Z";
    const regular = await createCgroupControl(f.options);
    const observation = { wrapperExited: true, wrapperExitCode: 1, receiptPath: "fixture", outcomePath: "fixture" };
    await assert.rejects(regular.adapter.stop(receipt, "unestablished control", observation), /historical owner provenance/); await regular.close();
    await assert.rejects(createCgroupControl({ ...f.options, lifecycleOnly: true }), /ownership verifier/);
    const cleanup = await createCgroupControl({ ...f.options, capabilityEvidence: historical, lifecycleOnly: true, verifyLifecycleOwnership: async value => {
      const original = JSON.parse(await fs.readFile(ownerPath, "utf8")) as typeof owner;
      assert.equal(original.launchId, value.launchId); assert.equal(original.machineId, value.machineId); assert.deepEqual(original.identity, value.identity);
      return original.key;
    } });
    try {
      const before = f.admissionCalls();
      for (const action of [() => cleanup.preflight(), () => cleanup.prepare("never-admitted"), () => cleanup.attach(receipt)]) await assert.rejects(action(), /Cleanup-only/);
      const stopped = await cleanup.adapter.stop(receipt, "offline historical cleanup only", observation);
      assert.equal(stopped?.kind, "observed_tree_exit"); assert.equal(f.admissionCalls(), before);
      const wrong = await createCgroupControl({ ...f.options, lifecycleOnly: true, verifyLifecycleOwnership: async () => ({ ...key, configurationDigest: "c".repeat(64) }) });
      const writes = f.writes.length;
      await assert.rejects(wrong.adapter.stop(receipt, "wrong owner key", observation), /exact containment key/);
      assert.equal(f.writes.length, writes); await wrong.close();
    } finally { await cleanup.close(); }
  });
});
