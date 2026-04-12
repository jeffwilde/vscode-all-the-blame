import * as assert from "node:assert";
import test, { afterEach, before, suite } from "node:test";
import type { git as gitType } from "../../src/git/command/CachedGit.js";
import type { gitRemotePathView as gitRemotePathViewType } from "../../src/git/get-tool-url.js";
import { Logger } from "../../src/logger.js";

suite("Get tool URL: gitRemotePathView", (): void => {
	Logger.createInstance();
	let git: typeof gitType;
	let gitRemotePathView: typeof gitRemotePathViewType;
	before(async () => {
		git = (await import("../../src/git/command/CachedGit.js")).git;
		gitRemotePathView = (await import("../../src/git/get-tool-url.js"))
			.gitRemotePathView;
	});
	afterEach(() => git.clear());

	test("http://", (): void => {
		const view = gitRemotePathView("http://example.com/path/to/something/");

		assert.strictEqual(view.full, "/path/to/something/");
		assert.strictEqual(view["0"], "path");
		assert.strictEqual(view["1"], "to");
		assert.strictEqual(view["2"], "something");
	});
	test("https://", (): void => {
		const view = gitRemotePathView("https://example.com/path/to/something/");

		assert.strictEqual(view.full, "/path/to/something/");
		assert.strictEqual(view["0"], "path");
		assert.strictEqual(view["1"], "to");
		assert.strictEqual(view["2"], "something");
	});
	test("ssh://", (): void => {
		const view = gitRemotePathView("ssh://example.com/path/to/something/");

		assert.strictEqual(view.full, "/path/to/something/");
		assert.strictEqual(view["0"], "path");
		assert.strictEqual(view["1"], "to");
		assert.strictEqual(view["2"], "something");
	});
	test("git@", (): void => {
		const view = gitRemotePathView("git@example.com:path/to/something/");

		assert.strictEqual(view.full, "/path/to/something/");
		assert.strictEqual(view["0"], "path");
		assert.strictEqual(view["1"], "to");
		assert.strictEqual(view["2"], "something");
	});
	test("org-1234@", (): void => {
		const view = gitRemotePathView("org-1234@example.com:path/to/something/");

		assert.strictEqual(view.full, "/path/to/something/");
		assert.strictEqual(view["0"], "path");
		assert.strictEqual(view["1"], "to");
		assert.strictEqual(view["2"], "something");
	});
	test("http:// with port", (): void => {
		const view = gitRemotePathView(
			"http://example.com:8080/path/to/something/",
		);

		assert.strictEqual(view.full, "/path/to/something/");
		assert.strictEqual(view["0"], "path");
		assert.strictEqual(view["1"], "to");
		assert.strictEqual(view["2"], "something");
	});
	test("https:// with port", (): void => {
		const view = gitRemotePathView(
			"https://example.com:8080/path/to/something/",
		);

		assert.strictEqual(view.full, "/path/to/something/");
		assert.strictEqual(view["0"], "path");
		assert.strictEqual(view["1"], "to");
		assert.strictEqual(view["2"], "something");
	});
	test("ssh:// with port", (): void => {
		const view = gitRemotePathView("ssh://example.com:8080/path/to/something/");

		assert.strictEqual(view.full, "/path/to/something/");
		assert.strictEqual(view["0"], "path");
		assert.strictEqual(view["1"], "to");
		assert.strictEqual(view["2"], "something");
	});

	test("Empty input", (): void => {
		const view = gitRemotePathView("");

		assert.strictEqual(view.full, "no-remote-url");
	});
	test("Weird input", (): void => {
		const view = gitRemotePathView("weird input");

		assert.strictEqual(view.full, "no-remote-url");
	});
	test("Out of bounds input", (): void => {
		const view = gitRemotePathView("https://part/");

		assert.strictEqual(view[Number.MAX_SAFE_INTEGER.toString()], undefined);
	});
});
