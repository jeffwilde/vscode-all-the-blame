---
name: vscode-env-terminology
description: Canonical terminology for VS Code runtime environments when discussing extensions, deployments, testing, and where code actually executes. Use whenever the user mentions VS Code, Codespaces, vscode.dev, github.dev, code-server, Remote SSH, Dev Containers, "web mode", "browser version", extension hosts, or any distinction between local and remote execution.
---

# VS Code Environment Terminology

Use these three terms — and nothing else — to describe where an extension actually runs. Do not say "web VS Code", "VS Code in the browser", or "desktop VS Code" without qualification; those phrases conflate the UI with the extension host and lead to confusion.

## The three classes

Defined by what kind of process hosts the extension:

| Class | Extension host is | Node.js + filesystem? |
|---|---|---|
| **local-host** | Node.js on the user's own machine | yes |
| **remote-host** | Node.js on another machine (container, server, WSL) | yes |
| **worker-host** | Sandboxed web worker in a browser tab | no |

The UI (browser tab vs native Electron window) is a **separate axis** and does not change the class. What matters is where the extension runs.

## Product mapping

| Product | Class |
|---|---|
| VS Code Desktop (native app, files on same machine) | local-host |
| VS Code Desktop + Remote SSH / WSL / Dev Container / Codespace | remote-host |
| GitHub Codespaces opened in a browser tab | remote-host |
| code-server, Gitpod, OpenVSCode Server | remote-host |
| vscode.dev | worker-host |
| github.dev | worker-host |

Codespaces-in-a-browser is **remote-host**, not worker-host. The browser is only drawing the UI — a real Node.js process runs in the Codespace container. Extensions that can't run in a worker can still run there.

## What extensions can do in each class

| Capability | local-host | remote-host | worker-host |
|---|---|---|---|
| `child_process` (spawn git, etc.) | yes | yes | no |
| `node:fs`, `node:path`, real filesystem | yes | yes | no |
| Native modules | yes | yes | no |
| Network (`fetch`) | yes | yes | yes |
| VS Code API (`vscode.*`) | yes | yes | subset (no `Terminal`, no `Task`, etc.) |

## Manifest signals (`package.json`)

- `"main": "./out/index.js"` — Node entry point. Used on local-host and remote-host.
- `"browser": "./out/web.js"` — web worker entry. Required for worker-host support.
- `"extensionKind": ["ui"]` — force local-host (extension always runs on the UI machine).
- `"extensionKind": ["workspace"]` — force wherever the workspace is (local-host or remote-host). Cannot run worker-host.
- `"extensionKind": ["ui", "workspace"]` — flexible.
- `"capabilities.virtualWorkspaces": false` — refuses to load when there is no real filesystem (i.e. worker-host).
- `"capabilities.untrustedWorkspaces.supported": false` — refuses to run in untrusted workspace mode.

An extension with only `"main"`, `extensionKind: ["workspace"]`, and `virtualWorkspaces: false` is explicitly declaring: **local-host or remote-host only. Never worker-host.**

## When the user says...

Translate loose phrasing to the precise class before responding:

- "VS Code web" / "web version" / "browser version" → **ambiguous**. Ask or assume by context: Codespaces-in-browser is **remote-host**; vscode.dev/github.dev is **worker-host**.
- "Codespace" / "codespaces" → **remote-host**, regardless of whether the UI is browser or desktop.
- "Remote" / "SSH" / "WSL" / "dev container" → **remote-host**.
- "Desktop" (unqualified) → usually **local-host**, but clarify if remote dev might apply.
- "vscode.dev" / "github.dev" → **worker-host**.
- "code-server" / "Gitpod" / "OpenVSCode Server" → **remote-host**.
- "Does this work in the browser?" → **depends on which class the browser UI is talking to**. A browser UI for Codespaces = remote-host (anything works). A browser UI for vscode.dev = worker-host (only `browser`-entry extensions).

## Common mistakes to avoid

- **Don't say "Codespaces is the web version of VS Code"** — it's a remote-host with a browser UI. Extensions that need Node.js work fine there. Conflating it with vscode.dev misleads users about what their extension can do.
- **Don't assume "the UI is in a browser" means "no filesystem."** The filesystem lives with the extension host, not the UI.
- **Don't say an extension "runs in the browser" for Codespaces.** The extension runs on the container. Only the UI is in the browser.
- **Don't ask "local or remote?" when the user is on vscode.dev.** There is no backend. It's worker-host.

## Testing implications

- `@vscode/test-electron` — launches a real Electron VS Code and runs tests against it. Covers local-host and, with `--remote`, remote-host. Does not exercise worker-host.
- `@vscode/test-web` — boots VS Code in a Playwright-controlled browser as worker-host. Only relevant for extensions with a `browser` entry.
- Integration tests for a local-host/remote-host-only extension: use `@vscode/test-electron`. Do not attempt `@vscode/test-web`.
