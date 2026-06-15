import { describe, expect, it } from "vitest";
import { EventHubNotifier } from "../src/kernel/event-hub/notifier.js";
import { runDueScheduledJobs } from "../src/plugins/scheduler/index.js";
import { createLogger } from "../src/runtime/logger.js";
import { createSupervisorToolRegistry } from "../src/tools/supervisor-tools.js";
import { createWorkerToolRegistry } from "../src/tools/worker-tools.js";
import { createMigratedTestDatabase } from "./helpers.js";

describe("internal tool registries", () => {
  it("lets the supervisor start asynchronous worker tasks through Event Hub", async () => {
    const db = createMigratedTestDatabase("pcs-tools-supervisor-");

    try {
      const registry = createSupervisorToolRegistry();
      const notifier = new EventHubNotifier();
      const waitForWorker = notifier.wait("worker_group", 5_000);
      const result = await registry.execute(
        { db, source: "supervisor", notifier },
        {
          id: "call_1",
          name: "task.start",
          input: {
            objective: "Summarize project architecture",
            priority: 20,
            context: { source: "test" },
            expectedOutput: "A short summary",
          },
        },
      );

      expect(result.ok).toBe(true);
      await expect(waitForWorker).resolves.toBe("wake");
      const output = result.output as { taskId: string; commandMessageId: string };
      expect(output.taskId).toMatch(/^task_/);

      expect(db.prepare("SELECT objective, status, priority FROM tasks WHERE id = ?").get(output.taskId)).toMatchObject({
        objective: "Summarize project architecture",
        status: "pending",
        priority: 20,
      });
      expect(db.prepare("SELECT type, kind FROM event_log WHERE id = ?").get(output.commandMessageId)).toMatchObject({
        type: "command.task.start",
        kind: "command",
      });
      expect(db.prepare("SELECT group_id FROM event_deliveries WHERE message_id = ? ORDER BY group_id").all(output.commandMessageId))
        .toEqual(expect.arrayContaining([
          { group_id: "projection_group" },
          { group_id: "worker_group" },
        ]));
    } finally {
      db.close();
    }
  });

  it("lets the supervisor create persistent schedules", async () => {
    const db = createMigratedTestDatabase("pcs-tools-schedule-");

    try {
      const registry = createSupervisorToolRegistry();
      const result = await registry.execute(
        { db, source: "supervisor" },
        {
          id: "call_1",
          name: "schedule.create",
          input: {
            name: "test_once_schedule",
            scheduleType: "once",
            runAt: "2026-06-15T01:00:00.000Z",
            eventType: "event.user.message_received",
            payload: {
              channel: "schedule",
              text: "scheduled task",
            },
          },
        },
      );

      expect(result.ok).toBe(true);
      const output = result.output as { jobId: string };
      expect(db.prepare("SELECT name, event_type FROM scheduled_jobs WHERE id = ?").get(output.jobId))
        .toMatchObject({
          name: "test_once_schedule",
          event_type: "event.user.message_received",
        });

      const due = runDueScheduledJobs({
        db,
        logger: createLogger({ level: "error" }),
      }, new Date("2026-06-15T01:00:00.000Z"));
      expect(due.map((item) => item.message.type)).toContain("event.user.message_received");
      expect(db.prepare("SELECT enabled FROM scheduled_jobs WHERE id = ?").get(output.jobId))
        .toMatchObject({ enabled: 0 });
    } finally {
      db.close();
    }
  });

  it("lets workers report progress and request supervisor decisions", async () => {
    const db = createMigratedTestDatabase("pcs-tools-worker-");

    try {
      db.prepare(`
        INSERT INTO tasks (id, objective, status, priority, correlation_id, created_at, updated_at)
        VALUES ('task_1', 'Test worker tools', 'running', 100, 'task_1', datetime('now'), datetime('now'))
      `).run();
      db.prepare(`
        INSERT INTO task_runs (id, task_id, worker_session_id, status, attempt, created_at, updated_at)
        VALUES ('run_1', 'task_1', 'session_worker_1', 'running', 1, datetime('now'), datetime('now'))
      `).run();

      const registry = createWorkerToolRegistry({
        taskId: "task_1",
        runId: "run_1",
        workerSessionId: "session_worker_1",
      });

      const progress = await registry.execute(
        { db, source: "worker" },
        {
          id: "call_1",
          name: "task.report_progress",
          input: {
            summary: "Half way done",
            details: "Collected inputs",
          },
        },
      );
      const decision = await registry.execute(
        { db, source: "worker" },
        {
          id: "call_2",
          name: "task.needs_decision",
          input: {
            summary: "Need a choice",
            details: "Should this notify the user?",
            recommendedAction: "Ask the supervisor before sending a message.",
          },
        },
      );

      expect(progress.ok).toBe(true);
      expect(decision.ok).toBe(true);
      expect(db.prepare("SELECT count(*) AS count FROM task_events").get()).toMatchObject({ count: 2 });
      expect(db.prepare("SELECT type FROM event_log").all()).toEqual(expect.arrayContaining([
        { type: "event.task.progress_updated" },
        { type: "event.task.needs_decision" },
      ]));
    } finally {
      db.close();
    }
  });
});
