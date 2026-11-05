export const PROTOCOL_VERSION = 1;
export const CLIENT_VERSION = "0.1.0-private";
export const PROBE_VERSION = "1";
export const CAPABILITIES = ["auth-v1", "run-grants-v1", "safe-snapshot-v1", "finalization-v1"] as const;
export const DEFAULTS = Object.freeze({ leaseMs: 90_000, renewMs: 20_000, watchdogMs: 60_000, sweepMs: 60_000, machineCapacity: 1, projectCapacity: 2, taskCap: 20, runTimeoutMs: 1_800_000, replanLimit: 2, captureAttempts: 3, fileBytes: 5 * 1024 * 1024, contextBytes: 12 * 1024, expansionBytes: 4 * 1024, updateBytes: 2 * 1024, scanPaths: 500, scanBytes: 100 * 1024 });
export type EvidenceStatus = "PASS" | "FAIL" | "BLOCKED";
export type ExecutionMode = "advisory" | "manual" | "managed";
export type Harness = "codex" | "antigravity";
export interface CapabilityKey { os: string; harness: Harness; harnessVersion: string; adapterVersion: string; probeVersion: string; configurationDigest: string; gitPolicyDigest: string }
export interface ProbeEvidence { schemaVersion: 1; checkId: string; status: EvidenceStatus; mode: ExecutionMode; observedAt: string; configurationDigest: string; command: string[]; summary: string; evidenceRef?: string; kind: "real" | "fixture"; }
export interface CapabilityEvidence { key: CapabilityKey; checks: ProbeEvidence[]; }
export const REQUIRED_CHECKS: Record<ExecutionMode, readonly string[]> = {
  advisory: ["harness.version", "mcp.roundtrip"],
  manual: ["harness.version", "plugin.discovery", "mcp.roundtrip", "manual.registration", "checkin.delivery", "harness.authentication", "credentials.tool-isolation", "human.unlock", "git.permissions"],
  managed: ["harness.version", "plugin.discovery", "mcp.roundtrip", "manual.registration", "checkin.delivery", "harness.authentication", "credentials.tool-isolation", "human.unlock", "git.permissions", "process.identity", "process.stop", "git.refs"],
};
export type ErrorCode = "INVALID_INPUT" | "UNAUTHORIZED" | "FORBIDDEN" | "PROTOCOL_INCOMPATIBLE" | "IDEMPOTENCY_CONFLICT" | "UNTRUSTED_WORKSPACE_CONFIG" | "LEASE_REVOKED" | "STALE_EPOCH" | "GOAL_NOT_APPROVED" | "CAPACITY_EXHAUSTED" | "LAUNCH_UNCERTAIN" | "COVERAGE_INCOMPLETE" | "CONFLICT_UNRESOLVED" | "CHECKPOINT_INCOMPLETE" | "BLOCKED_CHECKPOINT" | "BLOCKED_ENV" | "UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION" | "NEEDS_HUMAN" | "PUBLICATION_STALE" | "NOT_FOUND";
export class CoordError extends Error { constructor(public readonly code: ErrorCode, message: string) { super(message); this.name = "CoordError"; } }
export interface RequestIdentity { protocolVersion: number; clientVersion: string; capabilities: string[]; backendId: string; projectId: string; requestId: string }
export interface ExecutionBase { sha: string; revision: number; remoteRef: string }
export interface RunIdentity { taskId: string; runId: string; epoch: number; goalRevision: number }
export type TaskState = "queued" | "reserved" | "running" | "review_ready" | "blocked" | "yielding" | "waiting_dependencies" | "replan_requested" | "failed" | "cancelled" | "launch_uncertain";
export type RunState = "reserved" | "starting" | "running" | "finalizing" | "succeeded" | "failed" | "stopped";
export interface ProcessIdentity { pid: number; bootId: string; startIdentity: string; launchId: string; }
export interface LaunchReceipt { schemaVersion: 1; identity: RunIdentity; launchId: string; machineId: string; workspace: string; process: ProcessIdentity; recordedAt: string; }
export interface StopEvidence { kind: "observed_tree_exit" | "proven_never_started" | "verified_reboot"; launchId: string; machineId: string; process?: ProcessIdentity; observedAt: string; evidenceRef: string; }
export interface FileEntry { path: string; mode: string; type: "blob" | "symlink"; oid: string; }
export interface VerificationEvidence { head: string; tree: string; base: string; commands: { argv: string[]; exitCode: number }[]; environmentDigest: string; recordedAt: string; }
export interface CheckpointManifest { schemaVersion: 1; checkpointId: string; identity: RunIdentity; sourceHead: string; executionBase: ExecutionBase; remoteParent: string; tree: string; commit: string; ref: string; files: FileEntry[]; exclusions: { path: string; reason: string }[]; progressHash: string; evidence: VerificationEvidence[]; }
export interface HarnessAdapter { harness: Harness; version: string; binary: string; versionArgs: string[]; launchArgs(prompt: string): string[]; }
export function requireProtocol(version: number): void { if (version !== PROTOCOL_VERSION) throw new CoordError("PROTOCOL_INCOMPATIBLE", "Client and backend protocol versions differ"); }
export interface VersionHandshake { backendProtocolVersion: number; minSupportedClientVersion: string; requiredCapabilities: readonly string[]; supportedCapabilities: readonly string[]; }
function compareVersions(a: string, b: string): number {
  const parse = (value: string) => { const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value); if (!match) throw new CoordError("PROTOCOL_INCOMPATIBLE", "Invalid client version"); return match; };
  const left = parse(a), right = parse(b);
  for (let i = 1; i <= 3; i++) { const delta = Number(left[i]) - Number(right[i]); if (delta) return Math.sign(delta); }
  if (left[4] === right[4]) return 0;
  if (!left[4]) return 1; if (!right[4]) return -1;
  const l = left[4].split("."), r = right[4].split(".");
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    const x = l[i], y = r[i]; if (x === y) continue; if (x === undefined) return -1; if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Math.sign(Number(x) - Number(y)); if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
export function requireHandshake(server: VersionHandshake, client: { protocolVersion: number; clientVersion: string; capabilities: readonly string[] } = { protocolVersion: PROTOCOL_VERSION, clientVersion: CLIENT_VERSION, capabilities: CAPABILITIES }): void {
  requireProtocol(server.backendProtocolVersion); requireProtocol(client.protocolVersion);
  if (compareVersions(client.clientVersion, server.minSupportedClientVersion) < 0 || server.requiredCapabilities.some(c => !client.capabilities.includes(c)) || CAPABILITIES.some(c => !server.supportedCapabilities.includes(c))) throw new CoordError("PROTOCOL_INCOMPATIBLE", "Client/backend version or required capabilities are incompatible");
}
export function requireCapability(evidence: CapabilityEvidence, expected: CapabilityKey, mode: ExecutionMode, now = Date.now()): void {
  if (Object.keys(expected).some(k => evidence.key[k as keyof CapabilityKey] !== expected[k as keyof CapabilityKey])) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "Capability configuration changed; rerun qualification");
  for (const id of REQUIRED_CHECKS[mode]) {
    const checks = evidence.checks.filter(c => c.checkId === id);
    const check = checks[0];
    const observed = check ? Date.parse(check.observedAt) : NaN;
    const common = ["harness.version", "plugin.discovery", "mcp.roundtrip"].includes(id);
    if (checks.length !== 1 || !check || check.kind !== "real" || check.status !== "PASS" || check.configurationDigest !== expected.configurationDigest || !check.evidenceRef || !Number.isFinite(observed) || observed > now || now - observed > 86_400_000 || (!common && check.mode !== mode && !(check.mode === "managed" && mode === "manual"))) throw new CoordError("UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", `Missing, stale or ambiguous real capability evidence: ${id}`);
  }
}
