import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
	files: "out-test/integration/**/*.test.js",
	workspaceFolder: ".",
	launchArgs: ["--disable-extensions"],
	mocha: {
		ui: "tdd",
		timeout: 30_000,
	},
});
