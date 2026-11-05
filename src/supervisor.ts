import { spawn, type ChildProcess, type Serializable } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { canonicalJson } from "./canonical.js";
import { approvedWorkerEnvironment, readWrapperEvidence, receiptDigest, writeWrapperEvidence, type WrapperOutcome, type WrapperSpec } from "./launch-wrapper.js";
import { LaunchJournalStore, type LaunchEffects, type LaunchJournal } from "./launch.js";
import { CoordError, DEFAULTS, requireCapability, type CapabilityEvidence, type CapabilityKey, type HarnessAdapter, type LaunchReceipt, type StopEvidence } from "./protocol.js";

export { readNativeBootId, nativeProcessIdentity } from "./launch-wrapper.js";
export interface WrapperObservation { wrapperExited: boolean; wrapperExitCode: number | null; outcome?: WrapperOutcome; receiptPath: string; outcomePath: string }
export interface QualifiedStopAdapter {
  key: CapabilityKey;
  /** Positive evidence requires actual qualified containment/identity observation, never just root exit or no ps match. */
  observe(receipt: LaunchReceipt, observation: WrapperObservation): Promise<StopEvidence | undefined>;
  stop(receipt: LaunchReceipt, reason: string, observation: WrapperObservation): Promise<StopEvidence | undefined>;
}
export type SupervisorOutcome = { state: "stopped"; evidence: StopEvidence; receipt?: LaunchReceipt } | { state: "held"; reason: string; receipt?: LaunchReceipt };
export interface SupervisorOptions {
  store: LaunchJournalStore; journal: LaunchJournal; expectedCapability: CapabilityKey; capabilityEvidence: CapabilityEvidence;
  checkCurrentConfiguration(): Promise<CapabilityKey>;
  adapter: HarnessAdapter; executable: string; prompt: string;
  approvedEnvironment: Record<string, string>; allowedEnvironmentKeys: string[]; stopAdapter: QualifiedStopAdapter;
  markStarting(): Promise<void>;
  authorize(receipt: LaunchReceipt): Promise<{ launchId: string; authorized: true; leaseUntil: number }>;
  renew(receipt: LaunchReceipt): Promise<{ runId: string; epoch: number; leaseUntil: number }>;
  hold(reason: string): Promise<void>;
  renewMs?: number; watchdogMs?: number; timeoutMs?: number; receiptTimeoutMs?: number; authorizationTimeoutMs?: number; stopTimeoutMs?: number; stopGraceMs?: number;
}
export interface LaunchSupervisor {
  effects: LaunchEffects; completion: Promise<SupervisorOutcome>;
  stop(reason: string): Promise<SupervisorOutcome>; reconcile(): Promise<SupervisorOutcome>;
}
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
function bound(value: number | undefined, fallback: number, min: number, max: number): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < min || actual > max) throw new CoordError("INVALID_INPUT", "Invalid supervisor timing policy");
  return actual;
}

/** Concrete wrapper effects for startLaunch; no worker receives backend supervisor credentials. */
export async function createLaunchSupervisor(input: SupervisorOptions): Promise<LaunchSupervisor> {
  const options: SupervisorOptions = { ...input, journal: structuredClone(input.journal), expectedCapability: structuredClone(input.expectedCapability), capabilityEvidence: structuredClone(input.capabilityEvidence), approvedEnvironment: { ...input.approvedEnvironment }, allowedEnvironmentKeys: [...input.allowedEnvironmentKeys] };
  const renewMs = bound(options.renewMs, DEFAULTS.renewMs, 10, 60_000);
  const watchdogMs = bound(options.watchdogMs, DEFAULTS.watchdogMs, renewMs, 300_000);
  const timeoutMs = bound(options.timeoutMs, DEFAULTS.runTimeoutMs, 20, 24 * 60 * 60 * 1000);
  const receiptTimeoutMs = bound(options.receiptTimeoutMs, 10_000, 100, 60_000);
  const authorizationTimeoutMs = bound(options.authorizationTimeoutMs, 30_000, 100, 60_000);
  const stopTimeoutMs = bound(options.stopTimeoutMs, 5_000, 20, 60_000);
  const stopGraceMs = bound(options.stopGraceMs, 5_000, 20, 60_000);
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new CoordError("LAUNCH_UNCERTAIN", "Supervisor operation timed out; reservation retained")), stopTimeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  if (!options.stopAdapter || !same(options.stopAdapter.key, options.expectedCapability) || options.adapter.harness !== options.expectedCapability.harness || options.adapter.version !== options.expectedCapability.adapterVersion || !isAbsolute(options.executable) || await realpath(options.executable) !== options.executable) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Selected executable, harness adapter or qualified stop configuration differs from qualification");
  const environment = approvedWorkerEnvironment(options.approvedEnvironment, options.allowedEnvironmentKeys);
  const guard = async () => {
    if (!same(await options.checkCurrentConfiguration(), options.expectedCapability)) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Effective launch configuration changed after qualification");
    requireCapability(options.capabilityEvidence, options.expectedCapability, "managed");
  };
  await guard();
  const argv = options.adapter.launchArgs(options.prompt);
  if (argv.some(arg => typeof arg !== "string" || arg.includes("\0")) || Buffer.byteLength(JSON.stringify(argv)) > 512 * 1024) throw new CoordError("INVALID_INPUT", "Selected harness command exceeds supported launch bounds");
  let child: ChildProcess | undefined, receipt: LaunchReceipt | undefined, directory: string | undefined;
  let wrapperExited = false, wrapperExitCode: number | null = null, released = false, spawnCalled = false, stopRequested = false, settled = false;
  let lastConfirmed = performance.now(), releasedAt = 0, leaseUntil = 0, renewing = false;
  let renewTimer: ReturnType<typeof setInterval> | undefined, watchdogTimer: ReturnType<typeof setInterval> | undefined;
  let resolveReceipt: ((value: LaunchReceipt) => void) | undefined, rejectReceipt: ((error: Error) => void) | undefined;
  let resolveCompletion!: (outcome: SupervisorOutcome) => void;
  const completion = new Promise<SupervisorOutcome>(resolveOutcome => { resolveCompletion = resolveOutcome; });
  let resolveWrapperExit!: () => void;
  const wrapperExit = new Promise<void>(resolveExit => { resolveWrapperExit = resolveExit; });
  const clearTimers = () => { if (renewTimer) clearInterval(renewTimer); if (watchdogTimer) clearInterval(watchdogTimer); };
  const validateReceipt = (value: LaunchReceipt, offered?: LaunchReceipt): LaunchReceipt => {
    if (!value || value.schemaVersion !== 1 || !value.process || !child?.pid || !Number.isSafeInteger(value.process.pid) || value.process.pid !== child.pid || value.process.bootId !== options.journal.bootId || typeof value.process.startIdentity !== "string" || !value.process.startIdentity || value.process.startIdentity.length > 4096 || value.launchId !== options.journal.launchId || value.machineId !== options.journal.machineId || value.workspace !== options.journal.workspace || value.process.launchId !== value.launchId || !same(value.identity, options.journal.identity) || !Number.isFinite(Date.parse(value.recordedAt)) || Date.parse(value.recordedAt) > Date.now() || (offered && !same(value, offered))) throw new CoordError("LAUNCH_UNCERTAIN", "Wrapper durable identity does not bind the exact reserved launch");
    return value;
  };
  const observation = async (): Promise<WrapperObservation> => {
    let outcome: WrapperOutcome | undefined;
    if (directory) outcome = await readWrapperEvidence<WrapperOutcome>(directory, "wrapper-outcome.json");
    if (outcome && (outcome.schemaVersion !== 1 || outcome.launchId !== options.journal.launchId || !["never_started", "spawn_attempted", "running", "root_exited", "wrapper_error", "stop_unconfirmed"].includes(outcome.state) || !Number.isFinite(Date.parse(outcome.observedAt)) || Date.parse(outcome.observedAt) > Date.now())) throw new CoordError("LAUNCH_UNCERTAIN", "Durable wrapper outcome does not bind this launch");
    return { wrapperExited, wrapperExitCode, ...(outcome ? { outcome } : {}), receiptPath: directory ? join(directory, "wrapper-receipt.json") : "", outcomePath: directory ? join(directory, "wrapper-outcome.json") : "" };
  };
  const validStop = (evidence: StopEvidence): boolean => evidence.launchId === options.journal.launchId && evidence.machineId === options.journal.machineId && Boolean(evidence.evidenceRef) && Number.isFinite(Date.parse(evidence.observedAt)) && Date.parse(evidence.observedAt) <= Date.now() && (evidence.kind === "observed_tree_exit" ? Boolean(receipt && evidence.process && same(evidence.process, receipt.process)) : evidence.kind === "verified_reboot" ? Boolean(receipt && evidence.process && evidence.process.launchId === receipt.launchId && evidence.process.bootId !== receipt.process.bootId) : evidence.kind === "proven_never_started" && !receipt);
  const finish = async (outcome: SupervisorOutcome): Promise<SupervisorOutcome> => {
    clearTimers();
    if (outcome.state === "held") { try { await bounded(options.hold(outcome.reason)); } catch { /* local journal and outcome still require reconciliation */ } }
    if (!settled) { settled = true; resolveCompletion(outcome); }
    return outcome;
  };
  const reconcile = async (): Promise<SupervisorOutcome> => {
    try {
      const observed = await bounded(observation());
      if (!receipt && directory) {
        const persisted = await bounded(readWrapperEvidence<LaunchReceipt>(directory, "wrapper-receipt.json"));
        if (persisted) receipt = validateReceipt(persisted);
      }
      if (wrapperExited && !receipt && observed.outcome?.state === "never_started") return finish({ state: "stopped", evidence: { kind: "proven_never_started", launchId: options.journal.launchId, machineId: options.journal.machineId, observedAt: new Date().toISOString(), evidenceRef: observed.outcomePath } });
      if (receipt) {
        validateReceipt(receipt);
        const evidence = await bounded(options.stopAdapter.observe(receipt, observed));
        if (evidence && validStop(evidence)) return finish({ state: "stopped", evidence, receipt });
      }
    } catch { /* absent/invalid evidence must retain the reservation */ }
    return finish({ state: "held", reason: "process_tree_exit_unconfirmed", ...(receipt ? { receipt } : {}) });
  };
  let stopping: Promise<SupervisorOutcome> | undefined;
  const stop = (reason: string): Promise<SupervisorOutcome> => {
    if (stopping) return stopping;
    stopRequested = true; clearTimers();
    stopping = (async () => {
      if (child?.connected) { try { child.send({ type: "abort", launchId: options.journal.launchId }, () => {}); } catch { /* evidence remains unknown */ } }
      if (receipt) {
        try {
          validateReceipt(receipt);
          const observed = await bounded(observation());
          const evidence = await bounded(options.stopAdapter.stop(receipt, reason, observed));
          if (evidence && validStop(evidence)) return finish({ state: "stopped", evidence, receipt });
        } catch { /* failed stop keeps reservation held */ }
      }
      if (child && !wrapperExited) { try { await bounded(wrapperExit); } catch { /* exit unconfirmed */ } }
      return reconcile();
    })();
    return stopping;
  };
  const beginWatchdog = () => {
    releasedAt = performance.now();
    renewTimer = setInterval(() => {
      if (stopRequested || wrapperExited || renewing || !receipt) return;
      renewing = true;
      void guard().then(() => options.renew(receipt!)).then(result => {
        if (stopRequested) return;
        if (result.runId !== options.journal.identity.runId || result.epoch !== options.journal.identity.epoch || !Number.isFinite(result.leaseUntil) || result.leaseUntil <= Date.now()) { void stop("renewal_authority_changed"); return; }
        leaseUntil = result.leaseUntil; lastConfirmed = performance.now();
        void send({ type: "renew", launchId: options.journal.launchId, receiptDigest: receiptDigest(receipt!), leaseUntil }).catch(() => stop("wrapper_renewal_ipc_lost"));
      }).catch(error => {
        if (error instanceof CoordError && ["LEASE_REVOKED", "STALE_EPOCH", "GOAL_NOT_APPROVED", "FORBIDDEN", "UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION"].includes(error.code)) void stop("renewal_revoked");
      }).finally(() => { renewing = false; });
    }, renewMs);
    watchdogTimer = setInterval(() => {
      if (stopRequested) return;
      const elapsed = performance.now();
      if (elapsed - releasedAt >= timeoutMs) void stop("run_timeout");
      else if (elapsed - lastConfirmed >= watchdogMs || Date.now() >= leaseUntil) void stop("renewal_watchdog_unconfirmed");
    }, Math.max(5, Math.min(1_000, renewMs, watchdogMs / 4, timeoutMs / 4)));
  };
  const send = async (message: unknown): Promise<void> => {
    if (!child?.connected || wrapperExited) throw new CoordError("LAUNCH_UNCERTAIN", "Wrapper IPC is unavailable; no replacement will be spawned");
    await new Promise<void>((resolveSent, rejectSent) => child!.send(message as Serializable, error => error ? rejectSent(new CoordError("LAUNCH_UNCERTAIN", "Wrapper IPC delivery is uncertain")) : resolveSent()));
  };
  const effects: LaunchEffects = {
    markStarting: async () => { await guard(); await options.markStarting(); },
    spawnWrapper: async () => {
      if (spawnCalled || child) throw new CoordError("LAUNCH_UNCERTAIN", "Wrapper spawn already attempted; reconcile the original launch");
      await guard();
      directory = join(await realpath(options.store.root), options.journal.launchId);
      if (await readWrapperEvidence(directory, "wrapper-receipt.json") || await readWrapperEvidence(directory, "wrapper-outcome.json")) throw new CoordError("LAUNCH_UNCERTAIN", "Prior wrapper evidence exists; no blind replacement");
      const spec: WrapperSpec = { schemaVersion: 1, launchId: options.journal.launchId, machineId: options.journal.machineId, identity: options.journal.identity, workspace: options.journal.workspace, receiptDirectory: directory, executable: options.executable, argv, environment, allowedEnvironmentKeys: options.allowedEnvironmentKeys, authorizationTimeoutMs, watchdogMs, timeoutMs, stopGraceMs };
      const receiptPromise = new Promise<LaunchReceipt>((resolveValue, rejectValue) => { resolveReceipt = resolveValue; rejectReceipt = rejectValue; });
      void receiptPromise.catch(() => {});
      const timeout = setTimeout(() => { rejectReceipt?.(new CoordError("LAUNCH_UNCERTAIN", "Durable wrapper receipt was not acknowledged")); void stop("wrapper_receipt_timeout"); }, receiptTimeoutMs);
      spawnCalled = true;
      child = spawn(process.execPath, [fileURLToPath(new URL("./launch-wrapper.js", import.meta.url))], { cwd: spec.workspace, env: environment, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
      child.once("error", error => {
        clearTimeout(timeout); rejectReceipt?.(new CoordError("LAUNCH_UNCERTAIN", "Wrapper spawn did not complete"));
        if (!child?.pid && ["ENOENT", "EACCES", "EAGAIN", "EMFILE", "ENFILE"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          wrapperExited = true; resolveWrapperExit();
          void writeWrapperEvidence(directory!, "wrapper-outcome.json", { schemaVersion: 1, launchId: options.journal.launchId, state: "never_started", observedAt: new Date().toISOString(), reason: "os_rejected_wrapper_spawn" }).then(reconcile, () => finish({ state: "held", reason: "wrapper_spawn_unconfirmed" }));
        } else void finish({ state: "held", reason: "wrapper_spawn_unconfirmed" });
      });
      child.on("message", message => {
        const value = message as { type?: string; receipt?: LaunchReceipt };
        if (value?.type !== "receipt" || !value.receipt) return;
        void (async () => {
          try {
            const disk = await readWrapperEvidence<LaunchReceipt>(directory!, "wrapper-receipt.json");
            if (!disk) throw new CoordError("LAUNCH_UNCERTAIN", "Wrapper receipt is unavailable");
            receipt = validateReceipt(disk, value.receipt); clearTimeout(timeout); resolveReceipt?.(receipt);
          } catch { clearTimeout(timeout); rejectReceipt?.(new CoordError("LAUNCH_UNCERTAIN", "Wrapper receipt cannot be verified")); void stop("wrapper_receipt_mismatch"); }
        })();
      });
      child.once("exit", (code) => {
        wrapperExited = true; wrapperExitCode = code; clearTimeout(timeout); clearTimers();
        resolveWrapperExit();
        rejectReceipt?.(new CoordError("LAUNCH_UNCERTAIN", "Wrapper exited before the receipt handshake completed"));
        void stop("wrapper_exited_requires_tree_stop");
      });
      child.once("disconnect", () => { if (!wrapperExited && released) void stop("wrapper_ipc_lost"); });
      await send({ type: "start", spec });
      return receiptPromise;
    },
    authorize: async value => {
      await guard(); if (!receipt || !same(receipt, value)) throw new CoordError("LAUNCH_UNCERTAIN", "Authorization receipt differs from the wrapper");
      const result = await options.authorize(value);
      if (result.launchId !== value.launchId || result.authorized !== true || !Number.isFinite(result.leaseUntil) || result.leaseUntil <= Date.now()) throw new CoordError("LEASE_REVOKED", "Backend did not confirm current exact launch authorization");
      leaseUntil = result.leaseUntil; lastConfirmed = performance.now();
    },
    releaseWrapper: async value => {
      await guard();
      if (stopRequested || released || !receipt || !same(receipt, value) || leaseUntil <= Date.now()) throw new CoordError("LAUNCH_UNCERTAIN", "Wrapper cannot be released without its exact current authorization");
      const journal = await options.store.read(options.journal.launchId);
      if (journal?.state !== "authorized" || !journal.receipt || !same(journal.receipt, receipt)) throw new CoordError("LAUNCH_UNCERTAIN", "Backend authorization must be durably journaled before releasing the wrapper");
      await send({ type: "authorize", launchId: value.launchId, receiptDigest: receiptDigest(value), leaseUntil });
      released = true; beginWatchdog();
    },
    hold: async reason => { void stop(reason); await bounded(options.hold(reason)); },
  };
  return { effects, completion, stop, reconcile };
}
