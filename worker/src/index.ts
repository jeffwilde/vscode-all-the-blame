/**
 * Preview router Worker.
 *
 * Resolves requests against the `previews` R2 bucket via KV-backed
 * per-PR pointers. See infra/index.ts for the data model.
 *
 * Routes:
 *   GET /                         landing page (lists active PRs from KV)
 *   GET /pr/<n>/<rest...>         → kv.pr:<n> → r2: pr/<n>/<sha>/<rest>
 *   GET /main/<rest...>           → kv.main   → r2: main/<sha>/<rest>
 *   GET /base/<ver>/<rest...>     → r2: base/<ver>/<rest>        (no KV)
 *   GET /healthz                  always 200
 *
 * Everything is streamed — we don't buffer R2 bodies through Worker
 * memory, so the 115 MB workbench assets serve fine under the
 * per-request memory limit.
 */

type Env = {
	PREVIEWS: R2Bucket;
	POINTERS: KVNamespace;
};

const CACHE_CONTROL = {
	// vscode-web assets are keyed by version in their path → aggressively cacheable
	base: "public, max-age=31536000, immutable",
	// PR builds are SHA-prefixed in R2 but the user-facing path is /pr/<n>/,
	// which changes content on pointer flip → short cache with revalidation
	pr: "public, max-age=60, must-revalidate",
	// Landing is dynamic — lists current PRs
	landing: "no-cache",
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("method not allowed", { status: 405 });
		}

		const path = url.pathname;

		if (path === "/healthz") {
			return new Response("ok", { status: 200 });
		}

		if (path === "/" || path === "") {
			return landing(env);
		}

		const prMatch = /^\/pr\/(\d+)(?:\/(.*))?$/.exec(path);
		if (prMatch) {
			const prNum = prMatch[1];
			const rest = prMatch[2] ?? "index.html";
			return servePr(env, prNum, rest, request);
		}

		const mainMatch = /^\/main(?:\/(.*))?$/.exec(path);
		if (mainMatch) {
			const rest = mainMatch[1] ?? "index.html";
			return serveMain(env, rest, request);
		}

		const baseMatch = /^\/base\/([^/]+)(?:\/(.*))?$/.exec(path);
		if (baseMatch) {
			const version = baseMatch[1];
			const rest = baseMatch[2] ?? "";
			return serveR2(env, `base/${version}/${rest}`, CACHE_CONTROL.base, request);
		}

		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function servePr(
	env: Env,
	prNum: string,
	rest: string,
	request: Request,
): Promise<Response> {
	const sha = await env.POINTERS.get(`pr:${prNum}`);
	if (!sha) {
		return new Response(
			`no active preview for PR #${prNum}. Push a new commit to deploy one.`,
			{ status: 404 },
		);
	}
	// Trailing slash on /pr/<n> means "root of the PR build" → index.html
	const normalized = rest.endsWith("/") || rest === "" ? `${rest}index.html` : rest;
	return serveR2(env, `pr/${prNum}/${sha}/${normalized}`, CACHE_CONTROL.pr, request);
}

async function serveMain(env: Env, rest: string, request: Request): Promise<Response> {
	const sha = await env.POINTERS.get("main");
	if (!sha) return new Response("no main build yet", { status: 404 });
	const normalized = rest.endsWith("/") || rest === "" ? `${rest}index.html` : rest;
	return serveR2(env, `main/${sha}/${normalized}`, CACHE_CONTROL.pr, request);
}

async function serveR2(
	env: Env,
	key: string,
	cacheControl: string,
	request: Request,
): Promise<Response> {
	const obj = await env.PREVIEWS.get(key, {
		onlyIf: request.headers,
		range: request.headers,
	});
	if (!obj) return new Response("not found", { status: 404 });

	// R2's onlyIf returns an R2ObjectBody only when the precondition
	// passes; if it fails we get an R2Object with no body → 304.
	if (!("body" in obj)) {
		const headers = new Headers();
		obj.writeHttpMetadata(headers);
		headers.set("etag", obj.httpEtag);
		return new Response(null, { status: 304, headers });
	}

	const headers = new Headers();
	obj.writeHttpMetadata(headers);
	headers.set("etag", obj.httpEtag);
	headers.set("cache-control", cacheControl);

	// Ensure the content-type is set — R2 stores what the uploader sent,
	// which may be octet-stream for some workbench files.
	if (!headers.has("content-type")) {
		headers.set("content-type", guessContentType(key));
	}

	return new Response(obj.body, { headers });
}

async function landing(env: Env): Promise<Response> {
	const { keys } = await env.POINTERS.list({ prefix: "pr:" });
	const prs = keys
		.map((k) => Number(k.name.slice(3)))
		.filter((n) => Number.isFinite(n))
		.sort((a, b) => b - a);
	const mainSha = await env.POINTERS.get("main");

	const body = `<!doctype html>
<meta charset="utf-8" />
<title>All the Blame — preview router</title>
<style>
	body { font: 14px/1.4 system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; color: #222; }
	code { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; }
	ul { padding-left: 1.2rem; }
	a { color: #0b57d0; }
</style>
<h1>All the Blame — preview router</h1>
<p>
	Serves per-PR previews of the All the Blame VS Code extension running in
	<a href="https://github.com/microsoft/vscode/wiki/Issues-Triage#vscode-web">vscode-web</a>.
</p>
<h2>Active previews</h2>
<ul>
	${mainSha ? `<li><a href="/main/">main</a> (<code>${mainSha.slice(0, 8)}</code>)</li>` : ""}
	${prs.map((n) => `<li><a href="/pr/${n}/">PR #${n}</a></li>`).join("\n\t")}
	${prs.length === 0 && !mainSha ? "<li><em>(none)</em></li>" : ""}
</ul>
<p>
	<small>source: <a href="https://github.com/jeffwilde/vscode-all-the-blame">jeffwilde/vscode-all-the-blame</a></small>
</p>`;

	return new Response(body, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": CACHE_CONTROL.landing,
		},
	});
}

function guessContentType(key: string): string {
	const ext = key.split(".").pop()?.toLowerCase() ?? "";
	// Small map covering the file types vscode-web actually ships. Anything
	// not here falls through to octet-stream, which browsers handle fine
	// for the few binary assets.
	const types: Record<string, string> = {
		html: "text/html; charset=utf-8",
		js: "application/javascript; charset=utf-8",
		mjs: "application/javascript; charset=utf-8",
		css: "text/css; charset=utf-8",
		json: "application/json; charset=utf-8",
		map: "application/json; charset=utf-8",
		svg: "image/svg+xml",
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		woff: "font/woff",
		woff2: "font/woff2",
		ttf: "font/ttf",
		wasm: "application/wasm",
		txt: "text/plain; charset=utf-8",
		md: "text/markdown; charset=utf-8",
	};
	return types[ext] ?? "application/octet-stream";
}
