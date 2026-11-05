import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decryptVault, encryptVault, generateToken, readSmallFile, writeNewPrivateFile } from "../src/credentials.js";
const binding = { backendId: "backend", backendUrl: "https://fixture.convex.cloud", projectId: "project", humanId: "human" };
const passphrase = "fixture-only long passphrase";

test("T1 encrypted vault rejects wrong passphrase, all binding substitutions and authenticated ciphertext changes", async () => {
  const token = generateToken(), value = { token, role: "human" };
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(token, generateToken());
  const sealed = await encryptVault(value, passphrase, binding);
  assert.ok(!sealed.includes(token) && !sealed.includes(passphrase));
  assert.deepEqual(await decryptVault(sealed, passphrase, binding), value);
  await assert.rejects(decryptVault(sealed, "other fixture passphrase", binding), /Vault unlock failed/);
  for (const changed of [{ backendId: "other" }, { backendUrl: "https://other.convex.cloud" }, { projectId: "other" }, { humanId: "other" }]) await assert.rejects(decryptVault(sealed, passphrase, { ...binding, ...changed }), /Vault unlock failed/);
  for (const field of ["salt", "iv", "tag", "ciphertext"]) {
    const envelope = JSON.parse(sealed) as Record<string, string>;
    const current = envelope[field]!; envelope[field] = (current[0] === "a" ? "b" : "a") + current.slice(1);
    await assert.rejects(decryptVault(JSON.stringify(envelope), passphrase, binding), /Vault unlock failed/);
  }
  await assert.rejects(decryptVault(JSON.stringify({ ...JSON.parse(sealed), schemaVersion: 2 }), passphrase, binding));
});

test("vault sizes and fixed KDF limits cannot create an unreadable oversized envelope", async () => {
  await assert.rejects(encryptVault({}, "short", binding));
  await assert.rejects(encryptVault({ data: "x".repeat(65520) }, passphrase, binding), /local limit/);
  await assert.rejects(decryptVault("x".repeat(128 * 1024 + 1), passphrase, binding), /Vault unlock failed/);
  const sealed = await encryptVault({ data: "x".repeat(60 * 1024) }, passphrase, binding);
  assert.deepEqual(await decryptVault(sealed, passphrase, binding), { data: "x".repeat(60 * 1024) });
});

test("credential files are durable create-only, private, bounded and reject symlink redirects", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "coord-vault-fixture-")));
  try {
    const path = join(directory, "new", "vault.json");
    await writeNewPrivateFile(path, "fixture sealed bytes");
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal((await lstat(join(directory, "new"))).mode & 0o777, 0o700);
    assert.equal(await readSmallFile(path, true), "fixture sealed bytes");
    await assert.rejects(writeNewPrivateFile(path, "replacement"), { code: "EEXIST" });
    assert.equal(await readFile(path, "utf8"), "fixture sealed bytes");
    await symlink(path, join(directory, "alias"));
    await assert.rejects(readSmallFile(join(directory, "alias"), true));
    await symlink(join(directory, "new"), join(directory, "alias-directory"));
    await assert.rejects(writeNewPrivateFile(join(directory, "alias-directory", "other"), "rejected"));
    await assert.rejects(readSmallFile(join(directory, "alias-directory", "vault.json"), true));
    await chmod(path, 0o644);
    await assert.rejects(readSmallFile(path, true));
    await chmod(path, 0o600);
    await writeFile(path, "x".repeat(128 * 1024 + 1));
    await assert.rejects(readSmallFile(path, true));
    await chmod(join(directory, "new"), 0o755);
    await assert.rejects(writeNewPrivateFile(join(directory, "new", "other"), "rejected"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
