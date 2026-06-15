CREATE TABLE IF NOT EXISTS scheduled_jobs_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('interval', 'daily', 'once', 'cron')),
  interval_ms INTEGER,
  time_of_day TEXT,
  schedule_value TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  next_run_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 300,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO scheduled_jobs_new (
  id, name, enabled, schedule_type, interval_ms, time_of_day, schedule_value,
  timezone, next_run_at, event_type, topic, payload_json, priority, created_at, updated_at
)
SELECT
  id,
  name,
  enabled,
  schedule_type,
  interval_ms,
  time_of_day,
  CASE
    WHEN schedule_type = 'interval' AND interval_ms IS NOT NULL THEN CAST(interval_ms AS TEXT)
    WHEN schedule_type = 'daily' THEN time_of_day
    ELSE NULL
  END AS schedule_value,
  timezone,
  next_run_at,
  event_type,
  topic,
  payload_json,
  priority,
  created_at,
  updated_at
FROM scheduled_jobs;

CREATE TABLE IF NOT EXISTS scheduled_job_runs_new (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES scheduled_jobs_new(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  due_at TEXT NOT NULL,
  event_message_id TEXT REFERENCES event_log(id) ON DELETE SET NULL,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO scheduled_job_runs_new (
  id, job_id, status, due_at, event_message_id, error,
  started_at, finished_at, created_at, updated_at
)
SELECT
  id, job_id, status, due_at, event_message_id, error,
  started_at, finished_at, created_at, updated_at
FROM scheduled_job_runs;

DROP TABLE scheduled_job_runs;
DROP TABLE scheduled_jobs;

ALTER TABLE scheduled_jobs_new RENAME TO scheduled_jobs;
ALTER TABLE scheduled_job_runs_new RENAME TO scheduled_job_runs;

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
  ON scheduled_jobs(enabled, next_run_at, priority);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job
  ON scheduled_job_runs(job_id, created_at);
