import * as assert from "node:assert";
import test, {
	afterEach,
	beforeEach,
	mock,
	suite,
	type TestContext,
} from "node:test";
import { setupCachedGit } from "../../src/git/command/CachedGit.js";
import { Logger } from "../../src/logger.js";
import {
	type TemplateView,
	renderTemplate,
} from "../../src/string-stuff/text-decorator.js";
import { getExampleCommit } from "../getExampleCommit.js";
import { setupPropertyStore } from "../setupPropertyStore.js";

function nested(view: TemplateView, path: string): unknown {
	const parts = path.split(".");
	let current: unknown = view;
	for (const part of parts) {
		if (current == null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

async function setupMocks(
	t: TestContext,
	executeMock: typeof baseExecuteMock,
): Promise<ReturnType<typeof setupPropertyStore>> {
	t.mock.module("../../src/git/command/execute.js", {
		namedExports: {
			execute: async (_: Promise<string>, args: string[]): Promise<string> =>
				executeMock[args.join(" ") as keyof typeof executeMock] ?? "",
		},
	});
	await setupCachedGit();
	return await setupPropertyStore();
}

const baseExecuteMock = {
	"config branch.main.remote": "origin",
	"config remote.origin.url": "https://github.com/Sertion/vscode-gitblame.git",
	"ls-files --full-name -- /fake.file": "/fake.file",
	"ls-remote --get-url origin":
		"https://github.com/Sertion/vscode-gitblame.git",
	"rev-parse --abbrev-ref origin/HEAD": "origin/main",
	"rev-parse --absolute-git-dir": "/a/path/.git/",
	"symbolic-ref -q --short HEAD": "main",
};

suite("Generate URL Tokens", () => {
	Logger.createInstance();
	const exampleCommit = getExampleCommit();
	beforeEach(async (): Promise<void> => {
		mock.module("../../src/get-active.js", {
			namedExports: {
				getActiveTextEditor: () => ({
					document: {
						isUntitled: false,
						fileName: "/fake.file",
						uri: {
							scheme: "file",
						},
						lineCount: 1024,
					},
					selection: {
						active: {
							line: 1,
						},
					},
				}),
			},
		});
	});
	afterEach(() => {
		import("../../src/git/command/CachedGit.js").then((e) => e.git.clear());
		mock.restoreAll();
	});

	test("http:// origin", async (t) => {
		const propertyStore = await setupMocks(t, baseExecuteMock);
		propertyStore.setOverride("remoteName", "origin");

		const tokens = await (
			await import("../../src/git/get-tool-url.js")
		).generateUrlTokens(exampleCommit);

		propertyStore.clearOverrides();

		assert.ok(tokens);

		assert.strictEqual(nested(tokens, "gitorigin.hostname.full"), "github.com");
		assert.strictEqual(nested(tokens, "gitorigin.hostname.0"), "github");
		assert.strictEqual(nested(tokens, "gitorigin.hostname.1"), "com");
		assert.strictEqual(
			nested(tokens, "gitorigin.path.full"),
			"/Sertion/vscode-gitblame",
		);
		assert.strictEqual(nested(tokens, "gitorigin.path.0"), "Sertion");
		assert.strictEqual(nested(tokens, "gitorigin.path.1"), "vscode-gitblame");
		assert.strictEqual(
			tokens.hash,
			"60d3fd32a7a9da4c8c93a9f89cfda22a0b4c65ce",
		);
		assert.strictEqual(nested(tokens, "project.name"), "vscode-gitblame");
		assert.strictEqual(
			nested(tokens, "project.remote"),
			"github.com/Sertion/vscode-gitblame",
		);
		assert.strictEqual(nested(tokens, "file.path"), "/fake.file");
	});

	test("git@ origin", async (t) => {
		const prop = await setupMocks(t, {
			...baseExecuteMock,
			"config remote.origin.url": "git@github.com:Sertion/vscode-gitblame.git",
			"ls-remote --get-url origin":
				"git@github.com:Sertion/vscode-gitblame.git",
		});
		prop.setOverride("remoteName", "origin");

		const tokens = await (
			await import("../../src/git/get-tool-url.js")
		).generateUrlTokens(exampleCommit);

		prop.clearOverrides();

		assert.ok(tokens);

		assert.strictEqual(nested(tokens, "gitorigin.hostname.full"), "github.com");
		assert.strictEqual(nested(tokens, "gitorigin.hostname.0"), "github");
		assert.strictEqual(nested(tokens, "gitorigin.hostname.1"), "com");
		assert.strictEqual(
			nested(tokens, "gitorigin.path.full"),
			"/Sertion/vscode-gitblame",
		);
		assert.strictEqual(nested(tokens, "gitorigin.path.0"), "Sertion");
		assert.strictEqual(nested(tokens, "gitorigin.path.1"), "vscode-gitblame");
		assert.strictEqual(
			tokens.hash,
			"60d3fd32a7a9da4c8c93a9f89cfda22a0b4c65ce",
		);
		assert.strictEqual(nested(tokens, "project.name"), "vscode-gitblame");
		assert.strictEqual(
			nested(tokens, "project.remote"),
			"github.com/Sertion/vscode-gitblame",
		);
		assert.strictEqual(nested(tokens, "file.path"), "/fake.file");
	});

	test("ssh://git@ origin", async (t) => {
		const prop = await setupMocks(t, {
			...baseExecuteMock,
			"config remote.origin.url":
				"ssh://git@github.com/Sertion/vscode-gitblame.git",
			"ls-remote --get-url origin":
				"ssh://git@github.com/Sertion/vscode-gitblame.git",
		});
		prop.setOverride("remoteName", "origin");

		const tokens = await (
			await import("../../src/git/get-tool-url.js")
		).generateUrlTokens(exampleCommit);

		prop.clearOverrides();

		assert.ok(tokens);

		assert.strictEqual(nested(tokens, "gitorigin.hostname.full"), "github.com");
		assert.strictEqual(nested(tokens, "gitorigin.hostname.0"), "github");
		assert.strictEqual(nested(tokens, "gitorigin.hostname.1"), "com");
		assert.strictEqual(
			nested(tokens, "gitorigin.path.full"),
			"/Sertion/vscode-gitblame",
		);
		assert.strictEqual(nested(tokens, "gitorigin.path.0"), "Sertion");
		assert.strictEqual(nested(tokens, "gitorigin.path.1"), "vscode-gitblame");
		assert.strictEqual(
			tokens.hash,
			"60d3fd32a7a9da4c8c93a9f89cfda22a0b4c65ce",
		);
		assert.strictEqual(nested(tokens, "project.name"), "vscode-gitblame");
		assert.strictEqual(
			nested(tokens, "project.remote"),
			"github.com/Sertion/vscode-gitblame",
		);
		assert.strictEqual(nested(tokens, "file.path"), "/fake.file");
		assert.strictEqual(nested(tokens, "file.line"), "100");
	});

	test("ssh://git@git.company.com/project_x/test-repository.git origin", async (t) => {
		const prop = await setupMocks(t, {
			...baseExecuteMock,
			"config remote.origin.url":
				"ssh://git@git.company.com/project_x/test-repository.git",
			"ls-remote --get-url origin":
				"ssh://git@git.company.com/project_x/test-repository.git",
		});
		prop.setOverride("remoteName", "origin");

		const tokens = await (
			await import("../../src/git/get-tool-url.js")
		).generateUrlTokens(exampleCommit);

		prop.clearOverrides();

		assert.ok(tokens);

		assert.strictEqual(
			nested(tokens, "gitorigin.hostname.full"),
			"git.company.com",
		);
		assert.strictEqual(nested(tokens, "gitorigin.hostname.0"), "git");
		assert.strictEqual(nested(tokens, "gitorigin.hostname.1"), "company");
		assert.strictEqual(nested(tokens, "gitorigin.hostname.2"), "com");
		assert.strictEqual(
			nested(tokens, "gitorigin.path.full"),
			"/project_x/test-repository",
		);
		assert.strictEqual(nested(tokens, "gitorigin.path.0"), "project_x");
		assert.strictEqual(nested(tokens, "gitorigin.path.1"), "test-repository");
		assert.strictEqual(
			tokens.hash,
			"60d3fd32a7a9da4c8c93a9f89cfda22a0b4c65ce",
		);
		assert.strictEqual(nested(tokens, "project.name"), "test-repository");
		assert.strictEqual(
			nested(tokens, "project.remote"),
			"git.company.com/project_x/test-repository",
		);
		assert.strictEqual(nested(tokens, "file.path"), "/fake.file");
		assert.strictEqual(nested(tokens, "file.line"), "100");
	});

	test("local development (#128 regression)", async (t) => {
		const prop = await setupMocks(t, {
			...baseExecuteMock,
			"config branch.main.remote": "",
			"config remote.origin.url": "",
			"ls-remote --get-url origin": "origin",
		});
		prop.setOverride("remoteName", "origin");

		const tokens = await (
			await import("../../src/git/get-tool-url.js")
		).generateUrlTokens(exampleCommit);

		prop.clearOverrides();

		assert.strictEqual(tokens, undefined);
	});
});

suite("Use generated URL tokens", () => {
	const exampleCommit = getExampleCommit();
	afterEach(() => {
		import("../../src/git/command/CachedGit.js").then((e) => e.git.clear());
	});
	test("Default value", async (t) => {
		const prop = await setupMocks(t, {
			...baseExecuteMock,
			"config remote.origin.url":
				"ssh://git@git.company.com/project_x/test-repository.git",
			"ls-remote --get-url origin":
				"ssh://git@git.company.com/project_x/test-repository.git",
		});
		prop.setOverride("remoteName", "origin");

		const tokens = await (
			await import("../../src/git/get-tool-url.js")
		).generateUrlTokens(exampleCommit);

		prop.clearOverrides();

		assert.ok(tokens);

		assert.strictEqual(
			renderTemplate(
				"{{tool.protocol}}//{{gitorigin.hostname.full}}{{gitorigin.port}}{{gitorigin.path.full}}{{tool.commitpath}}{{hash}}",
				tokens,
			),
			"https://git.company.com/project_x/test-repository/commit/60d3fd32a7a9da4c8c93a9f89cfda22a0b4c65ce",
		);
	});

	test("Url with port (#188 regression)", async (t) => {
		const prop = await setupMocks(t, {
			...baseExecuteMock,
			"config remote.origin.url":
				"http://git.company.com:8080/project_x/test-repository.git",
			"ls-remote --get-url origin":
				"http://git.company.com:8080/project_x/test-repository.git",
		});
		prop.setOverride("remoteName", "origin");

		const tokens = await (
			await import("../../src/git/get-tool-url.js")
		).generateUrlTokens(exampleCommit);

		prop.clearOverrides();

		assert.ok(tokens);

		assert.strictEqual(
			renderTemplate(
				"{{tool.protocol}}//{{gitorigin.hostname.full}}{{gitorigin.port}}{{gitorigin.path.full}}{{tool.commitpath}}{{hash}}",
				tokens,
			),
			"http://git.company.com:8080/project_x/test-repository/commit/60d3fd32a7a9da4c8c93a9f89cfda22a0b4c65ce",
		);
	});
});
