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

**No long-lived Cloudflare secrets are stored anywhere.** GitHub Actions
authenticates to Cloudflare via OIDC federation:

```
GitHub OIDC JWT ──► Cloudflare API token (~1h TTL)
                    └─► R2 S3 temp credentials (~1h TTL, via /r2/temp-access-credentials)
                        └─► Pulumi state backend  (pulumi login s3://pulumi-state?…)
                        └─► aws s3 sync to vscode-web-base   (upload-vscode-web-base workflow)
```

This flow is implemented identically in
[`.github/workflows/infra.yml`](../.github/workflows/infra.yml) and
[`.github/workflows/upload-vscode-web-base.yml`](../.github/workflows/upload-vscode-web-base.yml).

## One-time bootstrap (manual)

These steps are **not** Pulumi-managed because they're required for
Pulumi itself to run, or because the Cloudflare provider doesn't cover
them yet.

### 1. Create an OIDC trust policy in Cloudflare

In the Cloudflare dashboard:

1. Go to **Manage Account → API Tokens → Trusted Issuers**.
2. Add `https://token.actions.githubusercontent.com` as a trusted issuer.
3. Add a **Token Policy** that trusts JWTs where:
   - `iss = https://token.actions.githubusercontent.com`
   - `aud = cloudflare`
   - `repository = jeffwilde/vscode-all-the-blame`
4. Grant the resulting identity these permissions:
   - Account → R2 Storage → Edit
   - Account → Workers R2 Storage → Edit
   - Account → Pages → Edit
5. Save the policy ID somewhere; the `cloudflare-login-action` auto-
   discovers it from the account ID + audience.

### 2. Create the `pulumi-state` R2 bucket manually

Pulumi uses this bucket as its state backend, so it has to exist
*before* Pulumi can run. Create it via `wrangler`:

```sh
# One-time, with a local scoped API token that has R2:Edit
npx wrangler r2 bucket create pulumi-state
```

After the first `pulumi up`, this bucket is fully managed declaratively
in `index.ts` — but it keeps its contents, so the bootstrap remains
self-consistent.

### 3. Set the `CLOUDFLARE_ACCOUNT_ID` repo variable

```sh
gh variable set CLOUDFLARE_ACCOUNT_ID --body "<your account id>"
```

### 4. Set the `PULUMI_CONFIG_PASSPHRASE` repo secret

Used to encrypt Pulumi state secrets. No secrets are currently stored
in this stack, but the passphrase is required by the self-hosted
backend anyway.

```sh
gh secret set PULUMI_CONFIG_PASSPHRASE
```

### 5. Create the Cloudflare Pages ↔ GitHub connection

Cloudflare's provider *can* define a Pages project, but the GitHub OAuth
connection (which requires dashboard interaction) is NOT declarative.
One-time:

1. Dashboard → **Pages → Overview → Connect to Git**.
2. Authorize Cloudflare's GitHub app on `jeffwilde/vscode-all-the-blame`.
3. Do not configure the build here — Pulumi does that. Just finish the
   OAuth handshake so Pulumi can reference the repo by name.

After step 5, `pulumi up` on `main` takes over and every PR gets a
preview at `https://<sha>.all-the-blame-preview.pages.dev`.

### 6. Seed the shared `vscode-web-base` bucket

Trigger the **Upload vscode-web base** workflow once:

```sh
gh workflow run upload-vscode-web-base.yml
```

This populates `vscode-web-base/<version>/` and `vscode-web-base/latest/`
with the current stable vscode-web tarball, unpacked. Re-run it when
you want to bump the base (typically once per VS Code release).

## Running Pulumi locally

For ad-hoc inspection (read-only is fine):

```sh
cd infra
pnpm install

# Mint a short-lived Cloudflare token locally (OIDC requires GitHub
# Actions — for local use, create a scoped API token with R2:Edit +
# Pages:Edit and export it):
export CLOUDFLARE_API_TOKEN=<token>

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
pulumi preview --stack production
```

Never run `pulumi up` from a developer laptop against production. The
canonical path is PR → `infra.yml` comment → merge to main → `pulumi up`
runs in Actions.
