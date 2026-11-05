import { mkdir, open, readFile, realpath, lstat, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { BackendClient } from "./client.js";
import { CoordError } from "./protocol.js";
import { canonicalJson } from "./canonical.js";
import type { CapabilityKey, Harness, RunIdentity } from "./protocol.js";

export interface ManualAdmission { requestId: string; taskId: string; machineId: string; harness: Harness; capabilityKey: CapabilityKey; }
interface Receipt { schemaVersion: 1; backendId: string; projectId: string; sessionId: string; requestHash: string; input: ManualAdmission; runId: string; launchId: string; grantToken: string; identity?: RunIdentity; }
export interface RunBinding { client: BackendClient; identity: RunIdentity; }
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function validId(value: string): void { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new CoordError("INVALID_INPUT", "Invalid local session identity"); }
async function directory(root: string, sessionId: string): Promise<string> {
  validId(sessionId);
  let current = await realpath(root);
  for (const component of [".coord-local", "sessions", sessionId]) {
    current = join(current, component);
    await mkdir(current, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Session directory is not a private local directory");
  }
  return current;
}
async function readReceipt(path: string, client: BackendClient, sessionId: string): Promise<Receipt> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new CoordError("UNAUTHORIZED", "Run receipt permissions must be private");
  const value = JSON.parse(await readFile(path, "utf8")) as Receipt;
  if (value.schemaVersion !== 1 || value.backendId !== client.config.backendId || value.projectId !== client.config.projectId || value.sessionId !== sessionId || !/^[a-f0-9]{64}$/.test(value.grantToken)) throw new CoordError("UNAUTHORIZED", "Run receipt does not match trusted routing");
  return value;
}
async function durableWrite(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
export async function loadSession(root: string, client: BackendClient, sessionId?: string): Promise<RunBinding | undefined> {
  if (!sessionId) return undefined;
  const dir = await directory(root, sessionId);
  let receipt: Receipt;
  try { receipt = await readReceipt(join(dir, "admission.json"), client, sessionId); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!receipt.identity) return undefined;
  const runClient = client.withRunToken(receipt.grantToken);
  await runClient.query("tasks:checkIn", { ...receipt.identity });
  return { client: runClient, identity: receipt.identity };
}
/** Persist the request/grant before admission; replay the same request after a lost reply. */
export async function registerManual(root: string, client: BackendClient, sessionId: string | undefined, input: ManualAdmission): Promise<RunBinding & { publicResult: unknown }> {
  if (!sessionId) throw new CoordError("BLOCKED_ENV", "A host-bound COORD_SESSION_ID is required for participating manual registration");
  const dir = await directory(root, sessionId), path = join(dir, "admission.json");
  const requestHash = digest(input);
  let receipt: Receipt = { schemaVersion: 1, backendId: client.config.backendId, projectId: client.config.projectId, sessionId, requestHash, input, runId: randomUUID(), launchId: randomUUID(), grantToken: randomBytes(32).toString("hex") };
  try { await durableWrite(path, receipt); await syncDirectory(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; receipt = await readReceipt(path, client, sessionId); }
  if (receipt.requestHash !== requestHash) throw new CoordError("IDEMPOTENCY_CONFLICT", "This session already has a different admission request; retain its receipt for recovery");
  const result = await client.mutation("tasks:registerManual", { taskId: input.taskId, machineId: input.machineId, harness: input.harness, capabilityKey: { ...input.capabilityKey }, runId: receipt.runId, launchId: receipt.launchId, grantToken: receipt.grantToken }, input.requestId);
  const value = result as Partial<RunIdentity>;
  if (value.runId !== receipt.runId || value.taskId !== input.taskId || !Number.isSafeInteger(value.epoch) || !Number.isSafeInteger(value.goalRevision)) throw new CoordError("INVALID_INPUT", "Backend admission returned an invalid identity");
  receipt.identity = { runId: value.runId, taskId: value.taskId, epoch: value.epoch!, goalRevision: value.goalRevision! };
  // A replayed historical admission is not proof of current authority.
  const runClient = client.withRunToken(receipt.grantToken);
  await runClient.query("tasks:checkIn", { ...receipt.identity });
  const temp = join(dir, `receipt-${randomUUID()}.json`);
  await durableWrite(temp, receipt); await rename(temp, path); await syncDirectory(dir);
  return { client: runClient, identity: receipt.identity, publicResult: { ...receipt.identity, registered: true } };
}
