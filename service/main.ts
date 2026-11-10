import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
const dataDir = process.env.OPENCHAMBER_SERVICE_DATA_DIR ?? path.join(os.homedir(), '.openchamber-agentic-tasks');

if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const DEFAULT_BASE = 'http://127.0.0.1:8600';
const CONFIG_FILE = path.join(dataDir, 'config.json');
const TASKS_TTL = 30_000;
const INDEX_TTL = 60_000;
const SCAN_CONCURRENCY = 16;
const REQUEST_TIMEOUT = 6000;

type TaskRow = { id: string; title: string; status: string; priority: number };

type LinkRow = {
  id: string;
  rowId: string;
  title: string;
  status: string;
  priority: number;
  url: string;
};

let baseUrl = readBaseUrl();
let tasksCache: { at: number; tasks: TaskRow[] } | null = null;
let indexCache: { at: number; map: Map<string, Array<{ task: TaskRow; rowId: string }>> } | null = null;

function readBaseUrl(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as { baseUrl?: unknown };
    if (typeof raw.baseUrl === 'string' && normalizeBase(raw.baseUrl)) return normalizeBase(raw.baseUrl)!;
  } catch {
    // No config yet, or it no longer parses: the default below is the answer.
  }
  return DEFAULT_BASE;
}

function normalizeBase(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(trimmed)) return null;
  return trimmed;
}

function writeBaseUrl(value: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify({ baseUrl: value }, null, 2)}\n`, 'utf8');
}

function clearCaches(): void {
  tasksCache = null;
  indexCache = null;
}

async function apiGet(pathname: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!res.ok) throw new Error(`${pathname} answered ${res.status}`);
  return res.json();
}

async function apiSend(method: string, pathname: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${pathname} answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

function toTaskRow(raw: any): TaskRow | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string') return null;
  return {
    id: raw.id,
    title: raw.title,
    status: typeof raw.status === 'string' ? raw.status : 'open',
    priority: typeof raw.priority === 'number' ? raw.priority : 0,
  };
}

function taskUrl(id: string): string {
  return `${baseUrl}/task/${encodeURIComponent(id)}`;
}

async function loadTasks(force = false): Promise<TaskRow[]> {
  if (!force && tasksCache && Date.now() - tasksCache.at < TASKS_TTL) return tasksCache.tasks;
  const raw = await apiGet('/api/tasks');
  if (!Array.isArray(raw)) throw new Error('/api/tasks did not answer a list');
  const tasks = raw.map(toTaskRow).filter((row): row is TaskRow => row !== null);
  tasksCache = { at: Date.now(), tasks };
  return tasks;
}

/**
 * Agentic records a hand-attached session per task, and its API only lists
 * sessions under a task, so the only way to ask "which tasks is this session
 * on" is to read every task's sessions once and keep the answer briefly.
 */
async function loadIndex(force = false): Promise<Map<string, Array<{ task: TaskRow; rowId: string }>>> {
  if (!force && indexCache && Date.now() - indexCache.at < INDEX_TTL) return indexCache.map;
  const tasks = await loadTasks(force);
  const map = new Map<string, Array<{ task: TaskRow; rowId: string }>>();
  const queue = [...tasks];
  const worker = async (): Promise<void> => {
    for (;;) {
      const task = queue.shift();
      if (!task) return;
      try {
        const rows = await apiGet(`/api/tasks/${encodeURIComponent(task.id)}/sessions`);
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
          if (!row || typeof row.session_id !== 'string' || typeof row.id !== 'string') continue;
          const list = map.get(row.session_id) ?? [];
          list.push({ task, rowId: row.id });
          map.set(row.session_id, list);
        }
      } catch {
        // One unreadable task must not empty the whole section.
      }
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  indexCache = { at: Date.now(), map };
  return map;
}

function linksFor(sessionId: string, map: Map<string, Array<{ task: TaskRow; rowId: string }>>): LinkRow[] {
  const rows = map.get(sessionId) ?? [];
  return rows
    .map(({ task, rowId }) => ({
      id: task.id,
      rowId,
      title: task.title,
      status: task.status,
      priority: task.priority,
      url: taskUrl(task.id),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

const IN_FLIGHT = new Set(['open', 'in_progress', 'blocked']);

function searchTasks(tasks: TaskRow[], query: string, skip: Set<string>): TaskRow[] {
  const needle = query.trim().toLowerCase();
  const matches = tasks.filter((task) => {
    if (skip.has(task.id)) return false;
    if (!needle) return IN_FLIGHT.has(task.status);
    return task.title.toLowerCase().includes(needle) || task.id.toLowerCase().startsWith(needle);
  });
  const rank = (task: TaskRow): number => (IN_FLIGHT.has(task.status) ? 0 : 1);
  return matches.sort((a, b) => rank(a) - rank(b)).slice(0, 12);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

const parseBody = (body: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(body || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const unreachable = (error: unknown): string => {
  const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
  return `Nothing answered at ${baseUrl}${detail}`;
};

async function stateFor(sessionId: string, force = false): Promise<unknown> {
  try {
    const map = await loadIndex(force);
    return { ok: true, baseUrl, links: linksFor(sessionId, map) };
  } catch (error) {
    return { ok: false, baseUrl, error: unreachable(error) };
  }
}

async function route(pathname: string, url: URL, req: http.IncomingMessage): Promise<[number, unknown]> {
  if (pathname === '/state' && req.method === 'GET') {
    const sessionId = (url.searchParams.get('session') ?? '').trim();
    if (!sessionId) return [400, { ok: false, error: 'A session id is required' }];
    return [200, await stateFor(sessionId, url.searchParams.get('refresh') === '1')];
  }

  if (pathname === '/tasks' && req.method === 'GET') {
    const query = url.searchParams.get('q') ?? '';
    const skip = new Set((url.searchParams.get('skip') ?? '').split(',').filter(Boolean));
    try {
      const tasks = await loadTasks();
      return [200, { ok: true, tasks: searchTasks(tasks, query, skip) }];
    } catch (error) {
      return [200, { ok: false, baseUrl, error: unreachable(error), tasks: [] }];
    }
  }

  if (pathname === '/link' && req.method === 'POST') {
    const body = parseBody(await readBody(req));
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
    if (!sessionId || !taskId) return [400, { ok: false, error: 'A session and a task are required' }];
    try {
      const map = await loadIndex();
      const linked = linksFor(sessionId, map).some((link) => link.id === taskId);
      if (!linked) {
        await apiSend('POST', `/api/tasks/${encodeURIComponent(taskId)}/sessions`, {
          session_id: sessionId,
          label: typeof body.label === 'string' ? body.label.slice(0, 200) : '',
          cwd: typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined,
        });
      }
      return [200, await stateFor(sessionId, true)];
    } catch (error) {
      return [200, { ok: false, baseUrl, error: unreachable(error), links: [] }];
    }
  }

  if (pathname === '/unlink' && req.method === 'POST') {
    const body = parseBody(await readBody(req));
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
    if (!sessionId || !taskId) return [400, { ok: false, error: 'A session and a task are required' }];
    try {
      const map = await loadIndex();
      const link = linksFor(sessionId, map).find((row) => row.id === taskId);
      if (!link) return [200, { ok: true, baseUrl, links: linksFor(sessionId, map) }];
      await apiSend('DELETE', `/api/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(link.rowId)}`, undefined);
      return [200, await stateFor(sessionId, true)];
    } catch (error) {
      return [200, { ok: false, baseUrl, error: unreachable(error), links: [] }];
    }
  }

  if (pathname === '/config' && req.method === 'POST') {
    const body = parseBody(await readBody(req));
    const next = typeof body.baseUrl === 'string' ? normalizeBase(body.baseUrl) : null;
    if (!next) return [400, { ok: false, error: 'Use an http:// or https:// address, for example http://127.0.0.1:8600' }];
    const previous = baseUrl;
    baseUrl = next;
    clearCaches();
    try {
      await loadTasks(true);
    } catch (error) {
      baseUrl = previous;
      clearCaches();
      const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
      return [
        200,
        { ok: false, baseUrl: previous, error: `Nothing answered at ${next}${detail}, so the address stays ${previous}.` },
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

  return [404, { ok: false, error: 'not-found' }];
}

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    json(res, 200, {});
    return;
  }
  route(url.pathname, url, req)
    .then(([status, body]) => json(res, status, body))
    .catch(() => json(res, 500, { ok: false, error: 'The request could not be read' }));
});

server.listen(port, '127.0.0.1');
