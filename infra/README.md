# Infrastructure (Pulumi + Cloudflare)

All the long-lived Cloudflare resources for the All the Blame public
preview are declared in [`index.ts`](./index.ts) and managed by Pulumi.

## What lives here

| Resource | Purpose |
| --- | --- |
| R2 bucket `pulumi-state` | Self-hosted Pulumi state backend (no Pulumi Cloud) |
| R2 bucket `vscode-web-base` | Versioned vscode-web tarball extracts, shared by every PR preview |
| Cloudflare Pages project `all-the-blame-preview` | GitHub-connected project that builds per-PR previews |

## How credentials work

Cloudflare does **not** currently support OIDC federation for its own
API (as of April 2026 — see
[cloudflare/wrangler-action#402](https://github.com/cloudflare/wrangler-action/issues/402)
and the open [community feature request](https://community.cloudflare.com/t/openid-connect-authentication-for-cloudflare-api/492897)).
So authentication is a long-lived, narrowly-scoped API token stored as
a GitHub repo secret, with short-lived R2 S3 credentials derived from
it at runtime:

```
CLOUDFLARE_API_TOKEN (repo secret, 90-day rotation, R2+Pages Edit only)
   └─► POST /r2/temp-access-credentials   ──►  AWS_ACCESS_KEY_ID/...   (~1h TTL)
        └─► pulumi login s3://pulumi-state?…                        (state backend)
        └─► aws s3 sync ...vscode-web-base/                         (base uploader)
```

The parent token is used only to mint the 1-hour S3 creds — it's never
passed to Pulumi, so even a compromised `pulumi/actions` cache can't
leak the long-lived credential. Rotating the parent token invalidates
all outstanding short-lived sessions too.

This flow is implemented identically in
[`.github/workflows/infra.yml`](../.github/workflows/infra.yml) and
[`.github/workflows/upload-vscode-web-base.yml`](../.github/workflows/upload-vscode-web-base.yml).

## One-time bootstrap (manual)

### 1. Create a scoped Cloudflare API token

Dashboard → **My Profile → API Tokens → Create Token → Custom Token**.

Permissions:
- **Account → Workers R2 Storage → Edit**   (bucket CRUD, managed domain, CORS, temp-access-credentials)
- **Account → Cloudflare Pages → Edit**     (create/update the Pages project)

Account Resources:
- **Include → your account only** (do NOT leave as "All accounts")

Optional but recommended:
- **Client IP Address Filtering** — restrict to GitHub Actions'
  published egress ranges (`https://api.github.com/meta` → `actions`).
  GitHub publishes these; they change occasionally so add a calendar
  reminder to re-check.
- **TTL**: 90 days. Calendar a rotation.

Save the generated token — you see it exactly once.

### 2. Pre-create the `pulumi-state` R2 bucket

Pulumi uses this bucket as its state backend, so it has to exist
*before* Pulumi can run. One-time via `wrangler` (or the dashboard):

```sh
CLOUDFLARE_API_TOKEN=<token-from-step-1> \
  npx wrangler r2 bucket create pulumi-state
```

After the first `pulumi up`, this bucket is also declaratively managed
in `index.ts` — but it keeps its contents, so the bootstrap remains
self-consistent.

### 3. Set repo variables + secrets

```sh
gh variable set CLOUDFLARE_ACCOUNT_ID --body "<32-char account id>"
gh secret   set CLOUDFLARE_API_TOKEN  --body "<token from step 1>"
gh secret   set PULUMI_CONFIG_PASSPHRASE                    # prompts
```

`PULUMI_CONFIG_PASSPHRASE` encrypts Pulumi state secrets. Nothing
secret is currently stored in this stack, but the self-hosted backend
requires the passphrase to be set anyway.

### 4. Create the Cloudflare Pages ↔ GitHub connection

Cloudflare's provider can define a Pages project, but the GitHub OAuth
connection (which requires dashboard interaction) is **not**
declarative. One-time:

1. Dashboard → **Pages → Overview → Connect to Git**.
2. Authorize Cloudflare's GitHub app on `jeffwilde/vscode-all-the-blame`.
3. Do not configure the build here — Pulumi does that. Just finish the
   OAuth handshake so Pulumi can reference the repo by name.

After step 4, `pulumi up` on `main` takes over and every PR gets a
preview at `https://<sha>.all-the-blame-preview.pages.dev`.

### 5. Seed the shared `vscode-web-base` bucket

Trigger the **Upload vscode-web base** workflow once:

```sh
gh workflow run upload-vscode-web-base.yml
```

This populates `vscode-web-base/<version>/` and `vscode-web-base/latest/`
with the current stable vscode-web tarball, unpacked. Re-run it when
you want to bump the base (typically once per VS Code release).

## Token rotation runbook (every ~90 days)

1. Create a new token with the exact same scopes (step 1 above).
2. `gh secret set CLOUDFLARE_API_TOKEN --body "<new token>"`.
3. Re-run the `Infrastructure` workflow (`gh workflow run infra.yml`)
   to verify the new token works.
4. Delete the old token in the Cloudflare dashboard.

If you need emergency revocation, step 4 alone (revoke in dashboard)
invalidates all outstanding short-lived S3 sessions derived from the
token within minutes.

## Running Pulumi locally

For ad-hoc inspection (read-only is fine):

```sh
cd infra
pnpm install

export CLOUDFLARE_API_TOKEN=<your scoped token>
export CLOUDFLARE_ACCOUNT_ID=<account id>

# Mint R2 S3 creds (same curl as the workflow):
RESP=$(curl -sSf -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/temp-access-credentials" \
  -d '{"bucket":"pulumi-state","permission":"admin-read-write","ttlSeconds":3600}')
export AWS_ACCESS_KEY_ID=$(echo "$RESP" | jq -r '.result.accessKeyId')
export AWS_SECRET_ACCESS_KEY=$(echo "$RESP" | jq -r '.result.secretAccessKey')
export AWS_SESSION_TOKEN=$(echo "$RESP" | jq -r '.result.sessionToken')

pulumi login "s3://pulumi-state?endpoint=$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com&region=auto&s3ForcePathStyle=true"
pulumi stack select production
pulumi preview
```

Never run `pulumi up` from a developer laptop against production. The
canonical path is PR → `infra.yml` comment → merge to main → `pulumi up`
runs in Actions.
