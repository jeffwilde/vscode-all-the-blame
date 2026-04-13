import type { GitBackend } from "./GitBackend.js";

let backendPromise: Promise<GitBackend> | undefined;

/**
 * Returns the singleton GitBackend appropriate for the current host.
 *
 * - local-host / remote-host (Node.js with child_process available):
 *   CliGitBackend that spawns real git
 * - worker-host (browser / web worker, no child_process):
 *   WasmGitBackend that runs libgit2 inside a WebAssembly module
 *
 * Detection is based on whether `child_process` can be require'd. The
 * specific check is wrapped in try/catch so that bundlers which strip
 * unused branches still produce a working build for either target.
 */
export function getGitBackend(): Promise<GitBackend> {
	backendPromise ??= load();
	return backendPromise;
}

async function load(): Promise<GitBackend> {
	if (await isChildProcessAvailable()) {
		const { CliGitBackend } = await import("./CliGitBackend.js");
		return new CliGitBackend();
	}
	const { WasmGitBackend } = await import("./WasmGitBackend.js");
	// In worker-host the wasm-git module is loaded relative to the
	// extension bundle; the path is rewritten by the web-target build.
	// @ts-expect-error -- vendor file, no .d.ts; resolved by esbuild at
	// build time when the web entry is bundled.
	const factory = (await import("../../../vendor/wasm-git/lg2.js")).default;
	return WasmGitBackend.create(factory);
}

async function isChildProcessAvailable(): Promise<boolean> {
	// In a Node.js extension host this resolves; in a web worker the import
	// fails (vscode marks node:* as external in the web target, and the
	// runtime has no node:child_process). Either way the result is cached.
	try {
		await import("node:child_process");
		return true;
	} catch {
		return false;
	}
}

/**
 * Test-only. Resets the cached backend so a fresh one is constructed on
 * the next call. No-op in normal extension execution.
 */
export function resetGitBackendForTests(): void {
	backendPromise = undefined;
}

export type {
	BlameOptions,
	BlameStreamHandle,
	GitBackend,
	GitInfo,
} from "./GitBackend.js";
