import { createHash } from "node:crypto";
import { CoordError, DEFAULTS } from "./protocol.js";
import { git, validatePreparedCheckpoint } from "./checkpoint.js";
import type { CaptureOptions, PreparedCheckpoint } from "./checkpoint.js";
import type { RunBinding } from "./session.js";
import type { RunIdentity } from "./protocol.js";
import type { BackendClient } from "./client.js";

export interface ScopeChunk { revision: string; chunk: number; paths: string[]; digest: string; expectedChunks: number; expectedPaths: number; sourceHead: string; tree: string; }
export function scopeChunks(paths: string[], revision: string, sourceHead: string, tree: string): ScopeChunk[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(revision) || ![sourceHead, tree].every(oid => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))) throw new CoordError("INVALID_INPUT", "Invalid scope scan identity");
  const sorted = [...new Set(paths)].sort(); const chunks: string[][] = []; let current: string[] = [];
  for (const path of sorted) {
    if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.length > 8192 || path.split("/").some(part => !part || part === "." || part === "..") || Buffer.byteLength(JSON.stringify([path])) > DEFAULTS.scanBytes) throw new CoordError("COVERAGE_INCOMPLETE", "A changed path cannot fit the supported scan representation");
    if (current.length >= DEFAULTS.scanPaths || Buffer.byteLength(JSON.stringify([...current, path])) > DEFAULTS.scanBytes) { chunks.push(current); current = []; }
    current.push(path);
  }
  if (current.length || !chunks.length) chunks.push(current);
  if (chunks.length > 1000) throw new CoordError("COVERAGE_INCOMPLETE", "Scan exceeds configured total chunk limit");
  return chunks.map((items, chunk) => ({ revision, chunk, paths: items, digest: createHash("sha256").update(JSON.stringify(items)).digest("hex"), expectedChunks: chunks.length, expectedPaths: sorted.length, sourceHead, tree }));
}
/** Net tracked/selected-untracked changes are read from the audited candidate, including local commits. */
export async function scanCheckpoint(options: CaptureOptions, checkpoint: PreparedCheckpoint, revision: string): Promise<ScopeChunk[]> {
  await validatePreparedCheckpoint(options, checkpoint);
  const output = await git(options.repo, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", options.executionBase.sha, checkpoint.tree, "--"], { transport: options.gitTransport, metadataIsolation: options.gitMetadataIsolation });
  let names: string;
  try { names = new TextDecoder("utf-8", { fatal: true }).decode(output.stdout); } catch { throw new CoordError("COVERAGE_INCOMPLETE", "Scope scan contains an unsupported non-UTF8 path"); }
  return scopeChunks(names.split("\0").filter(Boolean), revision, checkpoint.sourceHead, checkpoint.tree);
}
export async function uploadScope(run: RunBinding, chunks: ScopeChunk[]): Promise<void> {
  for (const chunk of chunks) await run.client.mutation("scans:upload", { ...run.identity, ...chunk }, `scan_${chunk.revision}_${chunk.chunk}`);
}
/** Only the separately protected artifact verifier may attest actual Git-derived coverage. */
export async function verifyScope(verifier: BackendClient, identity: RunIdentity, options: CaptureOptions, checkpoint: PreparedCheckpoint, revision: string, evidenceRef: string): Promise<unknown> {
  const chunks = await scanCheckpoint(options, checkpoint, revision);
  const paths = chunks.flatMap(chunk => chunk.paths);
  const pathsDigest = createHash("sha256").update(JSON.stringify(paths)).digest("hex");
  return verifier.mutation("scans:verify", { ...identity, revision, sourceHead: checkpoint.sourceHead, tree: checkpoint.tree, pathsDigest, expectedPaths: paths.length, evidenceRef }, `verify_scan_${revision}`);
}
