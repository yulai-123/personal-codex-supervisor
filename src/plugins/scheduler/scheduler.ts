import { appendHubMessage, type AppendHubMessageResult } from "../../kernel/event-hub/index.js";
import type { EventHubNotifier } from "../../kernel/event-hub/notifier.js";
import { createId } from "../../shared/ids.js";
import { parseJsonObject, stringifyJson } from "../../shared/json.js";
import type { RuntimeComponent } from "../../runtime/component.js";
import type { Logger } from "../../runtime/logger.js";
import { sleep } from "../../runtime/sleep.js";
import type { AppDatabase } from "../../storage/sqlite.js";

export type SchedulerOptions = {
  db: AppDatabase;
  notifier?: EventHubNotifier;
  logger: Logger;
  timezone: string;
  handoffTime: string;
  monitorIntervalMs: number;
  cleanupIntervalMs: number;
  handoffCheckIntervalMs: number;
};

export type SeedScheduledJobsInput = {
  timezone: string;
  handoffTime: string;
  monitorIntervalMs: number;
  cleanupIntervalMs: number;
  now?: Date;
};

export function createSchedulerComponent(options: SchedulerOptions): RuntimeComponent {
  const pollIntervalMs = Math.min(
    options.monitorIntervalMs,
    options.cleanupIntervalMs,
    options.handoffCheckIntervalMs,
  );

  return {
    name: "scheduler",
    start: async (signal) => {
      seedSystemScheduledJobs(options.db, {
        timezone: options.timezone,
        handoffTime: options.handoffTime,
        monitorIntervalMs: options.monitorIntervalMs,
        cleanupIntervalMs: options.cleanupIntervalMs,
      });
      runDueScheduledJobs(options, new Date());
      while (!signal.aborted) {
        const result = await sleep(pollIntervalMs, signal);
        if (result === "aborted") {
          return;
        }
        runDueScheduledJobs(options, new Date());
      }
    },
  };
}

export function seedSystemScheduledJobs(db: AppDatabase, input: SeedScheduledJobsInput): void {
  const now = input.now ?? new Date();
  upsertSystemJob(db, {
    name: "system.monitor.tick",
    scheduleType: "interval",
    intervalMs: input.monitorIntervalMs,
    nextRunAt: now.toISOString(),
    eventType: "event.monitor.tick",
    topic: "monitor",
    priority: 300,
    timezone: input.timezone,
  });
  upsertSystemJob(db, {
    name: "system.cleanup.requested",
    scheduleType: "interval",
    intervalMs: input.cleanupIntervalMs,
    nextRunAt: now.toISOString(),
    eventType: "event.cleanup.requested",
    topic: "cleanup",
    priority: 300,
    timezone: input.timezone,
  });
  upsertSystemJob(db, {
    name: "system.maintenance.handoff_required",
    scheduleType: "daily",
    timeOfDay: input.handoffTime,
    nextRunAt: nextDailyRunAfter(now, input.handoffTime, input.timezone).toISOString(),
    eventType: "event.maintenance.handoff_required",
    topic: "maintenance",
    priority: 400,
    timezone: input.timezone,
  });
}

export function runDueScheduledJobs(
  options: Pick<SchedulerOptions, "db" | "logger" | "notifier">,
  now: Date,
  limit = 20,
): AppendHubMessageResult[] {
  const rows = options.db.prepare(`
    SELECT *
    FROM scheduled_jobs
    WHERE enabled = 1
      AND next_run_at <= ?
    ORDER BY priority ASC, next_run_at ASC, created_at ASC
    LIMIT ?
  `).all(now.toISOString(), limit) as ScheduledJobRow[];

  const results: AppendHubMessageResult[] = [];
  for (const row of rows) {
    const runId = createId("job_run");
    const startedAt = new Date().toISOString();
    options.db.prepare(`
      INSERT INTO scheduled_job_runs (
        id, job_id, status, due_at, started_at, created_at, updated_at
      ) VALUES (?, ?, 'running', ?, ?, ?, ?)
    `).run(runId, row.id, row.next_run_at, startedAt, startedAt, startedAt);

    try {
      const result = appendHubMessage(options.db, {
        kind: "event",
        type: row.event_type,
        topic: row.topic,
        source: "scheduler",
        priority: row.priority,
        payload: {
          ...parseJsonObject(row.payload_json),
          jobId: row.id,
          jobName: row.name,
          scheduledAt: row.next_run_at,
        },
        dedupeKey: `${row.name}:${row.next_run_at}`,
      }, { ...(options.notifier ? { notifier: options.notifier } : {}) });
      results.push(result);

      const finishedAt = new Date().toISOString();
      options.db.prepare(`
        UPDATE scheduled_job_runs
        SET status = 'success',
            event_message_id = ?,
            finished_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(result.message.id, finishedAt, finishedAt, runId);

      updateNextRun(options.db, row, now);
    } catch (error) {
      const finishedAt = new Date().toISOString();
      options.db.prepare(`
        UPDATE scheduled_job_runs
        SET status = 'failed',
            error = ?,
            finished_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(error instanceof Error ? error.message : String(error), finishedAt, finishedAt, runId);
      options.logger.error("scheduled job failed", {
        jobId: row.id,
        jobName: row.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (results.length > 0) {
    options.logger.debug("scheduler emitted events", {
      count: results.length,
      types: results.map((result) => result.message.type),
    });
  }
  return results;
}

type UpsertSystemJobInput = {
  name: string;
  scheduleType: "interval" | "daily" | "once";
  intervalMs?: number;
  timeOfDay?: string;
  timezone: string;
  nextRunAt: string;
  eventType: string;
  topic: string;
  priority: number;
  payload?: Record<string, unknown>;
};

type ScheduledJobRow = {
  id: string;
  name: string;
  enabled: number;
  schedule_type: "interval" | "daily" | "once";
  interval_ms: number | null;
  time_of_day: string | null;
  timezone: string;
  next_run_at: string;
  event_type: string;
  topic: string;
  payload_json: string;
  priority: number;
  created_at: string;
  updated_at: string;
};

function upsertSystemJob(db: AppDatabase, input: UpsertSystemJobInput): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO scheduled_jobs (
      id, name, enabled, schedule_type, interval_ms, time_of_day, timezone,
      next_run_at, event_type, topic, payload_json, priority, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      enabled = 1,
      schedule_type = excluded.schedule_type,
      interval_ms = excluded.interval_ms,
      time_of_day = excluded.time_of_day,
      timezone = excluded.timezone,
      event_type = excluded.event_type,
      topic = excluded.topic,
      payload_json = excluded.payload_json,
      priority = excluded.priority,
      updated_at = excluded.updated_at
  `).run(
    createId("job"),
    input.name,
    input.scheduleType,
    input.intervalMs ?? null,
    input.timeOfDay ?? null,
    input.timezone,
    input.nextRunAt,
    input.eventType,
    input.topic,
    stringifyJson(input.payload ?? {}),
    input.priority,
    now,
    now,
  );
}

function updateNextRun(db: AppDatabase, row: ScheduledJobRow, now: Date): void {
  const updatedAt = new Date().toISOString();
  if (row.schedule_type === "once") {
    db.prepare(`
      UPDATE scheduled_jobs
      SET enabled = 0,
          updated_at = ?
      WHERE id = ?
    `).run(updatedAt, row.id);
    return;
  }

  const nextRunAt = row.schedule_type === "daily"
    ? nextDailyRunAfter(now, row.time_of_day ?? "00:00", row.timezone).toISOString()
    : nextIntervalRunAfter(row.next_run_at, row.interval_ms ?? 60_000, now).toISOString();

  db.prepare(`
    UPDATE scheduled_jobs
    SET next_run_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(nextRunAt, updatedAt, row.id);
}

function nextIntervalRunAfter(previousRunAt: string, intervalMs: number, now: Date): Date {
  let next = new Date(new Date(previousRunAt).getTime() + intervalMs);
  while (next <= now) {
    next = new Date(next.getTime() + intervalMs);
  }
  return next;
}

function nextDailyRunAfter(now: Date, timeOfDay: string, timezone: string): Date {
  const local = getLocalDateTime(now, timezone);
  const targetMinutes = parseHourMinute(timeOfDay);
  const addDays = local.minutesSinceMidnight < targetMinutes ? 0 : 1;
  const targetUtcMs = Date.UTC(local.year, local.month - 1, local.day + addDays, 0, targetMinutes);
  return new Date(targetUtcMs - local.offsetMinutes * 60_000);
}

function parseHourMinute(value: string): number {
  const [hourText, minuteText] = value.split(":");
  return Number(hourText) * 60 + Number(minuteText);
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
  const timeZoneName = get("timeZoneName");
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    minutesSinceMidnight: Number(get("hour")) * 60 + Number(get("minute")),
    offsetMinutes: parseOffsetMinutes(timeZoneName),
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
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes);
}
