/*
 * Web entry point for All the Blame in worker-host (vscode.dev,
 * github.dev, static-hosted vscode-web).
 *
 * Differences from src/index.ts:
 * - No `gitShow` command — worker-host doesn't have terminals
 * - No file-system-watcher invalidation that depends on node:fs
 * - Backend will be WasmGitBackend, selected by the factory
 *
 * The same Extension class drives status bar / inline rendering — the
 * UI surface is identical between desktop and worker-host. Only the git
 * data source differs.
 */

import type { Disposable, ExtensionContext } from "vscode";
import type { Extension } from "./extension.js";
import { setvscodeForActiveTextEditor } from "./get-active.js";
import { PropertyStore } from "./PropertyStore.js";
import { getvscode } from "./vscode-quarantine.js";

/**
 * @internal Test-only API returned from activate() for integration tests.
 * Identical shape to the desktop entry's ExtensionApi.
 */
export type ExtensionApi = {
	getStatusBarText(): string;
	getInlineDecorationText(): string | undefined;
	updateView(): Promise<void>;
};

export async function activate(
	context: ExtensionContext,
): Promise<ExtensionApi> {
	await PropertyStore.createInstance();
	setvscodeForActiveTextEditor();
	// Note: no setupCachedGit() — that's CliGitBackend-specific. The
	// WasmGitBackend factory handles its own initialization lazily on
	// first getGitBackend() call.

	const commands = getvscode().then((e) => e?.commands);

	let app: Extension | undefined;

	await Promise.all<Disposable | undefined>([
		import("./extension.js").then((i) => {
			app = new i.Extension();
			app.updateView();
			return app;
		}),
		import("./logger.js").then((i) => i.Logger.createInstance()),
		// Commands that work in worker-host:
		commands.then((e) =>
			e?.registerCommand("gitblame.quickInfo", () => void app?.showMessage()),
		),
		commands.then((e) =>
			e?.registerCommand("gitblame.online", () => void app?.blameLink()),
		),
		commands.then((e) =>
			e?.registerCommand(
				"gitblame.addCommitHashToClipboard",
				() => void app?.copyHash(),
			),
		),
		commands.then((e) =>
			e?.registerCommand(
				"gitblame.addToolUrlToClipboard",
				() => void app?.copyToolUrl(),
			),
		),
		// gitblame.gitShow intentionally omitted in worker-host — there's
		// no vscode.window.createTerminal in the browser. The command will
		// simply not appear in the palette when running in worker-host.
	]).then((disposables) =>
		context.subscriptions.push(...disposables.filter((e) => !!e)),
	);

	return {
		getStatusBarText: () => app?.getStatusBarText() ?? "",
		getInlineDecorationText: () => app?.getInlineDecorationText(),
		updateView: async () => {
			await app?.updateView();
		},
	};
}
