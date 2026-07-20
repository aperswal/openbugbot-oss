output "d1_database_id" {
  value       = cloudflare_d1_database.openbugbot.id
  description = "Use this in apps/reviewer/wrangler.jsonc before deploying the Worker."
}

output "review_queue_name" {
  value       = cloudflare_queue.review_jobs.queue_name
  description = "Cloudflare Queue used for webhook-triggered review jobs."
}
