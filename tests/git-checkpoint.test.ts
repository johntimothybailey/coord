import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCheckpoint, captureDigest, git, gitText, publishCheckpoint, verifyRemoteCheckpoint, type CaptureOptions, type PreparedCheckpoint } from "../src/checkpoint.js";
import { CoordError } from "../src/protocol.js";
import { checkEnvironment } from "../src/environment.js";
import { createResumeWorktree } from "../src/worktree.js";
import { publishReview, type PublishReviewOptions, type ReviewRecord } from "../src/review.js";
import { scanCheckpoint } from "../src/scan.js";

const canary = "FIXTURE_SECRET_LOCAL_ANCESTRY_51e652";
async function fixture(run: (options: CaptureOptions, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "coord-git-test-"));
  const repo = join(directory, "source"), remote = join(directory, "remote.git");
  try {
    await mkdir(repo);
    await git(repo, ["init", "--quiet", "-b", "main"]);
    await git(repo, ["init", "--quiet", "--bare", remote]);
    await writeFile(join(repo, "feature.ts"), "export const feature = 1;\n");
    await writeFile(join(repo, "unrelated.ts"), "export const unrelated = 1;\n");
    await commit(repo, "Establish shared fixture baseline");
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
    const base = await gitText(repo, ["rev-parse", "HEAD"]);
    const options: CaptureOptions = { repo, remote: { name: "origin", url: remote }, checkpointId: "cp1", identity: { taskId: "task1", runId: "run1", epoch: 1, goalRevision: 1 }, executionBase: { sha: base, revision: 1, remoteRef: "refs/heads/main" }, progress: { completed: ["Implemented feature"], remaining: ["Verify continuation"], nextStep: "Run tests" }, progressRevision: 1, createdAt: "2026-11-04T20:00:00.000Z", commitMessage: "Preserve verified work for cross-machine continuation\n\nConfidence: high\nScope-risk: narrow\nTested: Disposable fixture", policy: { allowedUntracked: [], exclusions: [], requiredPaths: ["feature.ts"], forbiddenContent: [canary] }, readAuthority: async () => ({ identity: options.identity, executionBase: options.executionBase, progressRevision: options.progressRevision, progressHash: captureDigest(options.progress), policyDigest: captureDigest(options.policy) }), quietBoundary: async () => {} };
    await run(options, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function commit(repo: string, message: string): Promise<void> {
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", message]);
}
async function assertNoLocalSecret(remote: string, manifest: PreparedCheckpoint, base: string): Promise<void> {
  const reachable = (await gitText(remote, ["rev-list", "--objects", manifest.ref])).split("\n");
  for (const item of reachable) {
    const oid = item.split(" ")[0]!;
    const type = await gitText(remote, ["cat-file", "-t", oid]);
    if (type === "blob") assert(!(await gitText(remote, ["cat-file", "blob", oid])).includes(canary));
  }
  assert.equal(await gitText(remote, ["rev-list", "--count", `${base}..${manifest.ref}`]), "1");
  assert.equal(await gitText(remote, ["show", "-s", "--format=%P", manifest.ref]), base);
}

test("T6/T7 complete capture preserves source index, captures modes/symlinks/untracked/deletions and excludes local secret ancestry", async () => {
  await fixture(async options => {
    await writeFile(join(options.repo, "local-secret.txt"), canary);
    await commit(options.repo, "Keep secret local to fixture ancestry");
    await unlink(join(options.repo, "local-secret.txt"));
    await commit(options.repo, "Remove fixture secret from final source tree");
    await writeFile(join(options.repo, "feature.ts"), "export const feature = 2;\n");
    await writeFile(join(options.repo, "feature.test.ts"), "export const test = true;\n");
    await writeFile(join(options.repo, ".env.local"), canary);
    await git(options.repo, ["add", "--", ".env.local"]);
    await chmod(join(options.repo, "feature.ts"), 0o755);
    await unlink(join(options.repo, "unrelated.ts"));
    await symlink("feature.ts", join(options.repo, "feature-link"));
    options.policy.allowedUntracked = ["feature.test.ts", "feature-link"];
    options.policy.exclusions = [{ path: ".env.local", reason: "Local-only fixture credentials" }];
    const originalHead = await gitText(options.repo, ["rev-parse", "HEAD"]);
    const index = await readFile(join(options.repo, ".git", "index"));
    const status = (await git(options.repo, ["status", "--porcelain=v1", "-z"])).stdout;
    const manifest = await captureCheckpoint(options);
    assert.equal(manifest.remoteParent, options.executionBase.sha);
    assert.equal(manifest.files.find(file => file.path === "feature.ts")?.mode, "100755");
    assert.equal(manifest.files.find(file => file.path === "feature-link")?.type, "symlink");
    assert(manifest.files.some(file => file.path === "feature.test.ts"));
    assert(!manifest.files.some(file => file.path === ".env.local" || file.path === "unrelated.ts"));
    assert(manifest.exclusions.some(item => item.path === ".env.local"));
    const scan = await scanCheckpoint(options, manifest, "scan1");
    assert.deepEqual(scan.flatMap(chunk => chunk.paths), ["feature-link", "feature.test.ts", "feature.ts", "unrelated.ts"]);
    assert(scan.every(chunk => chunk.sourceHead === manifest.sourceHead && chunk.tree === manifest.tree && chunk.expectedPaths === 4));
    await publishCheckpoint(options, manifest);
    const readback = await verifyRemoteCheckpoint(options, manifest);
    assert.deepEqual(readback.parents, [options.executionBase.sha]); assert.equal(readback.parent, options.executionBase.sha);
    await publishCheckpoint(options, manifest);
    await assertNoLocalSecret(options.remote.url, manifest, options.executionBase.sha);
    assert.equal(await gitText(options.repo, ["rev-parse", "HEAD"]), originalHead);
    assert.deepEqual(await readFile(join(options.repo, ".git", "index")), index);
    assert.deepEqual((await git(options.repo, ["status", "--porcelain=v1", "-z"])).stdout, status);
  });
});

test("T18 advancing target base never reparents an old source tree to the new tip", async () => {
  await fixture(async (options, directory) => {
    const upstream = join(directory, "upstream");
    await git(directory, ["clone", "--quiet", "--branch", "main", options.remote.url, upstream]);
    await writeFile(join(upstream, "feature.ts"), "export const feature = 100;\n");
    await writeFile(join(upstream, "unrelated.ts"), "export const unrelated = 100;\n");
    await commit(upstream, "Advance unrelated and task scoped source upstream");
    await git(upstream, ["push", "--quiet", "origin", "main"]);
    const newer = await gitText(upstream, ["rev-parse", "HEAD"]);
    await writeFile(join(options.repo, "feature.ts"), "export const feature = 2;\n");
    const manifest = await captureCheckpoint(options);
    assert.notEqual(newer, manifest.remoteParent);
    assert.equal(manifest.remoteParent, options.executionBase.sha);
    assert.equal(await gitText(options.repo, ["show", "-s", "--format=%P", manifest.commit]), options.executionBase.sha);
    await publishCheckpoint(options, manifest);
    assert.equal(await gitText(options.remote.url, ["show", "refs/heads/main:feature.ts"]), "export const feature = 100;");
    assert.equal(await gitText(options.remote.url, ["show", `${manifest.ref}:feature.ts`]), "export const feature = 2;");
    assert.equal(await gitText(options.remote.url, ["show", `${manifest.ref}:unrelated.ts`]), "export const unrelated = 1;");
  });
});

test("T7 local-only execution base blocks even if its object exists", async () => {
  await fixture(async options => {
    await writeFile(join(options.repo, "feature.ts"), "export const feature = 3;\n");
    await commit(options.repo, "Create unpublished local base");
    options.executionBase.sha = await gitText(options.repo, ["rev-parse", "HEAD"]);
    await assert.rejects(captureCheckpoint(options), (error: unknown) => error instanceof CoordError && error.code === "BLOCKED_CHECKPOINT");
    assert.equal(await gitText(options.remote.url, ["for-each-ref", "--format=%(refname)", "refs/coord"]), "");
  });
});

test("T8 repeated source write-and-revert and progress revision changes never produce a prepared checkpoint", async () => {
  await fixture(async options => {
    options.fault = async point => {
      if (point === "capture.after-index") {
        const file = join(options.repo, "feature.ts"); const old = await readFile(file);
        await writeFile(file, "temporary concurrent write\n"); await writeFile(file, old);
      }
    };
    await assert.rejects(captureCheckpoint(options), (error: unknown) => error instanceof CoordError && error.code === "CHECKPOINT_INCOMPLETE");
    let serverRevision = options.progressRevision;
    options.fault = async point => { if (point === "capture.after-index") serverRevision++; };
    options.readAuthority = async () => ({ identity: options.identity, executionBase: options.executionBase, progressRevision: serverRevision, progressHash: captureDigest(options.progress), policyDigest: captureDigest(options.policy) });
    await assert.rejects(captureCheckpoint(options), (error: unknown) => error instanceof CoordError && error.code === "STALE_EPOCH");
  });
});

test("T9 interrupted push acknowledgment reconciles exact immutable ref; compatible existing refs are never updated", async () => {
  await fixture(async options => {
    await writeFile(join(options.repo, "feature.ts"), "export const feature = 4;\n");
    const manifest = await captureCheckpoint(options);
    let injected = false;
    options.fault = async point => { if (point === "publish.after-push" && !injected) { injected = true; throw new Error("injected lost push response"); } };
    await assert.rejects(publishCheckpoint(options, manifest), /injected/);
    options.fault = undefined;
    assert.equal((await publishCheckpoint(options, manifest)).commit, manifest.commit);
    const second = { ...options, checkpointId: "collision" };
    const collision = await captureCheckpoint(second);
    await git(options.repo, ["push", "--quiet", "origin", `${options.executionBase.sha}:${collision.ref}`]);
    await assert.rejects(publishCheckpoint(second, collision), (error: unknown) => error instanceof CoordError && error.code === "IDEMPOTENCY_CONFLICT");
    assert.equal(await gitText(options.remote.url, ["rev-parse", collision.ref]), options.executionBase.sha);
  });
});

test("credential screening, filters, missing required assets and path escapes fail closed", async () => {
  await fixture(async options => {
    await writeFile(join(options.repo, "feature.ts"), canary);
    await assert.rejects(captureCheckpoint(options), /screening/);
    await writeFile(join(options.repo, "feature.ts"), "clean source\n");
    await writeFile(join(options.repo, ".gitattributes"), "*.ts filter=not-supported\n");
    await assert.rejects(captureCheckpoint(options), /filters/);
    await unlink(join(options.repo, ".gitattributes"));
    options.policy.requiredPaths.push("missing-asset.bin");
    await assert.rejects(captureCheckpoint(options), /Required/);
    options.policy.requiredPaths = ["../escape"];
    await assert.rejects(captureCheckpoint(options), /unsafe/);
  });
});

test("unchanged audited tree reuses the remote-present execution base", async () => {
  await fixture(async options => {
    const manifest = await captureCheckpoint(options);
    assert(manifest.reusedCommit);
    assert.equal(manifest.commit, options.executionBase.sha);
    await publishCheckpoint(options, manifest);
    const readback = await verifyRemoteCheckpoint(options, manifest);
    assert.deepEqual(readback.parents, []); assert.equal(readback.parent, null);
  });
});

test("actual commit metadata is screened and bound to exact intended checkpoint identity", async () => {
  await fixture(async options => {
    await writeFile(join(options.repo, "feature.ts"), "updated source\n");
    const manifest = await captureCheckpoint(options);
    const forge = async (message: string) => gitText(options.repo, ["commit-tree", manifest.tree, "-p", options.executionBase.sha], { input: `${message}\n\nCoord-Checkpoint: ${options.checkpointId}\nCoord-Manifest: ${manifest.manifestDigest}\nCoord-Progress: ${manifest.progressHash}\n`, env: { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@invalid" } });
    await assert.rejects(publishCheckpoint(options, { ...manifest, commit: await forge(canary) }), /screening/);
    await assert.rejects(publishCheckpoint(options, { ...manifest, commit: await forge("Unapproved alternate checkpoint metadata") }), /intended/);
    assert.equal(await gitText(options.remote.url, ["for-each-ref", "--format=%(refname)", "refs/coord"]), "");
  });
});

test("push ignores followTags/mirror config and atomic empty lease rejects an ancestor-compatible creation race", async () => {
  await fixture(async options => {
    await writeFile(join(options.repo, "feature.ts"), "updated source\n");
    const manifest = await captureCheckpoint(options);
    await git(options.repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "tag", "-a", "private-metadata", options.executionBase.sha, "-m", canary]);
    await git(options.repo, ["config", "push.followTags", "true"]);
    await git(options.repo, ["config", "remote.origin.mirror", "true"]);
    await publishCheckpoint(options, manifest);
    assert.equal(await gitText(options.remote.url, ["for-each-ref", "--format=%(refname)", "refs/tags"]), "");
    assert.equal(await gitText(options.remote.url, ["for-each-ref", "--format=%(refname)", "refs/heads"]), "refs/heads/main");
    const raceOptions = { ...options, checkpointId: "cas-race" };
    const race = await captureCheckpoint(raceOptions);
    const originalAuthority = raceOptions.readAuthority;
    raceOptions.readAuthority = async phase => {
      if (phase === "publish.before-push") await git(options.remote.url, ["update-ref", race.ref, options.executionBase.sha]);
      return originalAuthority(phase);
    };
    await assert.rejects(publishCheckpoint(raceOptions, race), /Remote checkpoint ref/);
    assert.equal(await gitText(options.remote.url, ["rev-parse", race.ref]), options.executionBase.sha);
  });
});

test("replace refs cannot disguise unsafe commit ancestry; reserved local credential paths require exclusion", async () => {
  await fixture(async options => {
    await writeFile(join(options.repo, "feature.ts"), "safe selected source\n");
    const safe = await captureCheckpoint(options);
    await writeFile(join(options.repo, "secret-history.txt"), canary);
    await commit(options.repo, "Commit private fixture history");
    await unlink(join(options.repo, "secret-history.txt")); await commit(options.repo, "Delete fixture secret");
    const unsafe = await gitText(options.repo, ["rev-parse", "HEAD"]);
    await git(options.repo, ["replace", unsafe, safe.commit]);
    await assert.rejects(publishCheckpoint(options, { ...safe, commit: unsafe }), /Snapshot|intended/);
    assert.equal(await gitText(options.remote.url, ["for-each-ref", "--format=%(refname)", "refs/coord"]), "");
    await mkdir(join(options.repo, ".coord-local"));
    await writeFile(join(options.repo, ".coord-local", "session.json"), '{"opaque":"value-outside-built-in-patterns"}');
    await git(options.repo, ["add", "--", ".coord-local/session.json"]);
    await assert.rejects(captureCheckpoint(options), /Reserved coordinator/);
    options.policy.exclusions.push({ path: ".coord-local/session.json", reason: "Coordinator credentials are machine local" });
    assert(!(await captureCheckpoint(options)).files.some(file => file.path.startsWith(".coord-local/")));
  });
});

test("T6/T9 fresh destination reconstructs exact checkpoint with source offline and never resets an existing directory", async () => {
  await fixture(async (options, directory) => {
    await writeFile(join(options.repo, "feature.ts"), "unfinished portable source\n");
    await writeFile(join(options.repo, "new-test.ts"), "allowed untracked test\n");
    options.policy.allowedUntracked.push("new-test.ts");
    const manifest = await captureCheckpoint(options); await publishCheckpoint(options, manifest);
    const destination = join(directory, "destination");
    await git(directory, ["clone", "--quiet", "--branch", "main", options.remote.url, destination]);
    await rename(options.repo, join(directory, "source-offline"));
    let admissions = 0;
    const resume = { capture: { ...options, repo: destination }, checkpoint: manifest, identity: { ...options.identity, epoch: 2, runId: "run2" }, projectId: "project1", worktreeRoot: join(await realpath(directory), "worktrees"), trustedCommonGitDir: await realpath(join(destination, ".git")), preflight: () => checkEnvironment([], "manual", { processEnv: {} }), assertReady: async () => {}, assertAdmission: async () => { admissions++; } };
    const restored = await createResumeWorktree(resume);
    assert(admissions >= 2); assert.equal(restored.head, manifest.commit); assert.equal(restored.tree, manifest.tree);
    assert.deepEqual(restored.executionBase, options.executionBase);
    assert.equal(await gitText(restored.path, ["branch", "--show-current"]), "coord/tasks/task1/e2/run2");
    assert.deepEqual(JSON.parse(await readFile(join(restored.path, ".coord-local/run.json"), "utf8")), { projectId: "project1", commonGitDir: resume.trustedCommonGitDir, runId: "run2", taskId: "task1", epoch: 2 });
    assert.equal(await readFile(join(restored.path, "new-test.ts"), "utf8"), "allowed untracked test\n");
    await writeFile(join(restored.path, "do-not-reset"), "live work\n");
    await assert.rejects(createResumeWorktree(resume), /already exists/);
    assert.equal(await readFile(join(restored.path, "do-not-reset"), "utf8"), "live work\n");
    let blockedAdmission = false;
    await assert.rejects(createResumeWorktree({ ...resume, identity: { ...resume.identity, runId: "blocked-run" }, preflight: () => checkEnvironment([{ name: "MISSING_KEY", modes: ["manual"] }], "manual", { processEnv: {} }), assertAdmission: async () => { blockedAdmission = true; } }), /MISSING_KEY/);
    assert.equal(blockedAdmission, false);
  });
});

test("linked worktree capture resolves its actual private index and common Git directory", async () => {
  await fixture(async (options, directory) => {
    const linked = join(directory, "linked");
    await git(options.repo, ["worktree", "add", "--quiet", "--detach", linked, options.executionBase.sha]);
    await writeFile(join(linked, "feature.ts"), "linked source\n");
    const indexPath = await gitText(linked, ["rev-parse", "--git-path", "index"]);
    const originalIndex = await readFile(indexPath);
    const manifest = await captureCheckpoint({ ...options, repo: linked });
    assert.equal(await gitText(linked, ["show", `${manifest.commit}:feature.ts`]), "linked source");
    assert.deepEqual(await readFile(indexPath), originalIndex);
  });
});

async function reviewOptions(options: CaptureOptions): Promise<{ review: PublishReviewOptions; records: ReviewRecord[]; creates: () => number }> {
  const artifact = await captureCheckpoint(options);
  const environmentDigest = captureDigest({ fixture: "effective-environment" });
  const command = ["git", "cat-file", "-e", `${artifact.commit}^{commit}`];
  const verified = await git(options.repo, command.slice(1));
  const records: ReviewRecord[] = []; let created = 0;
  const review: PublishReviewOptions = { capture: options, artifact, publicationId: "publication1", repositoryId: "fixture/team-repo", targetRef: "refs/heads/main", environmentDigest, requiredCommands: [command], verification: [{ head: artifact.commit, tree: artifact.tree, base: options.executionBase.sha, commands: [{ argv: command, exitCode: verified.code }], environmentDigest, recordedAt: new Date().toISOString() }], preflight: async () => {}, host: {
    find: async () => [...records],
    create: async input => { created++; const record: ReviewRecord = { id: `pr${created}`, url: `https://git.invalid/pr/${created}`, state: "open", repositoryId: input.repositoryId, publicationId: input.publicationId, headRef: input.headRef, headSha: input.headSha, baseRef: input.baseRef, baseSha: input.baseSha }; records.push(record); return record; },
    read: async id => { const record = records.find(item => item.id === id); if (!record) throw new Error("No fixture PR"); return record; },
  } };
  return { review, records, creates: () => created };
}

test("T7/T15 safe review snapshot excludes private ancestry and lost PR response reconciles without duplicate creation", async () => {
  await fixture(async options => {
    await writeFile(join(options.repo, "private.txt"), canary); await commit(options.repo, "Keep private ancestry local");
    await unlink(join(options.repo, "private.txt")); await commit(options.repo, "Delete local private fixture file");
    await writeFile(join(options.repo, "feature.ts"), "review ready source\n");
    const { review, records, creates } = await reviewOptions(options);
    const create = review.host.create;
    review.host.create = async input => { await create(input); throw new Error("injected lost host response"); };
    const published = await publishReview(review);
    assert.equal(published.status, "verified_external"); assert.equal(creates(), 1);
    assert.equal((await publishReview(review)).review.id, published.review.id); assert.equal(creates(), 1);
    await assertNoLocalSecret(options.remote.url, { ...review.artifact, ref: `refs/heads/${published.headRef}` }, options.executionBase.sha);
    records[0]!.state = "closed";
    await assert.rejects(publishReview(review), /closed/); assert.equal(creates(), 1);
  });
});

test("T15 preconstruction/source-HEAD verification and unresolved create uncertainty cannot authorize another PR", async () => {
  await fixture(async options => {
    await writeFile(join(options.repo, "feature.ts"), "review source\n");
    const { review, creates } = await reviewOptions(options);
    const verification = review.verification;
    review.verification = [{ ...verification[0]!, head: review.artifact.sourceHead }];
    await assert.rejects(publishReview(review), /exact final review/);
    assert.equal(creates(), 0);
    review.verification = verification;
    let attempts = 0;
    review.host.create = async () => { attempts++; throw new Error("uncertain network result"); };
    await assert.rejects(publishReview(review), /uncertain/);
    await assert.rejects(publishReview(review), /pending journal/);
    assert.equal(attempts, 1);
  });
});

export { fixture, commit, canary };
