#!/usr/bin/env bash
# Introspect live Cloudflare API tokens and diff their permissions
# against infra/token-policy.json.
#
# Answers the questions:
#   "what did I pick when I created this token?"
#   "does the live token match what the policy file says?"
#   "is there a drift / missing permission?"
#
# Usage:
#   infra/scripts/inspect-token.sh                 # list all tokens + highlight policy match
#   infra/scripts/inspect-token.sh <token-id>      # show one token's permissions in detail
#   infra/scripts/inspect-token.sh --diff          # diff matching token against policy file
#
# Required env:
#   CF_BOOTSTRAP_AUTH  — same format as mint-infra-token.sh

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
POLICY="${POLICY:-$HERE/../token-policy.json}"

: "${CF_BOOTSTRAP_AUTH:?set CF_BOOTSTRAP_AUTH (token:..., global:EMAIL:KEY, or wrangler)}"

case "$CF_BOOTSTRAP_AUTH" in
	token:*)  AUTH_HEADERS=(-H "Authorization: Bearer ${CF_BOOTSTRAP_AUTH#token:}") ;;
	global:*) rest="${CF_BOOTSTRAP_AUTH#global:}"
	          AUTH_HEADERS=(-H "X-Auth-Email: ${rest%%:*}" -H "X-Auth-Key: ${rest#*:}") ;;
	wrangler) TOK=$(awk -F'"' '/^oauth_token/ {print $2; exit}' "$HOME/.wrangler/config/default.toml" 2>/dev/null || true)
	          [[ -n "$TOK" ]] || { echo "no wrangler token" >&2; exit 1; }
	          AUTH_HEADERS=(-H "Authorization: Bearer $TOK") ;;
	*) echo "bad CF_BOOTSTRAP_AUTH format" >&2; exit 2 ;;
esac

api() { curl -sSf "${AUTH_HEADERS[@]}" -H "Content-Type: application/json" "$@"; }

MODE="${1:-list}"

# Load the permission-group name→id map once (saves API calls below).
GROUPS=$(api "https://api.cloudflare.com/client/v4/user/tokens/permission_groups")
id_to_name() { jq -r --arg id "$1" '.result[] | select(.id == $id) | .name' <<<"$GROUPS"; }

case "$MODE" in
	list)
		# List every token on the user with a ✓ next to any whose name
		# starts with the policy's name.
		POLICY_NAME=$(jq -r '.name' "$POLICY")
		TOKS=$(api "https://api.cloudflare.com/client/v4/user/tokens")
		jq -r --arg match "$POLICY_NAME" '
			.result[]
			| [
				(if (.name | startswith($match)) then "✓" else " " end),
				.id,
				.status,
				(.expires_on // "no-expiry"),
				.name
			  ]
			| @tsv' <<<"$TOKS" \
			| column -t -s $'\t' -N 'MATCH,ID,STATUS,EXPIRES,NAME'
		echo
		echo "hint: infra/scripts/inspect-token.sh <ID>  — show a single token's permissions" >&2
		echo "      infra/scripts/inspect-token.sh --diff — compare against token-policy.json" >&2
		;;

	--diff)
		# Find the token whose name matches the policy, fetch it, and
		# diff its permission-group names against the policy.
		POLICY_NAME=$(jq -r '.name' "$POLICY")
		TOKS=$(api "https://api.cloudflare.com/client/v4/user/tokens")
		MATCHES=$(jq -r --arg match "$POLICY_NAME" \
			'.result[] | select(.name | startswith($match)) | select(.status == "active") | .id' \
			<<<"$TOKS")
		COUNT=$(wc -l <<<"$MATCHES" | tr -d ' ')
		if [[ -z "$MATCHES" ]]; then
			echo "no active token matching '$POLICY_NAME*' — run mint-infra-token.sh" >&2
			exit 1
		fi
		if [[ "$COUNT" -gt 1 ]]; then
			echo "WARNING: multiple active tokens match '$POLICY_NAME*'. Using the newest." >&2
		fi
		TOKEN_ID=$(head -1 <<<"$MATCHES")
		DETAIL=$(api "https://api.cloudflare.com/client/v4/user/tokens/$TOKEN_ID")

		WANTED=$(jq -r '.permissions[].name' "$POLICY" | sort)
		ACTUAL=$(jq -r '.result.policies[].permission_groups[].id' <<<"$DETAIL" \
			| while read -r id; do id_to_name "$id"; done | sort -u)

		echo "token id:   $TOKEN_ID"
		echo "policy file: $POLICY"
		echo
		# Show the three-way diff: in-both, policy-only (missing), token-only (extra).
		comm -12 <(echo "$WANTED") <(echo "$ACTUAL") | sed 's/^/  = /'
		MISSING=$(comm -23 <(echo "$WANTED") <(echo "$ACTUAL") | sed 's/^/  - /')
		EXTRA=$(  comm -13 <(echo "$WANTED") <(echo "$ACTUAL") | sed 's/^/  + /')
		[[ -n "$MISSING" ]] && echo "$MISSING  (in policy, not in live token)"
		[[ -n "$EXTRA"   ]] && echo "$EXTRA  (in live token, not in policy)"

		if [[ -z "$MISSING" && -z "$EXTRA" ]]; then
			echo "live token matches policy."
		else
			echo
			echo "drift detected — re-run mint-infra-token.sh to realign." >&2
			exit 2
		fi
		;;

	*)
		# Treat the arg as a token ID.
		DETAIL=$(api "https://api.cloudflare.com/client/v4/user/tokens/$MODE")
		echo "name:      $(jq -r '.result.name'       <<<"$DETAIL")"
		echo "status:    $(jq -r '.result.status'     <<<"$DETAIL")"
		echo "expires:   $(jq -r '.result.expires_on' <<<"$DETAIL")"
		echo "policies:"
		jq -r '.result.policies[] | "  effect: \(.effect)\n  resources: \(.resources | keys | join(", "))"' <<<"$DETAIL"
		echo "permission groups:"
		jq -r '.result.policies[].permission_groups[].id' <<<"$DETAIL" \
			| while read -r id; do echo "  $id  $(id_to_name "$id")"; done
		;;
esac
