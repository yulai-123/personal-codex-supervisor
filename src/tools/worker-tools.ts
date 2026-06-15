import { z } from "zod";
import { appendHubMessage } from "../kernel/event-hub/append.js";
import { createId } from "../shared/ids.js";
import { stringifyJson } from "../shared/json.js";
import { nowIso } from "../shared/time.js";
import { ToolRegistry } from "./registry.js";

export type WorkerToolRegistryOptions = {
  taskId: string;
  runId: string;
  workerSessionId: string;
};

export function createWorkerToolRegistry(options: WorkerToolRegistryOptions): ToolRegistry {
  return new ToolRegistry()
    .register({
      name: "task.report_progress",
      description: "Record non-terminal task progress for the supervisor.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "the task is long-running and meaningful progress has been made",
          "the worker is about to perform a risky or slow phase and the supervisor should have visibility",
        ],
        doNotUseWhen: [
          "the task is about to finish immediately",
          "the update is noisy or not useful for later diagnosis",
        ],
        returns: "accepted metadata including task event id and Event Hub message id",
        exampleInput: {
          summary: "Finished reading the project structure and started running tests.",
          details: "No user action is needed yet.",
          severity: "info",
          shouldNotifyUser: "no",
        },
      },
      inputSchema: z.object({
        summary: z.string().min(1),
        details: z.string().optional(),
        severity: z.enum(["debug", "info", "notice", "warning", "error", "critical"]).optional(),
        shouldNotifyUser: z.enum(["yes", "no", "uncertain"]).optional(),
      }),
      handler: ({ db, source, notifier }, input) => {
        const eventId = createId("task_evt");
        const now = nowIso();
        db.prepare(`
          INSERT INTO task_events (
            id, task_id, run_id, worker_session_id, status, severity, summary,
            details, should_notify_user, needs_supervisor_decision, artifacts_json, created_at
          ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, 0, '[]', ?)
        `).run(
          eventId,
          options.taskId,
          options.runId,
          options.workerSessionId,
          input.severity ?? "info",
          input.summary,
          input.details ?? null,
          input.shouldNotifyUser ?? "no",
          now,
        );

        const result = appendHubMessage(db, {
          kind: "event",
          type: "event.task.progress_updated",
          source,
          correlationId: options.taskId,
          payload: {
            eventId,
            taskId: options.taskId,
            runId: options.runId,
            workerSessionId: options.workerSessionId,
            status: "running",
            severity: input.severity ?? "info",
            summary: input.summary,
            ...(input.details ? { details: input.details } : {}),
            shouldNotifyUser: input.shouldNotifyUser ?? "no",
            needsSupervisorDecision: false,
          },
        }, { ...(notifier ? { notifier } : {}) });

        return { accepted: true, eventId, messageId: result.message.id };
      },
    })
    .register({
      name: "task.register_artifact",
      description: "Register a local artifact path produced by this worker run.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "the worker produced a file, report, screenshot, log, or other durable artifact",
          "the final task event should reference output that exists on disk",
        ],
        doNotUseWhen: [
          "the result is only a short textual summary",
          "the path contains secrets or private credentials",
        ],
        returns: "artifact id for later reference in the final task event",
        exampleInput: {
          path: "local-only/artifacts/task_example/report.md",
          mediaType: "text/markdown",
          metadata: {
            description: "Task report",
          },
        },
      },
      inputSchema: z.object({
        path: z.string().min(1),
        mediaType: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      handler: ({ db }, input) => {
        const artifactId = createId("artifact");
        db.prepare(`
          INSERT INTO artifacts (id, task_id, run_id, path, media_type, metadata_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          artifactId,
          options.taskId,
          options.runId,
          input.path,
          input.mediaType ?? null,
          stringifyJson(input.metadata ?? {}),
          nowIso(),
        );
        return { artifactId };
      },
    })
    .register({
      name: "task.needs_decision",
      description: "Ask the supervisor to make a decision before the worker continues.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "the worker needs user preference, permission, credentials, or a product decision",
          "continuing without guidance would be risky or likely wrong",
        ],
        doNotUseWhen: [
          "the worker can choose a safe default and report it in the final event",
          "the question is only a minor implementation detail",
        ],
        returns: "accepted metadata including task event id and Event Hub message id",
        exampleInput: {
          summary: "Need permission before modifying a remote service.",
          details: "The task requires changing deployment settings.",
          recommendedAction: "Ask the user whether to proceed with the remote change.",
          shouldNotifyUser: "yes",
        },
      },
      inputSchema: z.object({
        summary: z.string().min(1),
        details: z.string().optional(),
        recommendedAction: z.string().optional(),
        shouldNotifyUser: z.enum(["yes", "no", "uncertain"]).optional(),
      }),
      handler: ({ db, source, notifier }, input) => {
        const eventId = createId("task_evt");
        const now = nowIso();
        db.prepare(`
          INSERT INTO task_events (
            id, task_id, run_id, worker_session_id, status, severity, summary,
            details, recommended_action, should_notify_user, needs_supervisor_decision,
            artifacts_json, created_at
          ) VALUES (?, ?, ?, ?, 'needs_decision', 'notice', ?, ?, ?, ?, 1, '[]', ?)
        `).run(
          eventId,
          options.taskId,
          options.runId,
          options.workerSessionId,
          input.summary,
          input.details ?? null,
          input.recommendedAction ?? null,
          input.shouldNotifyUser ?? "uncertain",
          now,
        );

        const result = appendHubMessage(db, {
          kind: "event",
          type: "event.task.needs_decision",
          source,
          correlationId: options.taskId,
          payload: {
            eventId,
            taskId: options.taskId,
            runId: options.runId,
            workerSessionId: options.workerSessionId,
            status: "needs_decision",
            severity: "notice",
            summary: input.summary,
            ...(input.details ? { details: input.details } : {}),
            ...(input.recommendedAction ? { recommendedAction: input.recommendedAction } : {}),
            shouldNotifyUser: input.shouldNotifyUser ?? "uncertain",
            needsSupervisorDecision: true,
          },
        }, { ...(notifier ? { notifier } : {}) });

        return { accepted: true, eventId, messageId: result.message.id };
      },
    })
    .register({
      name: "state.get_task_context",
      description: "Read immutable task context and recent task events.",
      riskLevel: "read",
      usage: {
        useWhen: [
          "the worker needs original task context or recent events before continuing",
          "a continue command lacks enough local detail",
        ],
        doNotUseWhen: [
          "the current prompt already contains all necessary task context",
        ],
        returns: "the task row and recent task_events for this task",
        exampleInput: {},
      },
      inputSchema: z.object({}),
      handler: ({ db }) => {
        const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(options.taskId) ?? null;
        const events = db.prepare(`
          SELECT *
          FROM task_events
          WHERE task_id = ?
          ORDER BY created_at DESC
          LIMIT 20
        `).all(options.taskId);
        return { task, events };
      },
    });
}
