/**
 * Pluggable backend for git operations the extension needs.
 *
 * The CLI implementation (CliGitBackend) spawns real git as a subprocess
 * and works on local-host and remote-host. The wasm-git implementation
 * (Phase 3) runs libgit2 in-browser against the active FileSystemProvider
 * and works on worker-host.
 *
 * The factory in ./index.ts picks an implementation at runtime.
 */

export type BlameOptions = {
	ignoreWhitespace: boolean;
	revsFile: string | undefined;
	detectMoveOrCopyFromOtherFiles: 0 | 1 | 2 | 3;
};

/**
 * Streaming blame output. Mirrors the shape of a Node child process so the
 * existing parser in src/git/stream-parsing.ts can consume it unchanged.
 * The wasm-git backend will adapt its iterator output into this shape.
 */
export type BlameStreamHandle = {
	stdout: AsyncIterable<Buffer | string>;
	stderr: AsyncIterable<Buffer | string>;
	kill(): void;
};

export type GitInfo = {
	remoteUrl: string;
	currentBranch: string;
	defaultBranch: string;
	currentHash: string;
	relativePathOfActiveFile: string;
	fileOrigin: string;
};

export interface GitBackend {
	/**
	 * Find the absolute path to the `.git` folder for `filePath`. Returns
	 * undefined when the file is not in a git repository.
	 */
	getRepositoryFolder(filePath: string): Promise<string | undefined>;

	/**
	 * Returns the user's git email (`user.email` config) for the repo
	 * containing `filePath`. Used to mark "current user" in blame output.
	 */
	getUserEmail(filePath: string): Promise<string | undefined>;

	/**
	 * Returns the absolute path of the configured revs-file for `filePath`,
	 * if one is set in `gitblame.revsFile` and accessible. Otherwise undefined.
	 *
	 * CLI-specific concept (the `-S <revsFile>` flag to `git blame`).
	 */
	findRevsFile(filePath: string): Promise<string | undefined>;

	/**
	 * Stream blame output for `filePath`. The stream emits lines in the
	 * `git blame --incremental` porcelain format, which the existing parser
	 * in src/git/stream-parsing.ts consumes line-by-line.
	 */
	blame(filePath: string, options: BlameOptions): Promise<BlameStreamHandle>;

	/**
	 * Returns the bag of git information used to render commit / tool URLs.
	 * Reads from the currently active text editor.
	 */
	getGeneralGitInfo(fallbackRemote: string): Promise<GitInfo | undefined>;
}
