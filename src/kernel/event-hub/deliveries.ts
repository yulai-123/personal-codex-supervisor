import type { AppDatabase } from "../../storage/sqlite.js";
import { createId } from "../../shared/ids.js";
import { stringifyJson } from "../../shared/json.js";
import { nowIso } from "../../shared/time.js";
import { mapJoinedDeliveryRow, type JoinedDeliveryRow } from "./rows.js";
import type { ClaimedDelivery } from "./types.js";

export type ClaimOptions = {
  limit?: number;
  leaseMs: number;
  workerId: string;
  now?: Date;
};

export type FailOptions = {
  error: unknown;
  retryDelayMs?: number;
  maxAttempts: number;
  now?: Date;
};

export function claimReadyDeliveries(
  db: AppDatabase,
  groupId: string,
  options: ClaimOptions,
): ClaimedDelivery[] {
  const limit = options.limit ?? 1;
  const now = options.now ?? new Date();
  const nowText = now.toISOString();
  const leaseUntil = new Date(now.getTime() + options.leaseMs).toISOString();

  const transaction = db.transaction(() => {
    const deliveryIds = db.prepare(`
      SELECT id
      FROM event_deliveries
      WHERE group_id = ?
        AND (
          (status = 'pending' AND available_at <= ?)
          OR (status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?)
        )
      ORDER BY priority ASC, available_at ASC, created_at ASC
      LIMIT ?
    `).all(groupId, nowText, nowText, limit) as Array<{ id: string }>;

    for (const row of deliveryIds) {
      db.prepare(`
        UPDATE event_deliveries
        SET status = 'running',
            attempts = attempts + 1,
            locked_by = ?,
            lease_until = ?,
            updated_at = ?
        WHERE id = ?
      `).run(options.workerId, leaseUntil, nowText, row.id);
    }

    if (deliveryIds.length === 0) {
      return [];
    }

    const placeholders = deliveryIds.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT
        d.id,
        d.message_id,
        d.group_id,
        d.status,
        d.priority,
        d.available_at,
        d.lease_until,
        d.attempts,
        d.locked_by,
        d.last_error,
        d.created_at,
        d.updated_at,
        m.id AS msg_id,
        m.kind AS msg_kind,
        m.type AS msg_type,
        m.topic AS msg_topic,
        m.source AS msg_source,
        m.priority AS msg_priority,
        m.payload_json AS msg_payload_json,
        m.correlation_id AS msg_correlation_id,
        m.causation_id AS msg_causation_id,
        m.dedupe_key AS msg_dedupe_key,
        m.scheduled_at AS msg_scheduled_at,
        m.created_at AS msg_created_at
      FROM event_deliveries d
      JOIN event_log m ON m.id = d.message_id
      WHERE d.id IN (${placeholders})
      ORDER BY d.priority ASC, d.available_at ASC, d.created_at ASC
    `).all(...deliveryIds.map((row) => row.id)) as JoinedDeliveryRow[];

    return rows.map(mapJoinedDeliveryRow);
  });

  return transaction() as ClaimedDelivery[];
}

export function ackDelivery(db: AppDatabase, deliveryId: string, now: Date = new Date()): void {
  db.prepare(`
    UPDATE event_deliveries
    SET status = 'acked',
        lease_until = NULL,
        locked_by = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(now.toISOString(), deliveryId);
}

export function failDelivery(db: AppDatabase, deliveryId: string, options: FailOptions): void {
  const now = options.now ?? new Date();
  const nowText = now.toISOString();
  const retryAt = new Date(now.getTime() + (options.retryDelayMs ?? 1_000)).toISOString();
  const errorMessage = formatError(options.error);

  const transaction = db.transaction(() => {
    const row = db.prepare(`
      SELECT id, message_id, group_id, attempts
      FROM event_deliveries
      WHERE id = ?
    `).get(deliveryId) as { id: string; message_id: string; group_id: string; attempts: number } | undefined;

    if (!row) {
      return;
    }

    if (row.attempts >= options.maxAttempts) {
      db.prepare(`
        UPDATE event_deliveries
        SET status = 'dead_letter',
            lease_until = NULL,
            locked_by = NULL,
            last_error = ?,
            updated_at = ?
        WHERE id = ?
      `).run(errorMessage, nowText, deliveryId);

      db.prepare(`
        INSERT INTO dead_letters (id, delivery_id, message_id, group_id, reason, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        createId("dead"),
        row.id,
        row.message_id,
        row.group_id,
        errorMessage,
        stringifyJson({ deliveryId, attempts: row.attempts }),
        nowText,
      );
      return;
    }

    db.prepare(`
      UPDATE event_deliveries
      SET status = 'pending',
          available_at = ?,
          lease_until = NULL,
          locked_by = NULL,
          last_error = ?,
          updated_at = ?
      WHERE id = ?
    `).run(retryAt, errorMessage, nowText, deliveryId);
  });

  transaction();
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
