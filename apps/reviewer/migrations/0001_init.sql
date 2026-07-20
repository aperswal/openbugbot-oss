CREATE TABLE IF NOT EXISTS enrollments (
  github_login TEXT PRIMARY KEY,
  encrypted_auth TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_runs (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  author_login TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repository, pr_number, head_sha)
);

CREATE TABLE IF NOT EXISTS missing_auth_notices (
  repository TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repository, pr_number)
);
