import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { BackendClient } from "./client.js";
import { CoordError, PROTOCOL_VERSION } from "./protocol.js";
import { syncRules } from "./rulesync.js";
import { buildContext } from "./context.js";
import type { RunBinding } from "./session.js";

/** Write a project-scoped JSONL export exclusively; no credential/invite/idempotency tables. */
export async function exportProject(client: Pick<BackendClient, "query" | "config">, destination: string): Promise<{ path: string; records: number }> {
  const requested = resolve(destination), parent = await realpath(dirname(requested)), path = join(parent, basename(requested));
  const file = await open(path, "wx", 0o600); let records = 0;
  try {
    await file.writeFile(`${JSON.stringify({ type: "header", schemaVersion: 1, protocolVersion: PROTOCOL_VERSION, backendId: client.config.backendId, projectId: client.config.projectId, exportedAt: new Date().toISOString(), consistentSnapshot: false })}\n`);
    for (const table of ["goals", "tasks", "runs", "scans", "messages", "memories", "checkpoints", "publications", "audit"]) {
      let cursor: string | null = null; const cursors = new Set<string>();
      for (;;) {
        const page = await client.query("exports:page", { table, pagination: { cursor, numItems: 25 } }) as { projectId: string; table: string; page: Record<string, unknown>[]; isDone: boolean; continueCursor: string };
        if (page.projectId !== client.config.projectId || page.table !== table || !Array.isArray(page.page) || page.page.length > 25 || typeof page.isDone !== "boolean" || typeof page.continueCursor !== "string" || page.page.some(row => row.projectId !== client.config.projectId)) throw new CoordError("UNAUTHORIZED", "Export response scope or pagination mismatch");
        for (const row of page.page) { await file.writeFile(`${JSON.stringify({ type: "record", table, record: row })}\n`); records++; }
        if (page.isDone) break;
        if (!page.continueCursor || cursors.has(page.continueCursor)) throw new CoordError("COVERAGE_INCOMPLETE", "Export pagination did not advance");
        cursors.add(page.continueCursor); cursor = page.continueCursor;
      }
    }
    await file.writeFile(`${JSON.stringify({ type: "complete", records })}\n`); await file.sync();
  } finally { await file.close(); }
  return { path, records };
}

export async function syncApprovedRules(root: string, targets: string[], run: RunBinding): Promise<unknown> {
  const response = await run.client.query("memories:rules", { ...run.identity }) as { complete: boolean; policyVersion: number; ruleTargets: string[]; rules: { id: string; revision: number; content: string; hash: string; approvedHash?: string; approvedBy?: string }[] };
  if (!response.complete || !Number.isSafeInteger(response.policyVersion) || !Array.isArray(response.rules) || !Array.isArray(response.ruleTargets) || targets.some(target => !response.ruleTargets.includes(target)) || response.rules.some(rule => !rule.approvedBy || rule.hash !== rule.approvedHash)) throw new CoordError("COVERAGE_INCOMPLETE", "Complete current approved rules and allowed targets are required before file synchronization");
  // Same mandatory-instruction cap as the briefing; never silently drop rules to fit.
  buildContext(response.rules.map(rule => ({ id: rule.id, kind: "rule", revision: String(rule.revision), status: "available", text: rule.content, approved: true, mandatory: true })));
  const results = await syncRules(root, targets, { policyVersion: response.policyVersion, content: response.rules.map(rule => rule.content).join("\n\n") });
  const local = join(await realpath(root), ".coord-local"); await mkdir(local, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const info = await lstat(local); if (!info.isDirectory() || info.isSymbolicLink()) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Local policy receipt directory is unsafe");
  const temporary = join(local, `policy-${randomUUID()}.json`), handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, policyVersion: response.policyVersion, results })); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, join(local, "policy.json"));
  return { policyVersion: response.policyVersion, targets: results, allCheckoutsSynced: false };
}
