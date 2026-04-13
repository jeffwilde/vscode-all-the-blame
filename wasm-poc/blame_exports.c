/*
 * Force-export libgit2 symbols we want to call from JS via cwrap/ccall.
 * Without EMSCRIPTEN_KEEPALIVE these get DCE'd because nothing in C
 * references them — only the JS side does, and Emscripten can't see that.
 */
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <git2.h>

/* --- core lifecycle --- */
EMSCRIPTEN_KEEPALIVE int lg2_libgit2_init(void) { return git_libgit2_init(); }
EMSCRIPTEN_KEEPALIVE int lg2_libgit2_shutdown(void) { return git_libgit2_shutdown(); }

/* --- repository --- */
EMSCRIPTEN_KEEPALIVE int lg2_repository_open(git_repository **out, const char *path) {
    return git_repository_open(out, path);
}
EMSCRIPTEN_KEEPALIVE void lg2_repository_free(git_repository *repo) {
    git_repository_free(repo);
}

/* --- blame --- */
EMSCRIPTEN_KEEPALIVE int lg2_blame_options_init(git_blame_options *opts, unsigned int version) {
    return git_blame_options_init(opts, version);
}
EMSCRIPTEN_KEEPALIVE int lg2_blame_file(git_blame **out, git_repository *repo, const char *path, git_blame_options *opts) {
    return git_blame_file(out, repo, path, opts);
}
EMSCRIPTEN_KEEPALIVE uint32_t lg2_blame_get_hunk_count(git_blame *blame) {
    return git_blame_get_hunk_count(blame);
}
EMSCRIPTEN_KEEPALIVE const git_blame_hunk *lg2_blame_get_hunk_byindex(git_blame *blame, uint32_t index) {
    return git_blame_get_hunk_byindex(blame, index);
}
EMSCRIPTEN_KEEPALIVE void lg2_blame_free(git_blame *blame) {
    git_blame_free(blame);
}

/* --- accessor helpers (struct field reads from JS are painful otherwise) --- */
EMSCRIPTEN_KEEPALIVE size_t lg2_blame_options_size(void) { return sizeof(git_blame_options); }
EMSCRIPTEN_KEEPALIVE size_t lg2_blame_hunk_size(void) { return sizeof(git_blame_hunk); }
EMSCRIPTEN_KEEPALIVE unsigned int lg2_blame_options_version(void) { return GIT_BLAME_OPTIONS_VERSION; }

EMSCRIPTEN_KEEPALIVE size_t lg2_hunk_lines_in_hunk(const git_blame_hunk *h) { return h->lines_in_hunk; }
EMSCRIPTEN_KEEPALIVE size_t lg2_hunk_final_start_line(const git_blame_hunk *h) { return h->final_start_line_number; }
EMSCRIPTEN_KEEPALIVE size_t lg2_hunk_orig_start_line(const git_blame_hunk *h) { return h->orig_start_line_number; }
EMSCRIPTEN_KEEPALIVE const git_oid *lg2_hunk_final_commit_id(const git_blame_hunk *h) { return &h->final_commit_id; }
EMSCRIPTEN_KEEPALIVE const git_oid *lg2_hunk_orig_commit_id(const git_blame_hunk *h) { return &h->orig_commit_id; }
EMSCRIPTEN_KEEPALIVE const char *lg2_hunk_final_signature_name(const git_blame_hunk *h) {
    return h->final_signature ? h->final_signature->name : NULL;
}
EMSCRIPTEN_KEEPALIVE const char *lg2_hunk_final_signature_email(const git_blame_hunk *h) {
    return h->final_signature ? h->final_signature->email : NULL;
}
EMSCRIPTEN_KEEPALIVE int64_t lg2_hunk_final_signature_when(const git_blame_hunk *h) {
    return h->final_signature ? h->final_signature->when.time : 0;
}

/* --- oid printing --- */
EMSCRIPTEN_KEEPALIVE int lg2_oid_tostr(char *out, size_t n, const git_oid *id) {
    git_oid_tostr(out, n, id);
    return 0;
}

/* --- commit (for getting commit message + author dates not in blame hunks) --- */
EMSCRIPTEN_KEEPALIVE int lg2_commit_lookup(git_commit **out, git_repository *repo, const git_oid *id) {
    return git_commit_lookup(out, repo, id);
}
EMSCRIPTEN_KEEPALIVE void lg2_commit_free(git_commit *commit) {
    git_commit_free(commit);
}
EMSCRIPTEN_KEEPALIVE const char *lg2_commit_summary(git_commit *commit) {
    return git_commit_summary(commit);
}
EMSCRIPTEN_KEEPALIVE const char *lg2_commit_message(git_commit *commit) {
    return git_commit_message(commit);
}
EMSCRIPTEN_KEEPALIVE int64_t lg2_commit_time(git_commit *commit) {
    return git_commit_time(commit);
}

/* --- error reporting --- */
EMSCRIPTEN_KEEPALIVE const char *lg2_error_last(void) {
    const git_error *e = git_error_last();
    return e ? e->message : NULL;
}

#endif
