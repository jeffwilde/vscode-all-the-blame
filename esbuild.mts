import { analyzeMetafile, build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

// --- desktop / remote-host build (Node entry point) ---
const desktopResult = await build({
	entryPoints: ["./src/index.ts"],
	bundle: true,
	format: "esm",
	minify: true,
	target: "node22.22",
	outdir: "./out/",
	sourcemap: !!process.env.SOURCEMAPS,
	metafile: !!process.env.METAFILE,
	splitting: true,
	external: ["vscode", "node:*"],
});

// --- worker-host build (web entry point) ---
//
// The web bundle uses ./src/web-entry.ts as its activate(). The wasm-git
// JS+WASM artifacts are external — they're copied into out/web/ and
// loaded via dynamic import at runtime. This keeps esbuild from trying
// to inline WASM bytes into the JS bundle (which would explode the
// download size and lose the streaming-WASM-compile speedup).
const webResult = await build({
	entryPoints: ["./src/web-entry.ts"],
	bundle: true,
	format: "esm",
	minify: true,
	target: "esnext",
	platform: "browser",
	outdir: "./out/web/",
	sourcemap: !!process.env.SOURCEMAPS,
	metafile: !!process.env.METAFILE,
	splitting: true,
	// vscode is provided by the host. node:* are not available in
	// worker-host; the web-only code path must avoid them. The wasm-git
	// loader is left external so the .wasm sibling file is fetched at
	// runtime from out/web/ rather than inlined.
	external: ["vscode", "node:*", "../../vendor/wasm-git/lg2.js"],
	define: {
		// Branch in the factory that picks CliGitBackend can be statically
		// stripped in the web bundle.
		"globalThis.process": "undefined",
	},
});

// Copy wasm-git artifacts into the web output so they're served as
// siblings of the bundled JS.
await mkdir("./out/web/", { recursive: true });
await copyFile("./vendor/wasm-git/lg2.js", "./out/web/lg2.js");
await copyFile("./vendor/wasm-git/lg2.wasm", "./out/web/lg2.wasm");

// Set METAFILE=1 to export a bundle analyze file for esbuild
// Look at it here: https://esbuild.github.io/analyze/
if (desktopResult.metafile && webResult.metafile) {
	await import("node:fs/promises").then(({ writeFile }) => {
		writeFile(
			new URL("./meta.json", import.meta.url),
			JSON.stringify({
				desktop: desktopResult.metafile,
				web: webResult.metafile,
			}),
		);
	});
	console.log("--- desktop ---");
	console.log(await analyzeMetafile(desktopResult.metafile, { verbose: true }));
	console.log("--- web ---");
	console.log(await analyzeMetafile(webResult.metafile, { verbose: true }));
}
