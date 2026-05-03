#!/usr/bin/env bash
# Mint (or rotate) the Cloudflare API token described by
# infra/token-policy.json.
#
# The policy file is the source of truth. To add/remove a permission,
# edit the file and re-run this script — never click through the
# Cloudflare dashboard.
#
# Required env:
#   CLOUDFLARE_ACCOUNT_ID
#   CF_BOOTSTRAP_AUTH  — one of:
#                          "token:<tok>"         (existing token with User API Tokens → Edit)
#                          "global:<email>:<k>"  (Global API Key)
#                          "wrangler"            (read ~/.wrangler/config/default.toml)
#
# Prints the new token value on stdout. Pipe into:
#   gh secret set CLOUDFLARE_API_TOKEN

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
POLICY="${POLICY:-$HERE/../token-policy.json}"

: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${CF_BOOTSTRAP_AUTH:?set CF_BOOTSTRAP_AUTH (token:..., global:EMAIL:KEY, or wrangler)}"
[[ -f "$POLICY" ]] || { echo "policy file not found: $POLICY" >&2; exit 1; }

case "$CF_BOOTSTRAP_AUTH" in
	token:*)
		AUTH_HEADERS=(-H "Authorization: Bearer ${CF_BOOTSTRAP_AUTH#token:}") ;;
	global:*)
		rest="${CF_BOOTSTRAP_AUTH#global:}"
		AUTH_HEADERS=(-H "X-Auth-Email: ${rest%%:*}" -H "X-Auth-Key: ${rest#*:}") ;;
	wrangler)
		TOK=$(awk -F'"' '/^oauth_token/ {print $2; exit}' "$HOME/.wrangler/config/default.toml" 2>/dev/null || true)
		[[ -n "$TOK" ]] || { echo "no wrangler token found; run 'wrangler login' first" >&2; exit 1; }
		AUTH_HEADERS=(-H "Authorization: Bearer $TOK") ;;
	*) echo "bad CF_BOOTSTRAP_AUTH format" >&2; exit 2 ;;
esac

api() { curl -sSf "${AUTH_HEADERS[@]}" -H "Content-Type: application/json" "$@"; }

# --- Read policy ---
NAME=$(jq -r '.name' "$POLICY")
TTL_DAYS=$(jq -r '.ttl_days' "$POLICY")
WANTED_NAMES=$(jq -r '.permissions[].name' "$POLICY")

# --- Resolve permission-group names → IDs ---
# Permission groups are stable but their IDs aren't documented inline;
# Cloudflare recommends looking them up by name. We fail loudly if a
# name in the policy doesn't match anything live, so typos don't
# silently produce under-scoped tokens.
echo "resolving permission group IDs..." >&2
GROUPS=$(api "https://api.cloudflare.com/client/v4/user/tokens/permission_groups?per_page=200")

ID_JSON=$(echo "$WANTED_NAMES" | while IFS= read -r name; do
	id=$(jq -r --arg n "$name" '.result[] | select(.name == $n) | .id' <<<"$GROUPS")
	if [[ -z "$id" || "$id" == "null" ]]; then
		echo "ERROR: no permission group named '$name' found" >&2
		echo "candidates containing similar text:" >&2
		word=$(awk '{print $1}' <<<"$name")
		jq -r --arg w "$word" '.result[] | select(.name | test($w; "i")) | "  \(.id)  \(.name)"' <<<"$GROUPS" >&2
		exit 1
	fi
	jq -n --arg id "$id" '{id: $id, meta: {}}'
done | jq -s '.')

# --- Build payload ---
# Omit `expires_on` entirely when the policy says ttl_days is null —
# Cloudflare treats that as "no expiration". Manual revocation only.
ACCOUNT_RESOURCE="com.cloudflare.api.account.$CLOUDFLARE_ACCOUNT_ID"

if [[ "$TTL_DAYS" == "null" || -z "$TTL_DAYS" ]]; then
	EXPIRES_DISPLAY="never (manual revocation only)"
	BODY=$(jq -n \
		--arg name "$NAME (rotated $(date -u +%Y-%m-%d))" \
		--arg acct "$ACCOUNT_RESOURCE" \
		--argjson groups "$ID_JSON" \
		'{
			name: $name,
			policies: [{
				effect: "allow",
				permission_groups: $groups,
				resources: { ($acct): "*" }
			}]
		}')
else
	EXPIRES=$(date -u -d "+$TTL_DAYS days" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
		|| date -u -v+"${TTL_DAYS}"d +%Y-%m-%dT%H:%M:%SZ)
	EXPIRES_DISPLAY="$EXPIRES"
	BODY=$(jq -n \
		--arg name "$NAME (rotated $(date -u +%Y-%m-%d))" \
		--arg acct "$ACCOUNT_RESOURCE" \
		--arg exp  "$EXPIRES" \
		--argjson groups "$ID_JSON" \
		'{
			name: $name,
			policies: [{
				effect: "allow",
				permission_groups: $groups,
				resources: { ($acct): "*" }
			}],
			expires_on: $exp
		}')
fi

echo "creating token '$NAME' (expires: $EXPIRES_DISPLAY)..." >&2
jq -r '.permission_groups[] | "  + \(.)"' <<<"$(echo "$WANTED_NAMES" | jq -R . | jq -s '{permission_groups: .}')" >&2

RESP=$(api -X POST "https://api.cloudflare.com/client/v4/user/tokens" --data "$BODY")
if [[ "$(jq -r '.success' <<<"$RESP")" != "true" ]]; then
	echo "token creation failed:" >&2
	jq . <<<"$RESP" >&2
	exit 1
fi

jq -r '.result.value' <<<"$RESP"
