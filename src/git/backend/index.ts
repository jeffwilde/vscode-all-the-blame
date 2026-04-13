import type { GitBackend } from "./GitBackend.js";

let backendPromise: Promise<GitBackend> | undefined;

/**
 * Returns the singleton GitBackend appropriate for the current host.
 *
 * Phase 2: always returns the CLI backend. Phase 3 will detect whether
 * `child_process` is available and select the wasm-git backend in
 * worker-host environments.
 */
export function getGitBackend(): Promise<GitBackend> {
	backendPromise ??= load();
	return backendPromise;
}

async function load(): Promise<GitBackend> {
	// Phase-3 will branch here:
	//   if (!hasChildProcess()) return new (await import('./WasmGitBackend.js')).WasmGitBackend();
	const { CliGitBackend } = await import("./CliGitBackend.js");
	return new CliGitBackend();
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
