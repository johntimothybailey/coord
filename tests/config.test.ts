import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalRemote, credentialKey, parseConfig } from "../src/config.js";
const config = { schemaVersion: 1, backendId: "team", backendUrl: "https://fixture.convex.cloud", projectId: "project", repository: "github.com/team/repo", remote: "git@github.com:team/repo.git", defaultBranch: "main", ruleTargets: ["AGENTS.md"] };
test("T2 canonical HTTPS and SSH identity agree without exposing credentials", () => {
  assert.equal(canonicalRemote(config.remote), canonicalRemote("https://github.com/team/repo.git"));
  assert.throws(() => canonicalRemote("https://user:secret@github.com/team/repo"));
  assert.throws(() => parseConfig({ ...config, backendUrl: "https://fixture.convex.cloud/path" }));
  assert.throws(() => parseConfig({ ...config, repository: "github.com/attacker/repo" }));
  assert.throws(() => parseConfig({ ...config, ruleTargets: ["../AGENTS.md"] }));
});
test("T1 backend token stores are keyed by both identity and destination", () => {
  assert.notEqual(credentialKey("same", "https://a.convex.cloud"), credentialKey("same", "https://b.convex.cloud"));
  assert.equal(parseConfig(config).backendUrl, config.backendUrl);
});
