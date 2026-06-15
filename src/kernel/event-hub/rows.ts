import { parseJsonObject } from "../../shared/json.js";
import type { EventDelivery, HubMessage } from "./types.js";

type MessageRow = {
  id: string;
  kind: "command" | "event";
  type: string;
  topic: string;
  source: string;
  priority: number;
  payload_json: string;
  correlation_id: string;
  causation_id: string | null;
  dedupe_key: string | null;
  scheduled_at: string | null;
  created_at: string;
};

type DeliveryRow = {
  id: string;
  message_id: string;
  group_id: string;
  status: EventDelivery["status"];
  priority: number;
  available_at: string;
  lease_until: string | null;
  attempts: number;
  locked_by: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export function mapMessageRow(row: MessageRow): HubMessage {
  const message: HubMessage = {
    id: row.id,
    kind: row.kind,
    type: row.type,
    topic: row.topic,
    source: row.source,
    priority: row.priority,
    payload: parseJsonObject(row.payload_json),
    correlationId: row.correlation_id,
    createdAt: row.created_at,
  };

  if (row.causation_id) message.causationId = row.causation_id;
  if (row.dedupe_key) message.dedupeKey = row.dedupe_key;
  if (row.scheduled_at) message.scheduledAt = row.scheduled_at;
  return message;
}

export function mapDeliveryRow(row: DeliveryRow): EventDelivery {
  const delivery: EventDelivery = {
    id: row.id,
    messageId: row.message_id,
    groupId: row.group_id,
    status: row.status,
    priority: row.priority,
    availableAt: row.available_at,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.lease_until) delivery.leaseUntil = row.lease_until;
  if (row.locked_by) delivery.lockedBy = row.locked_by;
  if (row.last_error) delivery.lastError = row.last_error;
  return delivery;
}

export type JoinedDeliveryRow = DeliveryRow & {
  msg_id: string;
  msg_kind: "command" | "event";
  msg_type: string;
  msg_topic: string;
  msg_source: string;
  msg_priority: number;
  msg_payload_json: string;
  msg_correlation_id: string;
  msg_causation_id: string | null;
  msg_dedupe_key: string | null;
  msg_scheduled_at: string | null;
  msg_created_at: string;
};

export function mapJoinedDeliveryRow(row: JoinedDeliveryRow) {
  return {
    delivery: mapDeliveryRow(row),
    message: mapMessageRow({
      id: row.msg_id,
      kind: row.msg_kind,
      type: row.msg_type,
      topic: row.msg_topic,
      source: row.msg_source,
      priority: row.msg_priority,
      payload_json: row.msg_payload_json,
      correlation_id: row.msg_correlation_id,
      causation_id: row.msg_causation_id,
      dedupe_key: row.msg_dedupe_key,
      scheduled_at: row.msg_scheduled_at,
      created_at: row.msg_created_at,
    }),
  };
}
