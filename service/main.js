// service/main.ts
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
var dataDir = process.env.OPENCHAMBER_SERVICE_DATA_DIR ?? path.join(os.homedir(), ".openchamber-agentic-tasks");
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var DEFAULT_BASE = "http://127.0.0.1:8600";
var CONFIG_FILE = path.join(dataDir, "config.json");
var TASKS_TTL = 30000;
var REQUEST_TIMEOUT = 6000;
var baseUrl = readBaseUrl();
var tasksCache = null;
function readBaseUrl() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (typeof raw.baseUrl === "string" && normalizeBase(raw.baseUrl))
      return normalizeBase(raw.baseUrl);
  } catch {}
  return DEFAULT_BASE;
}
function normalizeBase(value) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(trimmed))
    return null;
  return trimmed;
}
function writeBaseUrl(value) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify({ baseUrl: value }, null, 2)}
`, "utf8");
}
function clearCaches() {
  tasksCache = null;
}
async function apiGet(pathname) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT)
  });
  if (!res.ok)
    throw new Error(`${pathname} answered ${res.status}`);
  return res.json();
}
async function apiSend(method, pathname, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${pathname} answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  if (res.status === 204)
    return null;
  return res.json().catch(() => null);
}
function toTaskRow(raw) {
  if (!raw || typeof raw.id !== "string" || typeof raw.title !== "string")
    return null;
  return {
    id: raw.id,
    title: raw.title,
    status: typeof raw.status === "string" ? raw.status : "open",
    priority: typeof raw.priority === "number" ? raw.priority : 0
  };
}
function taskUrl(id) {
  return `${baseUrl}/task/${encodeURIComponent(id)}`;
}
async function loadTasks(force = false) {
  if (!force && tasksCache && Date.now() - tasksCache.at < TASKS_TTL)
    return tasksCache.tasks;
  const raw = await apiGet("/api/tasks");
  if (!Array.isArray(raw))
    throw new Error("/api/tasks did not answer a list");
  const tasks = raw.map(toTaskRow).filter((row) => row !== null);
  tasksCache = { at: Date.now(), tasks };
  return tasks;
}
async function linksFor(sessionId) {
  const raw = await apiGet(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!Array.isArray(raw))
    throw new Error("/api/sessions did not answer a list");
  const links = [];
  for (const entry of raw) {
    const task = entry?.task;
    const row = entry?.session;
    if (!task || typeof task.id !== "string" || typeof task.title !== "string")
      continue;
    if (!row || typeof row.id !== "string")
      continue;
    links.push({
      id: task.id,
      rowId: row.id,
      title: task.title,
      status: typeof task.status === "string" ? task.status : "open",
      priority: typeof task.priority === "number" ? task.priority : 0,
      url: taskUrl(task.id)
    });
  }
  return links.sort((a, b) => a.title.localeCompare(b.title));
}
var IN_FLIGHT = new Set(["open", "in_progress", "blocked"]);
function searchTasks(tasks, query, skip) {
  const needle = query.trim().toLowerCase();
  const matches = tasks.filter((task) => {
    if (skip.has(task.id))
      return false;
    if (!needle)
      return IN_FLIGHT.has(task.status);
    return task.title.toLowerCase().includes(needle) || task.id.toLowerCase().startsWith(needle);
  });
  const rank = (task) => IN_FLIGHT.has(task.status) ? 0 : 1;
  return matches.sort((a, b) => rank(a) - rank(b)).slice(0, 12);
}
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
var readBody = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => resolve(body));
  req.on("error", reject);
});
var parseBody = (body) => {
  try {
    const parsed = JSON.parse(body || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};
var unreachable = (error) => {
  const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
  return `Nothing answered at ${baseUrl}${detail}`;
};
async function stateFor(sessionId) {
  try {
    return { ok: true, baseUrl, links: await linksFor(sessionId) };
  } catch (error) {
    return { ok: false, baseUrl, error: unreachable(error) };
  }
}
async function route(pathname, url, req) {
  if (pathname === "/state" && req.method === "GET") {
    const sessionId = (url.searchParams.get("session") ?? "").trim();
    if (!sessionId)
      return [400, { ok: false, error: "A session id is required" }];
    return [200, await stateFor(sessionId)];
  }
  if (pathname === "/tasks" && req.method === "GET") {
    const query = url.searchParams.get("q") ?? "";
    const skip = new Set((url.searchParams.get("skip") ?? "").split(",").filter(Boolean));
    try {
      const tasks = await loadTasks();
      return [200, { ok: true, tasks: searchTasks(tasks, query, skip) }];
    } catch (error) {
      return [200, { ok: false, baseUrl, error: unreachable(error), tasks: [] }];
    }
  }
  if (pathname === "/link" && req.method === "POST") {
    const body = parseBody(await readBody(req));
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
    if (!sessionId || !taskId)
      return [400, { ok: false, error: "A session and a task are required" }];
    try {
      const already = (await linksFor(sessionId)).some((link) => link.id === taskId);
      if (!already) {
        await apiSend("POST", `/api/tasks/${encodeURIComponent(taskId)}/sessions`, {
          session_id: sessionId,
          label: typeof body.label === "string" ? body.label.slice(0, 200) : "",
          cwd: typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : undefined
        });
      }
      return [200, await stateFor(sessionId)];
    } catch (error) {
      return [200, { ok: false, baseUrl, error: unreachable(error), links: [] }];
    }
  }
  if (pathname === "/unlink" && req.method === "POST") {
    const body = parseBody(await readBody(req));
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
    if (!sessionId || !taskId)
      return [400, { ok: false, error: "A session and a task are required" }];
    try {
      const link = (await linksFor(sessionId)).find((row) => row.id === taskId);
      if (!link)
        return [200, await stateFor(sessionId)];
      await apiSend("DELETE", `/api/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(link.rowId)}`, undefined);
      return [200, await stateFor(sessionId)];
    } catch (error) {
      return [200, { ok: false, baseUrl, error: unreachable(error), links: [] }];
    }
  }
  if (pathname === "/config" && req.method === "POST") {
    const body = parseBody(await readBody(req));
    const next = typeof body.baseUrl === "string" ? normalizeBase(body.baseUrl) : null;
    if (!next)
      return [400, { ok: false, error: "Use an http:// or https:// address, for example http://127.0.0.1:8600" }];
    const previous = baseUrl;
    baseUrl = next;
    clearCaches();
    try {
      await loadTasks(true);
    } catch (error) {
      baseUrl = previous;
      clearCaches();
      const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
      return [
        200,
        { ok: false, baseUrl: previous, error: `Nothing answered at ${next}${detail}, so the address stays ${previous}.` }
      ];
    }
    try {
      writeBaseUrl(next);
    } catch (error) {
      baseUrl = previous;
      clearCaches();
      return [500, { ok: false, baseUrl: previous, error: `Could not save the address: ${String(error)}` }];
    }
    return [200, { ok: true, baseUrl: next }];
  }
  return [404, { ok: false, error: "not-found" }];
}
var server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    json(res, 200, {});
    return;
  }
  route(url.pathname, url, req).then(([status, body]) => json(res, status, body)).catch(() => json(res, 500, { ok: false, error: "The request could not be read" }));
});
server.listen(port, "127.0.0.1");
