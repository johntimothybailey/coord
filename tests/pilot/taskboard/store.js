import { randomUUID } from "node:crypto";

export class InputError extends Error {}

function fields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new InputError("Unexpected request fields.");
}

export function createTaskStore() {
  const tasks = new Map();
  return {
    list() { return [...tasks.values()].map(task => ({ ...task })); },
    add(input) {
      fields(input, ["title"]);
      if (typeof input.title !== "string") throw new InputError("Enter a task title.");
      const title = input.title.trim();
      if (!title || !title.isWellFormed() || [...title].length > 160 || /[\x00-\x1f\x7f]/u.test(title)) throw new InputError("Use a title of 1–160 characters without control characters.");
      const task = { id: randomUUID(), title, completed: false };
      tasks.set(task.id, task);
      return { ...task };
    },
    complete(id, input) {
      fields(input, ["completed"]);
      if (typeof input.completed !== "boolean") throw new InputError("Completion must be true or false.");
      const task = tasks.get(id);
      if (!task) return undefined;
      task.completed = input.completed;
      return { ...task };
    },
  };
}
