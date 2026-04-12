import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const pkg = JSON.parse(
	fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
);
const extensionId = `${pkg.publisher}.${pkg.name}`;
const settingsPrefix = pkg.name === "all-the-blame" ? "alltheblame" : "gitblame";

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

	test("opening a tracked file does not throw", async function () {
		this.timeout(30_000);
		const ext = vscode.extensions.getExtension(extensionId);
		await ext?.activate();

		const uri = vscode.Uri.file(
			path.resolve(__dirname, "../../src/extension.ts"),
		);
		const doc = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(doc);

		editor.selection = new vscode.Selection(5, 0, 5, 0);

		// Wait for async blame resolution + status bar render.
		await new Promise((r) => setTimeout(r, 3_000));

		// The extension should still be active — if rendering threw
		// synchronously, activation would be torn down.
		assert.strictEqual(
			ext?.isActive,
			true,
			"Extension should still be active after opening a file",
		);
	});
});
