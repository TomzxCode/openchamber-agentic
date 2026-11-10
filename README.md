# Agentic tasks

An [OpenChamber](https://github.com/openchamber/openchamber) extension that
links the chat you are viewing to one or more
[Agentic](https://github.com/tomzxcode/agentic) tasks.

Work Status gets an "Agentic tasks" section. It lists the Agentic tasks the
current chat is attached to, follows the chat you switch to, and lets you
associate more or unlink one, without leaving OpenChamber.

Clicking a task opens it in Agentic. Each link is an Agentic agent session on
that task (`POST /api/tasks/{id}/sessions`), so the task page lists the chat
with its usual ways to reopen it.

## Install

[Install Agentic tasks](openchamber://extensions/install?url=https%3A%2F%2Fgithub.com%2FTomzxCode%2Fopenchamber-agentic)

Or add this repository's URL (or this folder) in Settings → Extensions. Web and
desktop only; VS Code and the phone load no extensions.

## How it works

- `status/` is the Work Status section. It reads the session id and project
  directory from the host, then asks the service what that chat is linked to.
  A chip opens the task in Agentic; its `×` unlinks it. "+ Associate a task"
  opens a 560px anchored popover (the same page, `surface: "popover"`) with a
  task search, so the list is wider than the sidebar; a host without popovers
  gets the search inline instead.
- `service/` talks to Agentic over its HTTP API. Agentic lists sessions under a
  task only, so the service reads every task's sessions once and keeps the
  result for a minute (`/state` answers in about 15 ms from that cache, about
  400 ms cold for 340 tasks). Linking and unlinking clear it.
- `GET /health`, `GET /state?session=`, `GET /tasks?q=&skip=`, `POST /link`,
  `POST /unlink`, and `POST /config` make up the service.

Agentic is expected at `http://127.0.0.1:8600`. When it answers somewhere else,
use "Change address" in the section; the address is kept in the extension's
service data folder (`config.json`), so no source edit is needed.

## What it asks for

- A local service, which is how the section reaches Agentic on loopback.
- Nothing else: no session content, no files, no OpenCode connection.

## Development

```sh
bun install
bunx openchamber-guest-bundle status/main.ts status/main.js
bunx openchamber-guest-bundle --node service/main.ts service/main.js
bunx openchamber-guest-check
```

Try the service on its own:

```sh
OPENCHAMBER_SERVICE_PORT=4599 OPENCHAMBER_SERVICE_TOKEN=t node service/main.js &
curl -H 'Authorization: Bearer t' 'localhost:4599/state?session=ses_...'
```
