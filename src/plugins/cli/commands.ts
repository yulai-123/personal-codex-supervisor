import { appendHubMessage, type AppendHubMessageResult } from "../../kernel/event-hub/index.js";
import type { AppDatabase } from "../../storage/sqlite.js";

export type AppendCliUserMessageInput = {
  text: string;
  priority?: number;
  dedupeKey?: string;
};

export function appendCliUserMessage(
  db: AppDatabase,
  input: AppendCliUserMessageInput,
): AppendHubMessageResult {
  return appendHubMessage(db, {
    kind: "event",
    type: "event.user.message_received",
    source: "cli",
    priority: input.priority ?? 10,
    payload: {
      channel: "cli",
      text: input.text,
    },
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
  });
}

export function listCliTasks(db: AppDatabase, limit = 20): unknown[] {
  return db.prepare(`
    SELECT *
    FROM tasks_current_state
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit);
}

export function getCliTask(db: AppDatabase, taskId: string, limit = 20): unknown {
  return {
    current: db.prepare("SELECT * FROM tasks_current_state WHERE task_id = ?").get(taskId) ?? null,
    events: db.prepare(`
      SELECT *
      FROM recent_task_events
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(taskId, limit),
  };
}

export function listCliOutbox(db: AppDatabase, limit = 20): unknown[] {
  return db.prepare(`
    SELECT *
    FROM outbox_current_state
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit);
}

export function listCliEvents(db: AppDatabase, limit = 20): unknown[] {
  return db.prepare(`
    SELECT id, kind, type, topic, source, priority, correlation_id, causation_id, created_at
    FROM event_log
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

export function listCliHealth(db: AppDatabase): unknown[] {
  return db.prepare(`
    SELECT *
    FROM system_health_current_state
    ORDER BY updated_at DESC
  `).all();
}
