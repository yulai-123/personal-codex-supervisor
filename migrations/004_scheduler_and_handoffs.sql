CREATE TABLE IF NOT EXISTS session_handoffs (
  id TEXT PRIMARY KEY,
  logical_name TEXT NOT NULL,
  old_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  old_codex_session_id TEXT,
  new_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'summarized', 'archived', 'activated', 'skipped', 'failed')),
  summary_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  requested_at TEXT NOT NULL,
  summarized_at TEXT,
  archived_at TEXT,
  activated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_session_handoffs_logical
  ON session_handoffs(logical_name, status, updated_at);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('interval', 'daily', 'once')),
  interval_ms INTEGER,
  time_of_day TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  next_run_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 300,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
  ON scheduled_jobs(enabled, next_run_at, priority);

CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  due_at TEXT NOT NULL,
  event_message_id TEXT REFERENCES event_log(id) ON DELETE SET NULL,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job
  ON scheduled_job_runs(job_id, created_at);
