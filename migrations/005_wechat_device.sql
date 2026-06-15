CREATE TABLE IF NOT EXISTS wechat_conversations (
  conversation_id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  authorized INTEGER NOT NULL DEFAULT 0,
  context_token TEXT,
  context_token_updated_at TEXT,
  last_inbound_message_id TEXT REFERENCES event_log(id) ON DELETE SET NULL,
  last_inbound_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wechat_conversations_authorized
  ON wechat_conversations(authorized, updated_at);
