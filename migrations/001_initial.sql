CREATE TABLE IF NOT EXISTS event_log (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('command', 'event')),
  type TEXT NOT NULL,
  topic TEXT NOT NULL,
  source TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  payload_json TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  dedupe_key TEXT,
  scheduled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_log_type_created
  ON event_log(type, created_at);

CREATE INDEX IF NOT EXISTS idx_event_log_correlation
  ON event_log(correlation_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_log_dedupe
  ON event_log(dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS consumer_groups (
  id TEXT PRIMARY KEY,
  description TEXT,
  concurrency INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES event_log(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES consumer_groups(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'acked', 'failed', 'dead_letter')),
  priority INTEGER NOT NULL DEFAULT 100,
  available_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_by TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(message_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_event_deliveries_claim
  ON event_deliveries(group_id, status, available_at, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_event_deliveries_lease
  ON event_deliveries(status, lease_until);

CREATE TABLE IF NOT EXISTS dead_letters (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projection_offsets (
  projection_name TEXT PRIMARY KEY,
  last_message_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  logical_name TEXT NOT NULL,
  codex_session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('supervisor', 'worker')),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'failed')),
  handoff_summary TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_logical_status
  ON sessions(logical_name, status, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'warning', 'error', 'needs_decision', 'cancelled', 'timed_out')),
  priority INTEGER NOT NULL DEFAULT 100,
  origin_message_id TEXT REFERENCES event_log(id),
  correlation_id TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  expected_output TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_priority
  ON tasks(status, priority, updated_at);

CREATE INDEX IF NOT EXISTS idx_tasks_correlation
  ON tasks(correlation_id, created_at);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'warning', 'error', 'needs_decision', 'cancelled', 'timed_out')),
  attempt INTEGER NOT NULL DEFAULT 1,
  artifact_dir TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_runs_task
  ON task_runs(task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_task_runs_status
  ON task_runs(status, updated_at);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  worker_session_id TEXT,
  status TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'notice', 'warning', 'error', 'critical')),
  summary TEXT NOT NULL,
  details TEXT,
  user_impact TEXT,
  recommended_action TEXT,
  should_notify_user TEXT NOT NULL CHECK (should_notify_user IN ('yes', 'no', 'uncertain')),
  needs_supervisor_decision INTEGER NOT NULL DEFAULT 0,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  handled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_events_task
  ON task_events(task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_task_events_decision
  ON task_events(needs_supervisor_decision, handled_at, created_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  media_type TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO consumer_groups (id, description, concurrency) VALUES
  ('supervisor_group', 'Supervisor Codex session consumer', 1),
  ('worker_group', 'Background worker command consumer', 5),
  ('wechat_sender_group', 'External message sender consumer', 1),
  ('projection_group', 'Query projection updater', 1),
  ('maintenance_group', 'Session maintenance and cleanup', 1),
  ('monitor_group', 'Health monitor', 1);
