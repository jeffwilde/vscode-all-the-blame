# Browser-Only Preview: Web Port Plan

## Goal

Make All the Blame run end-to-end in the browser with no backend, so we can ship a **static-hosted, anonymous preview** that demonstrates the extension on a pre-seeded fixture repository. Secondary: the work generalizes the extension to be provider-agnostic, so it works with any present or future VS Code `FileSystemProvider` (local-host, remote-host, worker-host, and everything in between).

## Terminology

- **local-host**: extension host is Node.js on the user's machine (VS Code Desktop)
- **remote-host**: extension host is Node.js on another machine (Codespaces, SSH, WSL, Dev Containers, code-server)
- **worker-host**: extension host is a sandboxed web worker in the browser tab (vscode.dev, github.dev, static-hosted vscode-web builds)

See `.claude/skills/vscode-env-terminology/SKILL.md` for the full definitions.

## Architectural shape

Two independent layers the extension relies on:

```
         ┌─────────────────────────┐
         │   All the Blame         │
         │   (extension code)      │
         └──────────┬──────────────┘
                    │
            ┌───────┴───────┐
            ▼               ▼
    vscode.workspace.fs    GitBackend (new)
    (filesystem I/O)       (blame / log / config / refs)
            │               │
            │               │
   ┌────────┼────────┐      │
   ▼        ▼        ▼      │
 file://  vscode-   memfs:
          vfs://
          github/
```

### Layer 1 — Filesystem

All file I/O goes through `vscode.workspace.fs`. No `node:fs`, no `node:path` direct reads. Any `FileSystemProvider` (built-in or third-party) is then supported automatically: file://, vscode-vfs://github/..., memfs://, our own `demofs://`, or anything a future extension registers.

### Layer 2 — Git

A `GitBackend` interface with multiple implementations, chosen at runtime based on the URI scheme and host capabilities:

| Environment | URI scheme | Backend |
|---|---|---|
| local-host / remote-host | `file://` | `CliGitBackend` (spawn real git) |
| worker-host | `file://` via File System Access API | `WasmGitBackend` (libgit2 compiled to WASM, reads `.git/` via `workspace.fs`) |
| any host | `memfs://`, `demofs://`, any virtual provider | `WasmGitBackend` |
| out of scope for this plan | `vscode-vfs://github/...` | GitHub GraphQL — intentionally skipped (see below) |

We deliberately skip the GitHub-GraphQL-backed path. It's a valuable optimization for the "open an arbitrary GitHub repo in vscode.dev" use case, but not needed for a browser-only static preview, and it adds surface area we don't need yet.

### The WASM choice

**wasm-git** (libgit2 compiled to WASM via Emscripten), not isomorphic-git:

- Real git semantics — bit-for-bit identical blame output to CLI git
- No reimplementing subtle edge cases (renames, whitespace, -S/-C flags, co-author trailers)
- Tracks upstream git as the library updates
- Larger bundle (~1MB gzipped WASM) is acceptable for the preview use case

## Phases

Each phase is a separate PR in a stack. Each is independently reviewable. Later phases are no-ops on desktop until they get reached.

### Phase 1 — `vscode.workspace.fs` migration *(PR B)*

Scope: replace every `node:fs`, `node:path` filesystem call with the equivalent `vscode.workspace.fs` / `vscode.Uri` form. Zero behavior change on desktop. Unlocks provider-agnosticism for filesystem access.

Files touched:
- `src/blamed-file.ts` — `realpath`, `access`
- `src/blame.ts` — `watch` on files
- `src/git/command/getRevsFile.ts` — `access`
- `src/git/GitRepositoryWatcher.ts` — `watch` on repos
- any remaining `fs` / `fs/promises` / `node:path` imports in `src/`

Acceptance: all existing tests pass; the extension behaves identically on desktop; `grep -rE "from .node:fs" src/` returns empty.

### Phase 2 — `GitBackend` interface + `CliGitBackend` *(PR C)*

Scope: extract every CLI git call behind a typed interface. Move (or thinly wrap) the existing spawn/execFile-based code into `CliGitBackend`. Factory `getGitBackend()` picks CLI when `child_process` is available. Zero behavior change.

Files created:
- `src/git/backend/GitBackend.ts` — interface
- `src/git/backend/CliGitBackend.ts` — current behavior, injection point
- `src/git/backend/index.ts` — factory + environment detection

Files modified: every call site of `git.run` / `blameProcess` / `git.getRepositoryFolder` — routed through the backend.

Acceptance: all existing tests pass; every direct `execFile`/`spawn` of git has been moved inside `CliGitBackend`.

### Phase 3 — wasm-git backend + web entry point *(PR D)*

Scope: add a `browser` entry to the extension, add a second esbuild target for worker-host, and implement `WasmGitBackend` using wasm-git. Factory returns the WASM backend when `child_process` is unavailable.

Files created / modified:
- `package.json` — add `"browser": "./out/web.js"`, `extensionKind: ["ui", "workspace"]`, `virtualWorkspaces: true`
- `esbuild.mts` — add web target with `platform: 'browser'`, `target: 'esnext'`
- `src/git/backend/WasmGitBackend.ts` — libgit2-backed implementation of the interface
- `src/web-entry.ts` — browser-only activate() wrapper (strips Node-only command handlers like `gitShow`)
- `src/git/backend/index.ts` — factory selection

Commands that degrade in worker-host:
- `gitShow` — no `vscode.window.createTerminal` is available in worker-host. Either silently omit the command when running in worker-host or show a notification explaining it's desktop-only.

Acceptance: desktop tests all pass; `pnpm run build-web` emits a usable `out/web.js`; when loaded into worker-host with a fixture FS providing `.git/` objects, blame returns the same output CLI git would.

### Phase 5 — static preview (browser-only working demo) *(PR E)*

Scope: produce a statically-hosted page where a reviewer clicks a link and sees the extension running end-to-end against a bundled fixture repo — no signup, no backend, no Codespace.

Components:
- A fixture tarball (same authoring pattern as `test/integration/setup-fixture.mjs`) containing `.git/objects/`, refs, sample files. Generated at build time, committed as build artifact or produced by a pre-publish step.
- A minimal `FileSystemProvider` that reads from a built-in in-memory filesystem seeded from the tarball. Prefer reusing an existing memfs provider (e.g. from `@vscode/test-web`'s own helpers) over rolling our own.
- A static-hosted `vscode-web` distribution (via GitHub Pages or similar) with the extension preinstalled and the FS provider active at page load.
- Public URL pattern: `https://<org>.github.io/vscode-all-the-blame/preview/` (or similar). Linkable from README, PRs, marketplace listing.

Acceptance: opening the URL in a fresh browser session (incognito, no auth) loads VS Code-for-the-Web, our extension is active, and blame renders against the fixture with the expected authors and times. No network calls to GitHub or any backend after the static assets land.

## Deliberately skipped

- **Phase 4 (GitHub GraphQL backend)** — out of scope; useful later but not on the critical path to a static preview.
- **Demo Codespace devcontainer** — the static preview is a strict superset of what a demo Codespace would offer, with less overhead.
- **Phase 6 (Playwright screenshot tests)** — deferred. Once Phase 5 ships, this is a straightforward follow-up: drive the static preview with Playwright and snapshot-diff the UI.

## Scope boundaries

In scope: everything needed to click a public URL and see blame rendering in the browser.

Out of scope:
- Writable git (commits in the browser). wasm-git supports it, but we're demoing a read-only preview.
- Multi-repo support beyond the fixture.
- Authentication with GitHub for private repo previews.
- Bundle-size optimization below the "reasonable for a preview" threshold.

## Open questions, to resolve during implementation

- Which memfs provider to adopt for the preview (does `@vscode/test-web`'s memfs ship in a consumable way, or do we need a minimal reimplementation?)
- How to seed the fixture on page load — inline base64 of the tarball, a `fetch()` of a sibling `.tar`, or a packaged extension contribution point.
- Whether to sign/publish the web-compatible VSIX to the VS Code Marketplace to make vscode.dev installs trivial, or to sideload via a hosted URL.

These don't block starting Phase 1, which is pure filesystem-abstraction work.

## Tracking

Each phase lands as its own PR, stacked on the previous one. Progress is tracked by merging into main in order. The preview is considered "working" when Phase 5 lands and produces a public URL that renders blame end-to-end in the browser.
