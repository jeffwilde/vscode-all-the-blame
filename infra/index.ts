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
// The cloudflare provider in v5 doesn't accept `accountId` as a
// provider-level config key, so we can't use `pulumi.Config("cloudflare")`.
// Read it straight from the env var the workflow already sets.
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!accountId) {
	throw new Error("CLOUDFLARE_ACCOUNT_ID env var is required");
}
const workerName = cfg.get("workerName") ?? "preview-router";

// --- R2 buckets ---

// pulumi-state is pre-created during bootstrap (it has to exist before
// Pulumi's own state backend can use it). `import:` adopts it into
// Pulumi state on first apply; after that it's a no-op and could be
// removed on a future cleanup pass.
// Location must match the bucket as-created — it's a force-new
// attribute, and the bucket was provisioned in ENAM during bootstrap.
const stateBucket = new cloudflare.R2Bucket(
	"pulumi-state",
	{
		accountId,
		name: "pulumi-state",
		location: "ENAM",
	},
	{ import: `${accountId}/pulumi-state` },
);

const previewsBucket = new cloudflare.R2Bucket("previews", {
	accountId,
	name: "previews",
	location: "WNAM",
});

// CORS for the previews bucket is applied by a post-Pulumi step in
// .github/workflows/infra.yml — @pulumi/cloudflare v5 dropped the
// R2BucketCors resource and the v6 successor isn't released yet.

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
	name: workerName,
	content: workerContent,
	module: true,
	compatibilityDate: "2026-04-01",
	r2BucketBindings: [
		{
			name: "PREVIEWS",
			bucketName: previewsBucket.name,
		},
	],
	kvNamespaceBindings: [
		{
			name: "POINTERS",
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
export const workerScriptName = routerWorker.name;
export const previewsBaseUrl = pulumi.interpolate`https://${workerName}.${accountId}.workers.dev`;
