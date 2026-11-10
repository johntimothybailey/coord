import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { createConfirmationProbeServer } from "../src/confirmation-probe.js";
import type { ConfirmationProbeObservation } from "../src/confirmation-probe.js";
import { createCoordMcpServer } from "../src/mcp.js";
import { canonicalJson } from "../src/canonical.js";

const nonce = (request: ElicitRequest) => request.params.message.match(/Public probe nonce: ([a-f0-9-]{36})/)![1]!;
const payload = (result: unknown): ConfirmationProbeObservation => {
  const response = result as { isError?: boolean; content: { text: string }[] };
  assert.ok(!response.isError, JSON.stringify(response));
  const value = JSON.parse(response.content[0]!.text) as ConfirmationProbeObservation;
  assert.equal(value.humanVerified, false); assert.equal(value.authorityGranted, false); assert.equal(value.sideEffects, "none");
  assert.equal(value.synthetic.projectId, "coord-confirmation-probe"); assert.equal(value.synthetic.action, "no_effect_check");
  return value;
};
async function session(handler?: (request: ElicitRequest) => Promise<ElicitResult>, timeoutMs = 1000) {
  const observations: ConfirmationProbeObservation[] = [];
  const server = createConfirmationProbeServer({ timeoutMs, observe: value => { observations.push(value); } });
  const client = new Client({ name: "synthetic-probe-client", version: "fixture" }, { capabilities: handler ? { elicitation: { form: {}, url: {} }, experimental: { withheld: { token: "metadata-secret-canary" } } } : {} });
  if (handler) client.setRequestHandler(ElicitRequestSchema, handler);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { client, observations, close: async () => { await client.close(); await server.close(); } };
}
const call = (client: Client) => client.callTool({ name: "coord_confirmation_probe", arguments: {} });

test("isolated stdio mode starts without project/run credentials and refuses model-supplied probe arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coord-confirmation-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/src/cli.js"), "mcp", "--confirmation-probe"], cwd: directory, env: { PATH: process.env.PATH ?? "", COORD_RUNTIME_PATH: "/nonexistent/never-read-runtime.json", COORD_SESSION_ID: "never-load-session" }, stderr: "pipe" });
  const client = new Client({ name: "isolated-probe", version: "fixture" });
  let stderr = "";
  try {
    await client.connect(transport); transport.stderr?.on("data", chunk => { stderr += String(chunk); });
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["coord_confirmation_probe"]);
    const value = payload(await call(client));
    assert.equal(value.outcome, "capability_not_declared"); assert.equal(value.capabilities.form, false); assert.equal(value.responseAction, null);
    assert.equal((await client.callTool({ name: "coord_confirmation_probe", arguments: { approved: true, projectId: "real", token: "never-used" } })).isError, true);
    assert(!stderr.includes("never-read-runtime") && !stderr.includes("never-used"));
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test("official SDK accept, decline and cancel remain unverified host responses with fresh synthetic challenges", async () => {
  let action: "accept" | "decline" | "cancel" = "accept";
  const connection = await session(async request => ({ action, ...(action === "accept" ? { content: { nonce: nonce(request) } } : {}) }));
  try {
    const nonces = new Set<string>();
    for (const choice of ["accept", "decline", "cancel"] as const) {
      action = choice;
      const value = payload(await call(connection.client));
      assert.equal(value.outcome, choice === "accept" ? "accepted_response" : choice === "decline" ? "declined_response" : "cancelled_response");
      assert.equal(value.responseAction, choice); assert.equal(value.contentMatched, choice === "accept");
      assert.equal(value.capabilities.form, true); assert.equal(value.capabilities.url, true);
      assert(!nonces.has(value.synthetic.nonce)); nonces.add(value.synthetic.nonce);
      const { hash, ...source } = value.synthetic;
      assert.equal(createHash("sha256").update(canonicalJson(source)).digest("hex"), hash);
      for (const text of [hash, source.projectId, source.action, String(source.revision), source.nonce]) assert(value.message.includes(text));
      assert(!JSON.stringify(value).includes("metadata-secret-canary"));
    }
    assert.deepEqual(connection.observations.map(value => value.phase), ["prepared", "completed", "prepared", "completed", "prepared", "completed"]);
  } finally { await connection.close(); }
});

test("wrong or malformed accepted content never matches and arbitrary returned fields are withheld", async () => {
  const contents: NonNullable<ElicitResult["content"]>[] = [{ nonce: "0".repeat(36) }, {}, { nonce: "0".repeat(36), secret: "form-secret-canary" }];
  for (const content of contents) {
    const connection = await session(async () => ({ action: "accept", content }));
    try {
      const value = payload(await call(connection.client));
      assert(value.outcome === "invalid_response" || value.outcome === "request_failed"); assert.equal(value.contentMatched, false);
      assert(!JSON.stringify(value).includes("form-secret-canary"));
    } finally { await connection.close(); }
  }
});

test("request errors and timeouts return fixed observations without raw errors or authority", async () => {
  for (const handler of [async (): Promise<ElicitResult> => { throw new Error("provider-secret-canary"); }, async (): Promise<ElicitResult> => new Promise(() => {})]) {
    const connection = await session(handler, 20);
    try {
      const value = payload(await call(connection.client));
      assert(value.outcome === "request_failed" || value.outcome === "timed_out"); assert.equal(value.responseAction, null);
      assert(!JSON.stringify(value).includes("provider-secret-canary"));
    } finally { await connection.close(); }
  }
});

test("the ordinary plugin probe never calls its backend or a bound run's check-in path", async () => {
  let calls = 0;
  const backend = { query: async () => { calls++; throw new Error("No backend query permitted"); }, mutation: async () => { calls++; throw new Error("No backend mutation permitted"); } };
  const server = createCoordMcpServer({ client: backend, run: { client: backend, identity: { taskId: "task", runId: "run", epoch: 1, goalRevision: 1 } }, renewMs: 60_000 });
  const client = new Client({ name: "plugin-probe", version: "fixture" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "cancel" }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    assert.equal(payload(await call(client)).outcome, "cancelled_response"); assert.equal(calls, 0);
  } finally { await client.close(); await server.close(); }
});
