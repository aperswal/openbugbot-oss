terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22"
    }
  }
}

provider "cloudflare" {}

resource "cloudflare_d1_database" "openbugbot" {
  account_id = var.cloudflare_account_id
  name       = "openbugbot"
}

resource "cloudflare_queue" "review_jobs" {
  account_id = var.cloudflare_account_id
  queue_name = "openbugbot-review-jobs"
  settings = {
    message_retention_period = 86400
  }
}
