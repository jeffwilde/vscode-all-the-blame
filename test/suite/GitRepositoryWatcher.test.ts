import assert from "node:assert";
import test, { afterEach, beforeEach, type Mock, mock, suite } from "node:test";
import { scheduler } from "node:timers/promises";
import {
	GitRepositoryWatcher,
	type WatcherVscodeApi,
} from "../../src/git/GitRepositoryWatcher.js";
import { Logger, type LoggerPipe } from "../../src/logger.js";

type FakeWatcher = {
	onDidChange: (cb: (uri: unknown) => void) => { dispose: () => void };
	onDidCreate: (cb: (uri: unknown) => void) => { dispose: () => void };
	onDidDelete: (cb: (uri: unknown) => void) => { dispose: () => void };
	dispose: () => void;
	fireChange: (uri: unknown) => void;
	fireCreate: (uri: unknown) => void;
	fireDelete: (uri: unknown) => void;
};

function makeFakeWatcher(): FakeWatcher {
	const change: ((uri: unknown) => void)[] = [];
	const create: ((uri: unknown) => void)[] = [];
	const del: ((uri: unknown) => void)[] = [];
	return {
		onDidChange(cb) {
			change.push(cb);
			return { dispose: () => undefined };
		},
		onDidCreate(cb) {
			create.push(cb);
			return { dispose: () => undefined };
		},
		onDidDelete(cb) {
			del.push(cb);
			return { dispose: () => undefined };
		},
		dispose() {},
		fireChange(uri) {
			for (const l of change) l(uri);
		},
		fireCreate(uri) {
			for (const l of create) l(uri);
		},
		fireDelete(uri) {
			for (const l of del) l(uri);
		},
	};
}

function makeFakeVscodeApi(): {
	api: WatcherVscodeApi;
	created: FakeWatcher[];
} {
	const created: FakeWatcher[] = [];
	const api = {
		workspace: {
			createFileSystemWatcher: () => {
				const w = makeFakeWatcher();
				created.push(w);
				return w as unknown as ReturnType<
					WatcherVscodeApi["workspace"]["createFileSystemWatcher"]
				>;
			},
		},
		RelativePattern: class {
			constructor(
				public base: unknown,
				public pattern: string,
			) {}
		} as unknown as WatcherVscodeApi["RelativePattern"],
		Uri: {
			file: (p: string) =>
				({ scheme: "file", fsPath: p }) as unknown as ReturnType<
					WatcherVscodeApi["Uri"]["file"]
				>,
		},
	} satisfies WatcherVscodeApi;
	return { api, created };
}

suite("GitRepositoryWatcher", () => {
	let loggerPipe: LoggerPipe;

	beforeEach(() => {
		loggerPipe = {
			debug: mock.fn() as (e: string) => void,
		};
		Logger.createInstance(loggerPipe);
	});

	afterEach(() => {
		Logger.getInstance().dispose();
	});

	test("create instance", () => {
		assert.ok(new GitRepositoryWatcher() instanceof GitRepositoryWatcher);
	});

	test("should be able to add repository", async () => {
		const { api } = makeFakeVscodeApi();
		const instance = new GitRepositoryWatcher({
			targets: [{ gitPath: "file", isDirectory: true }],
			vscodeApi: async () => api,
		});

		assert.strictEqual(
			await instance.addRepository("/git/repository/path/.git"),
			"/git/repository/path/.git",
		);

		// Windows drive letter normalization
		assert.strictEqual(
			await instance.addRepository("c:\\git\\repository\\path\\.git"),
			"C:\\git\\repository\\path\\.git",
		);

		assert.strictEqual(
			await instance.addRepository("C:\\git\\repository\\path\\.git"),
			"C:\\git\\repository\\path\\.git",
		);
	});

	test("should call callback on watch event", async () => {
		const { api, created } = makeFakeVscodeApi();
		const instance = new GitRepositoryWatcher({
			targets: [{ gitPath: "file", isDirectory: false }],
			vscodeApi: async () => api,
		});
		const fn = mock.fn();

		instance.onChange(fn);

		await instance.addRepository("/git/repository/path/.git");

		assert.strictEqual(created.length, 1, "expected one watcher to be created");
		created[0].fireChange({ scheme: "file", fsPath: "/x" });

		await scheduler.yield();

		assert.strictEqual(fn.mock.callCount(), 1);
		assert.deepStrictEqual(fn.mock.calls[0].arguments, [
			{
				gitRoot: "/git/repository/path/.git",
				repositoryRoot: "/git/repository/path",
			},
		]);
	});

	test("should create one watcher per target", async () => {
		const { api, created } = makeFakeVscodeApi();
		const instance = new GitRepositoryWatcher({
			targets: [
				{ gitPath: "HEAD", isDirectory: false },
				{ gitPath: "objects", isDirectory: true },
			],
			vscodeApi: async () => api,
		});

		await instance.addRepository("/git/repository/path/.git");

		assert.strictEqual(
			created.length,
			2,
			"one watcher per target should be created",
		);
		assert.ok(
			(loggerPipe.debug as Mock<() => void>).mock.callCount() >= 2,
			"expected at least one debug log per created watcher",
		);
	});

	test("debounces rapid events within 10ms", async () => {
		const { api, created } = makeFakeVscodeApi();
		const instance = new GitRepositoryWatcher({
			targets: [{ gitPath: "HEAD", isDirectory: false }],
			vscodeApi: async () => api,
		});
		const fn = mock.fn();
		instance.onChange(fn);

		await instance.addRepository("/git/repository/path/.git");

		// Fire three events back-to-back (synchronously); only the first
		// should propagate, the others are debounced out.
		created[0].fireChange({});
		created[0].fireCreate({});
		created[0].fireDelete({});

		await scheduler.yield();

		assert.strictEqual(
			fn.mock.callCount(),
			1,
			"only the first of the rapid events should fire",
		);
	});

	test("gracefully no-ops when vscode is unavailable", async () => {
		const instance = new GitRepositoryWatcher({
			targets: [{ gitPath: "HEAD", isDirectory: false }],
			vscodeApi: async () => undefined,
		});
		const fn = mock.fn();
		instance.onChange(fn);

		// Should resolve cleanly even when no vscode API is present.
		await instance.addRepository("/git/repository/path/.git");

		assert.strictEqual(
			fn.mock.callCount(),
			0,
			"no events should fire when vscode is unavailable",
		);
	});
});
