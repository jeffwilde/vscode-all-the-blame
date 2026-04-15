/*
 * Builds preview-vscode-web/ — a self-contained static deployment of
 * VS Code for the Web (vscode-web) with the All the Blame extension
 * pre-installed and a fixture workspace preloaded.
 *
 * Resulting directory is ~120 MB. Intended for GitHub Pages /
 * CDN-backed static hosting where the one-time download cost is fine.
 *
 * Steps:
 *   1. Download + extract vscode-web tarball from update.code.visualstudio.com
 *   2. Copy main.js (the boot script) from @vscode/test-web
 *   3. Package the extension (desktop + web bundles) as a folder-based
 *      "extension" that vscode-web can load at startup
 *   4. Generate index.html from @vscode/test-web's workbench-esm.html
 *      template, with config pointing to an in-memory workspace
 *   5. Everything is ./ relative so it can be rehosted anywhere
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { get } from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- CLI flags ---
//
// By default we build a fat deployment that bundles the full vscode-web
// tree under ./vscode-web/. In `--base-url=...` mode we instead point
// WORKBENCH_WEB_BASE_URL at a remote host (typically the shared R2
// bucket) and skip the 115 MB copy. This is the mode used for
// per-PR Cloudflare Pages previews, where only the extension delta
// ships in each deploy.
const ARGS = Object.fromEntries(
	process.argv.slice(2).flatMap((arg) => {
		const m = /^--([^=]+)=(.*)$/.exec(arg);
		return m ? [[m[1], m[2]]] : [[arg.replace(/^-+/, ""), true]];
	}),
);
const BASE_URL = typeof ARGS["base-url"] === "string" ? ARGS["base-url"] : null;
const SLIM = BASE_URL !== null;
const ROOT = join(__dirname, "..");
const CACHE = join(ROOT, ".vscode-web-cache");
const OUT = join(ROOT, "preview-vscode-web");
const TARBALL = join(CACHE, "vscode-web.tar.gz");
const EXTRACTED = join(CACHE, "vscode-web");

// --- step 1: fetch vscode-web ---
const QUALITY = "stable";
const VSCODE_WEB_URL = `https://update.code.visualstudio.com/latest/web-standalone/${QUALITY}`;

async function ensureVscodeWeb() {
	if (existsSync(EXTRACTED)) {
		console.log(`re-using cached vscode-web at ${EXTRACTED}`);
		return;
	}
	mkdirSync(CACHE, { recursive: true });

	console.log(`fetching ${VSCODE_WEB_URL} …`);
	await follow(VSCODE_WEB_URL, TARBALL);

	const sha = createHash("sha1").update(readFileSync(TARBALL)).digest("hex").slice(0, 12);
	console.log(`vscode-web.tar.gz: ${readFileSync(TARBALL).length} bytes, sha1 ${sha}`);

	console.log("extracting…");
	execSync(`tar -xzf ${TARBALL} -C ${CACHE}`);
	console.log(`extracted to ${EXTRACTED}`);
}

function follow(url, dest) {
	return new Promise((resolve, reject) => {
		const req = get(url, (res) => {
			if (res.statusCode === 302 || res.statusCode === 301) {
				follow(res.headers.location, dest).then(resolve, reject);
				return;
			}
			if (res.statusCode !== 200) {
				reject(new Error(`HTTP ${res.statusCode} for ${url}`));
				return;
			}
			pipeline(res, createWriteStream(dest)).then(resolve, reject);
		});
		req.on("error", reject);
	});
}

// --- step 2–4 ---
async function build() {
	// In slim mode the workbench assets come from the `--base-url`
	// host, so we only need the tarball locally if we have to read
	// package.json for the version tag below. We still extract it
	// (it's cached) because the boot/main.js in @vscode/test-web
	// expects to see the right layout.
	await ensureVscodeWeb();

	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(OUT, { recursive: true });

	// In fat mode, copy the full vscode-web tree into the deploy.
	// In slim mode, the browser fetches it directly from `BASE_URL`.
	if (!SLIM) {
		await cp(EXTRACTED, join(OUT, "vscode-web"), { recursive: true });
	}

	// Copy the boot script from @vscode/test-web. This provides the
	// WorkspaceProvider / create() that the HTML template expects.
	const mainJs = readFileSync(
		join(ROOT, "node_modules/@vscode/test-web/out/browser/esm/main.js"),
		"utf8",
	);
	// Rewrite the workbench.api import to the real workbench URL. In
	// slim mode this is the absolute R2 URL; in fat mode it's the
	// relative path under our own deploy.
	const workbenchUrl = SLIM
		? `${BASE_URL.replace(/\/$/, "")}/out/vs/workbench/workbench.web.main.internal.js`
		: "./vscode-web/out/vs/workbench/workbench.web.main.internal.js";
	const mainJsFixed = mainJs.replace("./workbench.api", workbenchUrl);
	mkdirSync(join(OUT, "boot"), { recursive: true });
	writeFileSync(join(OUT, "boot/main.js"), mainJsFixed);

	// --- extension ---
	//
	// vscode-web can load a local extension via extensionDevelopmentPath.
	// We drop our built extension under ./extensions/all-the-blame/ and
	// add it to the workbench config's `additionalBuiltinExtensions`.
	const extRoot = join(OUT, "extensions/all-the-blame");
	mkdirSync(extRoot, { recursive: true });
	await cp(join(ROOT, "package.json"), join(extRoot, "package.json"));
	await cp(join(ROOT, "out"), join(extRoot, "out"), { recursive: true });
	if (existsSync(join(ROOT, "images"))) {
		await cp(join(ROOT, "images"), join(extRoot, "images"), { recursive: true });
	}

	// --- index.html ---
	const template = readFileSync(
		join(ROOT, "node_modules/@vscode/test-web/views/workbench-esm.html"),
		"utf8",
	);

	// Workbench config is built at runtime so the extension URIs get
	// the right scheme/authority for whatever host this is served from
	// (localhost:8081, github.io, or anywhere else). The meta tag is
	// placeholder-filled before the main bootstrap script runs.
	const productConfiguration = {
		nameShort: "All the Blame Preview",
		nameLong: "All the Blame — browser preview",
		applicationName: "alltheblame-web",
		dataFolderName: ".alltheblame",
		version: "1.0.0",
		// Disabling the gallery suppresses the "search extensions from
		// marketplace" UI that wouldn't work on a static deploy anyway.
		extensionsGallery: undefined,
	};

	const values = {
		WORKBENCH_WEB_BASE_URL: SLIM ? BASE_URL.replace(/\/$/, "") : "./vscode-web",
		// Seeded to empty at build time; overwritten at runtime by the
		// preamble script below.
		WORKBENCH_WEB_CONFIGURATION: "{}",
		WORKBENCH_BUILTIN_EXTENSIONS: "[]",
		WORKBENCH_MAIN: [
			"<script>",
			"// Build the workbench config at runtime so extension URIs",
			"// resolve to the current host. Replaces the placeholder meta",
			"// tag before the main bootstrap script runs.",
			"(() => {",
			`  const productConfiguration = ${JSON.stringify(productConfiguration, null, 2)};`,
			"  const origin = window.location.origin;",
			"  const basePath = window.location.pathname.replace(/index\\.html$/, '').replace(/\\/$/, '');",
			"  const extUri = (relativePath) => {",
			"    const u = new URL(basePath + '/' + relativePath, origin);",
			"    return { scheme: u.protocol.replace(':', ''), authority: u.host, path: u.pathname };",
			"  };",
			"  const config = {",
			"    folderUri: 'memfs:/fixture',",
			"    productConfiguration,",
			"    additionalBuiltinExtensions: [extUri('extensions/all-the-blame')],",
			"    developmentOptions: { extensions: [extUri('extensions/all-the-blame')] }",
			"  };",
			"  const meta = document.getElementById('vscode-workbench-web-configuration');",
			"  meta.setAttribute('data-settings', JSON.stringify(config));",
			"})();",
			"</script>",
			'<script type="module" src="./boot/main.js"></script>',
		].join("\n"),
	};

	const html = template.replace(/\{\{([^}]+)\}\}/g, (_m, k) => values[k] ?? "undefined");
	writeFileSync(join(OUT, "index.html"), html);

	// A small landing/readme so visitors know what's going on
	writeFileSync(
		join(OUT, "README.md"),
		[
			"# All the Blame — full VS Code for the Web preview",
			"",
			"Open `index.html` in a static host (or run `pnpm preview-vscode`).",
			"",
			"Contains:",
			SLIM
				? `- vscode-web assets — fetched at runtime from ${BASE_URL}`
				: "- `vscode-web/` — unmodified VS Code for the Web v" +
					JSON.parse(readFileSync(join(EXTRACTED, "package.json"), "utf8")).version,
			"- `extensions/all-the-blame/` — our extension",
			"- `boot/main.js` — workbench bootstrap",
			"- `index.html` — the entry point",
			"",
		].join("\n"),
	);

	console.log(`wrote ${OUT}`);
	console.log(`total size: ${humanSize(dirSize(OUT))}`);
}

function dirSize(p) {
	return Number(
		execSync(`du -sb ${p}`, { encoding: "utf8" }).split(/\s+/)[0],
	);
}

function humanSize(n) {
	const units = ["B", "KB", "MB", "GB"];
	let i = 0;
	while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
	return `${n.toFixed(1)} ${units[i]}`;
}

await build();
