import type { AppDatabase } from "../../storage/sqlite.js";
import { getBoolean, getNumber, getString, isRecord, stringifyJson } from "../../shared/json.js";
import type { HubMessage } from "../event-hub/types.js";

export function projectMessage(db: AppDatabase, message: HubMessage): void {
  switch (message.type) {
    case "command.task.start":
      projectTaskStart(db, message);
      return;
    case "event.task.run_started":
      projectTaskRunStarted(db, message);
      return;
    case "event.task.progress_updated":
    case "event.task.completed":
    case "event.task.failed":
    case "event.task.needs_decision":
    case "event.task.cancelled":
    case "event.task.timed_out":
      projectTaskEvent(db, message);
      return;
    case "command.message.send_wechat":
      projectWechatCommand(db, message);
      return;
    case "event.message.sent":
      projectMessageSent(db, message);
      return;
    case "event.message.send_failed":
      projectMessageFailed(db, message);
      return;
    case "event.session.created":
    case "event.session.archived":
      projectSessionEvent(db, message);
      return;
    case "event.system.health":
    case "event.system.alert":
      projectSystemHealth(db, message);
      return;
    default:
      return;
  }
}

export function getTaskCurrentState(db: AppDatabase, taskId: string): TaskCurrentState | null {
  return db.prepare("SELECT * FROM tasks_current_state WHERE task_id = ?").get(taskId) as TaskCurrentState | undefined ?? null;
}

export function getOutboxCurrentState(db: AppDatabase, messageId: string): OutboxCurrentState | null {
  return db.prepare("SELECT * FROM outbox_current_state WHERE message_id = ?").get(messageId) as OutboxCurrentState | undefined ?? null;
}

export function listRecentTaskEvents(db: AppDatabase, taskId: string, limit = 20): RecentTaskEvent[] {
  return db.prepare(`
    SELECT *
    FROM recent_task_events
    WHERE task_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(taskId, limit) as RecentTaskEvent[];
}

type TaskCurrentState = {
  task_id: string;
  objective: string | null;
  status: string;
  priority: number;
  correlation_id: string;
  latest_run_id: string | null;
  latest_task_event_id: string | null;
  summary: string | null;
  should_notify_user: string | null;
  needs_supervisor_decision: number;
  created_at: string;
  updated_at: string;
};

type RecentTaskEvent = {
  event_id: string;
  task_id: string;
  run_id: string | null;
  worker_session_id: string | null;
  status: string;
  severity: string;
  summary: string;
  should_notify_user: string;
  needs_supervisor_decision: number;
  created_at: string;
};

type OutboxCurrentState = {
  message_id: string;
  channel: string;
  status: string;
  target: string | null;
  text: string;
  attempts: number;
  last_error: string | null;
  correlation_id: string;
  command_message_id: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

function projectTaskStart(db: AppDatabase, message: HubMessage): void {
  const payload = asPayload(message.payload);
  const taskId = getString(payload, "taskId") ?? getString(payload, "task_id") ?? message.id;
  const objective = getString(payload, "objective") ?? "";
  const priority = getNumber(payload, "priority") ?? message.priority;

  db.prepare(`
    INSERT INTO tasks_current_state (
      task_id, objective, status, priority, correlation_id, created_at, updated_at
    ) VALUES (?, ?, 'pending', ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      objective = excluded.objective,
      priority = excluded.priority,
      correlation_id = excluded.correlation_id,
      updated_at = excluded.updated_at
  `).run(taskId, objective, priority, message.correlationId, message.createdAt, message.createdAt);
}

function projectTaskRunStarted(db: AppDatabase, message: HubMessage): void {
  const payload = asPayload(message.payload);
  const runId = getString(payload, "runId") ?? getString(payload, "run_id") ?? message.id;
  const taskId = getString(payload, "taskId") ?? getString(payload, "task_id");
  if (!taskId) return;

  const workerSessionId = getString(payload, "workerSessionId") ?? getString(payload, "worker_session_id");
  const artifactDir = getString(payload, "artifactDir") ?? getString(payload, "artifact_dir");
  const attempt = getNumber(payload, "attempt") ?? 1;

  db.prepare(`
    INSERT INTO task_runs_current_state (
      run_id, task_id, worker_session_id, status, attempt, artifact_dir, started_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      worker_session_id = excluded.worker_session_id,
      status = 'running',
      attempt = excluded.attempt,
      artifact_dir = excluded.artifact_dir,
      started_at = excluded.started_at,
      updated_at = excluded.updated_at
  `).run(runId, taskId, workerSessionId ?? null, attempt, artifactDir ?? null, message.createdAt, message.createdAt, message.createdAt);

  db.prepare(`
    UPDATE tasks_current_state
    SET status = 'running',
        latest_run_id = ?,
        updated_at = ?
    WHERE task_id = ?
  `).run(runId, message.createdAt, taskId);
}

function projectTaskEvent(db: AppDatabase, message: HubMessage): void {
  const payload = asPayload(message.payload);
  const taskId = getString(payload, "taskId") ?? getString(payload, "task_id");
  if (!taskId) return;

  const runId = getString(payload, "runId") ?? getString(payload, "run_id");
  const workerSessionId = getString(payload, "workerSessionId") ?? getString(payload, "worker_session_id");
  const status = normalizeTaskStatus(message.type, getString(payload, "status"));
  const severity = getString(payload, "severity") ?? defaultSeverity(status);
  const summary = getString(payload, "summary") ?? "";
  const shouldNotify = getString(payload, "shouldNotifyUser") ?? getString(payload, "should_notify_user") ?? "uncertain";
  const needsDecision = toIntegerBoolean(
    getBoolean(payload, "needsSupervisorDecision")
      ?? getBoolean(payload, "needs_supervisor_decision")
      ?? status === "needs_decision",
  );

  db.prepare(`
    INSERT OR REPLACE INTO recent_task_events (
      event_id, task_id, run_id, worker_session_id, status, severity, summary,
      should_notify_user, needs_supervisor_decision, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.id,
    taskId,
    runId ?? null,
    workerSessionId ?? null,
    status,
    severity,
    summary,
    shouldNotify,
    needsDecision,
    message.createdAt,
  );

  db.prepare(`
    INSERT INTO tasks_current_state (
      task_id, objective, status, priority, correlation_id, latest_run_id,
      latest_task_event_id, summary, should_notify_user, needs_supervisor_decision,
      created_at, updated_at
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      status = excluded.status,
      latest_run_id = COALESCE(excluded.latest_run_id, tasks_current_state.latest_run_id),
      latest_task_event_id = excluded.latest_task_event_id,
      summary = excluded.summary,
      should_notify_user = excluded.should_notify_user,
      needs_supervisor_decision = excluded.needs_supervisor_decision,
      updated_at = excluded.updated_at
  `).run(
    taskId,
    status,
    message.priority,
    message.correlationId,
    runId ?? null,
    message.id,
    summary,
    shouldNotify,
    needsDecision,
    message.createdAt,
    message.createdAt,
  );

  if (runId) {
    db.prepare(`
      INSERT INTO task_runs_current_state (
        run_id, task_id, worker_session_id, status, attempt, created_at, updated_at, finished_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        worker_session_id = COALESCE(excluded.worker_session_id, task_runs_current_state.worker_session_id),
        status = excluded.status,
        finished_at = excluded.finished_at,
        updated_at = excluded.updated_at
    `).run(
      runId,
      taskId,
      workerSessionId ?? null,
      status,
      message.createdAt,
      message.createdAt,
      isTerminalTaskStatus(status) ? message.createdAt : null,
    );
  }
}

function projectWechatCommand(db: AppDatabase, message: HubMessage): void {
  const payload = asPayload(message.payload);
  const text = getString(payload, "text") ?? "";
  const target = getString(payload, "target");

  db.prepare(`
    INSERT INTO outbox_current_state (
      message_id, channel, status, target, text, attempts, correlation_id,
      command_message_id, created_at, updated_at
    ) VALUES (?, 'wechat', 'pending', ?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      target = excluded.target,
      text = excluded.text,
      updated_at = excluded.updated_at
  `).run(message.id, target ?? null, text, message.correlationId, message.id, message.createdAt, message.createdAt);
}

function projectMessageSent(db: AppDatabase, message: HubMessage): void {
  const commandId = findCommandMessageId(message);
  if (!commandId) return;

  db.prepare(`
    UPDATE outbox_current_state
    SET status = 'sent',
        sent_at = ?,
        updated_at = ?
    WHERE message_id = ? OR command_message_id = ?
  `).run(message.createdAt, message.createdAt, commandId, commandId);
}

function projectMessageFailed(db: AppDatabase, message: HubMessage): void {
  const commandId = findCommandMessageId(message);
  if (!commandId) return;

  const payload = asPayload(message.payload);
  const error = getString(payload, "error") ?? getString(payload, "lastError") ?? "send failed";

  db.prepare(`
    UPDATE outbox_current_state
    SET status = 'failed',
        attempts = attempts + 1,
        last_error = ?,
        updated_at = ?
    WHERE message_id = ? OR command_message_id = ?
  `).run(error, message.createdAt, commandId, commandId);
}

function projectSessionEvent(db: AppDatabase, message: HubMessage): void {
  const payload = asPayload(message.payload);
  const sessionId = getString(payload, "sessionId") ?? getString(payload, "session_id") ?? message.id;
  const logicalName = getString(payload, "logicalName") ?? getString(payload, "logical_name") ?? "default";
  const codexSessionId = getString(payload, "codexSessionId") ?? getString(payload, "codex_session_id") ?? sessionId;
  const role = getString(payload, "role") ?? "worker";
  const status = message.type === "event.session.archived" ? "archived" : (getString(payload, "status") ?? "active");
  const handoffSummary = getString(payload, "handoffSummary") ?? getString(payload, "handoff_summary");

  db.prepare(`
    INSERT INTO sessions_current_state (
      session_id, logical_name, codex_session_id, role, status, handoff_summary, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      logical_name = excluded.logical_name,
      codex_session_id = excluded.codex_session_id,
      role = excluded.role,
      status = excluded.status,
      handoff_summary = excluded.handoff_summary,
      updated_at = excluded.updated_at
  `).run(sessionId, logicalName, codexSessionId, role, status, handoffSummary ?? null, message.createdAt);
}

function projectSystemHealth(db: AppDatabase, message: HubMessage): void {
  const payload = asPayload(message.payload);
  const component = getString(payload, "component") ?? message.topic;
  const status = getString(payload, "status") ?? (message.type === "event.system.alert" ? "alert" : "ok");
  const severity = getString(payload, "severity") ?? (message.type === "event.system.alert" ? "critical" : "info");
  const summary = getString(payload, "summary") ?? "";

  db.prepare(`
    INSERT INTO system_health_current_state (
      component, status, severity, summary, last_event_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(component) DO UPDATE SET
      status = excluded.status,
      severity = excluded.severity,
      summary = excluded.summary,
      last_event_id = excluded.last_event_id,
      updated_at = excluded.updated_at
  `).run(component, status, severity, summary, message.id, message.createdAt);
}

function asPayload(payload: unknown): Record<string, unknown> {
  return isRecord(payload) ? payload : {};
}

function normalizeTaskStatus(type: string, status: string | undefined): string {
  if (status) return status;
  const suffix = type.split(".").at(-1);
  switch (suffix) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed_out";
    case "needs_decision":
      return "needs_decision";
    case "progress_updated":
      return "running";
    default:
      return "running";
  }
}

function defaultSeverity(status: string): string {
  switch (status) {
    case "error":
    case "timed_out":
      return "error";
    case "warning":
    case "needs_decision":
      return "warning";
    default:
      return "info";
  }
}

function isTerminalTaskStatus(status: string): boolean {
  return ["success", "warning", "error", "needs_decision", "cancelled", "timed_out"].includes(status);
}

function toIntegerBoolean(value: boolean): number {
  return value ? 1 : 0;
}

function findCommandMessageId(message: HubMessage): string | undefined {
  const payload = asPayload(message.payload);
  return getString(payload, "commandMessageId")
    ?? getString(payload, "command_message_id")
    ?? getString(payload, "messageId")
    ?? getString(payload, "message_id")
    ?? message.causationId;
}
