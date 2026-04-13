/*
 * Builds a deterministic git fixture repo, packs it as a uncompressed tar,
 * and emits preview/fixture.js that exports the bytes as a base64 string.
 * The preview page imports this and seeds the wasm-git MEMFS with it.
 *
 * Self-contained — no fetch, no extra HTTP request, the fixture rides
 * along in the JS bundle. Costs us a few KB of base64 bloat in the
 * preview but eliminates an entire class of network race conditions.
 */

import { execSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "preview", "fixture.js");

const fixture = mkdtempSync(join(tmpdir(), "preview-fixture-"));
const sh = (cmd, env = {}) =>
	execSync(cmd, { cwd: fixture, stdio: "ignore", env: { ...process.env, ...env } });

function commit({ author, email, date, message }) {
	sh("git add -A");
	sh(`git commit -q -m "${message}"`, {
		GIT_AUTHOR_NAME: author,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: author,
		GIT_COMMITTER_EMAIL: email,
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_DATE: date,
	});
}

sh("git init -q -b main");
sh('git config user.email "harness@example.com"');
sh('git config user.name "Test Harness"');
sh("git config commit.gpgsign false");

writeFileSync(
	join(fixture, "demo.ts"),
	[
		"// All the Blame demo file",
		"// Each line was added by a different person across multiple years.",
		"",
		'export const greeting = "Hello, world!";',
		"",
	].join("\n"),
);
commit({
	author: "Alice Bob",
	email: "alice@example.com",
	date: "2020-01-01T09:00:00Z",
	message: "Initial commit",
});

writeFileSync(
	join(fixture, "demo.ts"),
	[
		"// All the Blame demo file",
		"// Each line was added by a different person across multiple years.",
		"",
		'export const greeting = "Hello, world!";',
		'export const farewell = "Goodbye!";',
		"",
	].join("\n"),
);
commit({
	author: "Charlie Doe",
	email: "charlie@example.com",
	date: "2021-06-15T13:20:00Z",
	message: "Add farewell constant",
});

writeFileSync(
	join(fixture, "demo.ts"),
	[
		"// All the Blame demo file",
		"// Each line was added by a different person across multiple years.",
		"",
		'export const greeting = "Hello, world!";',
		'export const farewell = "Goodbye!";',
		"",
		"export function greet(name: string): string {",
		"  return `${greeting} ${name}`;",
		"}",
		"",
	].join("\n"),
);
commit({
	author: "Diana Edwards",
	email: "diana@example.com",
	date: "2022-03-20T11:45:00Z",
	message: "Add greet function",
});

writeFileSync(
	join(fixture, "demo.ts"),
	[
		"// All the Blame demo file",
		"// Each line was added by a different person across multiple years.",
		"",
		'export const greeting = "Hello, world!";',
		'export const farewell = "Goodbye!";',
		"",
		"export function greet(name: string): string {",
		"  return `${greeting} ${name}`;",
		"}",
		"",
		"export function farewell_to(name: string): string {",
		"  return `${farewell} ${name}`;",
		"}",
		"",
	].join("\n"),
);
commit({
	author: "Eve Green",
	email: "eve@example.com",
	date: "2024-09-12T16:30:00Z",
	message: "Add farewell_to helper",
});

// --- pack to tar ---
//
// USTAR header is 512 bytes. Each file entry is header + content padded
// to 512-byte block boundary. Two trailing 512-byte zero blocks mark EOF.
function tarChunks(srcDir) {
	const chunks = [];
	function walk(dir, prefix) {
		for (const name of readdirSync(dir).sort()) {
			const sp = join(dir, name);
			const inner = prefix ? `${prefix}/${name}` : name;
			const st = statSync(sp);
			if (st.isDirectory()) {
				chunks.push(...header(inner + "/", 0, "5", 0o755));
				walk(sp, inner);
			} else if (st.isFile()) {
				const data = readFileSync(sp);
				chunks.push(...header(inner, data.length, "0", 0o644));
				chunks.push(data);
				const pad = 512 - (data.length % 512);
				if (pad < 512) chunks.push(new Uint8Array(pad));
			}
		}
	}
	walk(srcDir, "");
	chunks.push(new Uint8Array(1024)); // EOF marker
	return chunks;

	function header(path, size, type, mode) {
		const buf = new Uint8Array(512);
		const enc = new TextEncoder();
		const write = (s, off, n) => {
			const b = enc.encode(s);
			for (let i = 0; i < Math.min(b.length, n); i++) buf[off + i] = b[i];
		};
		write(path.length > 100 ? path.slice(-100) : path, 0, 100);
		write(mode.toString(8).padStart(7, "0") + "\0", 100, 8);
		write("0000000\0", 108, 8); // uid
		write("0000000\0", 116, 8); // gid
		write(size.toString(8).padStart(11, "0") + "\0", 124, 12);
		write("00000000000\0", 136, 12); // mtime — zeroed for determinism
		write("        ", 148, 8); // checksum placeholder (spaces)
		write(type, 156, 1);
		write("ustar  \0", 257, 8);
		// checksum
		let sum = 0;
		for (let i = 0; i < 512; i++) sum += buf[i];
		const cksum = sum.toString(8).padStart(6, "0") + "\0 ";
		write(cksum, 148, 8);
		return [buf];
	}
}

const all = tarChunks(fixture);
const total = all.reduce((n, c) => n + c.length, 0);
const tar = new Uint8Array(total);
let off = 0;
for (const c of all) {
	tar.set(c, off);
	off += c.length;
}

const b64 = Buffer.from(tar).toString("base64");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
	OUT,
	`// AUTOGENERATED by scripts/build-preview-fixture.mjs — do not edit by hand.
// Re-run \`pnpm build-preview-fixture\` to regenerate.
//
// Contains a deterministic git repo with 4 commits across 4 authors,
// packed as an uncompressed tar, base64-encoded.
//
// Authors: Alice Bob (2020), Charlie Doe (2021), Diana Edwards (2022),
// Eve Green (2024). All on file demo.ts.
//
// Total tar size: ${tar.length} bytes.

export const FIXTURE_TAR_BASE64 = "${b64}";

export function decodeFixtureTar() {
  const bin = atob(FIXTURE_TAR_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
`,
);

rmSync(fixture, { recursive: true, force: true });
console.log(`wrote ${relative(ROOT, OUT)} (${tar.length} bytes tar, ${b64.length} bytes base64)`);
