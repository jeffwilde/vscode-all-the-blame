# Infrastructure (Pulumi + Cloudflare)

All the Cloudflare resources for the All the Blame public preview are
declared in [`index.ts`](./index.ts) and managed by Pulumi.

## What lives here

| Resource | Purpose |
| --- | --- |
| R2 bucket `pulumi-state` | Self-hosted Pulumi state backend (no Pulumi Cloud). State for this project lives under the `jeffwilde/` prefix so the bucket can host other projects later. |
| R2 bucket `previews` | All preview assets: `base/<ver>/…`, `pr/<n>/<sha>/…`, `main/<sha>/…` |
| KV namespace `preview-pointers` | Atomic per-PR SHA pointers (`pr:<n>` → `<sha>`) |
| Worker `preview-router` | Routes `/pr/<n>/…` requests to the current SHA via KV lookup |

The Worker is a path-based router, so per-PR previews live at
`https://preview-router.<your-subdomain>.workers.dev/pr/<n>/`. No
custom domain or Pages integration required.

## How credentials work

Cloudflare does **not** currently support OIDC federation for its own
API (as of April 2026 — see
[cloudflare/wrangler-action#402](https://github.com/cloudflare/wrangler-action/issues/402)).
So authentication is a long-lived, narrowly-scoped API token stored as
a GitHub repo secret, with short-lived R2 S3 credentials derived from
it at runtime:

```
CLOUDFLARE_API_TOKEN  (repo secret, manual revocation only)
   └─► POST /r2/temp-access-credentials  ──►  AWS_ACCESS_KEY_ID/... (~1h TTL)
   │    └─► pulumi login s3://pulumi-state/jeffwilde?…      (state backend)
   │    └─► aws s3 sync previews/…                          (per-PR upload)
   │
   └─► Pulumi Cloudflare provider                           (manages all resources)
   └─► POST /accounts/.../storage/kv/.../values/pr:N         (KV pointer flip)
```

The parent token is used directly by Pulumi and the KV writes, and is
used once per run to mint temp S3 creds for R2 operations. Pulumi's
own state-backend credentials are always short-lived.

The `/r2/temp-access-credentials` endpoint requires a `parentAccessKeyId`
field — the **token id** of an R2-capable parent token, which scopes
the derived temp creds. The mint script emits this id to stderr on
each run; we store it as the repo variable
`CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID` (non-secret, rotates with the
token).

## One-time bootstrap (manual)

### 1. Claim a workers.dev subdomain

The Worker is served at `<worker-name>.<your-subdomain>.workers.dev`.
Pick the subdomain once:

Dashboard → **Workers & Pages → Overview → Subdomain** → pick
something like `jeffwilde.workers.dev`. Permanent-ish (changing it
breaks existing URLs).

### 2. Create a scoped Cloudflare API token (token-as-code)

Permissions are declared in [`token-policy.json`](./token-policy.json)
— **that file is the source of truth**. Never pick permissions by
clicking through the Cloudflare dashboard.

```sh
export CLOUDFLARE_ACCOUNT_ID=<32-char account id>

# Bootstrap auth (used ONCE, then discarded):
export CF_BOOTSTRAP_AUTH="global:<email>:<global-api-key>"
# or: export CF_BOOTSTRAP_AUTH="token:<existing-token-with-User-API-Tokens-Edit>"
# or: export CF_BOOTSTRAP_AUTH="wrangler"

infra/scripts/mint-infra-token.sh | gh secret set CLOUDFLARE_API_TOKEN
```

The token has no expiration — revoke manually in the dashboard if
needed. To add/remove a permission: edit `token-policy.json`, commit,
re-run the mint script.

Verify:

```sh
infra/scripts/inspect-token.sh --diff
# → "live token matches policy."
```

### 3. Pre-create the `pulumi-state` R2 bucket

Pulumi's state backend can't exist until the bucket does:

```sh
CLOUDFLARE_API_TOKEN=<the token you just minted> \
  npx wrangler r2 bucket create pulumi-state
```

### 4. Set repo variables + secrets

```sh
gh variable set CLOUDFLARE_ACCOUNT_ID --body "<account id>"
gh variable set CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID --body "<token id from step 2>"
gh secret set PULUMI_CONFIG_PASSPHRASE                    # prompts
```

`CLOUDFLARE_API_TOKEN` should already be set from step 2.
`CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID` is the token id printed to stderr
by `mint-infra-token.sh`; the temp-credentials endpoint won't accept a
request without it.
`PULUMI_CONFIG_PASSPHRASE` encrypts Pulumi state secrets (nothing is
currently encrypted but the backend requires it).

### 5. Run the Infrastructure workflow

Push an empty commit or run:

```sh
gh workflow run infra.yml
```

This creates the `previews` bucket, `preview-pointers` KV namespace,
and `preview-router` Worker. On success the workflow emits outputs
including `pointersKvId`.

### 6. Capture the KV ID as a repo variable

The per-PR deploy workflow needs to know the KV namespace ID to flip
pointers, but Pulumi outputs live in the state bucket (not
convenient to fetch per-PR). Copy the ID into a repo variable once:

```sh
# From the Pulumi workflow output, or via `pulumi stack output` locally:
gh variable set POINTERS_KV_ID --body "<32-char id from infra workflow output>"
```

### 7. Seed the shared vscode-web base (optional)

If you want per-PR deploys to be ~1 MB instead of ~120 MB each,
upload the vscode-web tarball to R2 once:

```sh
gh workflow run upload-vscode-web-base.yml
```

This populates `previews/base/<version>/` and `previews/base/latest/`.
Re-run when you want to bump the VS Code release.

## Token rotation

Tokens don't expire, but rotate if you suspect compromise:

```sh
# Same command as bootstrap — emits a new token, overwrites the secret.
# The new token id is printed to stderr; copy it into the repo variable.
infra/scripts/mint-infra-token.sh | gh secret set CLOUDFLARE_API_TOKEN
gh variable set CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID --body "<id from stderr>"

# Delete the old token in the dashboard:
#   https://dash.cloudflare.com/profile/api-tokens
```

## Running Pulumi locally

For ad-hoc inspection (read-only is fine):

```sh
cd infra
pnpm install

export CLOUDFLARE_API_TOKEN=<your scoped token>
export CLOUDFLARE_ACCOUNT_ID=<account id>

# Mint R2 S3 creds (same curl as the workflow):
export CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID=<token id from mint script's stderr>
RESP=$(curl -sSf -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/temp-access-credentials" \
  -d "{\"bucket\":\"pulumi-state\",\"parentAccessKeyId\":\"$CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID\",\"permission\":\"admin-read-write\",\"ttlSeconds\":3600}")
export AWS_ACCESS_KEY_ID=$(echo "$RESP" | jq -r '.result.accessKeyId')
export AWS_SECRET_ACCESS_KEY=$(echo "$RESP" | jq -r '.result.secretAccessKey')
export AWS_SESSION_TOKEN=$(echo "$RESP" | jq -r '.result.sessionToken')

# Build the worker bundle first — Pulumi reads it at program time:
(cd ../worker && pnpm install && pnpm run build)

pulumi login "s3://pulumi-state/jeffwilde?endpoint=$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com&region=auto&s3ForcePathStyle=true"
pulumi stack select production
pulumi preview
```

Never run `pulumi up` from a developer laptop against production. The
canonical path is PR → `infra.yml` comment → merge to main →
`pulumi up` runs in Actions.
