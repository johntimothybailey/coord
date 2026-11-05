import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTaskStore, InputError } from "./store.js";

const assets = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["public/style.css", "text/css; charset=utf-8"],
};

async function jsonBody(request) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new InputError("Send JSON request data.");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 8192) { request.resume(); throw new InputError("Request data is too large."); }
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new InputError("Send valid UTF-8 JSON request data."); }
}

export function createTaskboardServer(store = createTaskStore()) {
  return createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
    response.setHeader("Cache-Control", "no-store");
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };
    try {
      const address = request.socket.localPort;
      const expectedHost = `127.0.0.1:${address}`;
      if (request.headers.host !== expectedHost) { send(403, { error: "Use the local 127.0.0.1 server address." }); return; }
      if (request.headers.origin && request.headers.origin !== `http://${expectedHost}`) { send(403, { error: "Cross-origin access is unavailable." }); return; }
      const url = new URL(request.url, `http://${expectedHost}`);
      if (request.method === "GET" && Object.hasOwn(assets, url.pathname)) {
        const [filename, contentType] = assets[url.pathname];
        const content = await readFile(new URL(filename, import.meta.url));
        response.writeHead(200, { "Content-Type": contentType });
        response.end(content);
        return;
      }
      if (url.pathname === "/api/tasks") {
        if (request.method === "GET") { send(200, { tasks: store.list() }); return; }
        if (request.method === "POST") { send(201, { task: store.add(await jsonBody(request)) }); return; }
        response.setHeader("Allow", "GET, POST"); send(405, { error: "Method unavailable." }); return;
      }
      const taskRoute = /^\/api\/tasks\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (taskRoute) {
        if (request.method !== "PATCH") { response.setHeader("Allow", "PATCH"); send(405, { error: "Method unavailable." }); return; }
        const task = store.complete(taskRoute[1], await jsonBody(request));
        send(task ? 200 : 404, task ? { task } : { error: "Task not found." }); return;
      }
      send(404, { error: "Page not found." });
    } catch (error) {
      if (error instanceof InputError) send(400, { error: error.message });
      else send(500, { error: "The local taskboard could not complete the request." });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? "4317");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InputError("PORT must be an integer between 1 and 65535.");
  const server = createTaskboardServer();
  server.listen(port, "127.0.0.1", () => console.log(`Local taskboard: http://127.0.0.1:${port}`));
}
