import { appendHubMessage } from "../../kernel/event-hub/append.js";
import type { EventHubNotifier } from "../../kernel/event-hub/notifier.js";
import type { ClaimedDelivery, ConsumerHandler, HubMessage } from "../../kernel/event-hub/types.js";
import { createId } from "../../shared/ids.js";
import { parseJsonObject, stringifyJson, isRecord } from "../../shared/json.js";
import { nowIso } from "../../shared/time.js";
import type { AppDatabase } from "../../storage/sqlite.js";
import type { CodexRunner } from "../../codex/runner.js";
import { SessionRegistry } from "../../codex/session-registry.js";
import { createWorkerToolRegistry } from "../../tools/worker-tools.js";
import { runCodexToolLoop } from "../tool-loop.js";
import { buildWorkerPrompt } from "./context-builder.js";
import { parseWorkerTaskEvent, type WorkerTaskEvent } from "./output-schema.js";

export type WorkerGroupOptions = {
  db: AppDatabase;
  runner: CodexRunner;
  projectRoot: string;
  model?: string;
  env?: Record<string, string | undefined>;
  maxToolIterations?: number;
  notifier?: EventHubNotifier;
};

export function createWorkerGroupHandler(options: WorkerGroupOptions): ConsumerHandler {
  return async (delivery: ClaimedDelivery) => {
    await handleWorkerCommand(options, delivery.message);
  };
}

export async function handleWorkerCommand(options: WorkerGroupOptions, message: HubMessage): Promise<void> {
  switch (message.type) {
    case "command.task.start":
      await runWorkerTask(options, message, "start");
      return;
    case "command.task.continue":
      await runWorkerTask(options, message, "continue");
      return;
    case "command.task.cancel":
      cancelTask(options.db, message, options.notifier);
      return;
    default:
      return;
  }
}

async function runWorkerTask(
  options: WorkerGroupOptions,
  message: HubMessage,
  mode: "start" | "continue",
): Promise<void> {
  const payload = asPayload(message.payload);
  const taskId = getString(payload, "taskId") ?? getString(payload, "task_id") ?? message.id;
  const objective = getString(payload, "objective")
    ?? getString(payload, "instruction")
    ?? `Continue task ${taskId}`;
  const expectedOutput = getString(payload, "expectedOutput") ?? getString(payload, "expected_output");
  const context = getRecord(payload, "context") ?? {};
  const now = nowIso();
  const runId = createId("run");
  const workerSessionId = createId("session");

  ensureTaskRow(options.db, {
    taskId,
    objective,
    priority: message.priority,
    correlationId: message.correlationId,
    context,
    now,
    ...(expectedOutput ? { expectedOutput } : {}),
  });
  createTaskRun(options.db, { runId, taskId, workerSessionId, now });

  const sessionRegistry = new SessionRegistry(options.db);
  const session = sessionRegistry.create({
    id: workerSessionId,
    logicalName: `worker_${taskId}`,
    codexSessionId: `pending:${runId}`,
    role: "worker",
    metadata: {
      taskId,
      runId,
      mode,
    },
  });

  appendHubMessage(options.db, {
    kind: "event",
    type: "event.task.run_started",
    source: "worker_group",
    correlationId: message.correlationId,
    causationId: message.id,
    payload: {
      taskId,
      runId,
      workerSessionId,
      attempt: 1,
    },
  }, { ...(options.notifier ? { notifier: options.notifier } : {}) });

  const workerTools = createWorkerToolRegistry({ taskId, runId, workerSessionId });
  const prompt = buildWorkerPrompt({
    taskId,
    runId,
    objective,
    context,
    registry: workerTools,
    ...(expectedOutput ? { expectedOutput } : {}),
  });

  try {
    const result = await runCodexToolLoop({
      runner: options.runner,
      cwd: options.projectRoot,
      prompt,
      ...(options.model ? { model: options.model } : {}),
      ...(options.env ? { env: options.env } : {}),
      registry: workerTools,
      toolContext: {
        db: options.db,
        source: "worker",
        ...(options.notifier ? { notifier: options.notifier } : {}),
      },
      ...(options.maxToolIterations === undefined ? {} : { maxToolIterations: options.maxToolIterations }),
    });

    if (result.sessionId) {
      sessionRegistry.updateCodexSessionId(session.id, result.sessionId);
    }

    const taskEvent = parseWorkerTaskEvent(result.finalMessage);
    recordTerminalTaskEvent(options.db, {
      taskId,
      runId,
      workerSessionId,
      event: taskEvent,
      source: "worker",
      correlationId: message.correlationId,
      causationId: message.id,
      ...(options.notifier ? { notifier: options.notifier } : {}),
    });
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    sessionRegistry.markFailed(session.id, summary);
    recordTerminalTaskEvent(options.db, {
      taskId,
      runId,
      workerSessionId,
      event: {
        status: "error",
        severity: "error",
        summary,
        shouldNotifyUser: "uncertain",
        needsSupervisorDecision: true,
        artifacts: [],
      },
      source: "worker",
      correlationId: message.correlationId,
      causationId: message.id,
      ...(options.notifier ? { notifier: options.notifier } : {}),
    });
  }
}

function ensureTaskRow(
  db: AppDatabase,
  input: {
    taskId: string;
    objective: string;
    priority: number;
    correlationId: string;
    context: Record<string, unknown>;
    expectedOutput?: string;
    now: string;
  },
): void {
  db.prepare(`
    INSERT INTO tasks (
      id, objective, status, priority, origin_message_id, correlation_id,
      context_json, expected_output, created_at, updated_at
    ) VALUES (?, ?, 'running', ?, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = 'running',
      updated_at = excluded.updated_at
  `).run(
    input.taskId,
    input.objective,
    input.priority,
    input.correlationId,
    stringifyJson(input.context),
    input.expectedOutput ?? null,
    input.now,
    input.now,
  );
}

function createTaskRun(
  db: AppDatabase,
  input: {
    runId: string;
    taskId: string;
    workerSessionId: string;
    now: string;
  },
): void {
  db.prepare(`
    INSERT INTO task_runs (
      id, task_id, worker_session_id, status, attempt, started_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'running', 1, ?, ?, ?)
  `).run(input.runId, input.taskId, input.workerSessionId, input.now, input.now, input.now);
}

function recordTerminalTaskEvent(
  db: AppDatabase,
  input: {
    taskId: string;
    runId: string;
    workerSessionId: string;
    event: WorkerTaskEvent;
    source: string;
    notifier?: EventHubNotifier;
    correlationId: string;
    causationId: string;
  },
): void {
  const eventId = createId("task_evt");
  const now = nowIso();
  const eventType = toEventType(input.event.status);
  const needsDecision = input.event.needsSupervisorDecision || input.event.status === "needs_decision";

  db.prepare(`
    INSERT INTO task_events (
      id, task_id, run_id, worker_session_id, status, severity, summary,
      details, user_impact, recommended_action, should_notify_user,
      needs_supervisor_decision, artifacts_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    input.taskId,
    input.runId,
    input.workerSessionId,
    input.event.status,
    input.event.severity,
    input.event.summary,
    input.event.details ?? null,
    input.event.userImpact ?? null,
    input.event.recommendedAction ?? null,
    input.event.shouldNotifyUser,
    needsDecision ? 1 : 0,
    JSON.stringify(input.event.artifacts),
    now,
  );

  db.prepare(`
    UPDATE task_runs
    SET status = ?, finished_at = ?, updated_at = ?
    WHERE id = ?
  `).run(input.event.status, now, now, input.runId);

  db.prepare(`
    UPDATE tasks
    SET status = ?, updated_at = ?
    WHERE id = ?
  `).run(input.event.status, now, input.taskId);

  appendHubMessage(db, {
    kind: "event",
    type: eventType,
    source: input.source,
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: {
      eventId,
      taskId: input.taskId,
      runId: input.runId,
      workerSessionId: input.workerSessionId,
      status: input.event.status,
      severity: input.event.severity,
      summary: input.event.summary,
      ...(input.event.details ? { details: input.event.details } : {}),
      ...(input.event.userImpact ? { userImpact: input.event.userImpact } : {}),
      ...(input.event.recommendedAction ? { recommendedAction: input.event.recommendedAction } : {}),
      shouldNotifyUser: input.event.shouldNotifyUser,
      needsSupervisorDecision: needsDecision,
      artifacts: input.event.artifacts,
    },
  }, { ...(input.notifier ? { notifier: input.notifier } : {}) });
}

function cancelTask(db: AppDatabase, message: HubMessage, notifier?: EventHubNotifier): void {
  const payload = asPayload(message.payload);
  const taskId = getString(payload, "taskId") ?? getString(payload, "task_id");
  if (!taskId) {
    return;
  }
  const now = nowIso();
  db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, taskId);
  appendHubMessage(db, {
    kind: "event",
    type: "event.task.cancelled",
    source: "worker_group",
    correlationId: message.correlationId,
    causationId: message.id,
    payload: {
      taskId,
      status: "cancelled",
      severity: "notice",
      summary: getString(payload, "reason") ?? "Task cancelled.",
      shouldNotifyUser: "uncertain",
      needsSupervisorDecision: false,
    },
  }, { ...(notifier ? { notifier } : {}) });
}

function toEventType(status: WorkerTaskEvent["status"]): string {
  switch (status) {
    case "success":
    case "warning":
      return "event.task.completed";
    case "error":
      return "event.task.failed";
    case "needs_decision":
      return "event.task.needs_decision";
    case "cancelled":
      return "event.task.cancelled";
    case "timed_out":
      return "event.task.timed_out";
  }
}

function asPayload(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function getRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const item = value[key];
  return isRecord(item) ? item : undefined;
}

function getString(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  return typeof item === "string" ? item : undefined;
}
