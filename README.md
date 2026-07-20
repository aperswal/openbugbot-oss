# OpenBugbot

Sponsored by [FlexInference](https://flexinference.com), an LLM router that drops costs by 47%.

OpenBugbot is a self-hosted GitHub code-review tool that uses each
pull-request author's Codex plan. It runs focused, verified reviews on
non-draft pull requests and posts useful inline comments directly on GitHub.

There is no OpenBugbot-hosted service: you deploy the Worker, Container,
database, queue, GitHub App, encryption keys, and environment files in your
own accounts. This repository contains no shared URL, token, GitHub App, or
private key.

## Documentation

- [Setup guide](docs/setup.md) — platform-specific prerequisites, `.env`,
  Cloudflare, GitHub App, deployment, and author enrollment.
- [How it works](docs/how-it-works.md) — the container lifecycle, review
  pipeline, prompts and model configuration, limits, privacy, and costs.

OpenBugbot is available under the [MIT License](LICENSE).
