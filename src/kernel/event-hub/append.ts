import type { AppDatabase } from "../../storage/sqlite.js";
import { createId } from "../../shared/ids.js";
import { stringifyJson } from "../../shared/json.js";
import { nowIso } from "../../shared/time.js";
import { defaultEventRouter, inferTopic, type EventRouter } from "./router.js";
import { mapMessageRow } from "./rows.js";
import type { AppendHubMessageInput, AppendHubMessageResult, HubMessage } from "./types.js";
import type { EventHubNotifier } from "./notifier.js";

export type AppendOptions = {
  router?: EventRouter;
  notifier?: EventHubNotifier;
};

export function appendHubMessage(
  db: AppDatabase,
  input: AppendHubMessageInput,
  options: AppendOptions = {},
): AppendHubMessageResult {
  const router = options.router ?? defaultEventRouter;
  const messageId = createId(input.kind === "command" ? "cmd" : "evt");
  const createdAt = nowIso();
  const message: HubMessage = {
    id: messageId,
    kind: input.kind,
    type: input.type,
    topic: input.topic ?? inferTopic(input.type),
    source: input.source,
    priority: input.priority ?? 100,
    payload: input.payload ?? {},
    correlationId: input.correlationId ?? messageId,
    createdAt,
  };

  if (input.causationId) message.causationId = input.causationId;
  if (input.dedupeKey) message.dedupeKey = input.dedupeKey;
  if (input.scheduledAt) message.scheduledAt = input.scheduledAt;

  const transaction = db.transaction(() => {
    if (message.dedupeKey) {
      const existing = findMessageByDedupeKey(db, message.dedupeKey);
      if (existing) {
        return {
          message: existing,
          deliveryGroupIds: [],
          duplicate: true,
        };
      }
    }

    db.prepare(`
      INSERT INTO event_log (
        id, kind, type, topic, source, priority, payload_json,
        correlation_id, causation_id, dedupe_key, scheduled_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.kind,
      message.type,
      message.topic,
      message.source,
      message.priority,
      stringifyJson(message.payload),
      message.correlationId,
      message.causationId ?? null,
      message.dedupeKey ?? null,
      message.scheduledAt ?? null,
      message.createdAt,
    );

    const groupIds = router.route(message);
    for (const groupId of groupIds) {
      db.prepare(`
        INSERT OR IGNORE INTO event_deliveries (
          id, message_id, group_id, status, priority, available_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(
        createId("dlv"),
        message.id,
        groupId,
        message.priority,
        message.scheduledAt ?? message.createdAt,
        message.createdAt,
        message.createdAt,
      );
    }

    return {
      message,
      deliveryGroupIds: groupIds,
      duplicate: false,
    };
  });

  const result = transaction() as AppendHubMessageResult;
  if (!result.duplicate && result.deliveryGroupIds.length > 0) {
    options.notifier?.wake(result.deliveryGroupIds);
  }
  return result;
}

function findMessageByDedupeKey(db: AppDatabase, dedupeKey: string): HubMessage | null {
  const row = db.prepare(`
    SELECT
      id, kind, type, topic, source, priority, payload_json,
      correlation_id, causation_id, dedupe_key, scheduled_at, created_at
    FROM event_log
    WHERE dedupe_key = ?
  `).get(dedupeKey) as Parameters<typeof mapMessageRow>[0] | undefined;

  return row ? mapMessageRow(row) : null;
}
