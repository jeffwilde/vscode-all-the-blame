import * as assert from "node:assert";
import test, { suite } from "node:test";
import { isBotAuthor, parseCoAuthors } from "../../src/git/coauthor.js";
import { CoAuthorCache } from "../../src/git/coauthor-cache.js";

suite("Bot Author Detection", (): void => {
	test("Detects GitHub bot suffix", (): void => {
		assert.strictEqual(isBotAuthor("devin-ai-integration[bot]"), true);
		assert.strictEqual(isBotAuthor("dependabot[bot]"), true);
		assert.strictEqual(isBotAuthor("renovate[bot]"), true);
		assert.strictEqual(isBotAuthor("copilot-swe-agent[bot]"), true);
	});

	test("Case insensitive", (): void => {
		assert.strictEqual(isBotAuthor("SomeBot[BOT]"), true);
		assert.strictEqual(isBotAuthor("SomeBot[Bot]"), true);
	});

	test("Does not match human authors", (): void => {
		assert.strictEqual(isBotAuthor("Vladimir Davydov"), false);
		assert.strictEqual(isBotAuthor("nick-fields"), false);
		assert.strictEqual(isBotAuthor("bot-lover"), false);
		assert.strictEqual(isBotAuthor(""), false);
	});
});

suite("Co-Author Parsing", (): void => {
	test("Parses single co-author", (): void => {
		const message = [
			"refactor: migrate auto-placement to shared Cloud Run component",
			"",
			"Co-authored-by: nick-fields <nick@flux.ai>",
		].join("\n");

		const coAuthors = parseCoAuthors(message);
		assert.strictEqual(coAuthors.length, 1);
		assert.strictEqual(coAuthors[0].name, "nick-fields");
		assert.strictEqual(coAuthors[0].mail, "<nick@flux.ai>");
	});

	test("Parses multiple co-authors", (): void => {
		const message = [
			"feat: add new feature",
			"",
			"Co-authored-by: Alice Smith <alice@example.com>",
			"Co-authored-by: Bob Jones <bob@example.com>",
		].join("\n");

		const coAuthors = parseCoAuthors(message);
		assert.strictEqual(coAuthors.length, 2);
		assert.strictEqual(coAuthors[0].name, "Alice Smith");
		assert.strictEqual(coAuthors[0].mail, "<alice@example.com>");
		assert.strictEqual(coAuthors[1].name, "Bob Jones");
		assert.strictEqual(coAuthors[1].mail, "<bob@example.com>");
	});

	test("Handles extra whitespace", (): void => {
		const message = "msg\n\nCo-authored-by:   Jane Doe   <jane@example.com>";

		const coAuthors = parseCoAuthors(message);
		assert.strictEqual(coAuthors.length, 1);
		assert.strictEqual(coAuthors[0].name, "Jane Doe");
		assert.strictEqual(coAuthors[0].mail, "<jane@example.com>");
	});

	test("Returns empty array when no co-authors", (): void => {
		const message = "fix: simple bug fix\n\nSigned-off-by: Dev <dev@co.com>";

		const coAuthors = parseCoAuthors(message);
		assert.strictEqual(coAuthors.length, 0);
	});

	test("Case insensitive trailer key", (): void => {
		const message = "msg\n\nco-authored-by: Low Case <low@case.com>";

		const coAuthors = parseCoAuthors(message);
		assert.strictEqual(coAuthors.length, 1);
		assert.strictEqual(coAuthors[0].name, "Low Case");
	});

	test("Handles realistic bot commit message", (): void => {
		const message = [
			"refactor: migrate auto-placement to shared Cloud Run component + add shared Job component (#23352)",
			"",
			"* refactor: migrate auto-placement to shared Cloud Run component",
			"",
			"* fix: add maxInstanceCountNonProd to preserve non-prod scaling cap",
			"",
			"* feat: add shared createCloudRunJob() component and use in auto-placement",
			"",
			"---------",
			"",
			"Co-authored-by: nick-fields <nick@flux.ai>",
		].join("\n");

		const coAuthors = parseCoAuthors(message);
		assert.strictEqual(coAuthors.length, 1);
		assert.strictEqual(coAuthors[0].name, "nick-fields");
		assert.strictEqual(coAuthors[0].mail, "<nick@flux.ai>");
	});
});

suite("CoAuthorCache", (): void => {
	function createMockMemento() {
		const store: Record<string, unknown> = {};
		return {
			get<T>(key: string, defaultValue?: T): T {
				return (store[key] as T) ?? (defaultValue as T);
			},
			async update(key: string, value: unknown): Promise<void> {
				store[key] = value;
			},
			keys(): readonly string[] {
				return Object.keys(store);
			},
		};
	}

	test("Returns undefined for unknown hash", (): void => {
		const cache = CoAuthorCache.createInstance(createMockMemento());
		assert.strictEqual(cache.has("abc123"), false);
		assert.strictEqual(cache.get("abc123"), undefined);
	});

	test("Stores and retrieves co-author", (): void => {
		const cache = CoAuthorCache.createInstance(createMockMemento());
		cache.set("abc123", { name: "Alice", mail: "<alice@co.com>" });
		assert.strictEqual(cache.has("abc123"), true);
		assert.deepStrictEqual(cache.get("abc123"), {
			name: "Alice",
			mail: "<alice@co.com>",
		});
	});

	test("Stores null for commits with no co-author", (): void => {
		const cache = CoAuthorCache.createInstance(createMockMemento());
		cache.setNone("def456");
		assert.strictEqual(cache.has("def456"), true);
		assert.strictEqual(cache.get("def456"), null);
	});

	test("Flushes to memento storage", async (): Promise<void> => {
		const memento = createMockMemento();
		const cache = CoAuthorCache.createInstance(memento);
		cache.set("abc123", { name: "Alice", mail: "<alice@co.com>" });
		await cache.flush();

		const stored = memento.get<Record<string, unknown>>("coAuthorIndex", {});
		assert.deepStrictEqual(stored["abc123"], {
			name: "Alice",
			mail: "<alice@co.com>",
		});
	});

	test("Loads from existing memento data", (): void => {
		const memento = createMockMemento();
		memento.update("coAuthorIndex", {
			existing: { name: "Bob", mail: "<bob@co.com>" },
		});

		const cache = CoAuthorCache.createInstance(memento);
		assert.strictEqual(cache.has("existing"), true);
		assert.deepStrictEqual(cache.get("existing"), {
			name: "Bob",
			mail: "<bob@co.com>",
		});
	});
});
