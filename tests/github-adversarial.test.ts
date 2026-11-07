import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubReviewAdapter } from "../src/github.js";

const lookup = { repositoryId: "github.com/team/pilot", publicationId: "p1", headRef: "coord/reviews/t1/e1/p1", baseRef: "main" };
const pr = { number: 1, html_url: "https://github.com/team/pilot/pull/1", body: "Coord publication: p1\n", state: "open", merged_at: null, head: { repo: { full_name: "team/pilot" }, ref: lookup.headRef, sha: "a".repeat(40) }, base: { repo: { full_name: "team/pilot" }, ref: "main", sha: "b".repeat(40) } };
async function fakeGh(source: string, run: (environment: NodeJS.ProcessEnv, directory: string) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "coord-gh-adversarial-")));
  try {
    const binary = join(directory, "gh");
    await writeFile(binary, `#!${process.execPath}\n${source}\n`); await chmod(binary, 0o700);
    await run({ PATH: directory, FIXTURE_ALLOWED: "yes", FIXTURE_DIRECTORY: directory }, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("T15 actual adapter subprocess uses only supplied environment, fixed host and structured create stdin", async () => {
  await fakeGh(`
const fs = require('node:fs');
if (process.env.HOME || process.env.GH_TOKEN || process.env.FIXTURE_ALLOWED !== 'yes') process.exit(7);
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => { input += value; });
process.stdin.on('end', () => { fs.writeFileSync(process.env.FIXTURE_DIRECTORY + '/invocation.json', JSON.stringify({ argv: process.argv.slice(2), input })); process.stdout.write(${JSON.stringify(JSON.stringify(pr))}); });
`, async (environment, directory) => {
    const adapter = new GitHubReviewAdapter(lookup.repositoryId, environment, undefined, join(directory, "gh"));
    const title = "literal $(not-shell) `not-shell` title";
    const result = await adapter.create({ ...lookup, headSha: pr.head.sha, baseSha: pr.base.sha, title, body: pr.body });
    assert.equal(result.id, "1");
    const invocation = JSON.parse(await readFile(join(directory, "invocation.json"), "utf8")) as { argv: string[]; input: string };
    assert.deepEqual(invocation.argv, ["api", "--hostname", "github.com", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", "repos/team/pilot/pulls", "--method", "POST", "--input", "-"]);
    assert.deepEqual(JSON.parse(invocation.input), { head: lookup.headRef, base: "main", title, body: pr.body, maintainer_can_modify: false });
  });
});

test("T15 excessive, invalid and failed gh output stays bounded and never exposes captured canaries", async () => {
  const canary = "FAKE_GH_OUTPUT_SECRET_NEVER_EMIT_52992";
  for (const source of [
    `process.stderr.write('${canary}'); process.stdout.write('x'.repeat(2 * 1024 * 1024 + 4096));`,
    `process.stdout.write('${canary} invalid JSON');`,
    `process.stderr.write('${canary}'); process.exit(1);`,
  ]) await fakeGh(source, async (environment, directory) => {
    const adapter = new GitHubReviewAdapter(lookup.repositoryId, environment, undefined, join(directory, "gh"));
    await assert.rejects(adapter.read("1"), (error: unknown) => {
      assert(error instanceof Error); assert(!String(error).includes(canary)); assert.equal((error as { code?: string }).code, "PUBLICATION_STALE"); return true;
    });
  });
});
test("provider authority never selects gh from a worker-controlled PATH", async () => {
  await fakeGh(`process.stdout.write(${JSON.stringify(JSON.stringify(pr))});`, async (environment, directory) => {
    const worker = join(directory, "worker-bin"), marker = join(directory, "shadow-executed");
    await mkdir(worker);
    await writeFile(join(worker, "gh"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe');\n`); await chmod(join(worker, "gh"), 0o700);
    const env = { ...environment, PATH: worker, HOME: join(directory, "provider-home") };
    assert.throws(() => new GitHubReviewAdapter(lookup.repositoryId, env), { code: "UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION" });
    const adapter = new GitHubReviewAdapter(lookup.repositoryId, env, undefined, join(directory, "gh"));
    assert.equal((await adapter.read("1")).id, "1");
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    await chmod(join(directory, "gh"), 0o777);
    await assert.rejects(adapter.read("1"), { code: "UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION" });
  });
});
