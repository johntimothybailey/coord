const form = document.querySelector("#add-task");
const title = document.querySelector("#title");
const list = document.querySelector("#tasks");
const status = document.querySelector("#status");
const count = document.querySelector("#count");
const empty = document.querySelector("#empty");
const tasks = new Map();

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "The request failed.");
  return data;
}

function updateCount() {
  const completed = [...tasks.values()].filter(task => task.completed).length;
  count.textContent = `${tasks.size} task${tasks.size === 1 ? "" : "s"}, ${completed} completed.`;
  empty.hidden = tasks.size > 0;
}

function addTask(task) {
  tasks.set(task.id, task);
  const item = document.createElement("li");
  const label = document.createElement("label");
  const checkbox = document.createElement("input");
  const text = document.createElement("span");
  checkbox.type = "checkbox";
  checkbox.id = `task-${task.id}`;
  checkbox.checked = task.completed;
  label.htmlFor = checkbox.id;
  text.textContent = task.title;
  text.classList.toggle("completed", task.completed);
  label.append(checkbox, text);
  item.append(label);
  list.append(item);
  checkbox.addEventListener("change", async () => {
    const completed = checkbox.checked;
    checkbox.disabled = true;
    try {
      const result = await request(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ completed }) });
      task.completed = result.task.completed;
      checkbox.checked = task.completed;
      text.classList.toggle("completed", task.completed);
      updateCount();
      status.textContent = `Marked “${task.title}” ${task.completed ? "complete" : "incomplete"}.`;
    } catch (error) { checkbox.checked = task.completed; status.textContent = error.message; }
    finally { checkbox.disabled = false; checkbox.focus(); }
  });
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const { task } = await request("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: title.value }) });
    addTask(task); updateCount(); title.value = "";
    status.textContent = `Added “${task.title}”.`;
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; title.focus(); }
});

try {
  const data = await request("/api/tasks");
  for (const task of data.tasks) addTask(task);
  updateCount(); status.textContent = "Taskboard ready.";
} catch (error) { status.textContent = error.message; }
