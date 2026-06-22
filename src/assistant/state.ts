import { createId } from "../shared/ids.js";
import { parseJsonObject, stringifyJson } from "../shared/json.js";
import { nowIso } from "../shared/time.js";
import type { AppDatabase } from "../storage/sqlite.js";
import type {
  AssistantConfidence,
  AssistantInterventionAction,
  AssistantInterventionStatus,
  AssistantObservationSource,
  AssistantStateStatus,
} from "./types.js";

export type AssistantObservationInput = {
  capabilityId: string;
  key: string;
  value: unknown;
  source: AssistantObservationSource;
  confidence: AssistantConfidence;
  observedAt?: string;
  staleAfter?: string | null;
  sourceMessageId?: string | null;
};

export type AssistantStateRow = {
  capability_id: string;
  key: string;
  status: AssistantStateStatus;
  value_json: string;
  confidence: AssistantConfidence;
  last_observed_at: string | null;
  stale_after: string | null;
  latest_observation_id: string | null;
  updated_at: string;
};

export type AssistantStateView = {
  capabilityId: string;
  key: string;
  status: AssistantStateStatus;
  value: Record<string, unknown>;
  confidence: AssistantConfidence;
  lastObservedAt: string | null;
  staleAfter: string | null;
  latestObservationId: string | null;
  updatedAt: string;
};

export type AssistantInterventionInput = {
  capabilityId: string;
  action: AssistantInterventionAction;
  reason: string;
  userMessage?: string | null;
  status: AssistantInterventionStatus;
  sentMessageId?: string | null;
  stateTags?: string[];
  metadata?: Record<string, unknown>;
};

export type AssistantFollowupInput = {
  capabilityId: string;
  purpose: string;
  dueAt: string;
  payload?: Record<string, unknown>;
  priority?: number;
};

export type AssistantDailySummaryInput = {
  capabilityId: string;
  localDate: string;
  summary: string;
  metadata?: Record<string, unknown>;
};

export function recordAssistantObservation(db: AppDatabase, input: AssistantObservationInput): {
  observationId: string;
  state: AssistantStateView;
} {
  const now = nowIso();
  const observedAt = input.observedAt ?? now;
  const status = effectiveStatus("known", input.staleAfter ?? null, now);
  const observationId = createId("asst_obs");

  db.prepare(`
    INSERT INTO assistant_observations (
      id, capability_id, key, value_json, source, confidence,
      observed_at, stale_after, source_message_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    observationId,
    input.capabilityId,
    input.key,
    stringifyJson(toJsonObject(input.value)),
    input.source,
    input.confidence,
    observedAt,
    input.staleAfter ?? null,
    input.sourceMessageId ?? null,
    now,
  );

  db.prepare(`
    INSERT INTO assistant_state_current (
      capability_id, key, status, value_json, confidence,
      last_observed_at, stale_after, latest_observation_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(capability_id, key) DO UPDATE SET
      status = excluded.status,
      value_json = excluded.value_json,
      confidence = excluded.confidence,
      last_observed_at = excluded.last_observed_at,
      stale_after = excluded.stale_after,
      latest_observation_id = excluded.latest_observation_id,
      updated_at = excluded.updated_at
  `).run(
    input.capabilityId,
    input.key,
    status,
    stringifyJson(toJsonObject(input.value)),
    input.confidence,
    observedAt,
    input.staleAfter ?? null,
    observationId,
    now,
  );

  const row = getAssistantStateRow(db, input.capabilityId, input.key);
  if (!row) {
    throw new Error(`Failed to record assistant state for ${input.capabilityId}:${input.key}`);
  }
  return {
    observationId,
    state: toStateView(row, now),
  };
}

export function markAssistantStateUnknown(db: AppDatabase, input: {
  capabilityId: string;
  key: string;
  reason?: string;
}): AssistantStateView {
  const now = nowIso();
  db.prepare(`
    INSERT INTO assistant_state_current (
      capability_id, key, status, value_json, confidence, updated_at
    ) VALUES (?, ?, 'unknown', ?, 'low', ?)
    ON CONFLICT(capability_id, key) DO UPDATE SET
      status = 'unknown',
      confidence = 'low',
      updated_at = excluded.updated_at
  `).run(input.capabilityId, input.key, stringifyJson({ ...(input.reason ? { reason: input.reason } : {}) }), now);

  const row = getAssistantStateRow(db, input.capabilityId, input.key);
  if (!row) {
    throw new Error(`Failed to mark assistant state unknown for ${input.capabilityId}:${input.key}`);
  }
  return toStateView(row, now);
}

export function listAssistantState(db: AppDatabase, input: {
  capabilityId?: string;
  keys?: string[];
  limit?: number;
  now?: string;
} = {}): AssistantStateView[] {
  const limit = input.limit ?? 100;
  const rows = input.capabilityId
    ? db.prepare(`
        SELECT *
        FROM assistant_state_current
        WHERE capability_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(input.capabilityId, limit) as AssistantStateRow[]
    : db.prepare(`
        SELECT *
        FROM assistant_state_current
        ORDER BY capability_id ASC, updated_at DESC
        LIMIT ?
      `).all(limit) as AssistantStateRow[];

  const keySet = input.keys ? new Set(input.keys) : null;
  return rows
    .filter((row) => !keySet || keySet.has(row.key))
    .map((row) => toStateView(row, input.now ?? nowIso()));
}

export function recordAssistantIntervention(db: AppDatabase, input: AssistantInterventionInput): {
  interventionId: string;
} {
  const now = nowIso();
  const interventionId = createId("asst_int");
  db.prepare(`
    INSERT INTO assistant_interventions (
      id, capability_id, action, reason, user_message, status, sent_message_id,
      state_tags_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    interventionId,
    input.capabilityId,
    input.action,
    input.reason,
    input.userMessage ?? null,
    input.status,
    input.sentMessageId ?? null,
    stringifyJson(input.stateTags ?? []),
    stringifyJson(input.metadata ?? {}),
    now,
    now,
  );
  return { interventionId };
}

export function createAssistantFollowup(db: AppDatabase, input: AssistantFollowupInput): {
  followupId: string;
} {
  const now = nowIso();
  const followupId = createId("asst_followup");
  db.prepare(`
    INSERT INTO assistant_followups (
      id, capability_id, purpose, due_at, status, payload_json, priority, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    followupId,
    input.capabilityId,
    input.purpose,
    input.dueAt,
    stringifyJson(input.payload ?? {}),
    input.priority ?? 300,
    now,
    now,
  );
  return { followupId };
}

export function completeAssistantFollowup(db: AppDatabase, followupId: string): boolean {
  const now = nowIso();
  const result = db.prepare(`
    UPDATE assistant_followups
    SET status = 'completed',
        completed_at = ?,
        updated_at = ?
    WHERE id = ?
      AND status IN ('pending', 'triggered')
  `).run(now, now, followupId);
  return result.changes > 0;
}

export function upsertAssistantDailySummary(db: AppDatabase, input: AssistantDailySummaryInput): {
  summaryId: string;
} {
  const now = nowIso();
  const existing = db.prepare(`
    SELECT id
    FROM assistant_daily_summaries
    WHERE capability_id = ?
      AND local_date = ?
  `).get(input.capabilityId, input.localDate) as { id: string } | undefined;
  const summaryId = existing?.id ?? createId("asst_summary");

  db.prepare(`
    INSERT INTO assistant_daily_summaries (
      id, capability_id, local_date, summary, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(capability_id, local_date) DO UPDATE SET
      summary = excluded.summary,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(
    summaryId,
    input.capabilityId,
    input.localDate,
    input.summary,
    stringifyJson(input.metadata ?? {}),
    now,
    now,
  );

  return { summaryId };
}

export function getDueAssistantFollowups(db: AppDatabase, now: string, limit = 10): Array<{
  id: string;
  capability_id: string;
  purpose: string;
  due_at: string;
  payload_json: string;
  priority: number;
}> {
  return db.prepare(`
    SELECT id, capability_id, purpose, due_at, payload_json, priority
    FROM assistant_followups
    WHERE status = 'pending'
      AND due_at <= ?
    ORDER BY priority ASC, due_at ASC
    LIMIT ?
  `).all(now, limit) as Array<{
    id: string;
    capability_id: string;
    purpose: string;
    due_at: string;
    payload_json: string;
    priority: number;
  }>;
}

export function markAssistantFollowupTriggered(db: AppDatabase, followupId: string): boolean {
  const now = nowIso();
  const result = db.prepare(`
    UPDATE assistant_followups
    SET status = 'triggered',
        updated_at = ?
    WHERE id = ?
      AND status = 'pending'
  `).run(now, followupId);
  return result.changes > 0;
}

function getAssistantStateRow(db: AppDatabase, capabilityId: string, key: string): AssistantStateRow | null {
  return db.prepare(`
    SELECT *
    FROM assistant_state_current
    WHERE capability_id = ?
      AND key = ?
  `).get(capabilityId, key) as AssistantStateRow | undefined ?? null;
}

function toStateView(row: AssistantStateRow, now: string): AssistantStateView {
  return {
    capabilityId: row.capability_id,
    key: row.key,
    status: effectiveStatus(row.status, row.stale_after, now),
    value: parseJsonObject(row.value_json),
    confidence: row.confidence,
    lastObservedAt: row.last_observed_at,
    staleAfter: row.stale_after,
    latestObservationId: row.latest_observation_id,
    updatedAt: row.updated_at,
  };
}

function effectiveStatus(status: AssistantStateStatus, staleAfter: string | null, now: string): AssistantStateStatus {
  if (status === "known" && staleAfter && staleAfter <= now) {
    return "stale";
  }
  return status;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}
