import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnvironment, inspectSetup, requireEnvironment, type EnvironmentRequirement } from "../src/environment.js";

const requirements: EnvironmentRequirement[] = [{ name: "TEST_TOKEN", modes: ["manual", "managed"] }, { name: "PROD_KEY", modes: ["managed"] }, { name: "PORT", modes: ["manual"], type: "integer" }];
test("T14 exported effective keys pass without an env file; mode-specific production requirements do not block manual runs", async () => {
  const secret = "ENV_FAKE_SECRET_do_not_emit_18a7";
  const report = await checkEnvironment(requirements, "manual", { processEnv: { TEST_TOKEN: secret, PORT: "8080" } });
  assert.equal(report.status, "PASS"); assert(!JSON.stringify(report).includes(secret));
  assert(!report.sources.some(source => source.name === "PROD_KEY"));
  const managed = await checkEnvironment(requirements, "managed", { processEnv: { TEST_TOKEN: secret } });
  assert.deepEqual(managed.missing, ["PROD_KEY"]);
  assert.throws(() => requireEnvironment(managed), /PROD_KEY/);
});
test("T14 explicit files and approved provider resolve values without returning them; exported empty values override local defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coord-env-test-"));
  try {
    const file = join(directory, "selected.env");
    await writeFile(file, "TEST_TOKEN='FILE_SECRET_7b01'\nPORT=1234\n");
    const pass = await checkEnvironment(requirements, "managed", { processEnv: {}, files: [file], providers: [{ id: "test-provider", resolve: async names => Object.fromEntries(names.map(name => [name, "PROVIDER_SECRET_ca81"])) }] });
    assert.equal(pass.status, "PASS"); assert(!JSON.stringify(pass).includes("SECRET"));
    const blocked = await checkEnvironment(requirements, "manual", { processEnv: { TEST_TOKEN: "", PORT: "not-number" }, files: [file] });
    assert.deepEqual(blocked.missing, ["TEST_TOKEN"]); assert.deepEqual(blocked.invalid, ["PORT"]);
    await writeFile(file, "TEST_TOKEN=$(never-execute)\n");
    await assert.rejects(checkEnvironment(requirements, "manual", { processEnv: {}, files: [file] }), /expansion/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("setup inspection requires existing lockfiles and frozen commands, performs no install", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coord-setup-test-"));
  try {
    await assert.rejects(inspectSetup(directory, [["npm", "ci"]]), /lockfile/);
    await writeFile(join(directory, "package-lock.json"), '{"lockfileVersion":3}\n');
    const report = await inspectSetup(directory, [["npm", "ci"]]);
    assert.equal(report.locks.length, 1); assert.match(report.locks[0]!.sha256, /^[a-f0-9]{64}$/);
    await assert.rejects(inspectSetup(directory, [["npm", "install"]]), /lockfile-preserving/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
