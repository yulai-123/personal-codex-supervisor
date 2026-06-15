import { appendHubMessage } from "../kernel/event-hub/append.js";
import type { EventHubNotifier } from "../kernel/event-hub/notifier.js";
import type { ConsumerHandler } from "../kernel/event-hub/types.js";
import type { AppDatabase } from "../storage/sqlite.js";

export type HealthMonitorOptions = {
  db: AppDatabase;
  notifier?: EventHubNotifier;
};

export function createHealthMonitorHandler(options: HealthMonitorOptions): ConsumerHandler {
  return ({ message }) => {
    if (message.type !== "event.monitor.tick") {
      return;
    }

    const deliveryCounts = options.db.prepare(`
      SELECT status, count(*) AS count
      FROM event_deliveries
      GROUP BY status
    `).all() as Array<{ status: string; count: number }>;
    const deadLetters = options.db.prepare("SELECT count(*) AS count FROM dead_letters").get() as
      | { count: number }
      | undefined;
    const deadLetterCount = deadLetters?.count ?? 0;
    const deadDeliveryCount = deliveryCounts
      .filter((item) => item.status === "dead_letter")
      .reduce((count, item) => count + item.count, 0);
    const failed = deadLetterCount + deadDeliveryCount;
    const status = failed > 0 ? "degraded" : "ok";
    const severity = failed > 0 ? "warning" : "info";
    const summary = failed > 0
      ? `Event Hub has ${failed} failed delivery records.`
      : "Event Hub delivery state is healthy.";

    appendHubMessage(options.db, {
      kind: "event",
      type: "event.system.health",
      source: "monitor",
      topic: "system",
      correlationId: message.correlationId,
      causationId: message.id,
      payload: {
        component: "event_hub",
        status,
        severity,
        summary,
        deliveryCounts,
        deadLetterCount,
      },
    }, appendOptions(options));

    if (failed > 0) {
      appendHubMessage(options.db, {
        kind: "event",
        type: "event.system.alert",
        source: "monitor",
        topic: "system",
        priority: 10,
        correlationId: message.correlationId,
        causationId: message.id,
        payload: {
          component: "event_hub",
          status,
          severity,
          summary,
        },
      }, appendOptions(options));
    }
  };
}

function appendOptions(options: HealthMonitorOptions) {
  return options.notifier ? { notifier: options.notifier } : {};
}
