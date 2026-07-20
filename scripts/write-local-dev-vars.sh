#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
env_file=${OPENBUGBOT_ENV_FILE:-"$repo_root/.env"}

if [ ! -f "$env_file" ]; then
  echo "Missing $env_file. Copy .env.example to .env first." >&2
  exit 1
fi

set -a
. "$env_file"
set +a

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

node -e '
const fs = require("node:fs");
const [reviewerPath] = process.argv.slice(1);
const dotenv = (values) => `${Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\\n")}\\n`;
fs.writeFileSync(reviewerPath, dotenv({
  GITHUB_APP_ID: process.env.GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY: fs.readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_FILE, "utf8"),
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
  AUTH_ENCRYPTION_PRIVATE_KEY: fs.readFileSync(process.env.AUTH_ENCRYPTION_PRIVATE_KEY_FILE, "utf8"),
  AUTH_ENCRYPTION_PUBLIC_KEY: fs.readFileSync(process.env.AUTH_ENCRYPTION_PUBLIC_KEY_FILE, "utf8"),
}), { mode: 0o600 });
' "$repo_root/apps/reviewer/.dev.vars"

echo "Wrote the ignored reviewer development file."
