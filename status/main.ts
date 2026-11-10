import { connectHost } from '@openchamber/sdk';
import {
  applyHostReady,
  mountButton,
  mountEmpty,
  mountList,
  mountSearchField,
  mountSpinner,
  mountTextField,
  type ListItem,
} from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root')!;
// The host gives the frame the full section width; the browser's own body
// margin is the only thing left insetting it.
document.body.style.margin = '0';

type Link = { id: string; rowId: string; title: string; status: string; priority: number; url: string };
type TaskRow = { id: string; title: string; status: string; priority: number };
type Mode = 'list' | 'picker' | 'settings';

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  archived: 'Archived',
};

let sessionId: string | null = null;
let sessionTitle = '';
let directory: string | null = null;

let mode: Mode = 'list';
let loading = false;
let loaded = false;
let busy = false;
let links: Link[] = [];
let baseUrl = '';
let error: string | null = null;
let serviceError: string | null = null;

let query = '';
let results: TaskRow[] = [];
let searching = false;
let settingsValue = '';
let settingsError: string | null = null;

let isPopover = false;
let surfaceReady = false;
let canPopover = false;
let popoverId: string | null = null;
let popoverSkip: string[] = [];
let popoverError: string | null = null;

let stateSeq = 0;
let searchSeq = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let handles: Array<{ dispose: () => void }> = [];
let resultsBox: HTMLElement | null = null;
let listHandle: { update: (next: { items: ListItem[]; emptyText?: string }) => void; dispose: () => void } | null = null;
let spinnerHandle: { dispose: () => void } | null = null;

const SIDEBAR_STYLE = [
  'padding:0',
  'box-sizing:border-box',
  'font-family:var(--oc-font, system-ui, sans-serif)',
  'font-size:12px',
  'line-height:18px',
  'color:var(--oc-muted)',
].join(';');

const POPOVER_STYLE = [
  'position:fixed',
  'inset:0',
  'padding:10px',
  'box-sizing:border-box',
  'display:flex',
  'flex-direction:column',
  'gap:8px',
  'font-family:var(--oc-font, system-ui, sans-serif)',
  'font-size:12px',
  'line-height:18px',
  'color:var(--oc-muted)',
].join(';');

const resize = () => {
  // Before the first snapshot the surface is unknown: asking for a height then
  // would shrink a popover frame, which starts at the size it was opened with.
  if (!surfaceReady || isPopover) return;
  void host.setHeight(Math.max(24, Math.min(320, Math.ceil(root.getBoundingClientRect().height))));
};
new ResizeObserver(resize).observe(root);

const disposeAll = () => {
  for (const handle of handles) handle.dispose();
  handles = [];
  listHandle?.dispose();
  listHandle = null;
  spinnerHandle?.dispose();
  spinnerHandle = null;
  resultsBox = null;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, style = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  return node;
};

const paint = () => {
  disposeAll();
  root.textContent = '';
  root.style.cssText = isPopover ? POPOVER_STYLE : SIDEBAR_STYLE;

  if (isPopover) {
    paintPopover();
    return;
  }

  if (!sessionId) {
    mountEmpty(root, {
      title: 'No chat open',
      body: 'Open a chat, then link it to an Agentic task here.',
    });
    resize();
    return;
  }

  if (serviceError) {
    const retry = el('div', 'margin-top:6px');
    root.appendChild(el('div', 'color:var(--oc-error-text)')).textContent = serviceError;
    root.appendChild(retry);
    handles.push(mountButton(retry, { label: 'Try again', size: 'xs', variant: 'outline', onClick: () => void loadState() }));
    resize();
    return;
  }

  if (mode === 'settings') {
    paintSettings();
    resize();
    return;
  }

  if (mode === 'picker') {
    paintPicker();
    resize();
    return;
  }

  paintList();
  resize();
};

const paintList = () => {
  if (loading && !loaded) {
    handles.push(mountSpinner(root, { size: 'sm', label: 'Reading Agentic' }));
    return;
  }

  if (error) {
    const box = el('div', 'color:var(--oc-error-text);margin-bottom:6px');
    box.textContent = error;
    root.appendChild(box);
    const actions = el('div', 'display:flex;gap:6px;align-items:center');
    root.appendChild(actions);
    handles.push(mountButton(actions, { label: 'Change address', size: 'xs', variant: 'outline', onClick: openSettings }));
    handles.push(mountButton(actions, { label: 'Try again', size: 'xs', variant: 'ghost', onClick: () => void loadState() }));
    return;
  }

  if (links.length > 0) {
    const wrap = el('div', 'display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:2px 0 6px');
    for (const link of links) {
      wrap.appendChild(chip(link));
    }
    root.appendChild(wrap);
  } else {
    const empty = el('div', 'padding:2px 0 6px');
    empty.textContent = 'Not linked to an Agentic task.';
    root.appendChild(empty);
  }

  const actions = el('div', 'display:flex;gap:6px;align-items:center');
  root.appendChild(actions);
  let associateEl: HTMLElement | null = null;
  handles.push(
    mountButton(actions, {
      label: '+ Associate a task',
      size: 'xs',
      variant: 'ghost',
      disabled: busy,
      onClick: () => {
        if (canPopover) void openPopoverPicker(associateEl);
        else openPicker();
      },
    }),
  );
  associateEl = actions.firstElementChild as HTMLElement | null;
  handles.push(
    mountButton(actions, {
      label: 'Refresh',
      size: 'xs',
      variant: 'ghost',
      disabled: busy,
      onClick: () => void loadState(true),
    }),
  );
};

const chip = (link: Link): HTMLElement => {
  const box = el(
    'span',
    [
      'display:flex',
      'align-items:center',
      'gap:2px',
      'width:100%',
      'max-width:100%',
      'min-width:0',
      'background:var(--oc-subtle)',
      'border:1px solid var(--oc-border)',
      'border-radius:999px',
      'padding:0 2px 0 8px',
      'line-height:20px',
    ].join(';'),
  );

  const open = el(
    'button',
    [
      'flex:1 1 auto',
      'min-width:0',
      'border:0',
      'background:transparent',
      'color:var(--oc-fg)',
      'font:inherit',
      'text-align:left',
      'padding:0',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap',
      'cursor:pointer',
    ].join(';'),
  );
  open.type = 'button';
  open.textContent = link.title;
  open.title = `${link.title} (${STATUS_LABELS[link.status] ?? link.status})`;
  open.addEventListener('click', () => {
    void host.openUrl(link.url).catch(() => {
      void host.toast({ kind: 'error', message: `Could not open ${link.url}` });
    });
  });
  box.appendChild(open);

  const remove = el(
    'button',
    [
      'flex:0 0 auto',
      'border:0',
      'background:transparent',
      'color:var(--oc-muted)',
      'font:inherit',
      'line-height:1',
      'padding:0 6px',
      'cursor:pointer',
    ].join(';'),
  );
  remove.type = 'button';
  remove.textContent = '×';
  remove.setAttribute('aria-label', `Unlink ${link.title}`);
  remove.title = 'Unlink this chat from the task';
  remove.addEventListener('click', () => void unlink(link));
  box.appendChild(remove);

  return box;
};

const paintPopover = () => {
  const head = el('div', 'font-weight:500;color:var(--oc-fg)');
  head.textContent = 'Link to an Agentic task';
  root.appendChild(head);

  const field = el('div');
  root.appendChild(field);
  handles.push(
    mountSearchField(field, {
      value: query,
      autofocus: true,
      placeholder: 'Search Agentic tasks',
      label: 'Search Agentic tasks',
      onChange: (value) => {
        query = value;
        scheduleSearch();
      },
    }),
  );

  resultsBox = el('div', 'flex:1;min-height:0;overflow:auto');
  root.appendChild(resultsBox);
  renderResults();

  if (popoverError) {
    const box = el('div', 'color:var(--oc-error-text)');
    box.textContent = popoverError;
    root.appendChild(box);
  }

  const footer = el('div', 'display:flex;justify-content:flex-end;gap:6px;flex:0 0 auto');
  root.appendChild(footer);
  handles.push(
    mountButton(footer, {
      label: 'Cancel',
      size: 'xs',
      variant: 'ghost',
      onClick: () => void host.close(),
    }),
  );
};

const openPopoverPicker = async (anchorEl: HTMLElement | null) => {
  const rect = anchorEl?.getBoundingClientRect();
  const anchor = {
    x: Math.round(rect?.x ?? 0),
    y: Math.round(rect?.y ?? 0),
    width: Math.round(rect?.width ?? 1),
    height: Math.round(rect?.height ?? 1),
  };
  const id = `task-picker-${Date.now()}`;
  popoverId = id;
  try {
    await host.openPopover({
      id,
      anchor,
      width: 560,
      height: 420,
      focus: true,
      data: { sessionId, skip: links.map((link) => link.id) },
    });
  } catch {
    popoverId = null;
    openPicker();
  }
};

const paintPicker = () => {
  const field = el('div', 'margin-bottom:6px');
  root.appendChild(field);
  handles.push(
    mountSearchField(field, {
      value: query,
      autofocus: true,
      placeholder: 'Search Agentic tasks',
      label: 'Search Agentic tasks',
      onChange: (value) => {
        query = value;
        scheduleSearch();
      },
    }),
  );

  resultsBox = el('div', 'margin-bottom:6px');
  root.appendChild(resultsBox);
  renderResults();

  const actions = el('div', 'display:flex;gap:6px;align-items:center');
  root.appendChild(actions);
  handles.push(
    mountButton(actions, {
      label: 'Cancel',
      size: 'xs',
      variant: 'ghost',
      disabled: busy,
      onClick: () => {
        mode = 'list';
        paint();
      },
    }),
  );
};

const renderResults = () => {
  if (!resultsBox) return;
  listHandle?.dispose();
  listHandle = null;
  spinnerHandle?.dispose();
  spinnerHandle = null;
  resultsBox.textContent = '';
  if (searching && results.length === 0) {
    spinnerHandle = mountSpinner(resultsBox, { size: 'sm', label: 'Searching' });
    return;
  }
  listHandle = mountList(resultsBox, {
    ariaLabel: 'Agentic tasks',
    items: results.map((task) => ({
      id: task.id,
      title: task.title,
      meta: STATUS_LABELS[task.status] ?? task.status,
    })),
    emptyText: query.trim() ? 'No task matches that search.' : 'No open task to link.',
    onSelect: (id) => {
      const task = results.find((row) => row.id === id);
      if (task) void link(task);
    },
  });
};

const paintSettings = () => {
  const intro = el('div', 'padding:2px 0 6px');
  intro.textContent = 'Where Agentic runs.';
  root.appendChild(intro);

  const field = el('div', 'margin-bottom:6px');
  root.appendChild(field);
  handles.push(
    mountTextField(field, {
      value: settingsValue,
      label: 'Agentic address',
      placeholder: 'http://127.0.0.1:8600',
      mono: true,
      error: settingsError ?? undefined,
      onChange: (value) => {
        settingsValue = value;
      },
    }),
  );

  const actions = el('div', 'display:flex;gap:6px;align-items:center');
  root.appendChild(actions);
  handles.push(
    mountButton(actions, {
      label: 'Save',
      size: 'xs',
      variant: 'default',
      loading: busy,
      disabled: busy,
      onClick: () => void saveSettings(),
    }),
  );
  handles.push(
    mountButton(actions, {
      label: 'Cancel',
      size: 'xs',
      variant: 'ghost',
      disabled: busy,
      onClick: () => {
        mode = 'list';
        settingsError = null;
        paint();
      },
    }),
  );
};

const openPicker = () => {
  mode = 'picker';
  query = '';
  results = [];
  searching = true;
  paint();
  void runSearch();
};

const openSettings = () => {
  mode = 'settings';
  settingsValue = baseUrl || 'http://127.0.0.1:8600';
  settingsError = null;
  paint();
};

const scheduleSearch = () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void runSearch(), 140);
};

const parse = <T>(res: { status: number; body: string }): T | null => {
  if (res.status !== 200) return null;
  try {
    return JSON.parse(res.body) as T;
  } catch {
    return null;
  }
};

const runSearch = async () => {
  if (!sessionId) return;
  const seq = ++searchSeq;
  searching = true;
  renderResults();
  const skip = isPopover ? popoverSkip : links.map((link) => link.id);
  const res = await host
    .serviceRequest({
      method: 'GET',
      path: `/tasks?q=${encodeURIComponent(query)}&skip=${encodeURIComponent(skip.join(','))}`,
    })
    .catch(() => null);
  if (seq !== searchSeq) return;
  searching = false;
  const data = res ? parse<{ ok: boolean; tasks?: TaskRow[]; error?: string }>(res) : null;
  if (!data || !data.ok) {
    const message = data?.error ?? (data ? null : 'The extension service did not answer. Try again.');
    if (isPopover) {
      popoverError = message ?? 'Agentic did not answer the search.';
      paint();
      return;
    }
    if (mode === 'picker') {
      mode = 'list';
      error = data?.error ?? null;
      serviceError = data ? null : 'The extension service did not answer. Try again.';
      paint();
    }
    return;
  }
  popoverError = null;
  results = Array.isArray(data.tasks) ? data.tasks : [];
  renderResults();
};

const loadState = async (refresh = false) => {
  if (!sessionId) return;
  const seq = ++stateSeq;
  loading = true;
  serviceError = null;
  paint();
  const res = await host
    .serviceRequest({
      method: 'GET',
      path: `/state?session=${encodeURIComponent(sessionId)}${refresh ? '&refresh=1' : ''}`,
    })
    .catch(() => null);
  if (seq !== stateSeq) return;
  loading = false;
  loaded = true;
  const data = res
    ? parse<{ ok: boolean; baseUrl?: string; links?: Link[]; error?: string }>(res)
    : null;
  if (!res) {
    serviceError = 'The extension service did not answer. Try again.';
    paint();
    return;
  }
  if (!data) {
    serviceError = 'The extension service sent an answer this page could not read.';
    paint();
    return;
  }
  baseUrl = typeof data.baseUrl === 'string' ? data.baseUrl : baseUrl;
  if (data.ok) {
    error = null;
    links = Array.isArray(data.links) ? data.links.filter((link) => link && typeof link.id === 'string') : [];
  } else {
    error = typeof data.error === 'string' ? data.error : `Agentic is not answering at ${baseUrl}.`;
    links = [];
  }
  paint();
};

const applyState = (data: { ok: boolean; baseUrl?: string; links?: Link[]; error?: string } | null): boolean => {
  if (!data) return false;
  baseUrl = typeof data.baseUrl === 'string' ? data.baseUrl : baseUrl;
  if (!data.ok) {
    error = typeof data.error === 'string' ? data.error : `Agentic is not answering at ${baseUrl}.`;
    links = [];
    return false;
  }
  error = null;
  links = Array.isArray(data.links) ? data.links.filter((link) => link && typeof link.id === 'string') : [];
  return true;
};

const link = async (task: TaskRow) => {
  if (!sessionId || busy) return;
  busy = true;
  paint();
  const res = await host
    .serviceRequest({
      method: 'POST',
      path: '/link',
      body: JSON.stringify({ sessionId, taskId: task.id, label: sessionTitle, cwd: directory }),
    })
    .catch(() => null);
  busy = false;
  mode = 'list';
  const data = res ? parse<{ ok: boolean; baseUrl?: string; links?: Link[]; error?: string }>(res) : null;
  if (!applyState(data)) {
    if (isPopover) {
      popoverError = (data ? error : null) ?? `Could not link "${task.title}".`;
      paint();
      return;
    }
    if (!data) serviceError = 'The extension service did not answer. Try again.';
    paint();
    void host.toast({ kind: 'error', message: error ?? `Could not link "${task.title}".` });
    return;
  }
  if (isPopover) {
    void host.toast({ kind: 'success', message: `Linked "${task.title}"` });
    void host.close();
    return;
  }
  paint();
  void host.toast({ kind: 'success', message: `Linked "${task.title}"` });
};

const unlink = async (target: Link) => {
  if (!sessionId || busy) return;
  busy = true;
  paint();
  const res = await host
    .serviceRequest({
      method: 'POST',
      path: '/unlink',
      body: JSON.stringify({ sessionId, taskId: target.id }),
    })
    .catch(() => null);
  busy = false;
  const data = res ? parse<{ ok: boolean; baseUrl?: string; links?: Link[]; error?: string }>(res) : null;
  if (!applyState(data)) {
    if (!data) serviceError = 'The extension service did not answer. Try again.';
    paint();
    void host.toast({ kind: 'error', message: error ?? `Could not unlink "${target.title}".` });
    return;
  }
  paint();
  void host.toast({ kind: 'info', message: `Unlinked "${target.title}"` });
};

const saveSettings = async () => {
  if (busy) return;
  busy = true;
  settingsError = null;
  paint();
  const res = await host
    .serviceRequest({ method: 'POST', path: '/config', body: JSON.stringify({ baseUrl: settingsValue }) })
    .catch(() => null);
  busy = false;
  const data = res ? parse<{ ok: boolean; baseUrl?: string; error?: string }>(res) : null;
  if (!data) {
    settingsError = 'The extension service did not answer. Try again.';
    paint();
    return;
  }
  if (!data.ok) {
    settingsError = data.error ?? 'That address did not work.';
    paint();
    return;
  }
  baseUrl = data.baseUrl ?? settingsValue;
  mode = 'list';
  loaded = false;
  paint();
  void loadState();
};

host.onPopoverClosed(({ id }) => {
  if (isPopover || id !== popoverId) return;
  popoverId = null;
  // The picker may have linked a task; the service has already dropped its
  // cache, so this read is the fresh one.
  void loadState();
});

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  surfaceReady = true;
  canPopover = context.features?.popovers === true;

  if (context.surface === 'popover') {
    if (isPopover) return;
    isPopover = true;
    const data = (context.popover?.data ?? {}) as { sessionId?: string; skip?: string[] };
    popoverSkip = Array.isArray(data.skip) ? data.skip.filter((id): id is string => typeof id === 'string') : [];
    sessionId = context.session?.id ?? (typeof data.sessionId === 'string' ? data.sessionId : null);
    sessionTitle = context.session?.title ?? '';
    directory = context.directory ?? null;
    mode = 'picker';
    query = '';
    results = [];
    searching = true;
    popoverError = null;
    paint();
    void runSearch();
    return;
  }

  const next = context.session?.id ?? null;
  sessionTitle = context.session?.title ?? '';
  directory = context.directory ?? null;
  if (next === sessionId) {
    resize();
    return;
  }
  sessionId = next;
  mode = 'list';
  loaded = false;
  links = [];
  error = null;
  serviceError = null;
  busy = false;
  loading = next !== null;
  paint();
  void loadState();
});
