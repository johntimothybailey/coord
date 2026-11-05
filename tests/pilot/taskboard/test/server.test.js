import assert from "node:assert/strict";
import test from "node:test";
import { createTaskboardServer } from "../server.js";

async function fixture(t) {
  const server = createTaskboardServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const json = body => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("local HTTP API adds, lists and completes a task", async t => {
  const base = await fixture(t);
  assert.deepEqual(await (await fetch(`${base}/api/tasks`)).json(), { tasks: [] });
  const created = await fetch(`${base}/api/tasks`, { method: "POST", ...json({ title: "Pilot task" }) });
  assert.equal(created.status, 201);
  const { task } = await created.json();
  const completed = await fetch(`${base}/api/tasks/${task.id}`, { method: "PATCH", ...json({ completed: true }) });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).task.completed, true);
  assert.deepEqual((await (await fetch(`${base}/api/tasks`)).json()).tasks, [{ ...task, completed: true }]);
});

test("HTTP validation rejects malformed input and preserves state", async t => {
  const base = await fixture(t);
  const invalid = [
    { method: "POST", ...json({ title: "  " }) },
    { method: "POST", ...json({ title: 2 }) },
    { method: "POST", ...json({ title: "Valid", extra: "unexpected" }) },
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" },
    { method: "POST", headers: { "Content-Type": "text/plain" }, body: "title" },
    { method: "POST", ...json({ title: "x".repeat(9000) }) },
  ];
  for (const options of invalid) assert.equal((await fetch(`${base}/api/tasks`, options)).status, 400);
  assert.equal((await fetch(`${base}/api/tasks`, { method: "DELETE" })).status, 405);
  assert.equal((await fetch(`${base}/api/tasks/00000000-0000-0000-0000-000000000000`, { method: "PATCH", ...json({ completed: true }) })).status, 404);
  assert.deepEqual((await (await fetch(`${base}/api/tasks`)).json()).tasks, []);
});

test("fixed local asset routes and same-origin checks avoid arbitrary file exposure", async t => {
  const base = await fixture(t);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  assert.equal((await fetch(`${base}/server.js`)).status, 404);
  const foreign = await fetch(`${base}/api/tasks`, { method: "POST", headers: { ...json({}).headers, Origin: "https://unrelated.example" }, body: JSON.stringify({ title: "Denied" }) });
  assert.equal(foreign.status, 403);
  assert.deepEqual((await (await fetch(`${base}/api/tasks`)).json()).tasks, []);
});
