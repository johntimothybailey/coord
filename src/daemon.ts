import type { CapabilityKey } from "./protocol.js";
import { CoordError } from "./protocol.js";
import { canonicalJson } from "./canonical.js";

export interface DispatchCandidate { taskId: string; epoch: number; goalRevision: number; mode: "managed" | "replan"; checkpointId: string | null; executionBase: { sha: string; revision: number; remoteRef: string }; }
export interface DispatchSnapshot { candidates: DispatchCandidate[]; slots: number; complete: boolean; policyVersion: number; }
export interface DaemonDriver {
  /** Native backend subscription, not model polling. Close unsubscribes. */
  subscribe(machineId: string, key: CapabilityKey, update: (snapshot: DispatchSnapshot) => void, error: (error: unknown) => void): () => void;
  /** Effective environment/setup and exact-code checks before reserving capacity. */
  preflight(candidate: DispatchCandidate): Promise<{ configurationDigest: string }>;
  /** Durable request identity/grant persisted before transactional admission. */
  claim(candidate: DispatchCandidate, configurationDigest: string): Promise<unknown>;
  /** Recheck preflight after claim; never wait for human input or blindly retry spawn. */
  launch(candidate: DispatchCandidate, claim: unknown, configurationDigest: string): Promise<void>;
  notify(taskId: string, state: "blocked" | "launched", code: string): void;
}
/** Deterministic serial dispatcher. Claims remain authoritative across concurrent daemons. */
export function startDaemon(machineId: string, key: CapabilityKey, driver: DaemonDriver): { stop(): void; idle(): Promise<void> } {
  let stopped = false, tail = Promise.resolve(), latestRevision = 0;
  const seen = new Map<string, string>();
  const admitted = new Set<string>();
  const notify = (taskId: string, state: "blocked" | "launched", code: string) => { const value = `${state}:${code}`; if (seen.get(taskId) !== value) { seen.set(taskId, value); driver.notify(taskId, state, code); } };
  const unsubscribe = driver.subscribe(machineId, key, snapshot => {
    const revision = ++latestRevision;
    tail = tail.then(async () => {
      if (stopped || revision !== latestRevision) return;
      if (!snapshot.complete) { notify("project", "blocked", "COVERAGE_INCOMPLETE"); return; }
      let slots = snapshot.slots;
      for (const candidate of snapshot.candidates) {
        if (stopped || revision !== latestRevision || slots <= 0) break;
        const candidateKey = canonicalJson(candidate);
        if (admitted.has(candidateKey)) continue;
        try {
          const { configurationDigest } = await driver.preflight(candidate);
          if (stopped || revision !== latestRevision) break;
          const admission = await driver.claim(candidate, configurationDigest); slots--; admitted.add(candidateKey);
          // Once admission succeeds, launch must settle or hold the reservation even if a newer snapshot arrives.
          await driver.launch(candidate, admission, configurationDigest);
          notify(candidate.taskId, "launched", "AUTHORIZED_LAUNCH");
        } catch (error) { notify(candidate.taskId, "blocked", error instanceof CoordError ? error.code : "OPERATION_FAILED"); }
      }
    }).catch(() => { notify("project", "blocked", "OPERATION_FAILED"); });
  }, () => { latestRevision++; notify("project", "blocked", "BACKEND_UNAVAILABLE"); });
  return { stop() { stopped = true; latestRevision++; unsubscribe(); }, idle() { return tail; } };
}
