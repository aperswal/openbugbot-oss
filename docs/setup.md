# Setup

This guide takes a new installation from clone to its first self-hosted review.
You need a Cloudflare Workers Paid account with D1, Queues, and Containers; a
GitHub account or organization that can create and install a GitHub App; Node
24, pnpm 10, Go 1.26, Terraform 1.5+, OpenSSL, and Docker.

The reviewer Container image is built on your machine during deployment, so
Docker must be running before the deploy command.

## 1. Prepare your machine

### macOS — Apple silicon

```sh
# Install Homebrew if needed, then install the command-line dependencies.
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node@24 go terraform
brew install --cask docker
export PATH="$(brew --prefix node@24)/bin:$PATH"
corepack enable
corepack install --global pnpm@10.14.0
open -a Docker
```

Use Docker Desktop for Apple silicon. Wait for Docker Desktop to start, then
verify it with `docker info`.

### macOS — Intel

```sh
# Install Homebrew if needed, then install the command-line dependencies.
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node@24 go terraform
brew install --cask docker
export PATH="$(brew --prefix node@24)/bin:$PATH"
corepack enable
corepack install --global pnpm@10.14.0
open -a Docker
```

Use Docker Desktop for Intel Macs. The commands are the same; Homebrew and
Docker Desktop select the right architecture.

### Windows

Use WSL2 with Ubuntu for this repository and its tools. In an elevated
PowerShell window, run:

```powershell
wsl --install -d Ubuntu
winget install -e --id Docker.DockerDesktop
```

Restart if prompted, start Docker Desktop, and enable WSL integration for
Ubuntu in Docker Desktop settings. Then open Ubuntu and follow the Linux
instructions below. Run the remaining Git, Terraform, pnpm, and Go commands in
Ubuntu—not PowerShell.

### Linux (Ubuntu/Debian, including WSL2)

```sh
sudo apt-get update
sudo apt-get install -y build-essential ca-certificates curl git openssl docker.io
sudo usermod -aG docker "$USER"

curl https://mise.run | sh
echo 'eval "$($HOME/.local/bin/mise activate bash)"' >> ~/.bashrc
eval "$($HOME/.local/bin/mise activate bash)"
mise use --global node@24 go@1.26 terraform@1.5
corepack enable
corepack install --global pnpm@10.14.0
```

Sign out and back in after joining the `docker` group, then verify Docker with
`docker info`. On other Linux distributions, install Docker using that
distribution's package manager and use the same `mise` and `corepack` commands.

## 2. Clone and create your local environment

On macOS, Linux, or Ubuntu/WSL:

```sh
git clone https://github.com/aperswal/openbugbot-oss.git
cd openbugbot-oss
pnpm install --frozen-lockfile
cp .env.example .env
mkdir -p secrets
chmod 700 secrets
```

All deployment settings live in `.env`, which is shell-compatible and ignored
by Git. Do not commit or share it. The two checked-in `.dev.vars.example` files
show the narrower variables used for local Worker development.

## 3. Create the encryption keys

This key pair encrypts an author's Codex session before it leaves their
machine. It is separate from the GitHub App private key.

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out secrets/auth-encryption-private-key.pem
openssl pkey -in secrets/auth-encryption-private-key.pem -pubout \
  -out secrets/auth-encryption-public-key.pem
chmod 600 secrets/auth-encryption-private-key.pem
```

Keep `AUTH_ENCRYPTION_PRIVATE_KEY_FILE` and
`AUTH_ENCRYPTION_PUBLIC_KEY_FILE` in `.env` pointed at these files. Point
`OPENBUGBOT_AUTH_PUBLIC_KEY_FILE` at the public key as well.

## 4. Create a scoped Cloudflare API token

Create a **custom Account API token**, restricted to the one Cloudflare account
that will run OpenBugbot. Grant:

- `Workers Containers: Read` and `Write`
- `Queues: Read` and `Write`
- `D1: Read` and `Write`
- `Workers Scripts: Write`
- `Account Settings: Read`

For a `workers.dev` deployment, those account permissions are sufficient; do
not grant Zone, DNS, or Global API Key access. For a custom domain, additionally
grant `Workers Routes: Write`, restrict it to that zone, and set
`REVIEWER_WORKER_ROUTE` in `.env` to the hostname. Use a short expiry and, when
possible, an IP restriction for the CI runner or operator machine.

Copy the token to `CLOUDFLARE_API_TOKEN`. Copy the Cloudflare account ID to
both `CLOUDFLARE_ACCOUNT_ID` and `TF_VAR_cloudflare_account_id`, then provision
the D1 database and queue:

```sh
set -a; . ./.env; set +a
terraform -chdir=infra init
terraform -chdir=infra apply
```

## 5. Create your GitHub App

Go to **Settings → Developer settings → GitHub Apps → New GitHub App**. Create
the app under the account or organization that will operate OpenBugbot.

1. Choose an app name and homepage. Keep it private unless you want other
   organizations to install it.
2. Enable webhooks. Use a temporary valid HTTPS URL for now; replace it after
   deployment.
3. Generate a long random **Webhook secret**. Put the exact same value in
   `GITHUB_WEBHOOK_SECRET` in `.env`.
4. Give the app the repository permissions OpenBugbot needs:
   `Contents: Read & write`, `Pull requests: Read & write`, and
   `Issues: Read & write`. Contents needs write even though OpenBugbot never
   pushes code: GitHub only counts an approving review toward a required-review
   rule when the reviewer has write access, so a read-only app's LGTM cannot
   satisfy branch protection or auto-merge. The per-review job token is still
   minted with `contents: read`, so the container that clones and reviews your
   code can never push, whatever the app itself is granted.
5. Subscribe to both the **Pull request** and **Pull request review** events.
6. Create the app and copy its **App ID** to `GITHUB_APP_ID` in `.env`.
7. In the app's **Private keys** section, choose **Generate a private key**.
   Move the downloaded PEM to `secrets/github-app-private-key.pem` and protect
   it:

   ```sh
   chmod 600 secrets/github-app-private-key.pem
   ```

The default `GITHUB_APP_PRIVATE_KEY_FILE` value already points to that file.

## 6. Deploy the reviewer

Run:

```sh
pnpm deploy:reviewer
```

Docker builds the image locally. Wrangler then uploads it and deploys the
Worker, D1 binding, queue binding, and Cloudflare Container configuration in
your Cloudflare account. It prints a `workers.dev` URL similar to:

```text
https://openbugbot-reviewer.<your-workers-subdomain>.workers.dev
```

In the GitHub App settings, replace the temporary webhook URL with:

```text
https://openbugbot-reviewer.<your-workers-subdomain>.workers.dev/github/webhook
```

Install the GitHub App on the repositories you want reviewed. Then set
`OPENBUGBOT_ENROLL_URL` in `.env` to the same Worker with `/enroll` appended:

```text
OPENBUGBOT_ENROLL_URL="https://openbugbot-reviewer.<your-workers-subdomain>.workers.dev/enroll"
```

Re-run the deploy command after rotating a reviewer secret or key. The script
uploads only the reviewer settings as Cloudflare Worker secrets; it never
uploads your Cloudflare API token.

## 7. Local development and verification

After filling `.env`, generate the ignored app-local development values and run
the Worker locally:

```sh
pnpm setup:dev-vars
pnpm dev:reviewer
```

Before a production deployment, run the checks:

```sh
pnpm check
go test ./...
```

The generated reviewer `.dev.vars` remains ignored. Regenerate it after
rotating a key or secret.

## 8. Enroll each pull-request author

Do not give contributors the operator's `.env`, Cloudflare token, GitHub App
private key, or webhook secret. Share only the `/enroll` URL and the encryption
**public** PEM file.

Each author makes a local client configuration from `.env.client.example`,
copies the public PEM to the configured path, and runs:

```sh
set -a; . ./.env.client; set +a
codex login
gh auth login
go run ./cmd/openbugbot --login
```

The client reads the author's existing Codex login, encrypts it with the public
key, and sends it to your self-hosted `/enroll` endpoint. Re-enroll after that
author logs out of Codex, revokes access, or changes Codex accounts.

### Joining a repository that already has OpenBugbot

Enrollment is per person, not per repository. The reviewer runs Codex on behalf
of the pull-request author, using that author's own stored session, so an
installation someone else made does not cover a new collaborator. Until you
enroll, your pull requests are skipped while everyone else's are reviewed.

You will see that state as a comment on your pull request:

```text
Couldn’t review this PR. Please set up OpenBugbot with `openbugbot --login`.
```

That comment is posted once per pull request, so pushing more commits does not
repeat it. Draft pull requests are ignored entirely and get no comment at all.

`openbugbot --login` in that message is the command above:
`go run ./cmd/openbugbot --login` from a clone of this repository, or the same
binary after `go build -o openbugbot ./cmd/openbugbot`. Either form reads the
client environment variables below, so run it from a shell that has them set.

Enrolling needs far less than the operator install in section 1: a clone of
this repository, Go, the `codex` CLI, and the `gh` CLI. You do not need Docker,
Terraform, Node, a Cloudflare account, or any permission on the repository
beyond the access you already have.

Ask the operator for two things, neither of them secret: the deployment's
`/enroll` URL and the encryption **public** PEM file. Put them in a local
`.env.client` copied from `.env.client.example`, put the PEM at the configured
path, and run the four commands above. `codex login` creates the credential
that is enrolled, `~/.codex/auth.json`. `gh auth login` supplies the GitHub
token that proves who you are; the deployment resolves your login from that
token, so you can only ever enroll yourself. The client encrypts the Codex
session with the public key before anything leaves your machine, and the
deployment stores only that encrypted envelope. Its Worker holds the private
key, so enrolling means trusting whoever operates that deployment with a Codex
session.

A successful run prints:

```text
Codex auth stored securely and enrolled for @<your-login>. OpenBugbot will now review their eligible pull requests automatically.
```

One enrollment covers every repository that deployment reviews, because the
row is keyed on your GitHub login alone. A different self-hosted deployment
has its own database and key pair, so enroll again against that deployment's
`/enroll` URL and public PEM.

There is no confirmation comment; the review itself is the signal. To check it
worked, push a new commit to the pull request. Reviews are deduplicated on
repository, pull-request number, and head SHA, so a commit that already
received a review is never reviewed again — use a new commit rather than
reopening the pull request.

Running `--login` again replaces the stored session. You normally do not have
to: when Codex rotates the session during a review, the deployment re-encrypts
and stores the new one. Removing an enrollment is not self-service. Revoke the
session on the Codex side, and ask the operator to delete your row from the
deployment's D1 database. Deleting the local encrypted copy at
`~/.openbugbot/codex-auth.enc` does not unenroll you.

If a PR does not receive a review, first check the GitHub App's **Advanced →
Recent Deliveries** page: the app must be installed on that repository, the
webhook must point to `/github/webhook`, and the delivery needs a successful
response. Then check that the PR author completed enrollment.

## References

- [Cloudflare API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Docker Desktop installation](https://docs.docker.com/desktop/)
- [GitHub Apps quickstart](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/quickstart)
