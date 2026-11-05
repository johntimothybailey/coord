import assert from "node:assert/strict";
import test from "node:test";
import { createTaskStore, InputError } from "../store.js";

test("add/list/complete keeps stable identities and returns copies", () => {
  const store = createTaskStore();
  assert.deepEqual(store.list(), []);
  const first = store.add({ title: "  Add accessible labels  " });
  const second = store.add({ title: "Write state tests" });
  assert.equal(first.title, "Add accessible labels");
  assert.equal(first.completed, false);
  assert.notEqual(first.id, second.id);
  first.title = "Caller mutation";
  const listed = store.list();
  listed[0].completed = true;
  assert.equal(store.list()[0].title, "Add accessible labels");
  assert.equal(store.list()[0].completed, false);
  assert.equal(store.complete(first.id, { completed: true }).completed, true);
  assert.equal(store.list()[0].completed, true);
  assert.equal(store.complete(first.id, { completed: false }).completed, false);
  assert.equal(store.complete("missing", { completed: true }), undefined);
});

test("invalid task input cannot change stored state", () => {
  const store = createTaskStore();
  for (const input of [null, [], {}, { title: "" }, { title: "  " }, { title: 42 }, { title: "x".repeat(161) }, { title: "hello\nworld" }, { title: "\ud800" }, { title: "Valid", completed: true }]) {
    assert.throws(() => store.add(input), InputError);
  }
  assert.deepEqual(store.list(), []);
  const task = store.add({ title: "🧭".repeat(160) });
  for (const input of [{}, { completed: "true" }, { completed: 1 }, { completed: true, title: "Changed" }]) assert.throws(() => store.complete(task.id, input), InputError);
  assert.equal(store.list()[0].completed, false);
});

test("titles remain inert source text, including HTML-looking input", () => {
  const store = createTaskStore();
  const title = "<img src=x onerror=alert('fixture')>";
  assert.equal(store.add({ title }).title, title);
  assert.equal(store.list()[0].title, title);
});
