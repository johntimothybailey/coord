import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportProject } from "../src/operations.js";
import type { BackendClient } from "../src/client.js";

test("T17 project export paginates only permitted tables and marks completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coord-export-"));
  try {
    const calls: string[] = [];
    const client = { config: { backendId: "b", projectId: "p" }, async query(_name: string, args: { table: string; pagination: { cursor: string | null } }) {
      calls.push(args.table);
      return { projectId: "p", table: args.table, page: [{ projectId: "p", id: args.pagination.cursor ?? "first" }], isDone: args.pagination.cursor === "next", continueCursor: "next" };
    } } as unknown as Pick<BackendClient, "query" | "config">;
    const result = await exportProject(client, join(dir, "export.jsonl"));
    assert.equal(result.records, 18);
    assert.ok(!calls.includes("credentials") && !calls.includes("invites") && !calls.includes("idempotency"));
    const records = (await readFile(result.path, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { type: string; consistentSnapshot?: boolean });
    assert.equal(records[0]?.consistentSnapshot, false); assert.equal(records.at(-1)?.type, "complete");
    await assert.rejects(exportProject(client, result.path), { code: "EEXIST" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("T17 cross-project or nonadvancing export remains explicitly incomplete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coord-export-"));
  try {
    const client = { config: { backendId: "b", projectId: "p" }, async query(_name: string, args: { table: string }) { return { projectId: "other", table: args.table, page: [], isDone: true, continueCursor: "end" }; } } as unknown as Pick<BackendClient, "query" | "config">;
    const destination = join(dir, "partial.jsonl");
    await assert.rejects(exportProject(client, destination), { code: "UNAUTHORIZED" });
    assert.ok(!(await readFile(destination, "utf8")).includes('"type":"complete"'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
