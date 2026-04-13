import type { Disposable, ExtensionContext } from "vscode";
import type { Extension } from "./extension.js";
import { setvscodeForActiveTextEditor } from "./get-active.js";
import { CoAuthorCache } from "./git/coauthor-cache.js";
import { setupCachedGit } from "./git/command/CachedGit.js";
import { PropertyStore } from "./PropertyStore.js";
import { getvscode } from "./vscode-quarantine.js";

/**
 * @internal Test-only API returned from activate() for integration tests.
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
	await setupCachedGit();
	CoAuthorCache.createInstance(context.workspaceState);

	const commands = getvscode().then((e) => e?.commands);

	let app: Extension | undefined;

	await Promise.all<Disposable | undefined>([
		import("./extension.js").then((i) => {
			app = new i.Extension();
			app.updateView();
			return app;
		}),
		import("./logger.js").then((i) => i.Logger.createInstance()),
		commands.then((e) =>
			e?.registerCommand(
				"alltheblame.quickInfo",
				() => void app?.showMessage(),
			),
		),
		commands.then((e) =>
			e?.registerCommand("alltheblame.online", () => void app?.blameLink()),
		),
		commands.then((e) =>
			e?.registerCommand(
				"alltheblame.addCommitHashToClipboard",
				() => void app?.copyHash(),
			),
		),
		commands.then((e) =>
			e?.registerCommand(
				"alltheblame.addToolUrlToClipboard",
				() => void app?.copyToolUrl(),
			),
		),
		commands.then((e) =>
			e?.registerCommand("alltheblame.gitShow", () => void app?.runGitShow()),
		),
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
