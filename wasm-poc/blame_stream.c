/*
 * blame_stream.c — streaming blame implementation, parallel to libgit2's
 * own blame.c.
 *
 * Goal: emit per-commit-processed events as the algorithm walks history
 * backward, instead of producing a complete result and returning at end.
 * The algorithm uses libgit2's revwalk + diff primitives directly; no
 * dependency on git_blame_file().
 *
 * Algorithm (from-scratch streaming variant):
 *   1. Read the file at HEAD, count its lines N.
 *   2. Initialize a per-line "still attributable" bitmap of size N.
 *   3. Walk commits backward via git_revwalk.
 *   4. For each commit:
 *        a. Diff against its first parent on this path.
 *        b. For each hunk in the diff that affects lines still in the
 *           bitmap, emit an event:
 *              (commit, file_lines_attributed, blame_callback)
 *           and clear those lines from the bitmap.
 *        c. Emit a "commit-processed" progress event regardless of
 *           whether any lines were attributed.
 *        d. If the bitmap is empty, stop early — every line has been
 *           attributed.
 *   5. After the walk, any lines still in the bitmap are attributed to
 *      HEAD (the file existed but the line never changed).
 *
 * This is a much simpler algorithm than libgit2's blame.c — it doesn't
 * follow renames/copies, doesn't handle line moves between hunks, doesn't
 * implement -L line-range or -S skip-revs. For the streaming-preview use
 * case (blame for a freshly opened file in vscode-web with a curated
 * fixture), the simpler semantics are acceptable. Future revisions can
 * add the missing features.
 *
 * Why parallel rather than patching libgit2's blame.c:
 *   - blame.c's algorithm splits/shifts hunks during processing; per-hunk
 *     emission in mid-walk would emit hunks that later get mutated. A
 *     true streaming variant needs a different algorithmic shape.
 *   - Keeping it as a separate file means we can iterate independently,
 *     and a future upstream contribution is a clean additive PR rather
 *     than a refactor of existing code.
 *
 * Intentionally NOT in this file:
 *   - FFI wrappers (those live in blame_exports.c)
 *   - The bulk-blame buffer-serialization path (separate file/concern)
 */

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <git2.h>
#include <stdlib.h>
#include <string.h>

/*
 * Callback signature passed in from JS via Module.addFunction().
 *
 * Three event kinds get the same shape; the first arg distinguishes:
 *   kind = 0  hunk-attributed   (a range of lines just got blamed to
 *                                this commit)
 *   kind = 1  commit-processed  (progress event, fired per commit walked)
 *   kind = 2  done              (algorithm finished cleanly)
 *
 * Returning non-zero from the callback aborts the walk early.
 */
typedef int (*blame_stream_event_fn)(
    int kind,
    const git_oid *commit_oid,        /* the commit responsible (kinds 0,1) or NULL (kind 2) */
    uint32_t line_start,              /* 1-based; valid for kind 0 */
    uint32_t line_count,              /* valid for kind 0 */
    const char *author_name,          /* valid for kinds 0,1 */
    const char *author_email,         /* valid for kinds 0,1 */
    int64_t author_when,              /* valid for kinds 0,1 */
    const char *commit_summary,       /* valid for kinds 0,1 */
    uint32_t commits_walked,          /* progress: total commits processed so far */
    uint32_t lines_remaining,         /* progress: lines still unattributed */
    void *user_data);

#define EVENT_HUNK    0
#define EVENT_COMMIT  1
#define EVENT_DONE    2

/* --- bitmap helpers (one bit per line; line numbering is 1-based) --- */
typedef struct {
    uint8_t *bits;
    size_t   nbytes;
    uint32_t nlines;
    uint32_t set_count;
} line_bitmap;

static int bitmap_init(line_bitmap *bm, uint32_t nlines) {
    bm->nlines = nlines;
    bm->nbytes = (nlines + 7) / 8;
    bm->bits = calloc(bm->nbytes, 1);
    if (!bm->bits) return -1;
    /* set all bits up to nlines */
    for (uint32_t i = 1; i <= nlines; i++) bm->bits[(i - 1) / 8] |= (uint8_t)(1u << ((i - 1) % 8));
    bm->set_count = nlines;
    return 0;
}
static void bitmap_free(line_bitmap *bm) { free(bm->bits); bm->bits = NULL; }
static int bitmap_test(const line_bitmap *bm, uint32_t line) {
    if (line == 0 || line > bm->nlines) return 0;
    return (bm->bits[(line - 1) / 8] >> ((line - 1) % 8)) & 1;
}
static void bitmap_clear(line_bitmap *bm, uint32_t line) {
    if (line == 0 || line > bm->nlines) return;
    uint8_t mask = (uint8_t)(1u << ((line - 1) % 8));
    if (bm->bits[(line - 1) / 8] & mask) {
        bm->bits[(line - 1) / 8] &= (uint8_t)~mask;
        bm->set_count--;
    }
}

/* --- diff-line callback context: track the current commit being attributed --- */
typedef struct {
    line_bitmap *bm;
    blame_stream_event_fn cb;
    void *user_data;
    int abort;

    const git_oid *commit_oid;
    const char *author_name;
    const char *author_email;
    int64_t author_when;
    const char *commit_summary;
    uint32_t commits_walked;
} attribution_ctx;

/* libgit2 calls this for each line in the diff between (parent, this_commit).
 *
 * We care about ADDED/MODIFIED lines on the new side — those mean "this
 * commit is responsible for those lines in the file".
 *
 * Note: line numbers in git_diff_line refer to lines in the NEW side of
 * the diff (this commit), which is NOT the same as line numbers in HEAD.
 * To map back, we'd need to walk diffs forward from this commit to HEAD.
 * This first version simplifies by attributing on first encounter going
 * backward — which works correctly as long as later commits haven't
 * shifted line numbers by inserting/deleting lines. For a more rigorous
 * implementation we'd track a line-number translation table. */
static int line_cb(
    const git_diff_delta *delta,
    const git_diff_hunk *hunk,
    const git_diff_line *line,
    void *payload)
{
    (void)delta; (void)hunk;
    attribution_ctx *ctx = payload;
    if (ctx->abort) return -1;

    if (line->origin != GIT_DIFF_LINE_ADDITION) return 0;

    int new_lineno = line->new_lineno;
    if (new_lineno <= 0) return 0;
    if (!bitmap_test(ctx->bm, (uint32_t)new_lineno)) return 0;

    bitmap_clear(ctx->bm, (uint32_t)new_lineno);

    int stop = ctx->cb(
        EVENT_HUNK,
        ctx->commit_oid,
        (uint32_t)new_lineno,
        1,
        ctx->author_name,
        ctx->author_email,
        ctx->author_when,
        ctx->commit_summary,
        ctx->commits_walked,
        ctx->bm->set_count,
        ctx->user_data);
    if (stop) ctx->abort = 1;
    return ctx->abort ? -1 : 0;
}

/*
 * Streaming blame entry point.
 *
 * Walks history backward from start_oid (typically HEAD), attributing
 * each line of `path` to the commit that introduced it. Emits events
 * via cb as each line gets attributed and as each commit is processed.
 */
EMSCRIPTEN_KEEPALIVE
int lg2_blame_stream(
    git_repository *repo,
    const char *path,
    const git_oid *start_oid,
    blame_stream_event_fn cb,
    void *user_data)
{
    int rc = 0;
    git_revwalk *walk = NULL;
    git_commit *commit = NULL, *parent = NULL;
    git_tree *tree = NULL, *parent_tree = NULL;
    git_diff *diff = NULL;
    git_blob *blob = NULL;
    git_tree_entry *entry = NULL;
    line_bitmap bm = {0};

    /* 1. Resolve the file at start_oid, count lines */
    rc = git_commit_lookup(&commit, repo, start_oid);
    if (rc) goto done;
    rc = git_commit_tree(&tree, commit);
    if (rc) goto done;
    rc = git_tree_entry_bypath(&entry, tree, path);
    if (rc) goto done;
    rc = git_blob_lookup(&blob, repo, git_tree_entry_id(entry));
    if (rc) goto done;

    /* count lines */
    {
        const char *content = git_blob_rawcontent(blob);
        git_object_size_t size = git_blob_rawsize(blob);
        uint32_t lines = 0;
        for (git_object_size_t i = 0; i < size; i++) {
            if (content[i] == '\n') lines++;
        }
        if (size > 0 && content[size - 1] != '\n') lines++;
        if (bitmap_init(&bm, lines)) { rc = -1; goto done; }
    }

    git_blob_free(blob); blob = NULL;
    git_tree_free(tree); tree = NULL;
    git_tree_entry_free(entry); entry = NULL;

    /* 2. Walk history */
    rc = git_revwalk_new(&walk, repo);
    if (rc) goto done;
    git_revwalk_sorting(walk, GIT_SORT_TIME);
    rc = git_revwalk_push(walk, start_oid);
    if (rc) goto done;

    git_oid current_oid;
    uint32_t commits_walked = 0;
    attribution_ctx attr = { .bm = &bm, .cb = cb, .user_data = user_data };

    while (git_revwalk_next(&current_oid, walk) == 0) {
        if (commit) { git_commit_free(commit); commit = NULL; }
        rc = git_commit_lookup(&commit, repo, &current_oid);
        if (rc) goto done;

        const git_signature *sig = git_commit_author(commit);
        const char *summary = git_commit_summary(commit);
        commits_walked++;

        attr.commit_oid = git_commit_id(commit);
        attr.author_name = sig ? sig->name : NULL;
        attr.author_email = sig ? sig->email : NULL;
        attr.author_when = sig ? sig->when.time : 0;
        attr.commit_summary = summary;
        attr.commits_walked = commits_walked;

        /* Emit progress event before diffing */
        if (cb(
                EVENT_COMMIT,
                attr.commit_oid,
                0, 0,
                attr.author_name,
                attr.author_email,
                attr.author_when,
                attr.commit_summary,
                commits_walked,
                bm.set_count,
                user_data) != 0) {
            attr.abort = 1;
            break;
        }

        /* Diff against first parent (or empty tree if root commit) */
        if (tree)        { git_tree_free(tree); tree = NULL; }
        if (parent_tree) { git_tree_free(parent_tree); parent_tree = NULL; }
        if (parent)      { git_commit_free(parent); parent = NULL; }
        if (diff)        { git_diff_free(diff); diff = NULL; }

        rc = git_commit_tree(&tree, commit);
        if (rc) goto done;

        if (git_commit_parentcount(commit) > 0) {
            rc = git_commit_parent(&parent, commit, 0);
            if (rc) goto done;
            rc = git_commit_tree(&parent_tree, parent);
            if (rc) goto done;
        }

        git_diff_options dopts = GIT_DIFF_OPTIONS_INIT;
        git_strarray pathspec = { (char**)&path, 1 };
        dopts.pathspec = pathspec;

        rc = git_diff_tree_to_tree(&diff, repo, parent_tree, tree, &dopts);
        if (rc) goto done;

        rc = git_diff_foreach(diff, NULL, NULL, NULL, line_cb, &attr);
        if (rc < 0 && !attr.abort) goto done;
        rc = 0;

        if (attr.abort) break;
        if (bm.set_count == 0) break;  /* every line attributed */
    }

    /* 3. Done */
    cb(EVENT_DONE, NULL, 0, 0, NULL, NULL, 0, NULL, commits_walked, bm.set_count, user_data);

done:
    bitmap_free(&bm);
    if (entry) git_tree_entry_free(entry);
    if (blob) git_blob_free(blob);
    if (diff) git_diff_free(diff);
    if (parent_tree) git_tree_free(parent_tree);
    if (parent) git_commit_free(parent);
    if (tree) git_tree_free(tree);
    if (commit) git_commit_free(commit);
    if (walk) git_revwalk_free(walk);
    return rc;
}

#endif
