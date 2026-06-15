import { appendHubMessage } from "../kernel/event-hub/append.js";
import type { EventHubNotifier } from "../kernel/event-hub/notifier.js";
import type { ConsumerHandler } from "../kernel/event-hub/types.js";
import { SessionRegistry } from "../codex/session-registry.js";
import { createId } from "../shared/ids.js";
import { stringifyJson } from "../shared/json.js";
import { nowIso } from "../shared/time.js";
import type { AppDatabase } from "../storage/sqlite.js";

export type MaintenanceOptions = {
  db: AppDatabase;
  supervisorLogicalName: string;
  notifier?: EventHubNotifier;
};

export function createMaintenanceHandler(options: MaintenanceOptions): ConsumerHandler {
  return ({ message }) => {
    if (message.type !== "event.maintenance.handoff_required") {
      return;
    }

    const registry = new SessionRegistry(options.db);
    const active = registry.getActive(options.supervisorLogicalName, "supervisor");
    const summary = buildHandoffSummary(options.db);
    const handoffId = createHandoffRow(options.db, {
      logicalName: options.supervisorLogicalName,
      status: "requested",
      summary,
      ...(active ? { oldSessionId: active.id, oldCodexSessionId: active.codexSessionId } : {}),
    });

    if (!active) {
      updateHandoffStatus(options.db, handoffId, "skipped", {
        error: "no active supervisor session",
      });
      appendHubMessage(options.db, {
        kind: "event",
        type: "event.maintenance.handoff_skipped",
        source: "maintenance",
        correlationId: message.correlationId,
        causationId: message.id,
        payload: {
          handoffId,
          reason: "no active supervisor session",
          summary,
        },
      }, appendOptions(options));
      return;
    }

    updateHandoffStatus(options.db, handoffId, "summarized");
    const summaryText = stringifyJson(summary);
    registry.archive(active.id, summaryText);
    updateHandoffStatus(options.db, handoffId, "archived");
    appendHubMessage(options.db, {
      kind: "event",
      type: "event.session.archived",
      source: "maintenance",
      correlationId: message.correlationId,
      causationId: message.id,
      payload: {
        handoffId,
        sessionId: active.id,
        logicalName: active.logicalName,
        codexSessionId: active.codexSessionId,
        role: active.role,
        status: "archived",
        handoffSummary: summaryText,
      },
    }, appendOptions(options));
    appendHubMessage(options.db, {
      kind: "event",
      type: "event.maintenance.handoff_completed",
      source: "maintenance",
      correlationId: message.correlationId,
      causationId: message.id,
      payload: {
        handoffId,
        archivedSessionId: active.id,
        logicalName: active.logicalName,
        handoffSummary: summary,
      },
    }, appendOptions(options));
  };
}

export type HandoffSummary = {
  generatedBy: "maintenance";
  activeTasks: unknown[];
  openDecisions: unknown[];
  recentImportantContext: unknown[];
  nextSupervisorInstructions: string[];
};

export function buildHandoffSummary(db: AppDatabase): HandoffSummary {
  const activeTasks = db.prepare(`
    SELECT task_id, objective, status, priority, summary, updated_at
    FROM tasks_current_state
    WHERE status IN ('pending', 'running', 'needs_decision')
    ORDER BY priority ASC, updated_at DESC
    LIMIT 20
  `).all();
  const openDecisions = db.prepare(`
    SELECT event_id, task_id, run_id, status, severity, summary, created_at
    FROM recent_task_events
    WHERE needs_supervisor_decision = 1
    ORDER BY created_at DESC
    LIMIT 20
  `).all();
  const recentImportantContext = db.prepare(`
    SELECT id, kind, type, source, priority, correlation_id, created_at
    FROM event_log
    WHERE type IN (
      'event.task.failed',
      'event.task.needs_decision',
      'event.message.send_failed',
      'event.system.alert'
    )
    ORDER BY created_at DESC
    LIMIT 20
  `).all();

  return {
    generatedBy: "maintenance",
    activeTasks,
    openDecisions,
    recentImportantContext,
    nextSupervisorInstructions: [
      "Use this handoff summary as continuity context for the next supervisor session.",
      "Check active tasks and open decisions before starting duplicate work.",
      "Do not notify the user unless a task result or decision warrants it.",
    ],
  };
}

function appendOptions(options: MaintenanceOptions) {
  return options.notifier ? { notifier: options.notifier } : {};
}

function createHandoffRow(
  db: AppDatabase,
  input: {
    logicalName: string;
    oldSessionId?: string;
    oldCodexSessionId?: string;
    status: "requested" | "skipped";
    summary: HandoffSummary;
  },
): string {
  const id = createId("handoff");
  const now = nowIso();
  db.prepare(`
    INSERT INTO session_handoffs (
      id, logical_name, old_session_id, old_codex_session_id, status,
      summary_json, requested_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.logicalName,
    input.oldSessionId ?? null,
    input.oldCodexSessionId ?? null,
    input.status,
    stringifyJson(input.summary),
    now,
    now,
    now,
  );
  return id;
}

function updateHandoffStatus(
  db: AppDatabase,
  handoffId: string,
  status: "summarized" | "archived" | "activated" | "skipped" | "failed",
  options: {
    newSessionId?: string;
    error?: string;
  } = {},
): void {
  const now = nowIso();
  const timestampColumn = `${status}_at`;
  const allowedTimestampColumns = new Set(["summarized_at", "archived_at", "activated_at"]);
  const timestampUpdate = allowedTimestampColumns.has(timestampColumn)
    ? `, ${timestampColumn} = ?`
    : "";
  const params = timestampUpdate
    ? [status, options.newSessionId ?? null, options.error ?? null, now, now, handoffId]
    : [status, options.newSessionId ?? null, options.error ?? null, now, handoffId];

  db.prepare(`
    UPDATE session_handoffs
    SET status = ?,
        new_session_id = COALESCE(?, new_session_id),
        error = COALESCE(?, error),
        updated_at = ?
        ${timestampUpdate}
    WHERE id = ?
  `).run(...params);
}
