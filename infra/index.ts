/**
 * Pulumi program for All the Blame preview hosting on Cloudflare.
 *
 * Architecture (path-based routing, no Pages):
 *
 *   R2 bucket "previews"            one bucket, three prefixes
 *     - base/<vscode-ver>/…         shared vscode-web assets (per-release)
 *     - pr/<pr-num>/<sha>/…         per-PR preview build (per-commit)
 *     - main/<sha>/…                main-branch history
 *
 *   R2 bucket "pulumi-state"        self-hosted Pulumi state backend
 *
 *   KV namespace "preview-pointers" atomic per-PR SHA pointers
 *     - pr:<pr-num>  →  <sha>
 *     - main         →  <sha>
 *
 *   Worker "preview-router"         reads path, KV-looks up current SHA,
 *                                   streams from R2. Free workers.dev
 *                                   subdomain; path-based per-PR URLs.
 *
 * The Worker's compiled bundle is read from ../worker/dist/index.js at
 * `pulumi up` time, so redeploying the Worker = commit to worker/**
 * + next infra workflow run.
 */

import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "node:fs";
import * as path from "node:path";

const cfg = new pulumi.Config();
const cfCfg = new pulumi.Config("cloudflare");
const accountId = cfCfg.require("accountId");
const workerName = cfg.get("workerName") ?? "preview-router";

// --- R2 buckets ---

const stateBucket = new cloudflare.R2Bucket("pulumi-state", {
	accountId,
	name: "pulumi-state",
	location: "wnam",
});

const previewsBucket = new cloudflare.R2Bucket("previews", {
	accountId,
	name: "previews",
	location: "wnam",
});

// Permissive CORS — the Worker serves responses same-origin, but
// vscode-web fetches some resources cross-origin style (module imports
// via blob: URLs, webworker iframes). Easier to allow * than to audit.
const _previewsCors = new cloudflare.R2BucketCors("previews-cors", {
	accountId,
	bucketName: previewsBucket.name,
	rules: [
		{
			allowed: {
				methods: ["GET", "HEAD"],
				origins: ["*"],
			},
			exposeHeaders: ["ETag"],
			maxAgeSeconds: 86400,
		},
	],
});

// --- KV namespace for per-PR pointers ---

const pointersKv = new cloudflare.WorkersKvNamespace("preview-pointers", {
	accountId,
	title: "preview-pointers",
});

// --- Worker ---
//
// Bundle is produced by `pnpm --filter worker build` before `pulumi up`
// runs (see .github/workflows/infra.yml). On first ever run, if the
// bundle doesn't exist yet, fall back to a stub so the resource can
// still be created — the next run replaces it with real code.
const workerBundlePath = path.resolve(__dirname, "../worker/dist/index.js");
const workerContent = fs.existsSync(workerBundlePath)
	? fs.readFileSync(workerBundlePath, "utf8")
	: 'export default { async fetch() { return new Response("worker not built yet", { status: 503 }); } };';

const routerWorker = new cloudflare.WorkersScript(workerName, {
	accountId,
	scriptName: workerName,
	content: workerContent,
	mainModule: "index.js",
	compatibilityDate: "2026-04-01",
	bindings: [
		{
			name: "PREVIEWS",
			type: "r2_bucket",
			bucketName: previewsBucket.name,
		},
		{
			name: "POINTERS",
			type: "kv_namespace",
			namespaceId: pointersKv.id,
		},
	],
});

// Note: workers.dev subdomain binding is enabled by default for any
// WorkersScript when the account has claimed a workers.dev subdomain.
// That claim is a one-time manual step in the dashboard — see
// infra/README.md. No explicit Pulumi resource needed.

// --- Outputs ---

export const stateBucketName = stateBucket.name;
export const previewsBucketName = previewsBucket.name;
export const pointersKvId = pointersKv.id;
export const workerScriptName = routerWorker.scriptName;
export const previewsBaseUrl = pulumi.interpolate`https://${workerName}.${accountId}.workers.dev`;
