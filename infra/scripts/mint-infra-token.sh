#!/usr/bin/env bash
# Bootstraps the scoped Cloudflare API token for the infra pipeline
# without dashboard clicking. Reads:
#   CLOUDFLARE_ACCOUNT_ID  — your account ID
#   CF_BOOTSTRAP_AUTH      — how to auth this one-time request:
#                            either "token:<token-with-User-API-Tokens-Edit>"
#                            or "global:<email>:<global-api-key>"
#
# Emits on stdout the newly-minted scoped token value. Pipe into
#   gh secret set CLOUDFLARE_API_TOKEN
# or copy by hand. It is ONLY shown once (never retrievable again).

set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${CF_BOOTSTRAP_AUTH:?set CF_BOOTSTRAP_AUTH to 'token:...' or 'global:EMAIL:KEY'}"

case "$CF_BOOTSTRAP_AUTH" in
  token:*)
    AUTH_HEADERS=(-H "Authorization: Bearer ${CF_BOOTSTRAP_AUTH#token:}") ;;
  global:*)
    rest="${CF_BOOTSTRAP_AUTH#global:}"
    AUTH_HEADERS=(
      -H "X-Auth-Email: ${rest%%:*}"
      -H "X-Auth-Key: ${rest#*:}"
    ) ;;
  *) echo "bad CF_BOOTSTRAP_AUTH format" >&2; exit 2 ;;
esac

api() { curl -sSf "${AUTH_HEADERS[@]}" -H "Content-Type: application/json" "$@"; }

# 1. Find the permission_group IDs for "Workers R2 Storage Edit" and
#    "Cloudflare Pages Edit". The names/IDs are stable but not
#    documented inline, so we look them up.
echo "discovering permission group IDs..." >&2
GROUPS=$(api "https://api.cloudflare.com/client/v4/user/tokens/permission_groups")

R2_ID=$(jq -r '.result[] | select(.name == "Workers R2 Storage Write") | .id' <<<"$GROUPS")
PAGES_ID=$(jq -r '.result[] | select(.name == "Pages Write") | .id' <<<"$GROUPS")

# Cloudflare renames permission groups occasionally. If these fail,
# grep the dump below for the right names. "Write" is the edit-level;
# there's also "Workers R2 Storage Read" / "Pages Read" for readonly.
if [[ -z "$R2_ID" || "$R2_ID" == "null" ]]; then
  echo "couldn't find R2 write permission group. Available R2 groups:" >&2
  jq -r '.result[] | select(.name | test("R2"; "i")) | "\(.id)\t\(.name)"' <<<"$GROUPS" >&2
  exit 1
fi
if [[ -z "$PAGES_ID" || "$PAGES_ID" == "null" ]]; then
  echo "couldn't find Pages write permission group. Available Pages groups:" >&2
  jq -r '.result[] | select(.name | test("Pages"; "i")) | "\(.id)\t\(.name)"' <<<"$GROUPS" >&2
  exit 1
fi
echo "R2 Write:    $R2_ID"    >&2
echo "Pages Write: $PAGES_ID" >&2

# 2. Expiry: 90 days from now, RFC3339.
EXPIRES=$(date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
       || date -u -v+90d +%Y-%m-%dT%H:%M:%SZ)

# 3. Build the token request. Single policy, both permission groups,
#    scoped to the target account only.
BODY=$(jq -n \
  --arg name   "all-the-blame-infra (auto, rotate quarterly)" \
  --arg acct   "com.cloudflare.api.account.$CLOUDFLARE_ACCOUNT_ID" \
  --arg r2     "$R2_ID" \
  --arg pages  "$PAGES_ID" \
  --arg expire "$EXPIRES" \
  '{
     name: $name,
     policies: [{
       effect: "allow",
       permission_groups: [
         { id: $r2,    meta: {} },
         { id: $pages, meta: {} }
       ],
       resources: { ($acct): "*" }
     }],
     expires_on: $expire
   }')

echo "creating token..." >&2
RESP=$(api -X POST \
  "https://api.cloudflare.com/client/v4/user/tokens" \
  --data "$BODY")

if [[ "$(jq -r '.success' <<<"$RESP")" != "true" ]]; then
  echo "token creation failed:" >&2
  jq . <<<"$RESP" >&2
  exit 1
fi

# 4. Print token value on stdout (everything diagnostic is on stderr).
jq -r '.result.value' <<<"$RESP"
