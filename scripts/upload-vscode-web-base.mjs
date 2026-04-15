/*
 * One-shot helper: download the current stable vscode-web tarball,
 * extract it, and upload the unpacked tree to the R2 bucket
 * `vscode-web-base/` under a version-keyed prefix.
 *
 * Runs from GitHub Actions (.github/workflows/upload-vscode-web-base.yml)
 * under OIDC-minted temporary R2 S3 credentials.
 *
 * Per-PR Cloudflare Pages previews then point
 *     WORKBENCH_WEB_BASE_URL = https://vscode-web-base.r2.dev/<version>
 * so the 115 MB payload is hosted ONCE and shared across every PR.
 *
 * Env (all required):
 *   CLOUDFLARE_ACCOUNT_ID
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN
 *       — temporary R2 S3 creds, minted by the workflow
 *
 * Usage:
 *   node scripts/upload-vscode-web-base.mjs [--quality=stable] [--bucket=vscode-web-base]
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { get } from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const ARGS = Object.fromEntries(
	process.argv.slice(2).flatMap((arg) => {
		const m = /^--([^=]+)=(.*)$/.exec(arg);
		return m ? [[m[1], m[2]]] : [[arg.replace(/^-+/, ""), true]];
	}),
);
const QUALITY = ARGS.quality || "stable";
const BUCKET = ARGS.bucket || "vscode-web-base";
const ACCOUNT_ID = required("CLOUDFLARE_ACCOUNT_ID");

function required(name) {
	const v = process.env[name];
	if (!v) throw new Error(`missing env: ${name}`);
	return v;
}

const CACHE = join(ROOT, ".vscode-web-cache");
const TARBALL = join(CACHE, `vscode-web-${QUALITY}.tar.gz`);
const EXTRACTED = join(CACHE, `vscode-web-${QUALITY}`);

const url = `https://update.code.visualstudio.com/latest/web-standalone/${QUALITY}`;

mkdirSync(CACHE, { recursive: true });
console.log(`fetching ${url} …`);
await follow(url, TARBALL);

const sha = createHash("sha1").update(readFileSync(TARBALL)).digest("hex").slice(0, 12);
console.log(`vscode-web-${QUALITY}.tar.gz: ${readFileSync(TARBALL).length} bytes, sha1 ${sha}`);

rmSync(EXTRACTED, { recursive: true, force: true });
mkdirSync(EXTRACTED, { recursive: true });
execSync(`tar -xzf ${TARBALL} -C ${EXTRACTED} --strip-components=1`);

// Tarball layout is `vscode-web-${ver}/package.json`, so read the version
// from the extracted dir.
const version = JSON.parse(readFileSync(join(EXTRACTED, "package.json"), "utf8")).version;
console.log(`vscode-web version: ${version}`);

// Upload tree under <version>/ prefix. We ALSO upload to `latest/` so
// previews that don't pin can follow the latest base.
const endpoint = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;
for (const prefix of [version, "latest"]) {
	const dest = `s3://${BUCKET}/${prefix}/`;
	console.log(`uploading to ${dest} …`);
	// --checksum-algorithm CRC32 keeps aws-cli happy against R2 which
	// doesn't support the newer default algorithms.
	execSync(
		`aws s3 sync ${EXTRACTED} ${dest} --endpoint-url=${endpoint} --checksum-algorithm CRC32 --only-show-errors`,
		{ stdio: "inherit" },
	);
}
console.log(`done. base available at https://${BUCKET}.r2.dev/${version}/ and /latest/`);

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
