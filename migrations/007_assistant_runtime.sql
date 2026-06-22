CREATE TABLE IF NOT EXISTS assistant_observations (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL CHECK (source IN ('user_report', 'assistant_question', 'inferred', 'schedule', 'tool', 'worker', 'system')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  observed_at TEXT NOT NULL,
  stale_after TEXT,
  source_message_id TEXT REFERENCES event_log(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assistant_observations_capability_key
  ON assistant_observations(capability_id, key, observed_at);

CREATE TABLE IF NOT EXISTS assistant_state_current (
  capability_id TEXT NOT NULL,
  key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('known', 'unknown', 'stale')),
  value_json TEXT NOT NULL DEFAULT '{}',
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  last_observed_at TEXT,
  stale_after TEXT,
  latest_observation_id TEXT REFERENCES assistant_observations(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (capability_id, key)
);

CREATE INDEX IF NOT EXISTS idx_assistant_state_current_status
  ON assistant_state_current(capability_id, status, updated_at);

CREATE TABLE IF NOT EXISTS assistant_interventions (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('silence', 'record', 'ask', 'remind', 'follow_up', 'task', 'schedule')),
  reason TEXT NOT NULL,
  user_message TEXT,
  status TEXT NOT NULL CHECK (status IN ('planned', 'sent', 'suppressed', 'skipped', 'failed')),
  sent_message_id TEXT REFERENCES event_log(id) ON DELETE SET NULL,
  state_tags_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assistant_interventions_capability
  ON assistant_interventions(capability_id, created_at);

CREATE INDEX IF NOT EXISTS idx_assistant_interventions_status
  ON assistant_interventions(status, created_at);

CREATE TABLE IF NOT EXISTS assistant_followups (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'triggered', 'completed', 'cancelled')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 300,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_assistant_followups_due
  ON assistant_followups(status, due_at, priority);

CREATE TABLE IF NOT EXISTS assistant_daily_summaries (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(capability_id, local_date)
);
