# How OpenBugbot works

OpenBugbot is a self-hosted GitHub App integration, not a hosted dashboard and
not a per-repository prompt product. The operator deploys one Worker and review
configuration in their own Cloudflare account. Every repository on which that
operator installs the GitHub App uses that shared configuration.

Each pull-request author enrolls their own Codex session. That lets OpenBugbot
use the author's Codex plan for their reviews rather than charging an
OpenBugbot per-review platform fee.

## Request path

```text
Eligible GitHub pull request
        │ webhook
        ▼
Cloudflare Worker → D1 run record → Cloudflare Queue
                                      │
                                      ▼
                         isolated Cloudflare Container
                                      │
                                      ▼
                              GitHub pull-request review
```

1. GitHub sends a signed `pull_request` webhook to the Worker.
2. The Worker verifies the webhook secret, ignores ineligible events, confirms
   that the author has enrolled, writes a run record in D1, and queues the job.
3. A queue consumer exchanges the GitHub App installation for a short-lived
   repository token and starts a Container for that particular run.
4. The Container checks out the PR, runs the review agents, and posts a GitHub
   review using the installation token. D1 records the outcome.

The encrypted Codex session is stored in D1. It is decrypted only by the
reviewer Worker immediately before it is sent to that run's Container; it is
written there as a temporary file and deleted with the temporary workspace at
the end of the review. The deployment operator must therefore be trusted by
the authors who enroll.

## Which pull requests get reviewed

OpenBugbot reviews only non-draft pull requests—what teams commonly call a
published or ready-for-review PR. It reacts to these GitHub actions:

- `opened`
- `reopened`
- `ready_for_review`
- `synchronize` (new commits)

Draft PRs and all other webhook events are ignored. The Worker also deduplicates
the same repository, PR number, and head SHA, so the same commit is not queued
twice. If an eligible author is not enrolled, OpenBugbot posts a one-time
explanation instead of silently attempting a review.

## Containers spin up only for a review

Docker is used only on the operator's machine while deploying: the deployment
builds the image from `Dockerfile.reviewer`, then Wrangler uploads that image to
Cloudflare. Reviews themselves run in Cloudflare Containers, not in a local
Docker daemon.

Every queued review gets a distinct Container identity. Cloudflare starts it on
the first request, the reviewer performs the job, and its `sleepAfter` setting
puts it to sleep after 20 seconds without work. The current deployment permits
up to 25 container instances. The queue handles one job per batch and retries
retryable failures up to twice, with a 30-second retry delay.

## Review workflow and prompts

The Container checks out the exact base and head commits, calculates the
changed right-side lines, and runs nine independent candidate reviews in
parallel. Their focus areas are security, privacy/data loss, performance, clean
code, developer experience, comment hygiene, bugs, regressions, and
over-engineering.

One final verifier then reads the diff and candidate output. It discards
speculation, duplicates, style-only nits, pre-existing issues, and anything
without an introduced impact tied to a changed line. The verifier returns only
actionable inline comments. The reviewer approves the PR when there are no
verified findings.

Repository text, comments, and instructions are treated as untrusted input.
The Codex processes run in read-only sandbox mode, are instructed not to edit,
test, or use network tools, and must emit structured JSON matching a schema.

### The eight-comment limit

OpenBugbot can create at most **eight** inline comments per review. It removes
findings that do not point to a changed right-side line, deduplicates them,
sorts by severity, then applies the cap. Eight is a ceiling, never a target:
zero comments is the intended result when the verifier has no strong evidence.

## Changing prompts, models, thinking, and limits

This is deliberate source configuration, shared by all repositories installed
on one deployment. There is no per-repository prompt editor.

- [Prompts and review focus](../cmd/reviewer/main.go) — edit
  `candidateFocuses`, `reviewPrompt`, and `verifierPrompt` to change what the
  candidate agents look for and how the verifier judges them.
- [Model and reasoning level](../cmd/reviewer/main.go) — `runCodex` currently
  uses `gpt-5.6-terra` with `model_reasoning_effort="xhigh"`. Change those
  values there to select a different available model or reasoning effort.
- [Comment cap and timeout](../cmd/reviewer/main.go) — adjust `maxFindings`
  (currently 8) and `reviewTimeout` (currently 12 minutes).
- [Cloudflare scaling and retries](../apps/reviewer/wrangler.jsonc) — adjust
  `max_instances`, queue batch/retry settings, and the Container's
  `sleepAfter` setting in `apps/reviewer/src/index.ts`.

Run the checks from the setup guide after a change, then redeploy the reviewer.
Treat prompt and model changes like production code: try them on a test
repository first, especially if you relax the reviewer’s evidence threshold.

## Cost model

OpenBugbot has no per-PR software charge. Your costs are your Codex plan or
usage, plus your own Cloudflare usage. That can be materially cheaper for a
team already paying for Codex and opening more than 20 PRs a month, because
there is no additional per-review platform bill.

It is not a guaranteed savings: compare your actual plan limits and Cloudflare
bill with the alternatives. As one reference point, Anthropic says Claude Code
Review averages **$15–$25 per review**; at 20 reviews, that is roughly
**$300–$500 per month** before taxes or overages. Cursor documents Bugbot as a
separate billable feature from its core subscription, so check its current
pricing before comparing. [Claude Code Review pricing](https://code.claude.com/docs/en/code-review) · [Cursor pricing](https://docs.cursor.com/account/pricing)

## Operational boundaries

The GitHub App is installed only where the operator chooses. It needs Contents
read access to check out code, and Pull requests/Issues read-write access to
publish reviews and one-time enrollment notices. It does not need a broad
personal access token for repositories.

The deployment only has the Cloudflare permissions described in the setup
guide. A `workers.dev` deployment does not need domain-routing privileges;
custom domains add only the route permission for that zone.
