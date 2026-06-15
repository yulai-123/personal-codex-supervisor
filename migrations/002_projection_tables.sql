CREATE TABLE IF NOT EXISTS tasks_current_state (
  task_id TEXT PRIMARY KEY,
  objective TEXT,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  correlation_id TEXT NOT NULL,
  latest_run_id TEXT,
  latest_task_event_id TEXT,
  summary TEXT,
  should_notify_user TEXT,
  needs_supervisor_decision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_current_status_priority
  ON tasks_current_state(status, priority, updated_at);

CREATE INDEX IF NOT EXISTS idx_tasks_current_correlation
  ON tasks_current_state(correlation_id, updated_at);

CREATE TABLE IF NOT EXISTS task_runs_current_state (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  worker_session_id TEXT,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  artifact_dir TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_runs_current_task
  ON task_runs_current_state(task_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_task_runs_current_status
  ON task_runs_current_state(status, updated_at);

CREATE TABLE IF NOT EXISTS recent_task_events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT,
  worker_session_id TEXT,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL,
  should_notify_user TEXT NOT NULL,
  needs_supervisor_decision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recent_task_events_task
  ON recent_task_events(task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_recent_task_events_decision
  ON recent_task_events(needs_supervisor_decision, created_at);

CREATE TABLE IF NOT EXISTS outbox_current_state (
  message_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  target TEXT,
  text TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  correlation_id TEXT NOT NULL,
  command_message_id TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_status
  ON outbox_current_state(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_outbox_correlation
  ON outbox_current_state(correlation_id, created_at);

CREATE TABLE IF NOT EXISTS sessions_current_state (
  session_id TEXT PRIMARY KEY,
  logical_name TEXT NOT NULL,
  codex_session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  handoff_summary TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_current_logical
  ON sessions_current_state(logical_name, role, status);

CREATE TABLE IF NOT EXISTS system_health_current_state (
  component TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL,
  last_event_id TEXT,
  updated_at TEXT NOT NULL
);
