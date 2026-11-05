import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RULES_END, RULES_START, syncRules } from "../src/rulesync.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-rules-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("rule sync changes only the managed block, preserves file mode, and is repeatable", async t => {
  const root = await fixture(t);
  const target = path.join(root, "AGENTS.md");
  const prefix = "Human instructions stay byte-for-byte.\r\n\n";
  const suffix = "\n\n## More human instructions\nKeep these.\n";
  await writeFile(target, `${prefix}${RULES_START}\nold\n${RULES_END}${suffix}`, { mode: 0o640 });
  const first = await syncRules(root, ["AGENTS.md"], { policyVersion: 2, content: "Current approved rules" });
  const updated = await readFile(target, "utf8");
  assert.ok(updated.startsWith(prefix));
  assert.ok(updated.endsWith(suffix));
  assert.match(updated, /policyVersion: 2/);
  assert.equal((await stat(target)).mode & 0o777, 0o640);
  const second = await syncRules(root, ["AGENTS.md"], { policyVersion: 2, content: "Current approved rules" });
  assert.equal(first[0]!.changed, true);
  assert.equal(second[0]!.changed, false);
  assert.equal(first[0]!.contentHash, second[0]!.contentHash);
  assert.deepEqual(await readdir(root), ["AGENTS.md"]);
});

test("missing file is created, existing human content is preserved when adding first block", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "AGENTS.md"), "Human text without final newline");
  await syncRules(root, ["AGENTS.md", "CLAUDE.md"], { policyVersion: 1, content: "Rule 🧭" });
  assert.ok((await readFile(path.join(root, "AGENTS.md"), "utf8")).startsWith("Human text without final newline\n"));
  assert.match(await readFile(path.join(root, "CLAUDE.md"), "utf8"), /Rule 🧭/);
});

test("path traversal, absolute paths, Windows escapes and metadata targets are rejected before writes", async t => {
  const root = await fixture(t);
  for (const target of ["../outside.md", "/tmp/outside.md", "C:\\outside.md", "rules/../../outside.md", "rules\\outside.md", ".git/config", "./AGENTS.md", "rules//AGENTS.md"]) {
    await assert.rejects(syncRules(root, [target], { policyVersion: 1, content: "Rule" }), /repository-relative/);
  }
  assert.deepEqual(await readdir(root), []);
});

test("final symlink and directory symlink escapes never alter their external target", async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const externalFile = path.join(outside, "AGENTS.md");
  await writeFile(externalFile, "External human content");
  await symlink(externalFile, path.join(root, "AGENTS.md"));
  await symlink(outside, path.join(root, "rules"));
  await assert.rejects(syncRules(root, ["AGENTS.md"], { policyVersion: 1, content: "Rule" }), /symlinks/);
  await assert.rejects(syncRules(root, ["rules/AGENTS.md"], { policyVersion: 1, content: "Rule" }), /ordinary directories/);
  assert.equal(await readFile(externalFile, "utf8"), "External human content");
});

test("malformed markers, nested rule markers and invalid UTF-8 fail without overwriting human data", async t => {
  const root = await fixture(t);
  const target = path.join(root, "AGENTS.md");
  for (const contents of [`Human\n${RULES_START}\nmissing end`, `${RULES_START}\n${RULES_START}\n${RULES_END}`, `${RULES_END}\n${RULES_START}`]) {
    await writeFile(target, contents);
    await assert.rejects(syncRules(root, ["AGENTS.md"], { policyVersion: 1, content: "Rule" }), /ambiguous/);
    assert.equal(await readFile(target, "utf8"), contents);
  }
  await assert.rejects(syncRules(root, ["AGENTS.md"], { policyVersion: 1, content: RULES_END }), /marker-free/);
  const invalid = Buffer.from([0xff, 0xfe]);
  await writeFile(target, invalid);
  await assert.rejects(syncRules(root, ["AGENTS.md"], { policyVersion: 1, content: "Rule" }), /valid UTF-8/);
  assert.deepEqual(await readFile(target), invalid);
});

test("all targets preflight before changes, and duplicate targets fail", async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, "rules"));
  await writeFile(path.join(root, "AGENTS.md"), "Human");
  await assert.rejects(syncRules(root, ["AGENTS.md", "../escape"], { policyVersion: 1, content: "Rule" }));
  assert.equal(await readFile(path.join(root, "AGENTS.md"), "utf8"), "Human");
  await assert.rejects(syncRules(root, ["AGENTS.md", "AGENTS.md"], { policyVersion: 1, content: "Rule" }), /Duplicate/);
});
