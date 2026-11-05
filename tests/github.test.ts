import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubReviewAdapter } from "../src/github.js";
const lookup = { repositoryId: "github.com/team/pilot", publicationId: "p1", headRef: "coord/reviews/t1/e1/p1", baseRef: "main" };
const pr = { number: 1, html_url: "https://github.com/team/pilot/pull/1", body: "Coord publication: p1\n", state: "open", merged_at: null, head: { repo: { full_name: "team/pilot" }, ref: lookup.headRef, sha: "a".repeat(40) }, base: { repo: { full_name: "team/pilot" }, ref: "main", sha: "b".repeat(40) } };
test("T15 GitHub adapter searches all states/pages and sends structured create input", async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const adapter = new GitHubReviewAdapter(lookup.repositoryId, {}, async (args, input) => { calls.push({ args, input }); return args.includes("--slurp") ? [[pr], [{ ...pr, number: 2, html_url: "https://github.com/team/pilot/pull/2", state: "closed" }]] : pr; });
  assert.equal((await adapter.find(lookup)).length, 2); assert.match(calls[0]!.args[0]!, /state=all/);
  await adapter.create({ ...lookup, headSha: pr.head.sha, baseSha: pr.base.sha, title: "A literal $(not-shell) title", body: pr.body });
  assert.equal((JSON.parse(calls[1]!.input!) as { title: string }).title, "A literal $(not-shell) title");
  assert.equal((await adapter.read("1")).headSha, pr.head.sha);
});
test("T15 adapter rejects wrong repository, missing identity, malformed pagination and unsafe routes", async () => {
  const wrong = new GitHubReviewAdapter(lookup.repositoryId, {}, async () => ({ ...pr, base: { ...pr.base, repo: { full_name: "other/pilot" } } }));
  await assert.rejects(wrong.read("1"), { code: "PUBLICATION_STALE" });
  await assert.rejects(wrong.find({ ...lookup, repositoryId: "github.com/other/pilot" }), { code: "FORBIDDEN" });
  await assert.rejects(wrong.read("../merge"), { code: "INVALID_INPUT" });
  await assert.rejects(wrong.find(lookup), { code: "COVERAGE_INCOMPLETE" });
  const missing = new GitHubReviewAdapter(lookup.repositoryId, {}, async () => ({ ...pr, body: "no stable identity" }));
  await assert.rejects(missing.read("1"), { code: "PUBLICATION_STALE" });
});
