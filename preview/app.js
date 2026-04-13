/*
 * Phase 5 — browser-only static preview.
 *
 * Loads the wasm-git artifact (libgit2 + our blame_exports.c +
 * blame_stream.c, compiled to WebAssembly), seeds an in-memory git repo
 * fixture, then runs streaming blame and renders the results live.
 *
 * Entirely client-side. Works in any modern browser. No backend, no
 * authentication, no fetch beyond the static assets that arrived with
 * the page.
 */

import { decodeFixtureTar } from "./fixture.js";

const $phase = document.getElementById("phase");
const $metrics = document.getElementById("metrics");
const $code = document.getElementById("code");
const $events = document.getElementById("events");

function setPhase(text) { $phase.textContent = text; }
function setMetrics(text) { $metrics.textContent = text; }

function logEvent(kind, body) {
	const li = document.createElement("li");
	const k = document.createElement("span");
	k.className = `ev-kind kind-${kind}`;
	k.textContent = kind;
	const b = document.createElement("span");
	b.textContent = body;
	li.append(k, b);
	$events.append(li);
	$events.scrollTop = $events.scrollHeight;
}

const SAMPLE_PATH = "demo.ts";

// --- ustar reader ---
function readUstar(buf) {
	const files = [];
	const dec = new TextDecoder();
	const trim = (s) => s.replace(/\0.*$/, "").trim();
	let off = 0;
	while (off + 512 <= buf.length) {
		const header = buf.subarray(off, off + 512);
		const name = trim(dec.decode(header.subarray(0, 100)));
		if (!name) break; // EOF marker
		const sizeStr = trim(dec.decode(header.subarray(124, 136)));
		const size = parseInt(sizeStr, 8) || 0;
		const type = String.fromCharCode(header[156]);
		off += 512;
		if (type === "0" || type === "" || type === "\0") {
			files.push({ name, data: buf.subarray(off, off + size) });
		}
		off += size;
		if (size % 512 !== 0) off += 512 - (size % 512);
	}
	return files;
}

// --- main ---
async function main() {
	setPhase("loading WebAssembly module…");
	const lgFactory = (await import("./lg2.js")).default;
	const lg = await lgFactory();
	setPhase("seeding fixture into MEMFS…");

	const tar = decodeFixtureTar();
	const files = readUstar(tar);
	lg.FS.mkdir("/work");
	for (const f of files) {
		const path = `/work/${f.name}`;
		// Make any missing parent directories.
		const parts = path.split("/").filter(Boolean);
		let cur = "";
		for (let i = 0; i < parts.length - 1; i++) {
			cur += "/" + parts[i];
			try { lg.FS.mkdir(cur); } catch { /* exists */ }
		}
		lg.FS.writeFile(path, f.data);
	}

	// Read HEAD to get the starting commit OID.
	const headTxt = new TextDecoder().decode(lg.FS.readFile("/work/.git/HEAD"));
	const refMatch = /^ref: (.+)$/m.exec(headTxt);
	let headOid;
	if (refMatch) {
		const refTxt = new TextDecoder().decode(
			lg.FS.readFile(`/work/.git/${refMatch[1].trim()}`),
		);
		headOid = refTxt.trim();
	} else {
		headOid = headTxt.trim();
	}
	setMetrics(`HEAD = ${headOid.slice(0, 8)}, ${files.length} fixture entries`);

	setPhase("opening repository…");

	// --- wire libgit2 functions via cwrap ---
	const _init = lg.cwrap("lg2_libgit2_init", "number", []);
	const _open = lg.cwrap("lg2_repository_open", "number", ["number", "string"]);
	const _blame_stream = lg.cwrap("lg2_blame_stream", "number",
		["number", "string", "number", "number", "number"]);
	const _err = lg.cwrap("lg2_error_last", "string", []);

	if (_init() < 1) throw new Error("git_libgit2_init failed");
	const repoPP = lg._malloc(4);
	if (_open(repoPP, "/work") !== 0) throw new Error("repository_open: " + _err());
	const repo = lg.HEAPU32[repoPP >> 2];

	const oidPtr = lg._malloc(20);
	for (let i = 0; i < 20; i++) {
		lg.HEAPU8[oidPtr + i] = parseInt(headOid.substr(i * 2, 2), 16);
	}

	// --- render the file with placeholder annotations, fill in as
	//     events arrive ---
	const sourceBytes = lg.FS.readFile(`/work/${SAMPLE_PATH}`);
	const sourceText = new TextDecoder().decode(sourceBytes);
	const sourceLines = sourceText.split("\n");
	if (sourceLines[sourceLines.length - 1] === "") sourceLines.pop();

	$code.innerHTML = "";
	const lineEls = sourceLines.map((src, i) => {
		const div = document.createElement("div");
		div.className = "line unattributed";
		const lineno = document.createElement("span");
		lineno.className = "lineno";
		lineno.textContent = i + 1;
		const annot = document.createElement("span");
		annot.className = "annotation";
		annot.textContent = "…";
		const code = document.createElement("span");
		code.className = "source";
		code.textContent = src || " ";
		div.append(lineno, annot, code);
		$code.append(div);
		return { div, annot };
	});

	// --- the streaming callback ---
	// C signature (see blame_stream.c blame_stream_event_fn):
	//   (kind, oid_ptr, line_start, line_count,
	//    name_ptr, email_ptr, when, summary_ptr,
	//    commits_walked, lines_remaining, user_data) -> int
	const callbackPtr = lg.addFunction(
		(kind, oidPP, lineStart, lineCount, namePtr, _emailPtr, when, summaryPtr, walked, remaining, _ud) => {
			const oid = oidPP ? oidHexAt(lg, oidPP) : "";
			const name = namePtr ? lg.UTF8ToString(namePtr) : "";
			const summary = summaryPtr ? lg.UTF8ToString(summaryPtr) : "";
			const date = when ? new Date(Number(when) * 1000).toISOString().slice(0, 10) : "";

			if (kind === 0) {
				// hunk
				logEvent("hunk", `line ${lineStart}+${lineCount}  ${name}  (${oid.slice(0, 8)})  ${date}`);
				for (let i = 0; i < lineCount; i++) {
					const idx = lineStart - 1 + i;
					if (lineEls[idx]) {
						lineEls[idx].div.classList.remove("unattributed");
						lineEls[idx].div.classList.add("attributed");
						lineEls[idx].annot.textContent = `${name} · ${date} · ${oid.slice(0, 7)}  ${summary}`;
					}
				}
				setMetrics(`${walked} commits walked, ${sourceLines.length - remaining} of ${sourceLines.length} lines attributed`);
			} else if (kind === 1) {
				// commit
				logEvent("commit", `walked=${walked} remaining=${remaining}  ${name}  ${date}  "${summary}"`);
				setPhase(`walking history… ${walked} commits, ${remaining} lines remaining`);
			} else {
				// done
				logEvent("done", `walked=${walked} remaining=${remaining}`);
				setPhase("done");
				setMetrics(`${walked} commits walked, ${sourceLines.length - remaining} of ${sourceLines.length} lines attributed`);
			}
			return 0;
		},
		"iiiiiiijiiii",
	);

	setPhase("walking history…");
	const t0 = performance.now();
	const rc = _blame_stream(repo, SAMPLE_PATH, oidPtr, callbackPtr, 0);
	const dt = (performance.now() - t0).toFixed(1);

	if (rc !== 0) {
		setPhase("error");
		logEvent("done", `blame_stream returned ${rc}: ${_err() || "(no error)"}`);
		return;
	}

	logEvent("done", `total: ${dt} ms`);
}

function oidHexAt(lg, ptr) {
	let s = "";
	for (let i = 0; i < 20; i++) s += lg.HEAPU8[ptr + i].toString(16).padStart(2, "0");
	return s;
}

main().catch((err) => {
	setPhase("crashed");
	logEvent("done", String(err && err.stack ? err.stack : err));
	console.error(err);
});
