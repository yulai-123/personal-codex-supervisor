import { z } from "zod";
import { appendHubMessage } from "../kernel/event-hub/append.js";
import { createId } from "../shared/ids.js";
import { parseJsonObject, stringifyJson } from "../shared/json.js";
import { nowIso } from "../shared/time.js";
import type { AppDatabase } from "../storage/sqlite.js";
import { ToolRegistry } from "./registry.js";

export function createSupervisorToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register({
      name: "task.start",
      description: "Start an asynchronous worker task. Returns accepted metadata immediately; does not wait for completion.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "the user asks for work that may take more than one short turn",
          "the task requires shell, file, browser, code, or multi-step execution",
          "a background task should continue without blocking the Supervisor",
        ],
        doNotUseWhen: [
          "a short answer or status lookup is enough",
          "the task is already running and only needs more instructions; use task.continue instead",
        ],
        returns: "accepted metadata including taskId and commandMessageId; completion arrives later as task events",
        exampleInput: {
          objective: "Inspect the repository health and report test results.",
          priority: 50,
          context: {
            userRequest: "帮我检查项目现在是否健康",
          },
          expectedOutput: "A concise summary of checks run, failures found, and recommended next steps.",
        },
      },
      inputSchema: z.object({
        objective: z.string().min(1),
        priority: z.number().int().positive().optional(),
        context: z.record(z.string(), z.unknown()).optional(),
        expectedOutput: z.string().optional(),
      }),
      handler: ({ db, source, notifier }, input) => {
        const taskId = createId("task");
        const now = nowIso();
        const priority = input.priority ?? 100;
        const correlationId = taskId;

        db.prepare(`
          INSERT INTO tasks (
            id, objective, status, priority, origin_message_id, correlation_id,
            context_json, expected_output, created_at, updated_at
          ) VALUES (?, ?, 'pending', ?, NULL, ?, ?, ?, ?, ?)
        `).run(
          taskId,
          input.objective,
          priority,
          correlationId,
          stringifyJson(input.context ?? {}),
          input.expectedOutput ?? null,
          now,
          now,
        );

        const payload = {
          taskId,
          objective: input.objective,
          context: input.context ?? {},
          ...(input.expectedOutput ? { expectedOutput: input.expectedOutput } : {}),
        };

        const result = appendHubMessage(db, {
          kind: "command",
          type: "command.task.start",
          source,
          priority,
          correlationId,
          payload,
        }, { ...(notifier ? { notifier } : {}) });

        return {
          accepted: true,
          taskId,
          commandMessageId: result.message.id,
        };
      },
    })
    .register({
      name: "task.continue",
      description: "Send follow-up instructions to an existing asynchronous task.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "the user adds context or a decision for an existing task",
          "a worker asked for supervisor guidance and the answer is now known",
        ],
        doNotUseWhen: [
          "starting unrelated new work; use task.start",
          "the task is already terminal unless a new run is intentionally desired",
        ],
        returns: "accepted metadata including commandMessageId",
        exampleInput: {
          taskId: "task_example",
          instruction: "Continue with option A and notify the supervisor if credentials are required.",
          priority: 40,
        },
      },
      inputSchema: z.object({
        taskId: z.string().min(1),
        instruction: z.string().min(1),
        priority: z.number().int().positive().optional(),
      }),
      handler: ({ db, source, notifier }, input) => {
        const result = appendHubMessage(db, {
          kind: "command",
          type: "command.task.continue",
          source,
          priority: input.priority ?? 100,
          correlationId: input.taskId,
          payload: {
            taskId: input.taskId,
            instruction: input.instruction,
          },
        }, { ...(notifier ? { notifier } : {}) });
        return { accepted: true, commandMessageId: result.message.id };
      },
    })
    .register({
      name: "task.cancel",
      description: "Cancel a task if it has not completed.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "the user explicitly cancels a task",
          "continuing would be unsafe, obsolete, or clearly wasteful",
        ],
        doNotUseWhen: [
          "a worker merely failed once and a retry or clarification is better",
        ],
        returns: "accepted metadata including commandMessageId",
        exampleInput: {
          taskId: "task_example",
          reason: "User asked to stop this background task.",
        },
      },
      inputSchema: z.object({
        taskId: z.string().min(1),
        reason: z.string().optional(),
      }),
      handler: ({ db, source, notifier }, input) => {
        const result = appendHubMessage(db, {
          kind: "command",
          type: "command.task.cancel",
          source,
          correlationId: input.taskId,
          payload: {
            taskId: input.taskId,
            reason: input.reason,
          },
        }, { ...(notifier ? { notifier } : {}) });
        return { accepted: true, commandMessageId: result.message.id };
      },
    })
    .register({
      name: "task.get_status",
      description: "Read the current projected state for a task.",
      riskLevel: "read",
      usage: {
        useWhen: [
          "the user asks about one known task",
          "the Supervisor needs current status before deciding whether to continue or notify",
        ],
        doNotUseWhen: [
          "you need full recent event history; use task.get_result",
        ],
        returns: "the current projected task state or null",
        exampleInput: {
          taskId: "task_example",
        },
      },
      inputSchema: z.object({
        taskId: z.string().min(1),
      }),
      handler: ({ db }, input) => {
        return db.prepare("SELECT * FROM tasks_current_state WHERE task_id = ?").get(input.taskId) ?? null;
      },
    })
    .register({
      name: "task.list_active",
      description: "List active tasks from query projections.",
      riskLevel: "read",
      usage: {
        useWhen: [
          "the user asks what is currently running",
          "the Supervisor needs a quick overview before dispatching more work",
        ],
        doNotUseWhen: [
          "you already have the taskId and need detailed history; use task.get_result",
        ],
        returns: "active task projection rows ordered by priority",
        exampleInput: {
          limit: 10,
        },
      },
      inputSchema: z.object({
        limit: z.number().int().positive().max(50).optional(),
      }),
      handler: ({ db }, input) => {
        return db.prepare(`
          SELECT *
          FROM tasks_current_state
          WHERE status IN ('pending', 'running', 'needs_decision')
          ORDER BY priority ASC, updated_at DESC
          LIMIT ?
        `).all(input.limit ?? 20);
      },
    })
    .register({
      name: "task.get_result",
      description: "Read recent task events and current state for a task.",
      riskLevel: "read",
      usage: {
        useWhen: [
          "a task completed, failed, or needs a decision",
          "the Supervisor must decide whether and how to notify the user",
        ],
        doNotUseWhen: [
          "a one-line current status is enough; use task.get_status",
        ],
        returns: "current task projection plus recent task events",
        exampleInput: {
          taskId: "task_example",
          limit: 10,
        },
      },
      inputSchema: z.object({
        taskId: z.string().min(1),
        limit: z.number().int().positive().max(50).optional(),
      }),
      handler: ({ db }, input) => {
        return {
          current: db.prepare("SELECT * FROM tasks_current_state WHERE task_id = ?").get(input.taskId) ?? null,
          events: db.prepare(`
            SELECT *
            FROM recent_task_events
            WHERE task_id = ?
            ORDER BY created_at DESC
            LIMIT ?
          `).all(input.taskId, input.limit ?? 10),
        };
      },
    })
    .register({
      name: "state.get_recent_events",
      description: "Read recent Event Hub messages.",
      riskLevel: "read",
      usage: {
        useWhen: [
          "debugging routing, delivery, or recent system activity",
          "the Supervisor needs event context not available in task projections",
        ],
        doNotUseWhen: [
          "the answer can be obtained from a task-specific query",
        ],
        returns: "recent Event Hub message metadata without full payload bodies",
        exampleInput: {
          limit: 20,
          typePrefix: "event.task.",
        },
      },
      inputSchema: z.object({
        limit: z.number().int().positive().max(100).optional(),
        typePrefix: z.string().optional(),
      }),
      handler: ({ db }, input) => {
        if (input.typePrefix) {
          return db.prepare(`
            SELECT id, kind, type, topic, source, priority, correlation_id, causation_id, created_at
            FROM event_log
            WHERE type LIKE ?
            ORDER BY created_at DESC
            LIMIT ?
          `).all(`${input.typePrefix}%`, input.limit ?? 20);
        }
        return db.prepare(`
          SELECT id, kind, type, topic, source, priority, correlation_id, causation_id, created_at
          FROM event_log
          ORDER BY created_at DESC
          LIMIT ?
        `).all(input.limit ?? 20);
      },
    })
    .register({
      name: "state.get_system_status",
      description: "Read projected system health and delivery backlog counts.",
      riskLevel: "read",
      usage: {
        useWhen: [
          "the user asks if the runtime is healthy",
          "the Supervisor suspects backlog, dead letters, or component issues",
        ],
        doNotUseWhen: [
          "task-specific status is enough",
        ],
        returns: "system health projection rows and delivery counts by group/status",
        exampleInput: {},
      },
      inputSchema: z.object({}),
      handler: ({ db }) => {
        return {
          health: db.prepare("SELECT * FROM system_health_current_state ORDER BY component ASC").all(),
          deliveries: db.prepare(`
            SELECT group_id, status, count(*) AS count
            FROM event_deliveries
            GROUP BY group_id, status
            ORDER BY group_id ASC, status ASC
          `).all(),
        };
      },
    })
    .register({
      name: "message.send_wechat",
      description: "Request an outbound WeChat message. The sender plugin consumes the command asynchronously.",
      riskLevel: "external",
      usage: {
        useWhen: [
          "the Supervisor wants to send any normal user-visible response",
          "a task result should notify the user",
          "the user needs a clarification or decision request",
        ],
        doNotUseWhen: [
          "writing an internal note to the event log is enough",
          "a worker wants to talk to the user directly; workers must report to Supervisor instead",
          "sending to anyone other than the configured owner",
        ],
        returns: "accepted metadata including commandMessageId; send result arrives later from the message plugin; target authorization is enforced by the WeChat device layer",
        exampleInput: {
          text: "我已经启动后台任务，会在有结果后通知你。",
        },
      },
      inputSchema: z.object({
        text: z.string().min(1),
        target: z.string().optional(),
      }),
      handler: ({ db, source, notifier }, input) => {
        const result = appendHubMessage(db, {
          kind: "command",
          type: "command.message.send_wechat",
          source,
          payload: {
            text: input.text,
            target: input.target,
          },
        }, { ...(notifier ? { notifier } : {}) });
        return { accepted: true, commandMessageId: result.message.id };
      },
    })
    .register({
      name: "schedule.create",
      description: "Create a persistent scheduled Event Hub event.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "the user wants a reminder or repeated background trigger",
          "the system should append an Event Hub event at a future time",
        ],
        doNotUseWhen: [
          "the task should start immediately; use task.start",
          "the schedule requires real-world external credentials or unsupported calendar sync",
        ],
        returns: "created scheduled job id and next run timestamp",
        exampleInput: {
          name: "daily_project_check",
          scheduleType: "daily",
          timeOfDay: "09:00",
          eventType: "event.user.message_received",
          topic: "user",
          payload: {
            channel: "schedule",
            text: "Run the daily project health check.",
          },
        },
      },
      inputSchema: z.object({
        name: z.string().min(1),
        scheduleType: z.enum(["interval", "daily", "once"]),
        intervalMs: z.number().int().positive().optional(),
        timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        runAt: z.string().datetime().optional(),
        timezone: z.string().optional(),
        eventType: z.string().regex(/^event\./),
        topic: z.string().optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
        priority: z.number().int().positive().optional(),
      }),
      handler: ({ db }, input) => {
        const jobId = createId("job");
        const now = nowIso();
        const nextRunAt = computeScheduleNextRun(input, now);
        db.prepare(`
          INSERT INTO scheduled_jobs (
            id, name, enabled, schedule_type, interval_ms, time_of_day, timezone,
            next_run_at, event_type, topic, payload_json, priority, created_at, updated_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          jobId,
          input.name,
          input.scheduleType,
          input.intervalMs ?? null,
          input.timeOfDay ?? null,
          input.timezone ?? "UTC",
          nextRunAt,
          input.eventType,
          input.topic ?? inferScheduleTopic(input.eventType),
          stringifyJson(input.payload ?? {}),
          input.priority ?? 300,
          now,
          now,
        );
        return {
          jobId,
          name: input.name,
          nextRunAt,
        };
      },
    })
    .register({
      name: "schedule.list",
      description: "List persistent scheduled jobs.",
      riskLevel: "read",
      usage: {
        useWhen: [
          "the user asks what reminders or scheduled jobs exist",
          "the Supervisor needs to avoid creating duplicate schedules",
        ],
        doNotUseWhen: [
          "looking for active worker tasks; use task.list_active",
        ],
        returns: "scheduled job rows ordered by next run time",
        exampleInput: {
          includeDisabled: false,
          limit: 20,
        },
      },
      inputSchema: z.object({
        includeDisabled: z.boolean().optional(),
        limit: z.number().int().positive().max(100).optional(),
      }),
      handler: ({ db }, input) => {
        if (input.includeDisabled) {
          return db.prepare(`
            SELECT *
            FROM scheduled_jobs
            ORDER BY next_run_at ASC
            LIMIT ?
          `).all(input.limit ?? 20);
        }
        return db.prepare(`
          SELECT *
          FROM scheduled_jobs
          WHERE enabled = 1
          ORDER BY next_run_at ASC
          LIMIT ?
        `).all(input.limit ?? 20);
      },
    })
    .register({
      name: "schedule.cancel",
      description: "Disable a persistent scheduled job.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "the user cancels a reminder or repeated scheduled trigger",
          "a schedule is obsolete or duplicated",
        ],
        doNotUseWhen: [
          "the user wants to stop an active worker task; use task.cancel",
        ],
        returns: "whether a scheduled job was disabled",
        exampleInput: {
          jobId: "job_example",
        },
      },
      inputSchema: z.object({
        jobId: z.string().min(1),
      }),
      handler: ({ db }, input) => {
        const now = nowIso();
        const result = db.prepare(`
          UPDATE scheduled_jobs
          SET enabled = 0,
              updated_at = ?
          WHERE id = ?
        `).run(now, input.jobId);
        return {
          cancelled: result.changes > 0,
          jobId: input.jobId,
        };
      },
    })
    .register({
      name: "task.mark_event_handled",
      description: "Mark a task event as handled by the supervisor.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "the Supervisor has acted on a needs_decision or important task event",
          "a notification decision has been made and duplicate handling should be avoided",
        ],
        doNotUseWhen: [
          "the event still requires user or supervisor action",
        ],
        returns: "whether the event row was marked and the handled timestamp",
        exampleInput: {
          eventId: "task_evt_example",
        },
      },
      inputSchema: z.object({
        eventId: z.string().min(1),
      }),
      handler: ({ db }, input) => {
        const handledAt = nowIso();
        const result = db.prepare("UPDATE task_events SET handled_at = ? WHERE id = ?").run(handledAt, input.eventId);
        return {
          handled: result.changes > 0,
          handledAt,
        };
      },
    });
}

export function readTaskContext(db: AppDatabase, taskId: string): Record<string, unknown> {
  const row = db.prepare("SELECT context_json FROM tasks WHERE id = ?").get(taskId) as { context_json: string } | undefined;
  return row ? parseJsonObject(row.context_json) : {};
}

type ScheduleCreateInput = {
  scheduleType: "interval" | "daily" | "once";
  intervalMs?: number | undefined;
  timeOfDay?: string | undefined;
  runAt?: string | undefined;
  timezone?: string | undefined;
};

function computeScheduleNextRun(input: ScheduleCreateInput, nowIsoText: string): string {
  const now = new Date(nowIsoText);
  if (input.scheduleType === "interval") {
    if (!input.intervalMs) {
      throw new Error("interval schedules require intervalMs");
    }
    return new Date(now.getTime() + input.intervalMs).toISOString();
  }
  if (input.scheduleType === "once") {
    if (!input.runAt) {
      throw new Error("once schedules require runAt");
    }
    return input.runAt;
  }
  if (!input.timeOfDay) {
    throw new Error("daily schedules require timeOfDay");
  }
  return nextDailyRunAfter(now, input.timeOfDay, input.timezone ?? "UTC").toISOString();
}

function nextDailyRunAfter(now: Date, timeOfDay: string, timezone: string): Date {
  const local = getLocalDateTime(now, timezone);
  const [hourText, minuteText] = timeOfDay.split(":");
  const targetMinutes = Number(hourText) * 60 + Number(minuteText);
  const addDays = local.minutesSinceMidnight < targetMinutes ? 0 : 1;
  const targetUtcMs = Date.UTC(local.year, local.month - 1, local.day + addDays, 0, targetMinutes);
  return new Date(targetUtcMs - local.offsetMinutes * 60_000);
}

function getLocalDateTime(
  now: Date,
  timezone: string,
): { year: number; month: number; day: number; minutesSinceMidnight: number; offsetMinutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    minutesSinceMidnight: Number(get("hour")) * 60 + Number(get("minute")),
    offsetMinutes: parseOffsetMinutes(get("timeZoneName")),
  };
}

function parseOffsetMinutes(value: string): number {
  if (value === "GMT" || value === "UTC") {
    return 0;
  }
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(value);
  if (!match) {
    return 0;
  }
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? "0"));
}

function inferScheduleTopic(eventType: string): string {
  const parts = eventType.split(".");
  return parts.length >= 2 && parts[1] ? parts[1] : "schedule";
}
