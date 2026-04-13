// Verify that lg2_blame_stream from blame_stream.c emits per-commit
// progress events and per-line hunk attributions as it walks history.
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fixture = mkdtempSync(join(tmpdir(), "blame-stream-"));
const sh = (cmd, env = {}) =>
	execSync(cmd, { cwd: fixture, stdio: "ignore", env: { ...process.env, ...env } });

sh("git init -q -b main");
sh('git config user.email "test@test"');
sh('git config user.name "Test"');
sh("git config commit.gpgsign false");

execSync(`bash -c 'echo "alice line 1" > sample.txt'`, { cwd: fixture });
sh("git add sample.txt");
sh('git commit -q -m "Add line 1"', {
	GIT_AUTHOR_NAME: "Alice",
	GIT_AUTHOR_EMAIL: "alice@test.com",
	GIT_COMMITTER_NAME: "Alice",
	GIT_COMMITTER_EMAIL: "alice@test.com",
	GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
});
execSync(`bash -c 'echo "bob line 2" >> sample.txt'`, { cwd: fixture });
sh('git commit -q -am "Add line 2"', {
	GIT_AUTHOR_NAME: "Bob",
	GIT_AUTHOR_EMAIL: "bob@test.com",
	GIT_COMMITTER_NAME: "Bob",
	GIT_COMMITTER_EMAIL: "bob@test.com",
	GIT_AUTHOR_DATE: "2021-06-15T12:00:00Z",
	GIT_COMMITTER_DATE: "2021-06-15T12:00:00Z",
});
execSync(`bash -c 'echo "carol line 3" >> sample.txt'`, { cwd: fixture });
sh('git commit -q -am "Add line 3"', {
	GIT_AUTHOR_NAME: "Carol",
	GIT_AUTHOR_EMAIL: "carol@test.com",
	GIT_COMMITTER_NAME: "Carol",
	GIT_COMMITTER_EMAIL: "carol@test.com",
	GIT_AUTHOR_DATE: "2022-09-20T09:30:00Z",
	GIT_COMMITTER_DATE: "2022-09-20T09:30:00Z",
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

// HEAD commit oid (we need to give the streaming blame a starting point)
const headOid = execSync("git rev-parse HEAD", { cwd: fixture, encoding: "utf8" }).trim();
console.log("HEAD:", headOid);

const _init = lg.cwrap("lg2_libgit2_init", "number", []);
const _open = lg.cwrap("lg2_repository_open", "number", ["number", "string"]);
const _blame_stream = lg.cwrap("lg2_blame_stream", "number", [
	"number", "string", "number", "number", "number",
]);
const _err = lg.cwrap("lg2_error_last", "string", []);

_init();
const repoPP = lg._malloc(4);
if (_open(repoPP, "/work") !== 0) { console.error("open failed:", _err()); process.exit(1); }
const repo = lg.HEAPU32[repoPP >> 2];

// Marshal HEAD oid into WASM memory as a 20-byte git_oid
const oidBuf = lg._malloc(20);
for (let i = 0; i < 20; i++) {
	lg.HEAPU8[oidBuf + i] = parseInt(headOid.substr(i * 2, 2), 16);
}

// Build a JS callback C can invoke. Signature in Emscripten letters:
//   i = int, j = int64
// Args: kind:i, oid:i, line_start:i, line_count:i,
//       name:i, email:i, when:j, summary:i,
//       commits_walked:i, lines_remaining:i, user_data:i
// Return: i
const events = [];
const callbackPtr = lg.addFunction((kind, oidPtr, ls, lc, namePtr, emailPtr, when, summaryPtr, walked, remaining, _ud) => {
	const oid = oidPtr ? Array.from(lg.HEAPU8.subarray(oidPtr, oidPtr + 20))
		.map((b) => b.toString(16).padStart(2, "0")).join("") : null;
	const name = namePtr ? lg.UTF8ToString(namePtr) : null;
	const email = emailPtr ? lg.UTF8ToString(emailPtr) : null;
	const summary = summaryPtr ? lg.UTF8ToString(summaryPtr) : null;
	const ev = {
		kind: ["hunk", "commit", "done"][kind],
		oid: oid?.slice(0, 8),
		line_start: ls,
		line_count: lc,
		name, email,
		when: Number(when),
		summary,
		walked,
		remaining,
	};
	events.push(ev);
	const ts = ev.when ? new Date(ev.when * 1000).toISOString().slice(0, 10) : "         ";
	if (kind === 0) console.log(`  HUNK     line ${ls}+${lc}  ${name}  (${oid?.slice(0, 8)}) ${ts}`);
	if (kind === 1) console.log(`  COMMIT   walked=${walked} remaining=${remaining}  ${name}  ${ts}  "${summary}"`);
	if (kind === 2) console.log(`  DONE     walked=${walked} remaining=${remaining}`);
	return 0;
}, "iiiiiiijiiii");

console.log("\n--- streaming blame for sample.txt ---");
const rc = _blame_stream(repo, "sample.txt", oidBuf, callbackPtr, 0);
console.log(`\nrc=${rc}, total events=${events.length}`);
console.log(`  ${events.filter(e => e.kind === "hunk").length} hunk events`);
console.log(`  ${events.filter(e => e.kind === "commit").length} commit events`);
console.log(`  ${events.filter(e => e.kind === "done").length} done event`);

if (rc === 0) console.log("\n✅ streaming blame works.");
else console.log("\n❌ streaming blame failed:", _err());
