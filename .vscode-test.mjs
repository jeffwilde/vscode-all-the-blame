import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
	files: "out-test/integration/**/*.test.js",
	workspaceFolder: "out-test/fixture-repo",
	launchArgs: ["--disable-extensions"],
	mocha: {
		ui: "tdd",
		timeout: 30_000,
	},
});
