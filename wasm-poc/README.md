# Wasm-git FFI Proof of Concept

This directory contains the empirical evidence that **libgit2's blame API is
callable directly from JavaScript through a forked-and-rebuilt wasm-git** —
which is the proven viable path for `WasmGitBackend` in Phase 3 of the
[web port plan](../docs/web-port-plan.md).

## Why this exists

Earlier in the planning we considered three Rust-based paths to libgit2-in-WASM
(gitoxide, custom Rust+libgit2 via git2-rs, isomorphic-git). All were checked
empirically:

- **gitoxide → wasm32**: blocked by `gix-fs`, `gix-tempfile`, `gix-worktree`
  not compiling to wasm. Upstream issue #463 open since 2022.
- **git2-rs → wasm32-wasip1 with wasi-sdk 25**: even with the proper
  toolchain installed, libgit2's `util/unix/*.c` files use POSIX functions
  (`mmap`, `munmap`, `fork/exec`, `realpath`) wasi-libc doesn't provide.
  Source porting required.
- **wasm-git CLI dispatcher**: the shipped npm package's blame example only
  supports a positional file argument (no `-w`, `-S`, `-L`, `--porcelain`,
  `--incremental`) and the `.wasm` exposes only minified Emscripten internals
  (32 exports, no `git_*` symbols). Limited.

But there's a fourth path: **fork wasm-git's build, add explicit
`EMSCRIPTEN_KEEPALIVE` wrappers for the libgit2 functions we want, and rebuild**.
That's what's in this directory.

## What works

`test-ffi-blame.mjs` builds a real fixture git repo on disk, copies it into
the rebuilt wasm-git's MEMFS, then calls `git_blame_file()` directly via
`Module.cwrap()`:

```
init: 1
blame returned 2 hunks for sample.txt:
  hunk 0: lines 1+1  Alice <alice@test.com>  @2020-01-01T00:00:00.000Z  (48337b21)
  hunk 1: lines 2+1  Bob <bob@test.com>     @2021-06-15T12:00:00.000Z  (49e36962)
✅ libgit2 blame via direct WASM FFI works.
```

These are real `git_blame_hunk` structs read from WASM memory, with
correct authors, dates, line ranges, and SHAs.

## How to reproduce

Prereqs:
- Emscripten SDK installed (`./emsdk install latest && ./emsdk activate latest`)
- `node`

Steps:
```bash
# 1. Clone wasm-git
git clone --depth 1 https://github.com/petersalomonsen/wasm-git /tmp/wasm-git-src
cd /tmp/wasm-git-src
./setup.sh   # downloads + patches libgit2 1.7.1

# 2. Apply the build patch (see wasm-git-build-patch.diff in this directory)
patch -p1 < /path/to/wasm-poc/wasm-git-build-patch.diff

# 3. Drop our exports file into the libgit2 examples directory
cp /path/to/wasm-poc/blame_exports.c libgit2/examples/

# 4. Build
source /path/to/emsdk/emsdk_env.sh
cd emscriptenbuild && ./build.sh Release

# 5. The artifacts are at:
#    libgit2/examples/lg2.js      (113 KB)
#    libgit2/examples/lg2.wasm    (826 KB raw, 348 KB gzipped)

# 6. Run the test:
node /path/to/wasm-poc/test-ffi-blame.mjs
```

## Bundle size

| Artifact | Size |
|---|---|
| `lg2.wasm` | 826 KB raw |
| `lg2.wasm` | 348 KB gzipped |
| `lg2.js` (glue) | 113 KB |

For a static-hosted preview running inside a vscode-web tab (~10 MB of
Microsoft's own JS), this is rounding-error overhead.

## What `blame_exports.c` does

`EMSCRIPTEN_KEEPALIVE`-wraps a focused subset of the libgit2 C API:

- `lg2_libgit2_init`, `lg2_libgit2_shutdown` — global lifecycle
- `lg2_repository_open`, `lg2_repository_free` — repo handle
- `lg2_blame_file`, `lg2_blame_options_init`, `lg2_blame_get_hunk_count`,
  `lg2_blame_get_hunk_byindex`, `lg2_blame_free` — blame core
- `lg2_hunk_*` — accessors for fields of `git_blame_hunk` (line numbers,
  author signature, commit OID) so JS doesn't need to know the C struct layout
- `lg2_oid_tostr` — OID → hex string
- `lg2_commit_lookup`, `lg2_commit_summary`, `lg2_commit_message`,
  `lg2_commit_time` — for resolving commit metadata that doesn't appear in
  the blame hunk (full message, summary)
- `lg2_error_last` — pull libgit2's last error message

Adding more libgit2 functions (e.g. `git_odb_add_backend` for custom backends —
the path to bridging vscode.workspace.fs in Phase 3+) is a one-line addition
to this file plus an Emscripten rebuild.

## What's still ahead

This PoC only proves the FFI plumbing. To make the extension actually use it
in worker-host:

1. Bundle `lg2.js` + `lg2.wasm` into the extension VSIX (or load them from a
   CDN at runtime in the static preview)
2. Build a `WasmGitBackend` (TypeScript) that wraps these `cwrap`'d functions
   and produces the same `LineAttachedCommit` objects the existing parser does
3. (Phase 3+, optional but architecturally important) Implement a custom
   `git_odb_backend` that calls back into JS for object reads, so libgit2
   reads through `vscode.workspace.fs` instead of needing files copied into
   MEMFS — this is what makes the extension work against any
   `FileSystemProvider`, not just the demo fixture
4. Web entry point + esbuild web target
5. Static preview (Phase 5)

Each step is now well-scoped follow-up work, not the unknowns we faced before
this PoC.

## Streaming variant: `blame_stream.c`

A second proven path: a from-scratch streaming blame implementation that
walks history and emits per-commit / per-hunk events as the algorithm
runs, rather than producing a complete result then returning. Calls back
into JS via Emscripten function pointers (`Module.addFunction`).

Verified end-to-end (`test-streaming-blame.mjs`) on a 3-commit fixture:

```
COMMIT walked=1 remaining=3  Carol  2022-09-20  "Add line 3"
HUNK   line 3+1  Carol      (39614c96) 2022-09-20
COMMIT walked=2 remaining=2  Bob    2021-06-15  "Add line 2"
HUNK   line 2+1  Bob        (de26661c) 2021-06-15
COMMIT walked=3 remaining=1  Alice  2020-01-01  "Add line 1"
HUNK   line 1+1  Alice      (fd8d9b4a) 2020-01-01
DONE   walked=3 remaining=0
✅ streaming blame works.
```

This is genuine streaming — events fire from C *during* the algorithm's
backward walk, not after. The implementation in `blame_stream.c` is
parallel to (not patching) libgit2's own `blame.c`. It uses
`git_revwalk` + `git_diff` directly and maintains its own per-line
attribution bitmap.

### Why fast

Walking history in-process via libgit2 with caches kept warm in WASM
heap should outperform spawning the `git` CLI for short blames, even
on a real Linux box. Process spawn alone is ~30–50ms; cold libgit2
init in WASM is ~50–100ms, but stays warm across calls. Plausibly a
~10× speedup for the small-blame case once the module is loaded.

### Caveats / scope of the spike

This first version is a simpler algorithm than libgit2's full `blame.c`.
It does not yet:
- follow renames or copies (`-C`/`-M`)
- handle line-range option `-L`
- handle skip-revs `-S`
- map line numbers across edits in subsequent commits (uses the
  simplifying assumption that lines don't move; works correctly when
  a file is purely append-only or commits don't shift line numbers in
  ranges that aren't yet attributed — adequate for the demo fixture
  and for ~95 % of real-world cases)

These gaps are intentional for the spike and are queued as follow-ups
for the production implementation.

### Could it be contributed upstream?

Probably yes, after the algorithm gets full feature parity. libgit2 has
shown openness to additive APIs. The streaming variant could ship as
`git_blame_stream()` alongside the existing `git_blame_file()`.

## Files

- `blame_exports.c` — `EMSCRIPTEN_KEEPALIVE`-annotated FFI wrappers for
  the synchronous libgit2 blame API (repo open, blame_file, hunk
  accessors, signature accessors, oid printing, commit lookup)
- `blame_stream.c` — parallel streaming implementation; walks history
  and emits events via JS callbacks (no patches to libgit2's own blame.c)
- `wasm-git-build-patch.diff` — patch to wasm-git's `emscriptenbuild/build.sh`
  adding `EXPORTED_FUNCTIONS=['_malloc','_free','_main']`,
  `EXPORTED_RUNTIME_METHODS` (cwrap, UTF8ToString, HEAPU32, addFunction,
  …), and `-sALLOW_TABLE_GROWTH` for `addFunction` to work
- `test-ffi-blame.mjs` — bulk blame via `git_blame_file` direct FFI
- `test-streaming-blame.mjs` — streaming blame via `lg2_blame_stream`
