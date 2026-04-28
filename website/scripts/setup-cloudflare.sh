#!/usr/bin/env bash
#
# One-shot Cloudflare Pages + GitHub Secrets bootstrap.
#
# Run from website/ directory:
#   ./scripts/setup-cloudflare.sh
#
# What it does (idempotent — safe to re-run):
#   1. Creates the Cloudflare Pages project (`cockpit-website`)
#   2. Sets the E2B_API_KEY runtime secret used by functions/try.ts
#   3. Attaches custom domain cocking.cc
#   4. Pushes CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID to GitHub repo secrets
#
# Prerequisites (the only manual steps left):
#   - CLOUDFLARE_API_TOKEN  (Cloudflare → My Profile → API Tokens → Create
#     Token with permissions: Account → Cloudflare Pages → Edit)
#   - E2B_API_KEY  (copy from your existing e2b/ Vercel project)
#   - `gh` CLI logged in (`gh auth login`) for pushing GitHub secrets
#
# Easiest: drop the two values into website/.env (gitignored) and run the
# script — it will auto-load that file. See website/.env.example.

set -euo pipefail

PROJECT_NAME="cockpit-website"
PRODUCTION_BRANCH="main"
DOMAIN="cocking.cc"

# ─── auto-load website/.env if present ────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [[ -f "$ENV_FILE" ]]; then
  # `set -a` exports any var assigned in the sourced file
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# ─── helpers ──────────────────────────────────────────────────────────
say()  { printf "\033[36m›\033[0m %s\n" "$*"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[33m!\033[0m %s\n" "$*"; }
fail() { printf "\033[31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

# ─── pre-flight ───────────────────────────────────────────────────────
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || fail "Set CLOUDFLARE_API_TOKEN first (see header comment)."
command -v gh >/dev/null 2>&1 || fail "GitHub CLI 'gh' not found. Install: brew install gh"
# Use a real API call instead of 'gh auth status' — the latter sometimes
# returns non-zero in non-TTY contexts even when auth is fine (keychain quirks).
gh api user --silent 2>/dev/null || fail "Run 'gh auth login' first (or check 'gh auth status')."

# Resolve account ID — prefer explicit override, otherwise fetch via API
if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID"
  ok "Account (from env): $ACCOUNT_ID"
else
  say "Looking up your Cloudflare account ID via API…"
  ACCOUNT_RESP=$(curl -sS --max-time 30 \
    "https://api.cloudflare.com/client/v4/accounts" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" || echo '{"success":false,"errors":["curl_failed"]}')

  if ! echo "$ACCOUNT_RESP" | grep -q '"success":true'; then
    echo "$ACCOUNT_RESP" >&2
    fail "API call failed. Token may lack 'Account → Cloudflare Pages → Edit' or 'Account Settings → Read'."
  fi

  # Extract account IDs.
  # NOTE: `|| true` is critical — grep returns 1 when no match, which under
  # `set -e -o pipefail` would silently kill the script.
  ALL_IDS=$(echo "$ACCOUNT_RESP" | grep -oE '"id"[[:space:]]*:[[:space:]]*"[a-fA-F0-9]+"' | head -10 | sed -E 's/.*"([a-fA-F0-9]+)".*/\1/' || true)
  ACCOUNT_ID=$(echo "$ALL_IDS" | head -1 || true)
  ID_COUNT=$(echo "$ALL_IDS" | grep -c . 2>/dev/null || echo 0)

  if [[ -z "$ACCOUNT_ID" ]]; then
    warn "API succeeded but no account ID could be parsed. Raw response:"
    echo "$ACCOUNT_RESP" | head -c 800 >&2
    echo "" >&2
    fail "Add CLOUDFLARE_ACCOUNT_ID to .env manually (find it at dash.cloudflare.com → right sidebar)."
  fi

  if [[ "$ID_COUNT" -gt 1 ]]; then
    warn "Multiple accounts found, using the first. Set CLOUDFLARE_ACCOUNT_ID in .env to override:"
    echo "$ALL_IDS" | sed 's/^/    - /' >&2
  fi
  ok "Account: $ACCOUNT_ID"
fi

# ─── 1. Create Pages project (idempotent) ─────────────────────────────
say "Creating Pages project '$PROJECT_NAME'…"
if npx wrangler pages project list 2>/dev/null | grep -q "^$PROJECT_NAME\b"; then
  ok "Project already exists, skipping."
else
  npx wrangler pages project create "$PROJECT_NAME" \
    --production-branch="$PRODUCTION_BRANCH"
  ok "Project created."
fi

# ─── 2. Push runtime secret ───────────────────────────────────────────
if [[ -z "${E2B_API_KEY:-}" ]]; then
  printf "\n"
  read -rsp "Paste E2B_API_KEY (input hidden): " E2B_API_KEY
  printf "\n"
fi
say "Uploading E2B_API_KEY to Pages project…"
printf "%s" "$E2B_API_KEY" | npx wrangler pages secret put E2B_API_KEY \
  --project-name="$PROJECT_NAME"
ok "Secret uploaded."

# ─── 3. Attach custom domain via API (no CLI for this) ────────────────
say "Attaching custom domain '$DOMAIN'…"
domain_response=$(curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT_NAME/domains" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data "{\"name\":\"$DOMAIN\"}")

# Tolerate the optional whitespace Cloudflare sometimes inserts after the colon.
if echo "$domain_response" | grep -qE '"success":[[:space:]]*true'; then
  # Status may be "initializing" right after first bind — Cloudflare runs an
  # HTTP-01 challenge in the background (a few minutes). That's normal.
  if echo "$domain_response" | grep -qE '"status":[[:space:]]*"initializing"'; then
    ok "Domain attached (status: initializing — TLS cert auto-provisions in ~5 min)."
  else
    ok "Domain attached."
  fi
elif echo "$domain_response" | grep -q "already exists"; then
  ok "Domain already attached."
else
  warn "Domain attach response: $domain_response"
  warn "You may need to: 1) bind cocking.cc to Cloudflare DNS, or 2) attach manually via dashboard."
fi

# ─── 4. Push secrets to GitHub repo ───────────────────────────────────
say "Pushing CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID to GitHub…"
gh secret set CLOUDFLARE_API_TOKEN --body "$CLOUDFLARE_API_TOKEN"
gh secret set CLOUDFLARE_ACCOUNT_ID --body "$ACCOUNT_ID"
ok "GitHub secrets set."

# ─── done ─────────────────────────────────────────────────────────────
printf "\n"
ok "All set. Push a commit that touches website/** and the workflow takes over."
echo "  https://github.com/Surething-io/cockpit/actions/workflows/website-deploy.yml"
