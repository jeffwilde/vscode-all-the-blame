/*
 * WasmGitBackend — implements GitBackend by calling libgit2 inside a
 * WebAssembly module (the forked wasm-git build with our blame_exports.c +
 * blame_stream.c). Selected by the factory when child_process is unavailable
 * (i.e. worker-host).
 *
 * The WASM runs synchronously per-call. Higher-level streaming responsiveness
 * comes from running this whole backend inside a Web Worker — which the
 * factory does — so blame compute doesn't block the UI thread.
 */

import type {
	BlameOptions,
	BlameStreamHandle,
	GitBackend,
	GitInfo,
} from "./GitBackend.js";

/** Shape of the wasm-git module after instantiation. */
type LgModule = {
	cwrap: (
		name: string,
		ret: string | null,
		args: readonly string[],
	) => (...a: unknown[]) => unknown;
	addFunction: (fn: (...a: unknown[]) => unknown, sig: string) => number;
	removeFunction?: (ptr: number) => void;
	UTF8ToString: (ptr: number) => string;
	HEAPU8: Uint8Array;
	HEAPU32: Uint32Array;
	_malloc: (size: number) => number;
	_free: (ptr: number) => void;
	FS: {
		mkdir: (path: string) => void;
		writeFile: (path: string, data: Uint8Array | string) => void;
		analyzePath: (path: string) => { exists: boolean };
	};
};

type LgFactory = (opts?: Record<string, unknown>) => Promise<LgModule>;

/** Wrap-once handle to libgit2 functions exposed by blame_exports.c + blame_stream.c. */
class LibgitBindings {
	readonly _libgit2_init: () => number;
	readonly _repository_open: (outPP: number, path: string) => number;
	readonly _repository_free: (repo: number) => void;
	readonly _blame_stream: (
		repo: number,
		path: string,
		startOidPtr: number,
		callbackPtr: number,
		userData: number,
	) => number;
	readonly _error_last: () => string | null;

	constructor(public readonly lg: LgModule) {
		this._libgit2_init = lg.cwrap(
			"lg2_libgit2_init",
			"number",
			[],
		) as () => number;
		this._repository_open = lg.cwrap("lg2_repository_open", "number", [
			"number",
			"string",
		]) as (a: number, b: string) => number;
		this._repository_free = lg.cwrap("lg2_repository_free", null, [
			"number",
		]) as (a: number) => void;
		this._blame_stream = lg.cwrap("lg2_blame_stream", "number", [
			"number",
			"string",
			"number",
			"number",
			"number",
		]) as (a: number, b: string, c: number, d: number, e: number) => number;
		this._error_last = lg.cwrap("lg2_error_last", "string", []) as () =>
			| string
			| null;
	}

	openRepo(path: string): number {
		const pp = this.lg._malloc(4);
		try {
			const rc = this._repository_open(pp, path);
			if (rc !== 0) {
				const msg = this._error_last() ?? `git_repository_open failed (${rc})`;
				throw new Error(`WasmGitBackend: ${msg}`);
			}
			return this.lg.HEAPU32[pp >> 2];
		} finally {
			this.lg._free(pp);
		}
	}

	/** Allocate a 20-byte buffer holding the given hex-string OID. */
	allocOid(hexOid: string): number {
		const ptr = this.lg._malloc(20);
		for (let i = 0; i < 20; i++) {
			this.lg.HEAPU8[ptr + i] = Number.parseInt(hexOid.substr(i * 2, 2), 16);
		}
		return ptr;
	}

	/** Read a 20-byte OID at `ptr` as a hex string. */
	readOid(ptr: number): string {
		if (!ptr) return "";
		let out = "";
		for (let i = 0; i < 20; i++) {
			out += this.lg.HEAPU8[ptr + i].toString(16).padStart(2, "0");
		}
		return out;
	}
}

export type StreamingBlameEvent =
	| {
			kind: "hunk";
			line: number;
			lines: number;
			oid: string;
			author: string;
			email: string;
			when: number; // unix seconds
			summary: string;
			origLine: number;
			origOid: string;
	  }
	| {
			kind: "commit";
			oid: string;
			author: string;
			email: string;
			when: number;
			summary: string;
			commitsWalked: number;
			linesRemaining: number;
	  }
	| { kind: "done"; commitsWalked: number; linesRemaining: number };

export type StreamingBlameCallback = (e: StreamingBlameEvent) => boolean | void;

/**
 * The actual backend.
 *
 * Construction is async because we need to fetch + instantiate the WASM
 * module. Use {@link create} rather than `new`.
 */
export class WasmGitBackend implements GitBackend {
	private readonly bindings: LibgitBindings;
	/** Map from repository path (e.g. "/work") → libgit2 repo pointer. */
	private readonly repoCache = new Map<string, number>();

	private constructor(lg: LgModule) {
		this.bindings = new LibgitBindings(lg);
		const rc = this.bindings._libgit2_init();
		if (rc < 1) {
			throw new Error(`git_libgit2_init returned ${rc}`);
		}
	}

	/** Construct the backend. `factory` is the wasm-git module's default export. */
	static async create(factory: LgFactory): Promise<WasmGitBackend> {
		const lg = await factory();
		return new WasmGitBackend(lg);
	}

	/**
	 * Find the repo for `filePath`. Walks up directories looking for a `.git`
	 * folder or `gitdir` pointer file. Returns the absolute path to the
	 * `.git` directory (or undefined if not found).
	 *
	 * In worker-host the filesystem is the WASM MEMFS (or our seeded
	 * IndexedDB-backed FileSystemProvider). On desktop we'd use CliGitBackend
	 * instead, so this is only ever called against a virtual FS.
	 */
	async getRepositoryFolder(filePath: string): Promise<string | undefined> {
		// Walk up looking for a ".git" entry. Pure string ops, no FS calls
		// to vscode.workspace.fs — that bridge happens via the future custom
		// git_odb_backend (Phase 6.0).
		let dir = filePath.replace(/\/[^/]*$/, "") || "/";
		while (dir && dir !== "/") {
			const candidate = `${dir}/.git`;
			if (this.bindings.lg.FS.analyzePath(candidate).exists) {
				return candidate;
			}
			const next = dir.replace(/\/[^/]*$/, "") || "/";
			if (next === dir) break;
			dir = next;
		}
		// One last try at the root
		if (this.bindings.lg.FS.analyzePath("/.git").exists) return "/.git";
		return undefined;
	}

	/**
	 * Stream blame events for `filePath`. The callback fires per commit
	 * processed and per line attributed; return non-zero / true from the
	 * callback to abort early.
	 *
	 * `gitDir` is the absolute path to the `.git` directory inside the
	 * WASM filesystem (the value returned by `getRepositoryFolder`).
	 * `headOid` is the hex OID to start the walk from (typically HEAD's
	 * commit OID, which the caller can resolve via `git_reference_name_to_id`
	 * or by reading `.git/HEAD` + refs).
	 */
	streamBlame(
		gitDir: string,
		filePath: string,
		headOid: string,
		callback: StreamingBlameCallback,
	): number {
		// Repo path is the parent of .git
		const repoPath = gitDir.replace(/\/\.git\/?$/, "") || "/";
		let repo = this.repoCache.get(repoPath);
		if (!repo) {
			repo = this.bindings.openRepo(repoPath);
			this.repoCache.set(repoPath, repo);
		}

		// File path passed to libgit2 is relative to repo root
		const relPath = filePath.startsWith(`${repoPath}/`)
			? filePath.slice(repoPath.length + 1)
			: filePath;

		const oidPtr = this.bindings.allocOid(headOid);
		try {
			let aborted = false;
			const cbPtr = this.bindings.lg.addFunction(
				(
					kind: number,
					oidPP: number,
					ls: number,
					lc: number,
					namePtr: number,
					emailPtr: number,
					when: bigint,
					summaryPtr: number,
					origLine: number,
					origOidPP: number,
					_userData: number,
				) => {
					const evtCommon = {
						oid: this.bindings.readOid(oidPP),
						author: namePtr ? this.bindings.lg.UTF8ToString(namePtr) : "",
						email: emailPtr ? this.bindings.lg.UTF8ToString(emailPtr) : "",
						when: Number(when),
						summary: summaryPtr
							? this.bindings.lg.UTF8ToString(summaryPtr)
							: "",
					};
					let evt: StreamingBlameEvent;
					if (kind === 0) {
						evt = {
							kind: "hunk",
							line: ls,
							lines: lc,
							...evtCommon,
							origLine,
							origOid: this.bindings.readOid(origOidPP),
						};
					} else if (kind === 1) {
						evt = {
							kind: "commit",
							...evtCommon,
							commitsWalked: ls,
							linesRemaining: lc,
						};
					} else {
						evt = {
							kind: "done",
							commitsWalked: ls,
							linesRemaining: lc,
						};
					}
					const stop = callback(evt);
					if (stop === true) aborted = true;
					return aborted ? 1 : 0;
				},
				// Emscripten signature letters:
				//   ret=i kind=i oid=i ls=i lc=i name=i email=i when=j
				//   summary=i origLine=i origOid=i userData=i  → 12 chars
				"iiiiiiijiiii",
			);
			try {
				const rc = this.bindings._blame_stream(repo, relPath, oidPtr, cbPtr, 0);
				if (rc !== 0 && !aborted) {
					throw new Error(
						`lg2_blame_stream returned ${rc}: ${this.bindings._error_last() ?? "(no error)"}`,
					);
				}
				return rc;
			} finally {
				this.bindings.lg.removeFunction?.(cbPtr);
			}
		} finally {
			this.bindings.lg._free(oidPtr);
		}
	}

	// --- GitBackend interface (legacy/CLI-shaped methods that don't
	//     map cleanly to streaming yet — these will be implemented
	//     properly in Phase 6.0 along with the buffer serializer + custom
	//     git_odb_backend bridge to vscode.workspace.fs).

	async getUserEmail(_filePath: string): Promise<string | undefined> {
		// libgit2 doesn't have a direct equivalent; would need to read
		// .git/config or parse repo config. Phase 6.0 follow-up.
		return undefined;
	}

	async findRevsFile(_filePath: string): Promise<string | undefined> {
		// Wired in Phase 6.1 when we add -S / --ignore-revs-file support.
		return undefined;
	}

	async blame(
		_filePath: string,
		_options: BlameOptions,
	): Promise<BlameStreamHandle> {
		// The CLI backend's blame returns a porcelain-format stream that the
		// existing parser consumes. WasmGitBackend bypasses the parser and
		// produces structured events directly via streamBlame(). The Blamer
		// class will be taught about both shapes in Phase 6.0.
		throw new Error(
			"WasmGitBackend.blame() is not the right entry point — use streamBlame() and parse events directly. Wired in Phase 6.0.",
		);
	}

	async getGeneralGitInfo(
		_fallbackRemote: string,
	): Promise<GitInfo | undefined> {
		// Will read from libgit2 repo config in Phase 6.0.
		return undefined;
	}
}
