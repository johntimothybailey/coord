import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchJournalStore, reconcileLaunch, recordExitAndRelease, startLaunch } from "../src/launch.js";
import type { LaunchEffects, LaunchFault, LaunchJournal } from "../src/launch.js";
import { CoordError } from "../src/protocol.js";
import type { LaunchReceipt, StopEvidence } from "../src/protocol.js";

const uncertain = (error: unknown) => error instanceof CoordError && error.code === "LAUNCH_UNCERTAIN";
async function fixture(run: (store: LaunchJournalStore, journal: LaunchJournal) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "coord-launch-test-"));
  try { await run(new LaunchJournalStore(join(root, "journals")), { schemaVersion: 1, launchId: "launch", identity: { taskId: "task", runId: "run", epoch: 2, goalRevision: 3 }, machineId: "machine", workspace: join(root, "workspace"), bootId: "fixture-boot", state: "starting" }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function receipt(journal: LaunchJournal): LaunchReceipt {
  return { schemaVersion: 1, identity: { ...journal.identity }, launchId: journal.launchId, machineId: journal.machineId, workspace: journal.workspace, process: { pid: 1234, bootId: journal.bootId, startIdentity: "fixture-start", launchId: journal.launchId }, recordedAt: new Date(Date.now() - 1000).toISOString() };
}
function exit(journal: LaunchJournal): StopEvidence {
  return { kind: "observed_tree_exit", machineId: journal.machineId, launchId: journal.launchId, process: receipt(journal).process, observedAt: new Date().toISOString(), evidenceRef: "injected-host-driver-exit" };
}
function effects(store: LaunchJournalStore, journal: LaunchJournal, events: string[], result = receipt(journal)): LaunchEffects {
  return {
    async markStarting() { events.push("markStarting"); },
    async spawnWrapper() {
      events.push("spawnWrapper"); const saved = await store.read(journal.launchId); assert.equal(saved?.state, "starting");
      const path = join(store.root, journal.launchId, "journal.json"); assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((JSON.parse(await readFile(path, "utf8")) as LaunchJournal).launchId, journal.launchId);
      return result;
    },
    async authorize(value) { events.push("authorize"); assert.deepEqual(value, result); assert.equal((await store.read(journal.launchId))?.state, "receipt_recorded"); },
    async releaseWrapper(value) { events.push("releaseWrapper"); assert.deepEqual(value, result); assert.equal((await store.read(journal.launchId))?.state, "authorized"); },
    async hold(reason) { events.push(`hold:${reason}`); },
  };
}

test("T10 launch driver observes private durable journal before spawn and exact receipt before authorization/release", async () => {
  await fixture(async (store, journal) => {
    const events: string[] = [];
    const result = await startLaunch(store, journal, effects(store, journal, events), async point => { events.push(point); });
    assert.deepEqual(events, ["markStarting", "journal_synced", "spawnWrapper", "receipt_synced", "authorize", "authorization_received", "releaseWrapper"]);
    assert.equal(result.state, "authorized"); assert.deepEqual((await store.read(journal.launchId))?.receipt, result.receipt);
    await assert.rejects(startLaunch(new LaunchJournalStore(store.root), journal, effects(store, journal, events)), uncertain);
    assert.equal(events.filter(value => value === "spawnWrapper").length, 1);
  });
});

test("T10 crashes at each durable launch boundary hold the reservation and never blindly spawn on retry", async () => {
  for (const point of ["journal_synced", "receipt_synced", "authorization_received"] as const) await fixture(async (store, journal) => {
    const events: string[] = [];
    const fault: LaunchFault = async current => { if (point === current) throw new Error(`Crash at ${point}`); };
    await assert.rejects(startLaunch(store, journal, effects(store, journal, events), fault), uncertain);
    const saved = await new LaunchJournalStore(store.root).read(journal.launchId);
    assert.equal(saved?.state, "uncertain"); assert(events.some(value => value.startsWith("hold:"))); assert(!events.includes("releaseWrapper"));
    assert.equal(events.filter(value => value === "spawnWrapper").length, point === "journal_synced" ? 0 : 1);
    const count = events.length;
    await assert.rejects(startLaunch(store, journal, effects(store, journal, events)), uncertain); assert.equal(events.length, count);
  });
});

test("T10 lost wrapper response before any process receipt remains unknown and held", async () => {
  await fixture(async (store, journal) => {
    const events: string[] = [], driver = effects(store, journal, events);
    driver.spawnWrapper = async () => { events.push("wrapper-spawn-ack-lost"); throw new Error("Spawned wrapper but reply was lost"); };
    await assert.rejects(startLaunch(store, journal, driver), uncertain);
    const saved = (await store.read(journal.launchId))!;
    assert.equal(saved.receipt, undefined); assert.equal(reconcileLaunch(saved, { kind: "unknown" }), "hold");
    assert.equal(reconcileLaunch(saved, { kind: "identified", receipt: receipt(journal), supervisionRecovered: true }), "hold");
    assert(!events.includes("authorize")); assert(!events.includes("releaseWrapper"));
    await assert.rejects(startLaunch(store, journal, driver), uncertain);
    assert.equal(events.filter(value => value === "wrapper-spawn-ack-lost").length, 1);
  });
});

test("T10 mismatched machine, workspace, process boot/launch and run identity never authorize a wrapper", async () => {
  for (const field of ["launch", "machine", "workspace", "boot", "process-launch", "epoch"] as const) await fixture(async (store, journal) => {
    const changed = receipt(journal), events: string[] = [];
    if (field === "launch") changed.launchId = "other";
    if (field === "machine") changed.machineId = "other";
    if (field === "workspace") changed.workspace = "/other";
    if (field === "boot") changed.process.bootId = "other";
    if (field === "process-launch") changed.process.launchId = "other";
    if (field === "epoch") changed.identity.epoch++;
    await assert.rejects(startLaunch(store, journal, effects(store, journal, events, changed)), uncertain);
    assert(!events.includes("authorize")); assert(!events.includes("releaseWrapper")); assert.equal((await store.read(journal.launchId))?.state, "uncertain");
  });
});

test("T10 reconciliation requires matching identity and recovered supervision; receipt existence never releases capacity", async () => {
  await fixture(async (store, journal) => {
    const saved: LaunchJournal = { ...journal, state: "authorized", receipt: receipt(journal) }; await store.write(saved, true);
    assert.equal(reconcileLaunch(saved, { kind: "unknown" }), "hold");
    assert.equal(reconcileLaunch(saved, { kind: "identified", receipt: saved.receipt!, supervisionRecovered: true }), "stop_known_tree");
    const currentAuthorization = { identity: journal.identity, launchId: journal.launchId, leaseUntil: Date.now() + 60_000, authorized: true };
    assert.equal(reconcileLaunch(saved, { kind: "identified", receipt: saved.receipt!, supervisionRecovered: true, currentAuthorization }), "adopt");
    assert.equal(reconcileLaunch(saved, { kind: "identified", receipt: saved.receipt!, supervisionRecovered: false }), "stop_known_tree");
    let calls = 0;
    for (const stop of [{ ...exit(journal), process: undefined }, { ...exit(journal), launchId: "other" }, { ...exit(journal), machineId: "other" }, { ...exit(journal), evidenceRef: "" }, { ...exit(journal), kind: "proven_never_started" as const }]) {
      await assert.rejects(recordExitAndRelease(store, journal.launchId, stop, async () => { calls++; return "incorrect-release"; }), uncertain);
    }
    assert.equal(calls, 0); assert.equal((await store.read(journal.launchId))?.state, "authorized");
  });
});

test("T10/T11 process adoption requires fresh exact backend authorization and never resurrects a terminal journal", async () => {
  await fixture(async (_store, journal) => {
    const saved: LaunchJournal = { ...journal, state: "authorized", receipt: receipt(journal) };
    const valid = { identity: { goalRevision: journal.identity.goalRevision, epoch: journal.identity.epoch, runId: journal.identity.runId, taskId: journal.identity.taskId }, launchId: journal.launchId, leaseUntil: Date.now() + 60_000, authorized: true };
    const identified = { kind: "identified" as const, receipt: saved.receipt!, supervisionRecovered: true };
    assert.equal(reconcileLaunch(saved, { ...identified, currentAuthorization: valid }), "adopt");
    for (const changed of [{ leaseUntil: Date.now() - 1 }, { leaseUntil: Number.POSITIVE_INFINITY }, { leaseUntil: Number.NaN }, { authorized: false }, { launchId: "different-launch" }, { identity: { ...journal.identity, epoch: journal.identity.epoch + 1 } }, { identity: { ...journal.identity, goalRevision: journal.identity.goalRevision + 1 } }, { identity: { ...journal.identity, runId: "different-run" } }]) {
      assert.equal(reconcileLaunch(saved, { ...identified, currentAuthorization: { ...valid, ...changed } }), "stop_known_tree");
    }
    assert.equal(reconcileLaunch(saved, { ...identified, supervisionRecovered: false, currentAuthorization: valid }), "stop_known_tree");
    for (const state of ["released", "exit_recorded"] as const) assert.equal(reconcileLaunch({ ...saved, state }, { ...identified, currentAuthorization: valid }), "hold");
  });
});

test("T19 exit/release crash recovery reuses the durable request and releases once", async () => {
  for (const crashPoint of ["exit_synced", "release_received"] as const) await fixture(async (store, journal) => {
    await store.write({ ...journal, state: "authorized", receipt: receipt(journal) }, true);
    const stop = exit(journal), requests: Array<{ requestId: string; evidence: StopEvidence }> = [], accepted = new Map<string, string>();
    const release = async (requestId: string, evidence: StopEvidence) => { requests.push({ requestId, evidence: structuredClone(evidence) }); if (!accepted.has(requestId)) accepted.set(requestId, "release-receipt"); return accepted.get(requestId)!; };
    await assert.rejects(recordExitAndRelease(store, journal.launchId, stop, release, async point => { if (point === crashPoint) throw new Error("Injected crash"); }), /Injected crash/);
    const saved = (await store.read(journal.launchId))!; assert.equal(saved.state, "exit_recorded"); assert(saved.releaseRequestId); assert.deepEqual(saved.stop, stop);
    const result = await recordExitAndRelease(new LaunchJournalStore(store.root), journal.launchId, stop, release);
    assert.equal(result.state, "released"); assert.equal(result.releaseReceipt, "release-receipt"); assert.equal(accepted.size, 1);
    assert(requests.every(request => request.requestId === saved.releaseRequestId));
    const count = requests.length; await recordExitAndRelease(store, journal.launchId, stop, release); assert.equal(requests.length, count);
  });
});

test("T19 recovery preserves the first durable stop payload when an exit observation is regenerated", async () => {
  await fixture(async (store, journal) => {
    await store.write({ ...journal, state: "authorized", receipt: receipt(journal) }, true);
    const original = exit(journal), requests: Array<{ requestId: string; evidence: StopEvidence }> = [];
    const release = async (requestId: string, evidence: StopEvidence) => { requests.push({ requestId, evidence: structuredClone(evidence) }); return "released"; };
    await assert.rejects(recordExitAndRelease(store, journal.launchId, original, release, async point => { if (point === "release_received") throw new Error("Lost release reply"); }), /Lost release reply/);
    const regenerated = { ...original, observedAt: new Date(Date.parse(original.observedAt) - 1).toISOString(), evidenceRef: "regenerated-evidence" };
    await recordExitAndRelease(store, journal.launchId, regenerated, release);
    assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0]);
  });
});

test("T10/T19 future exit times and unrelated reboot process identities cannot finalize", async () => {
  await fixture(async (_store, journal) => {
    const saved = { ...journal, receipt: receipt(journal) };
    assert.equal(reconcileLaunch(saved, { kind: "stopped", stop: { ...exit(journal), observedAt: new Date(Date.now() + 3600_000).toISOString() } }), "hold");
    assert.equal(reconcileLaunch(saved, { kind: "stopped", stop: { ...exit(journal), kind: "verified_reboot", process: { ...receipt(journal).process, bootId: "new-boot", launchId: "unrelated" } } }), "hold");
  });
});

test("launch journals reject broad file permissions, symlink files and path traversal", async () => {
  await fixture(async (store, journal) => {
    await store.write(journal, true); const path = join(store.root, journal.launchId, "journal.json");
    await chmod(path, 0o644); await assert.rejects(store.read(journal.launchId), /private launch journal/);
    await rm(path); const external = join(store.root, "external.json"); await writeFile(external, JSON.stringify(journal), { mode: 0o600 }); await symlink(external, path);
    await assert.rejects(store.read(journal.launchId), /private launch journal/);
    await assert.rejects(store.read("../escape"), /Invalid launch identity/);
  });
});
