import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeChunks } from "../src/scan.js";
test("T4 scans preserve complete >500 path coverage within both limits", () => {
  const paths = Array.from({ length: 1003 }, (_, index) => `src/${String(index).padStart(4, "0")}.ts`);
  paths.push(`src/${"long".repeat(500)}.ts`);
  const chunks = scopeChunks(paths, "revision", "a".repeat(40), "b".repeat(40));
  assert.deepEqual(chunks.flatMap(chunk => chunk.paths), paths.sort());
  assert.ok(chunks.every(chunk => chunk.paths.length <= 500 && Buffer.byteLength(JSON.stringify(chunk.paths)) <= 102400 && chunk.expectedPaths === 1004));
});
test("T4 empty scans are explicit and unsupported paths never silently disappear", () => {
  assert.equal(scopeChunks([], "empty", "a".repeat(40), "b".repeat(40))[0]?.expectedPaths, 0);
  assert.throws(() => scopeChunks(["../escape"], "bad", "a".repeat(40), "b".repeat(40)), { code: "COVERAGE_INCOMPLETE" });
});
