import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const pkg = JSON.parse(
	fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
);
const extensionId = `${pkg.publisher}.${pkg.name}`;
const settingsPrefix = pkg.name === "all-the-blame" ? "alltheblame" : "gitblame";

type ExtensionApi = {
	getStatusBarText(): string;
	updateView(): Promise<void>;
};

suite("Extension Integration", () => {
	test("extension is registered", () => {
		const ext = vscode.extensions.getExtension(extensionId);
		assert.ok(ext, `Extension ${extensionId} should be registered`);
	});

	test("extension activates without error", async function () {
		this.timeout(20_000);
		const ext = vscode.extensions.getExtension(extensionId);
		assert.ok(ext);
		await ext.activate();
		assert.strictEqual(
			ext.isActive,
			true,
			"Extension should be active after activate()",
		);
	});

	test("all commands are registered", async () => {
		const ext = vscode.extensions.getExtension(extensionId);
		await ext?.activate();

		const commands = await vscode.commands.getCommands(true);
		const expected = [
			`${settingsPrefix}.quickInfo`,
			`${settingsPrefix}.online`,
			`${settingsPrefix}.addCommitHashToClipboard`,
			`${settingsPrefix}.addToolUrlToClipboard`,
			`${settingsPrefix}.gitShow`,
		];
		for (const cmd of expected) {
			assert.ok(
				commands.includes(cmd),
				`Command ${cmd} should be registered`,
			);
		}
	});

	test("status bar renders blame text for a tracked line", async function () {
		this.timeout(30_000);
		const ext = vscode.extensions.getExtension(extensionId);
		assert.ok(ext);
		const api = (await ext.activate()) as ExtensionApi;
		assert.ok(
			typeof api?.getStatusBarText === "function",
			"activate() should return an API with getStatusBarText",
		);

		// src/extension.ts is a real tracked file with plenty of git history.
		const target = path.resolve(__dirname, "../../src/extension.ts");
		const doc = await vscode.workspace.openTextDocument(
			vscode.Uri.file(target),
		);
		const editor = await vscode.window.showTextDocument(doc);
		editor.selection = new vscode.Selection(5, 0, 5, 0);

		await api.updateView();

		// Poll for the status bar text to populate — blame is async (git
		// subprocess + queueing), so it isn't ready immediately.
		const deadline = Date.now() + 15_000;
		let text = api.getStatusBarText();
		while (Date.now() < deadline) {
			text = api.getStatusBarText();
			if (text && text !== "$(git-commit) " && !text.includes("extensions-refresh")) {
				break;
			}
			await new Promise((r) => setTimeout(r, 250));
		}

		assert.ok(
			text.length > 0,
			`Status bar text should not be empty. Got: "${text}"`,
		);
		assert.ok(
			!text.includes("extensions-refresh"),
			`Status bar should have finished blaming (not the activity spinner). Got: "${text}"`,
		);
		// Expect either "Blame <name> (<time ago>)" or "Not Committed Yet".
		// At minimum it should contain something other than just the icon.
		assert.match(
			text,
			/Blame |Not Committed/,
			`Status bar should contain rendered blame text. Got: "${text}"`,
		);
	});
});
