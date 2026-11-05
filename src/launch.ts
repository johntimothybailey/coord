import { mkdir, open, readFile, lstat, rename, realpath } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CoordError } from "./protocol.js";
import { canonicalJson } from "./canonical.js";
import type { LaunchReceipt, RunIdentity, StopEvidence } from "./protocol.js";

export interface LaunchJournal {
  schemaVersion: 1; launchId: string; identity: RunIdentity; machineId: string; workspace: string; bootId: string;
  state: "starting" | "receipt_recorded" | "authorized" | "uncertain" | "exit_recorded" | "released";
  receipt?: LaunchReceipt; stop?: StopEvidence; releaseRequestId?: string; releaseReceipt?: string;
}
export type LaunchFault = (point: "journal_synced" | "receipt_synced" | "authorization_received" | "exit_synced" | "release_received") => Promise<void>;
function id(value: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new CoordError("INVALID_INPUT", "Invalid launch identity"); }
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
export class LaunchJournalStore {
  constructor(readonly root: string) {}
  private async directory(launchId: string): Promise<string> {
    id(launchId); const firstCreated = await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (firstCreated) {
      const boundary = dirname(resolve(firstCreated));
      for (let current = resolve(this.root); ; current = dirname(current)) { await syncDirectory(current); if (current === boundary) break; }
    }
    const rootInfo = await lstat(this.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Launch journal must be a local private directory");
    const directory = join(await realpath(this.root), launchId); await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Launch directory is not trusted");
    await syncDirectory(this.root);
    return directory;
  }
  async read(launchId: string): Promise<LaunchJournal | undefined> {
    const path = join(await this.directory(launchId), "journal.json");
    try {
      const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 || (info.mode & 0o077)) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Invalid private launch journal");
      const journal = JSON.parse(await readFile(path, "utf8")) as LaunchJournal;
      if (journal.schemaVersion !== 1 || journal.launchId !== launchId || !journal.identity || !journal.machineId || !journal.bootId) throw new CoordError("LAUNCH_UNCERTAIN", "Launch journal is inconsistent");
      return journal;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async write(journal: LaunchJournal, initial = false): Promise<void> {
    const directory = await this.directory(journal.launchId), final = join(directory, "journal.json"), path = initial ? final : join(directory, `${randomUUID()}.json`);
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(journal)); await file.sync(); } finally { await file.close(); }
    if (!initial) await rename(path, final);
    await syncDirectory(directory);
  }
}
export interface LaunchEffects {
  markStarting(): Promise<void>;
  /** Wrapper MUST fsync its own identity receipt before requesting authorization; no harness starts yet. */
  spawnWrapper(): Promise<LaunchReceipt>;
  authorize(receipt: LaunchReceipt): Promise<void>;
  /** Release wrapper only after backend authorizes this exact durable receipt. */
  releaseWrapper(receipt: LaunchReceipt): Promise<void>;
  hold(reason: string): Promise<void>;
}
/** A retry with any prior journal reconciles; it never blindly spawns again. */
export async function startLaunch(store: LaunchJournalStore, journal: LaunchJournal, effects: LaunchEffects, fault?: LaunchFault): Promise<LaunchJournal> {
  if (await store.read(journal.launchId)) throw new CoordError("LAUNCH_UNCERTAIN", "Existing launch must be reconciled before another spawn");
  await effects.markStarting();
  await store.write({ ...journal, state: "starting" }, true);
  try {
    await fault?.("journal_synced");
    const receipt = await effects.spawnWrapper();
    if (receipt.launchId !== journal.launchId || receipt.machineId !== journal.machineId || receipt.workspace !== journal.workspace || receipt.process.launchId !== journal.launchId || receipt.process.bootId !== journal.bootId || canonicalJson(receipt.identity) !== canonicalJson(journal.identity)) throw new CoordError("LAUNCH_UNCERTAIN", "Wrapper receipt differs from the reserved launch");
    journal = { ...journal, state: "receipt_recorded", receipt }; await store.write(journal); await fault?.("receipt_synced");
    await effects.authorize(receipt); await fault?.("authorization_received");
    journal = { ...journal, state: "authorized" }; await store.write(journal);
    await effects.releaseWrapper(receipt); return journal;
  } catch {
    journal = { ...journal, state: "uncertain" }; await store.write(journal);
    await effects.hold("launch_acknowledgement_or_identity_uncertain");
    throw new CoordError("LAUNCH_UNCERTAIN", "Launch requires positive reconciliation; reservation remains held");
  }
}
export function reconcileLaunch(journal: LaunchJournal, evidence: { kind: "unknown" } | { kind: "identified"; receipt: LaunchReceipt; supervisionRecovered: boolean; currentAuthorization?: { identity: RunIdentity; launchId: string; leaseUntil: number; authorized: boolean } } | { kind: "stopped"; stop: StopEvidence }): "hold" | "adopt" | "stop_known_tree" | "finalize" {
  if (evidence.kind === "unknown") return "hold";
  if (evidence.kind === "identified") {
    if (!journal.receipt || canonicalJson(evidence.receipt) !== canonicalJson(journal.receipt)) return "hold";
    if (["released", "exit_recorded"].includes(journal.state)) return "hold";
    const auth = evidence.currentAuthorization;
    return evidence.supervisionRecovered && auth?.authorized && auth.launchId === journal.launchId && Number.isFinite(auth.leaseUntil) && auth.leaseUntil > Date.now() && canonicalJson(auth.identity) === canonicalJson(journal.identity) ? "adopt" : "stop_known_tree";
  }
  const stop = evidence.stop;
  if (stop.launchId !== journal.launchId || stop.machineId !== journal.machineId || !stop.evidenceRef || !Number.isFinite(Date.parse(stop.observedAt)) || Date.parse(stop.observedAt) > Date.now()) return "hold";
  if (stop.kind === "observed_tree_exit" && (!journal.receipt || !stop.process || canonicalJson(stop.process) !== canonicalJson(journal.receipt.process))) return "hold";
  if (stop.kind === "proven_never_started" && journal.receipt) return "hold";
  if (stop.kind === "verified_reboot" && (!journal.receipt || !stop.process || stop.process.bootId === journal.bootId || stop.process.launchId !== journal.launchId)) return "hold";
  return "finalize";
}
export async function recordExitAndRelease(store: LaunchJournalStore, launchId: string, stop: StopEvidence, release: (requestId: string, evidence: StopEvidence) => Promise<string>, fault?: LaunchFault): Promise<LaunchJournal> {
  let journal = await store.read(launchId);
  if (!journal || reconcileLaunch(journal, { kind: "stopped", stop }) !== "finalize") throw new CoordError("LAUNCH_UNCERTAIN", "No positive stop evidence bound to this launch");
  if (journal.state === "released") return journal;
  journal = { ...journal, state: "exit_recorded", stop: journal.stop ?? stop, releaseRequestId: journal.releaseRequestId ?? randomUUID() };
  await store.write(journal); await fault?.("exit_synced");
  const releaseReceipt = await release(journal.releaseRequestId!, journal.stop!); await fault?.("release_received");
  journal = { ...journal, state: "released", releaseReceipt }; await store.write(journal); return journal;
}
