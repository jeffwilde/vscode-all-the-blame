// Test the freshly-built lg2.js via direct FFI calls to libgit2 functions.
import { execSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fixture = mkdtempSync(join(tmpdir(), "blame-fixture-"));
const sh = (cmd, env = {}) =>
	execSync(cmd, { cwd: fixture, stdio: "ignore", env: { ...process.env, ...env } });
sh("git init -q -b main");
sh('git config user.email "test@test"');
sh('git config user.name "Test"');
sh("git config commit.gpgsign false");
execSync(`bash -c 'echo "alice line" > sample.txt'`, { cwd: fixture });
sh("git add sample.txt");
sh('git commit -q -m "alice"', {
	GIT_AUTHOR_NAME: "Alice",
	GIT_AUTHOR_EMAIL: "alice@test.com",
	GIT_COMMITTER_NAME: "Alice",
	GIT_COMMITTER_EMAIL: "alice@test.com",
	GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
});
execSync(`bash -c 'echo "bob line" >> sample.txt'`, { cwd: fixture });
sh('git commit -q -am "bob"', {
	GIT_AUTHOR_NAME: "Bob",
	GIT_AUTHOR_EMAIL: "bob@test.com",
	GIT_COMMITTER_NAME: "Bob",
	GIT_COMMITTER_EMAIL: "bob@test.com",
	GIT_AUTHOR_DATE: "2021-06-15T12:00:00Z",
	GIT_COMMITTER_DATE: "2021-06-15T12:00:00Z",
});

const lgFactory = (await import("/tmp/wasm-git-src/emscriptenbuild/libgit2/examples/lg2.js")).default;
const lg = await lgFactory();

function mirror(srcDir, destDir) {
	for (const entry of readdirSync(srcDir)) {
		const sp = join(srcDir, entry);
		const dp = `${destDir}/${entry}`;
		const st = statSync(sp);
		if (st.isDirectory()) {
			lg.FS.mkdir(dp);
			mirror(sp, dp);
		} else {
			lg.FS.writeFile(dp, readFileSync(sp));
		}
	}
}
lg.FS.mkdir("/work");
mirror(fixture, "/work");

const _init = lg.cwrap("lg2_libgit2_init", "number", []);
const _open = lg.cwrap("lg2_repository_open", "number", ["number", "string"]);
const _opt_init = lg.cwrap("lg2_blame_options_init", "number", ["number", "number"]);
const _opt_version = lg.cwrap("lg2_blame_options_version", "number", []);
const _opt_size = lg.cwrap("lg2_blame_options_size", "number", []);
const _blame_file = lg.cwrap("lg2_blame_file", "number", ["number", "number", "string", "number"]);
const _hunk_count = lg.cwrap("lg2_blame_get_hunk_count", "number", ["number"]);
const _hunk_at = lg.cwrap("lg2_blame_get_hunk_byindex", "number", ["number", "number"]);
const _hunk_lines = lg.cwrap("lg2_hunk_lines_in_hunk", "number", ["number"]);
const _hunk_start = lg.cwrap("lg2_hunk_final_start_line", "number", ["number"]);
const _hunk_name = lg.cwrap("lg2_hunk_final_signature_name", "string", ["number"]);
const _hunk_email = lg.cwrap("lg2_hunk_final_signature_email", "string", ["number"]);
const _hunk_when = lg.cwrap("lg2_hunk_final_signature_when", "number", ["number"]);
const _hunk_oid = lg.cwrap("lg2_hunk_final_commit_id", "number", ["number"]);
const _oid_str = lg.cwrap("lg2_oid_tostr", "number", ["number", "number", "number"]);
const _err = lg.cwrap("lg2_error_last", "string", []);
const _free = lg.cwrap("lg2_blame_free", null, ["number"]);

console.log("init:", _init());

const repoPP = lg._malloc(4);
const rc = _open(repoPP, "/work");
if (rc !== 0) { console.error("open failed:", rc, _err()); process.exit(1); }
const repo = lg.HEAPU32[repoPP >> 2];

const opts = lg._malloc(_opt_size());
_opt_init(opts, _opt_version());

const blamePP = lg._malloc(4);
const brc = _blame_file(blamePP, repo, "sample.txt", opts);
if (brc !== 0) { console.error("blame failed:", brc, _err()); process.exit(1); }
const blame = lg.HEAPU32[blamePP >> 2];

const count = _hunk_count(blame);
console.log(`\nblame returned ${count} hunks for sample.txt:`);
const oidBuf = lg._malloc(41);
for (let i = 0; i < count; i++) {
	const h = _hunk_at(blame, i);
	const oidPtr = _hunk_oid(h);
	_oid_str(oidBuf, 41, oidPtr);
	const oidStr = lg.UTF8ToString(oidBuf);
	console.log(
		`  hunk ${i}: lines ${_hunk_start(h)}+${_hunk_lines(h)}  ${_hunk_name(h)} <${_hunk_email(h)}>  @${new Date(Number(_hunk_when(h)) * 1000).toISOString()}  (${oidStr.slice(0, 8)})`,
	);
}

_free(blame);
console.log("\n✅ libgit2 blame via direct WASM FFI works.");
