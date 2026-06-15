import { describe, expect, it, vi } from "vitest";
import { appendHubMessage } from "../src/kernel/event-hub/append.js";
import { ackDelivery, claimReadyDeliveries, failDelivery } from "../src/kernel/event-hub/deliveries.js";
import { EventHubNotifier } from "../src/kernel/event-hub/notifier.js";
import { runConsumerOnce } from "../src/kernel/event-hub/consumer-runner.js";
import { createMigratedTestDatabase } from "./helpers.js";

describe("Event Hub", () => {
  it("appends messages, routes deliveries, and wakes affected groups", async () => {
    const db = createMigratedTestDatabase("pcs-event-hub-append-");
    const notifier = new EventHubNotifier();
    const wait = notifier.wait("supervisor_group", 5_000);

    try {
      const result = appendHubMessage(
        db,
        {
          kind: "event",
          type: "event.wechat.message_received",
          source: "test",
          payload: { text: "hello" },
          dedupeKey: "wechat-message-1",
        },
        { notifier },
      );

      await expect(wait).resolves.toBe("wake");
      expect(result.duplicate).toBe(false);
      expect(result.deliveryGroupIds).toEqual(expect.arrayContaining(["projection_group", "supervisor_group"]));

      const duplicate = appendHubMessage(
        db,
        {
          kind: "event",
          type: "event.wechat.message_received",
          source: "test",
          payload: { text: "hello again" },
          dedupeKey: "wechat-message-1",
        },
        { notifier },
      );

      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.message.id).toBe(result.message.id);
      expect(duplicate.deliveryGroupIds).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("claims deliveries in priority order and acks them", () => {
    const db = createMigratedTestDatabase("pcs-event-hub-claim-");

    try {
      appendHubMessage(db, {
        kind: "command",
        type: "command.task.start",
        source: "test",
        priority: 50,
        payload: { taskId: "task_low", objective: "low" },
      });
      appendHubMessage(db, {
        kind: "command",
        type: "command.task.start",
        source: "test",
        priority: 10,
        payload: { taskId: "task_high", objective: "high" },
      });

      const claimed = claimReadyDeliveries(db, "worker_group", {
        limit: 2,
        leaseMs: 60_000,
        workerId: "worker-1",
      });

      expect(claimed.map((item) => item.message.priority)).toEqual([10, 50]);
      ackDelivery(db, claimed[0]!.delivery.id);

      const acked = db
        .prepare("SELECT status FROM event_deliveries WHERE id = ?")
        .get(claimed[0]!.delivery.id) as { status: string };
      expect(acked.status).toBe("acked");
    } finally {
      db.close();
    }
  });

  it("retries failures and eventually dead-letters", () => {
    const db = createMigratedTestDatabase("pcs-event-hub-fail-");

    try {
      appendHubMessage(db, {
        kind: "command",
        type: "command.task.start",
        source: "test",
        payload: { taskId: "task_retry", objective: "retry" },
      });

      const first = claimReadyDeliveries(db, "worker_group", {
        limit: 1,
        leaseMs: 60_000,
        workerId: "worker-1",
      })[0]!;
      failDelivery(db, first.delivery.id, {
        error: new Error("temporary"),
        maxAttempts: 2,
        retryDelayMs: 0,
      });

      const retry = claimReadyDeliveries(db, "worker_group", {
        limit: 1,
        leaseMs: 60_000,
        workerId: "worker-1",
      })[0]!;
      failDelivery(db, retry.delivery.id, {
        error: new Error("permanent"),
        maxAttempts: 2,
        retryDelayMs: 0,
      });

      const row = db
        .prepare("SELECT status, last_error FROM event_deliveries WHERE id = ?")
        .get(first.delivery.id) as { status: string; last_error: string };
      const deadLetters = db.prepare("SELECT count(*) AS count FROM dead_letters").get() as { count: number };

      expect(row.status).toBe("dead_letter");
      expect(row.last_error).toBe("permanent");
      expect(deadLetters.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("runs a consumer handler and acks on success", async () => {
    const db = createMigratedTestDatabase("pcs-event-hub-consumer-");
    const handler = vi.fn();

    try {
      appendHubMessage(db, {
        kind: "command",
        type: "command.task.start",
        source: "test",
        payload: { taskId: "task_consumer", objective: "consumer" },
      });

      const result = await runConsumerOnce(db, {
        groupId: "worker_group",
        handler,
        leaseMs: 60_000,
        maxAttempts: 3,
        workerId: "worker-1",
      });

      expect(result).toEqual({ claimed: 1, acked: 1, failed: 0 });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });
});
