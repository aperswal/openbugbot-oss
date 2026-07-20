#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
env_file=${OPENBUGBOT_ENV_FILE:-"$repo_root/.env"}

if [ ! -f "$env_file" ]; then
  echo "Missing $env_file. Copy .env.example to .env and fill in the reviewer settings." >&2
  exit 1
fi

set -a
. "$env_file"
set +a

worker_route=${REVIEWER_WORKER_ROUTE:-}
if [ -z "$worker_route" ] && [ -n "${OPENBUGBOT_ENROLL_URL:-}" ]; then
  derived_route=$(node -e '
const value = process.argv[1];
try {
  const url = new URL(value);
  if (url.protocol === "https:" && !url.hostname.endsWith(".workers.dev")) process.stdout.write(url.hostname);
} catch {}
' "$OPENBUGBOT_ENROLL_URL")
  worker_route=$derived_route
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "Missing CLOUDFLARE_API_TOKEN in $env_file" >&2
  exit 1
fi

upload_secrets=false
if [ -n "${GITHUB_WEBHOOK_SECRET:-}" ] || [ -n "${GITHUB_APP_PRIVATE_KEY_FILE:-}" ] || [ -n "${AUTH_ENCRYPTION_PRIVATE_KEY_FILE:-}" ] || [ -n "${AUTH_ENCRYPTION_PUBLIC_KEY_FILE:-}" ]; then
  upload_secrets=true
  for setting in GITHUB_APP_ID GITHUB_WEBHOOK_SECRET GITHUB_APP_PRIVATE_KEY_FILE AUTH_ENCRYPTION_PRIVATE_KEY_FILE AUTH_ENCRYPTION_PUBLIC_KEY_FILE; do
    eval "value=\${$setting:-}"
    if [ -z "$value" ]; then
      echo "Missing $setting in $env_file" >&2
      exit 1
    fi
  done
  for key_file in "$GITHUB_APP_PRIVATE_KEY_FILE" "$AUTH_ENCRYPTION_PRIVATE_KEY_FILE" "$AUTH_ENCRYPTION_PUBLIC_KEY_FILE"; do
    if [ ! -f "$key_file" ]; then
      echo "Missing key file: $key_file" >&2
      exit 1
    fi
  done
fi

cd "$repo_root"
database_id="$(terraform -chdir=infra output -raw d1_database_id)"
queue_name="$(terraform -chdir=infra output -raw review_queue_name)"
container_image="${OPENBUGBOT_CONTAINER_IMAGE:-../../Dockerfile.reviewer}"

node -e '
const fs = require("node:fs");
const [id, queue, image, route] = process.argv.slice(1);
const routeConfig = route ? `\n  "routes": [{ "pattern": ${JSON.stringify(route)}, "custom_domain": true }],` : "";
const source = fs.readFileSync("apps/reviewer/wrangler.jsonc", "utf8")
  .replace("REPLACE_WITH_TERRAFORM_OUTPUT", id)
  .replaceAll("openbugbot-review-jobs", queue)
  .replace("\"image\": \"../../Dockerfile.reviewer\"", `"image": ${JSON.stringify(image)}`)
  .replace("\"workers_dev\": true,", `"workers_dev": true,${routeConfig}`);
fs.writeFileSync("apps/reviewer/.openbugbot.wrangler.jsonc", source);
' "$database_id" "$queue_name" "$container_image" "$worker_route"

if [ "$upload_secrets" = true ]; then
  secrets_file=$(mktemp "${TMPDIR:-/tmp}/openbugbot-reviewer-secrets.XXXXXX")
  trap 'rm -f "$secrets_file"' EXIT HUP INT TERM
  node -e '
const fs = require("node:fs");
const [output] = process.argv.slice(1);
fs.writeFileSync(output, JSON.stringify({
  GITHUB_APP_ID: process.env.GITHUB_APP_ID,
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
  GITHUB_APP_PRIVATE_KEY: fs.readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_FILE, "utf8"),
  AUTH_ENCRYPTION_PRIVATE_KEY: fs.readFileSync(process.env.AUTH_ENCRYPTION_PRIVATE_KEY_FILE, "utf8"),
  AUTH_ENCRYPTION_PUBLIC_KEY: fs.readFileSync(process.env.AUTH_ENCRYPTION_PUBLIC_KEY_FILE, "utf8"),
}), { mode: 0o600 });
' "$secrets_file"
fi

pnpm --filter @openbugbot/reviewer exec wrangler d1 execute openbugbot --remote --file migrations/0001_init.sql --config .openbugbot.wrangler.jsonc
if [ "$upload_secrets" = true ]; then
  pnpm --filter @openbugbot/reviewer exec wrangler deploy --config .openbugbot.wrangler.jsonc --secrets-file "$secrets_file"
else
  echo "No reviewer key files configured; preserving the existing reviewer Worker secrets." >&2
  pnpm --filter @openbugbot/reviewer exec wrangler deploy --config .openbugbot.wrangler.jsonc
fi
