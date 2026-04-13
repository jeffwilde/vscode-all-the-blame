# Blame feature parity tracker

Comprehensive enumeration of every `git blame` feature in canonical git, with status
columns for libgit2's native support and our `blame_stream.c` implementation. Ordered
by priority so the post-MVP PR stack falls out naturally.

Legend:
- ✅ Implemented
- 🚧 Partial / known gaps
- ❌ Not implemented
- N/A Not applicable to our use case (CLI output formatting we don't expose)

---

## A. Algorithmic features (must match for correctness)

These change *which commit gets attributed to which line*. Output divergence here
is a real bug.

| Feature | Canonical git CLI | libgit2 | `blame_stream.c` (today) | Priority |
|---|---|---|---|---|
| Walk history backward, attribute lines | ✅ | ✅ `git_blame_file` | ✅ | (done) |
| Per-line attribution | ✅ | ✅ | ✅ | (done) |
| **Line-number translation across edits** | ✅ | ✅ | 🚧 simplified — assumes lines don't shift in unattributed ranges | **P0** — must fix before parity claims |
| Rename following (file moved) | ✅ implicit + `--follow`-ish | ✅ via tree walk | ❌ | **P1** |
| `-M` move detection within a file | ✅ | ⚠️ limited | ❌ | P2 |
| `-C` copy detection within same commit | ✅ | ✅ `GIT_BLAME_TRACK_COPIES_SAME_FILE` | ❌ | P2 |
| `-C -C` copies across all files in commit | ✅ | ✅ `GIT_BLAME_TRACK_COPIES_SAME_COMMIT_MOVES` / `_COPIES` | ❌ | P3 |
| `-C -C -C` copies in any commit | ✅ | ✅ `GIT_BLAME_TRACK_COPIES_ANY_COMMIT_COPIES` | ❌ | P3 |
| `-w` / `--ignore-whitespace` | ✅ | ✅ `GIT_BLAME_IGNORE_WHITESPACE` | ❌ — easy to wire (set diff option) | **P1** |
| `--ignore-blank-lines` | ✅ | ❌ libgit2 missing | ❌ | P3 (needs upstream lib) |
| `--ignore-cr-at-eol` | ✅ | ❌ | ❌ | P4 |
| `--ignore-space-at-eol` | ✅ | ❌ | ❌ | P4 |
| `--ignore-space-change` | ✅ | ❌ | ❌ | P4 |
| `--ignore-all-space` | ✅ | ❌ | ❌ | P4 |
| `-L <start>,<end>` line range | ✅ | ✅ `min_line`/`max_line` | ❌ | **P1** — wire through |
| `-L :<funcname>:<file>` function-range | ✅ | ❌ libgit2 missing | ❌ | P3 |
| `-L /<regex>/` regex-range | ✅ | ❌ libgit2 missing | ❌ | P4 |
| `-S <revs-file>` / `--ignore-revs-file` | ✅ | ❌ libgit2 missing | ❌ | **P1** — used by extension's `revsFile` setting |
| `--ignore-rev <rev>` | ✅ | ❌ | ❌ | P3 |
| `--first-parent` | ✅ | ✅ `GIT_BLAME_FIRST_PARENT` | ❌ | P2 — wire revwalk option |
| `<startpoint>` (blame from a non-HEAD commit) | ✅ | ✅ `newest_commit` | 🚧 take any oid as parameter — works | P2 — already supported, document it |
| `<oldest>..<newest>` range | ✅ | ✅ `newest_commit` + `oldest_commit` | ❌ | P3 |
| `--reverse <rev>..<rev>` (when was line LAST seen?) | ✅ | ❌ libgit2 missing | ❌ | P4 |
| Boundary commits / `--root` | ✅ | ⚠️ partial | ❌ | P3 |
| `--minimal` (use minimal diff) | ✅ | ✅ via `GIT_DIFF_MINIMAL` | ❌ | P3 — wire diff option |
| Mailmap (`--mailmap` / default behavior) | ✅ | ✅ `GIT_BLAME_USE_MAILMAP` | ❌ | **P1** — enable it; fixture-driven test |

## B. Output / data fields

What information we expose per hunk. Most of these are libgit2 struct accessors
or `git_commit` lookups — no algorithmic work required.

| Field | Canonical | libgit2 | `blame_stream.c` events | Priority |
|---|---|---|---|---|
| Final commit OID | ✅ | ✅ `final_commit_id` | ✅ emitted | (done) |
| Original commit OID (where line first appeared in the path) | ✅ | ✅ `orig_commit_id` | 🚧 we have it but don't emit | **P0** add to event |
| Original path (rename source) | ✅ | ✅ `orig_path` | ❌ | P1 (after rename tracking) |
| Original line number | ✅ | ✅ `orig_start_line_number` | ❌ | **P0** add to event |
| Final start line | ✅ | ✅ | ✅ | (done) |
| Hunk lines count | ✅ | ✅ `lines_in_hunk` | ✅ | (done) |
| Author signature: name | ✅ | ✅ `final_signature->name` | ✅ | (done) |
| Author signature: email | ✅ | ✅ `final_signature->email` | ✅ | (done) |
| Author signature: when (timestamp + tz) | ✅ | ✅ | 🚧 timestamp only, no timezone | **P0** add tz |
| Committer signature (name/email/when) | ✅ | ✅ via `git_commit_committer` | ❌ | P1 |
| Commit summary (first line of message) | ✅ | ✅ `git_commit_summary` | ✅ emitted | (done) |
| Full commit message body | ✅ via `--porcelain` | ✅ `git_commit_message` | ❌ | **P0** — needed for co-author trailer parsing on the AI-blame branch |
| Boundary marker (root commit ↔ ancestor) | ✅ | ✅ flag bit | ❌ | P3 |

## C. Output formatting (CLI-only, mostly N/A)

These are how the CLI renders blame — irrelevant for our use case where the
extension renders into status bar / decorations from structured events.

| Feature | Status |
|---|---|
| Default human-readable output | N/A — we produce events, not text |
| `--porcelain` / `--line-porcelain` / `--incremental` | N/A |
| `--date=<format>` | N/A — we expose raw timestamp + tz, JS formats |
| `-l` long hash, `--abbrev=<n>` | N/A — we expose full OID, JS abbreviates |
| `-t`, `-s`, `-f`, `-n`, `-c`, `-e` (output toggles) | N/A |
| `-h` help | N/A |
| `--encoding=<enc>` | 🚧 we always assume UTF-8 in C → JS string conv. P3 if anyone hits it. |
| `--show-stats`, `--score-debug`, `--progress` | N/A (debug) |

## D. Performance / behavior options

| Feature | Canonical | libgit2 | `blame_stream.c` | Priority |
|---|---|---|---|---|
| Streaming progress events as commits process | ❌ CLI only via `--incremental` | ❌ | ✅ unique to us | (done) |
| Cancel mid-blame from caller | ❌ (kill the process) | partial | ✅ callback returns non-zero | (done) |
| Stop early when all lines attributed | implicit | ✅ | ✅ | (done) |
| Bounded WASM heap | N/A | N/A | 🚧 unbounded (one bit per line, plus libgit2 internals) | P3 |
| Custom object database backend (read objects via `vscode.workspace.fs`) | N/A | ✅ `git_odb_add_backend` | ❌ — not yet wired | **P0** for worker-host compat with arbitrary FS providers |

## E. Misc edge cases worth noting

| Behavior | Canonical | `blame_stream.c` | Priority |
|---|---|---|---|
| Files that don't exist at HEAD (deleted) | error | ❌ silent failure today | P1 |
| Binary files | refuses or trivial blame | ❌ untested | P2 |
| Files with no trailing newline | counted correctly | 🚧 we count via `\n` and bump for missing trailing — needs test | P1 — add fixture test |
| Empty files | refuses | ❌ untested | P2 |
| Submodules | skipped | ❌ untested | P3 |
| LFS pointer files | blame the pointer, not contents | ❌ untested — fine, that's expected | (done by accident) |
| Files with very deep history (10K+ commits on path) | works, slowly | 🚧 we keep walking; should work but unbenched | P2 |
| `\r\n` line endings | handled | ❌ untested | P2 |
| Non-UTF-8 file content | handled byte-wise | ❌ untested — should be fine since we don't decode | P3 |

## Proposed PR sequence after the end-to-end MVP lands

Each row maps to one stacked PR. Each is independently verifiable against a
fixture and against `git blame`'s output for cross-validation.

1. **PR: P0 algorithmic correctness** — fix line-number translation across
   commits; emit `orig_start_line`, `orig_commit_id`, signature timezone, full
   commit message; add `git_odb_add_backend` callback machinery for the
   `vscode.workspace.fs` bridge. Add a fixture test that compares our blame
   output line-by-line against real `git blame` for ~20 representative commits.

2. **PR: P1 features** — `-w` ignore-whitespace; `-L` line range; `-S` /
   `--ignore-revs-file` (the extension already has a `revsFile` setting);
   mailmap (`GIT_BLAME_USE_MAILMAP`); rename following. Each adds 1–2
   diff/revwalk options plus a fixture test.

3. **PR: P2 features** — `--first-parent`; `-M` and `-C` move/copy detection;
   blame from non-HEAD start point. Each is mostly wiring an existing libgit2
   flag through our options struct.

4. **PR: P3 features** — `--ignore-rev`, boundary commits, `--minimal`,
   range `<oldest>..<newest>`, function-range `-L`. Most need either libgit2
   feature work or non-trivial algorithm changes.

5. **PR: P4 features** — `--reverse` blame, regex line ranges, the various
   `--ignore-*` whitespace variants. Niche enough to ship without unless a
   user asks.

6. **PR: cross-validation harness** — a script that runs `git blame` on a
   real fixture repo and our streaming blame on the same fixture, diffs the
   results, and fails CI on divergence. Catches regressions.

## Notes on libgit2 limitations

The features marked "❌ libgit2 missing" in column 3 above (`--ignore-blank-lines`,
function-range `-L`, `-S`/ignore-revs-file, `--ignore-rev`, regex `-L`,
`--reverse`) are gaps in libgit2 itself. For those we have three choices:

a) **Skip them.** Document as "desktop git CLI only."
b) **Implement in our streaming algorithm.** Some are tractable (skip-revs is a
   set lookup; ignore-revs-file is parsing); others (reverse blame) are
   significant algorithm work.
c) **Contribute upstream to libgit2.** Adds the feature for everyone using
   libgit2; longest-feedback-loop option.

Recommended: (a) for niche flags, (b) for `--ignore-revs-file` since the
extension already has a `revsFile` setting we'd want to honor, (c) opportunistic
for the rest if they ever block a user.
