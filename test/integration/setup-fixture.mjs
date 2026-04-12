// Sets up an isolated git repository at out-test/fixture-repo with known
// authors, dates, and content. Integration tests run with this directory
// as the VS Code workspace, so blame assertions are deterministic regardless
// of the surrounding repo's history.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const FIXTURE = join(ROOT, "out-test", "fixture-repo");

function sh(cmd, env = {}) {
	execSync(cmd, {
		cwd: FIXTURE,
		stdio: "ignore",
		env: { ...process.env, ...env },
	});
}

function commit(opts) {
	sh("git add -A");
	sh(`git commit -q -m "${opts.message}"`, {
		GIT_AUTHOR_NAME: opts.author.name,
		GIT_AUTHOR_EMAIL: opts.author.email,
		GIT_COMMITTER_NAME: opts.author.name,
		GIT_COMMITTER_EMAIL: opts.author.email,
		GIT_AUTHOR_DATE: opts.date,
		GIT_COMMITTER_DATE: opts.date,
	});
}

// Fresh fixture every run.
if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true, force: true });
mkdirSync(FIXTURE, { recursive: true });

sh("git init -q -b main");
sh('git config user.email "harness@example.com"');
sh('git config user.name "Test Harness"');

// Commit 1 — Alice writes the initial file.
writeFileSync(
	join(FIXTURE, "sample.ts"),
	['export const greeting = "hello";', ""].join("\n"),
);
commit({
	author: { name: "Alice Bob", email: "alice@example.com" },
	date: "2020-01-01T00:00:00Z",
	message: "Add sample.ts",
});

// Commit 2 — Charlie appends a second export.
writeFileSync(
	join(FIXTURE, "sample.ts"),
	[
		'export const greeting = "hello";',
		'export const farewell = "bye";',
		"",
	].join("\n"),
);
commit({
	author: { name: "Charlie Doe", email: "charlie@example.com" },
	date: "2021-06-15T12:00:00Z",
	message: "Add farewell",
});

// Commit 3 — Diana adds an unrelated file (used for file-switch assertions).
writeFileSync(
	join(FIXTURE, "other.ts"),
	['export const count = 42;', ""].join("\n"),
);
commit({
	author: { name: "Diana Edwards", email: "diana@example.com" },
	date: "2022-03-20T09:30:00Z",
	message: "Add other.ts",
});

// Configure a remote so commitUrl rendering has something to point at.
sh(
	"git remote add origin https://github.com/test-user/fixture-repo.git",
);

console.log(`Fixture repo ready at ${FIXTURE}`);
