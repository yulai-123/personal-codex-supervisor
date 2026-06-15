import { describe, expect, it } from "vitest";
import { appendHubMessage } from "../src/kernel/event-hub/append.js";
import { runConsumerOnce } from "../src/kernel/event-hub/consumer-runner.js";
import { getOutboxCurrentState, getTaskCurrentState, listRecentTaskEvents, projectMessage } from "../src/kernel/projections/projector.js";
import { createMigratedTestDatabase } from "./helpers.js";

describe("projections", () => {
  it("projects task lifecycle into query tables", async () => {
    const db = createMigratedTestDatabase("pcs-projection-task-");

    try {
      appendHubMessage(db, {
        kind: "command",
        type: "command.task.start",
        source: "supervisor",
        priority: 20,
        payload: {
          taskId: "task_1",
          objective: "Analyze project",
        },
        correlationId: "corr_1",
      });

      await drainProjectionGroup(db);
      expect(getTaskCurrentState(db, "task_1")).toMatchObject({
        task_id: "task_1",
        objective: "Analyze project",
        status: "pending",
        priority: 20,
        correlation_id: "corr_1",
      });

      appendHubMessage(db, {
        kind: "event",
        type: "event.task.completed",
        source: "worker",
        payload: {
          taskId: "task_1",
          runId: "run_1",
          workerSessionId: "session_worker_1",
          status: "success",
          severity: "notice",
          summary: "Done",
          shouldNotifyUser: "uncertain",
        },
        correlationId: "corr_1",
      });

      await drainProjectionGroup(db);
      expect(getTaskCurrentState(db, "task_1")).toMatchObject({
        task_id: "task_1",
        status: "success",
        latest_run_id: "run_1",
        summary: "Done",
        should_notify_user: "uncertain",
      });
      expect(listRecentTaskEvents(db, "task_1")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("projects outbox state from send command and result events", async () => {
    const db = createMigratedTestDatabase("pcs-projection-outbox-");

    try {
      const command = appendHubMessage(db, {
        kind: "command",
        type: "command.message.send_wechat",
        source: "supervisor",
        payload: {
          text: "hello",
          target: "user",
        },
        correlationId: "corr_message",
      });

      await drainProjectionGroup(db);
      expect(getOutboxCurrentState(db, command.message.id)).toMatchObject({
        message_id: command.message.id,
        channel: "wechat",
        status: "pending",
        target: "user",
        text: "hello",
      });

      appendHubMessage(db, {
        kind: "event",
        type: "event.message.sent",
        source: "wechat.sender",
        causationId: command.message.id,
        payload: {},
        correlationId: "corr_message",
      });

      await drainProjectionGroup(db);
      expect(getOutboxCurrentState(db, command.message.id)).toMatchObject({
        status: "sent",
      });
    } finally {
      db.close();
    }
  });
});

async function drainProjectionGroup(db: ReturnType<typeof createMigratedTestDatabase>): Promise<void> {
  for (;;) {
    const result = await runConsumerOnce(db, {
      groupId: "projection_group",
      handler: ({ message }) => projectMessage(db, message),
      leaseMs: 60_000,
      maxAttempts: 3,
      batchSize: 10,
      workerId: "projection-test",
    });
    if (result.claimed === 0) {
      return;
    }
  }
}
