import * as assert from "node:assert";
import test, {
	after,
	afterEach,
	before,
	beforeEach,
	mock,
	suite,
} from "node:test";
import { between } from "../../src/ago.js";
import {
	normalizeCommitInfoTokens,
	renderTemplate,
	type TemplateView,
	toInlineTextView,
	toStatusBarTextView,
} from "../../src/string-stuff/text-decorator.js";
import { getExampleCommit } from "../getExampleCommit.js";
import { setupPropertyStore } from "../setupPropertyStore.js";

suite("Date Calculations", async (): Promise<void> => {
	await setupPropertyStore();
	test("Time ago in years", (): void => {
		assert.strictEqual(
			between(new Date(2015, 2), new Date(2014, 1)),
			"1 year ago",
		);
		assert.strictEqual(
			between(new Date(2015, 1), new Date(2005, 1)),
			"10 years ago",
		);
	});

	test("Time ago in months", (): void => {
		assert.strictEqual(
			between(new Date(2015, 1), new Date(2015, 0)),
			"1 month ago",
		);
		assert.strictEqual(
			between(new Date(2015, 11, 10), new Date(2015, 0)),
			"11 months ago",
		);
		assert.strictEqual(
			between(new Date(2015, 1), new Date(2014, 1)),
			"12 months ago",
		);
	});

	test("Time ago in days", (): void => {
		assert.strictEqual(
			between(new Date(2015, 1, 2, 8), new Date(2015, 1, 1, 0)),
			"1 day ago",
		);
		assert.strictEqual(
			between(new Date(2015, 1, 31), new Date(2015, 1, 1)),
			"30 days ago",
		);
	});

	test("Time ago in hours", (): void => {
		assert.strictEqual(
			between(new Date(2015, 1, 1, 1, 5, 0), new Date(2015, 1, 1, 0, 0, 0)),
			"1 hour ago",
		);
		assert.strictEqual(
			between(new Date(2015, 1, 1, 23, 29, 0), new Date(2015, 1, 1, 0, 0, 0)),
			"23 hours ago",
		);
		assert.strictEqual(
			between(new Date(2015, 1, 2), new Date(2015, 1, 1)),
			"24 hours ago",
		);
	});

	test("Time ago in minutes", (): void => {
		assert.strictEqual(
			between(new Date(2015, 1, 1, 1, 5, 0), new Date(2015, 1, 1, 1, 0, 0)),
			"5 minutes ago",
		);
		assert.strictEqual(
			between(new Date(2015, 1, 1, 1, 59, 29), new Date(2015, 1, 1, 1, 0, 0)),
			"59 minutes ago",
		);
		assert.strictEqual(
			between(new Date(2015, 1, 1, 1, 0, 0), new Date(2015, 1, 1, 0, 0, 0)),
			"60 minutes ago",
		);
	});

	test("Right now", (): void => {
		assert.strictEqual(
			between(new Date(2015, 1, 1, 1, 0, 1), new Date(2015, 1, 1, 1, 0, 0)),
			"right now",
		);
	});
});

suite("Mustache Template Rendering", async (): Promise<void> => {
	await setupPropertyStore();
	const view: TemplateView = {
		example: { token: "example-token" },
		mixed: { token: "mIxeD-ToKeN" },
		name: "World",
		upper:
			() =>
			(text: string, render: (text: string) => string): string =>
				render(text).toUpperCase(),
		lower:
			() =>
			(text: string, render: (text: string) => string): string =>
				render(text).toLowerCase(),
	};

	test("No token", (): void => {
		assert.strictEqual(renderTemplate("No token", view), "No token");
	});

	test("Simple replace", (): void => {
		assert.strictEqual(
			renderTemplate("Simple {{example.token}}", view),
			"Simple example-token",
		);
	});

	test("Simple replace at the start of string", (): void => {
		assert.strictEqual(
			renderTemplate("{{example.token}} simple", view),
			"example-token simple",
		);
	});

	test("Simple replace only token", (): void => {
		assert.strictEqual(
			renderTemplate("{{example.token}}", view),
			"example-token",
		);
	});

	test("Uppercase lambda", (): void => {
		assert.strictEqual(
			renderTemplate("Value {{#upper}}{{mixed.token}}{{/upper}}", view),
			"Value MIXED-TOKEN",
		);
	});

	test("Lowercase lambda", (): void => {
		assert.strictEqual(
			renderTemplate("Value {{#lower}}{{mixed.token}}{{/lower}}", view),
			"Value mixed-token",
		);
	});

	test("Token in the middle of string", (): void => {
		assert.strictEqual(
			renderTemplate("Simple {{example.token}} in a longer text", view),
			"Simple example-token in a longer text",
		);
	});

	test("Multiple tokens", (): void => {
		assert.strictEqual(
			renderTemplate("Hello {{name}}, {{example.token}}", view),
			"Hello World, example-token",
		);
	});

	test("Conditional section (truthy)", (): void => {
		assert.strictEqual(
			renderTemplate("{{#name}}Hi {{name}}{{/name}}", view),
			"Hi World",
		);
	});

	test("Conditional section (falsy)", (): void => {
		assert.strictEqual(
			renderTemplate("{{#missing}}nope{{/missing}}fallback", view),
			"fallback",
		);
	});

	test("Inverted section", (): void => {
		assert.strictEqual(
			renderTemplate("{{^missing}}no value{{/missing}}", view),
			"no value",
		);
	});
});

suite("Text Decorator with CommitInfoToken", async (): Promise<void> => {
	mock.timers.enable({
		apis: ["Date"],
		now: 1_621_014_626_000,
	});
	after(() => {
		mock.timers.reset();
	});
	await setupPropertyStore();

	function check(token: string, expect: string) {
		test(`Render "{{${token}}}"`, (): void => {
			const view = normalizeCommitInfoTokens(getExampleCommit().commit);
			assert.strictEqual(renderTemplate(`{{${token}}}`, view), expect);
		});
	}

	check("author.mail", "<vdavydov.dev@gmail.com>");
	check("author.name", "Vladimir Davydov");
	check("author.tz", "-0800");
	check("author.date", "2015-02-12");

	check("committer.mail", "<torvalds@linux-foundation.org>");
	check("committer.name", "Linus Torvalds");
	check("committer.tz", "-0800");
	check("committer.date", "2015-02-13");

	check("commit.summary", "list_lru: introduce per-memcg lists");
	check("commit.hash", "60d3fd32a7a9da4c8c93a9f89cfda22a0b4c65ce");
	check("commit.hash_short", "60d3fd3");

	check("time.ago", "6 years ago");
	check("time.c_ago", "6 years ago");

	test("Uppercase via lambda", (): void => {
		const view = normalizeCommitInfoTokens(getExampleCommit().commit);
		assert.strictEqual(
			renderTemplate("{{#upper}}{{author.name}}{{/upper}}", view),
			"VLADIMIR DAVYDOV",
		);
	});

	test("Lowercase via lambda", (): void => {
		const view = normalizeCommitInfoTokens(getExampleCommit().commit);
		assert.strictEqual(
			renderTemplate("{{#lower}}{{author.name}}{{/lower}}", view),
			"vladimir davydov",
		);
	});

	test("Multiple tokens in one template", () => {
		const view = normalizeCommitInfoTokens(getExampleCommit().commit);
		assert.strictEqual(
			renderTemplate("{{commit.summary}} {{commit.hash_short}}", view),
			"list_lru: introduce per-memcg lists 60d3fd3",
		);
	});
});

suite("Can generate output based on settings", async (): Promise<void> => {
	before(() => {
		mock.timers.enable({
			apis: ["Date"],
			now: 1_621_014_626_000,
		});
	});
	after(() => {
		mock.timers.reset();
	});

	let prop: Awaited<ReturnType<typeof setupPropertyStore>>;
	beforeEach(async () => {
		prop = await setupPropertyStore();
	});
	afterEach(() => prop.clearOverrides());
	test("Default statusBarMessageFormat", (): void => {
		assert.strictEqual(
			toStatusBarTextView(getExampleCommit().commit),
			"Blame Vladimir Davydov (6 years ago)",
		);
	});
	test("Default inlineMessageFormat", (): void => {
		assert.strictEqual(
			toInlineTextView(getExampleCommit().commit),
			"Blame Vladimir Davydov (6 years ago)",
		);
	});

	test("Custom statusBarMessageFormat", (): void => {
		prop.setOverride("statusBarMessageFormat", "Date: {{author.date}}");
		assert.strictEqual(
			toStatusBarTextView(getExampleCommit().commit),
			"Date: 2015-02-12",
		);
	});
	test("Custom inlineMessageFormat", (): void => {
		prop.setOverride("inlineMessageFormat", "Date: {{author.date}}");
		assert.strictEqual(
			toInlineTextView(getExampleCommit().commit),
			"Date: 2015-02-12",
		);
	});
});

suite("Text Sanitizing", async (): Promise<void> => {
	await setupPropertyStore();
	const exampleCommit = getExampleCommit();
	exampleCommit.commit.setByKey(
		"summary",
		"list_lru: \u202eintroduce per-memcg lists",
	);
	const view = normalizeCommitInfoTokens(exampleCommit.commit);
	test("removes right-to-left override characters from text", () => {
		assert.strictEqual(
			renderTemplate("Blame {{author.name}} ({{commit.summary}})", view),
			"Blame Vladimir Davydov (list_lru: introduce per-memcg lists)",
		);
	});
});

suite("Current User Replace", async (): Promise<void> => {
	let prop: Awaited<ReturnType<typeof setupPropertyStore>>;
	beforeEach(async () => {
		prop = await setupPropertyStore();
	});
	afterEach(() => prop.clearOverrides());

	test("replaces author name with alias for current user", async () => {
		prop.setOverride("currentUserAlias", "CURRENT_USER");
		const view = normalizeCommitInfoTokens(
			getExampleCommit("<vdavydov.dev@gmail.com>").commit,
		);

		assert.strictEqual(
			renderTemplate("Blame {{author.name}} ({{commit.summary}})", view),
			"Blame CURRENT_USER (list_lru: introduce per-memcg lists)",
		);
		assert.strictEqual(
			renderTemplate("Blame {{committer.name}} ({{commit.summary}})", view),
			"Blame Linus Torvalds (list_lru: introduce per-memcg lists)",
		);
	});
});
