import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/doctor.js";
import { requireCapability, type ExecutionMode } from "../src/protocol.js";

const canary = "DOCTOR_FAKE_SECRET_DO_NOT_EMIT_861abca9";
async function withBinaries(body: string, run: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "coord-doctor-test-"));
  const oldPath = process.env.PATH;
  try {
    for (const name of ["codex", "agy", "claude"]) {
      const path = join(directory, name);
      await writeFile(path, `#!/bin/sh\n${body}\n`); await chmod(path, 0o700);
    }
    process.env.PATH = `${directory}:${oldPath ?? ""}`;
    await run();
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  }
}

test("doctor withholds config/help/auth canaries and never promotes sign-in or fixtures into qualification", async () => {
  await withBinaries(`case "$1" in
--version) echo '99.1.2';;
login) echo 'Logged in using ${canary}';;
*) echo '--sandbox --ask-for-approval ${canary}';;
esac`, async () => {
    const report = await runDoctor({ fixtures: false });
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.capabilities.length, 3);
    assert(!JSON.stringify(report).includes(canary));
    assert(report.gates.every(gate => gate.status === "BLOCKED"));
    for (const capability of report.capabilities) {
      assert.equal(capability.key.harnessVersion, "99.1.2");
      assert.equal(capability.checks.find(check => check.checkId === "credentials.tool-isolation")?.status, "BLOCKED");
      assert.match(capability.key.configurationDigest, /^[a-f0-9]{64}$/);
      for (const mode of ["advisory", "manual", "managed"] as ExecutionMode[]) assert.throws(() => requireCapability(capability, capability.key, mode));
    }
    assert.equal(report.capabilities[0]?.checks.find(check => check.checkId === "harness.authentication")?.status, "PASS");
  });
});

test("doctor bounds hung or excessive command output and keeps evidence redacted", async () => {
  await withBinaries(`case "$1" in
--version) while :; do :; done;;
*) while :; do echo '${canary}'; done;;
esac`, async () => {
    const start = Date.now();
    const report = await runDoctor({ timeoutMs: 1_000, outputLimit: 1024, fixtures: false });
    assert(Date.now() - start < 10_000);
    assert(report.commandResults.some(result => result.outcome === "timeout"));
    assert(report.commandResults.some(result => result.outcome === "output-limit"));
    assert(!JSON.stringify(report).includes(canary));
    assert(report.gates.every(gate => gate.status === "BLOCKED"));
  });
});

test("disposable real Git/process primitives stay labeled fixture", { skip: process.platform === "win32" }, async () => {
  await withBinaries("echo '99.1.2'", async () => {
    const report = await runDoctor();
    assert.equal(report.fixtures.length, 3);
    assert(report.fixtures.every(check => check.kind === "fixture"));
    assert.equal(report.fixtures.find(check => check.checkId === "fixture.git.refs")?.status, "PASS");
    // Restricted hosts may deny ps/boot inspection; that is an explicit blocker, never a fabricated pass.
    assert(["PASS", "BLOCKED"].includes(report.fixtures.find(check => check.checkId === "fixture.process.identity")?.status ?? "missing"));
    assert.equal(report.fixtures.find(check => check.checkId === "fixture.process.stop")?.status, "PASS");
    assert(report.gates.every(gate => gate.status === "BLOCKED"));
  });
});

test("doctor rejects nonfinite command limits", async () => {
  await assert.rejects(runDoctor({ timeoutMs: Number.NaN }), /finite/);
  await assert.rejects(runDoctor({ outputLimit: Number.NaN }), /finite/);
});
