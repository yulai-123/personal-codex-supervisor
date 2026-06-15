import { appendHubMessage } from "../kernel/event-hub/append.js";
import type { EventHubNotifier } from "../kernel/event-hub/notifier.js";
import type { ConsumerHandler } from "../kernel/event-hub/types.js";
import type { AppDatabase } from "../storage/sqlite.js";

export type CleanupOptions = {
  db: AppDatabase;
  ackedDeliveryRetentionMs: number;
  notifier?: EventHubNotifier;
};

export function createCleanupHandler(options: CleanupOptions): ConsumerHandler {
  return ({ message }) => {
    if (message.type !== "event.cleanup.requested") {
      return;
    }

    const cutoff = new Date(Date.now() - options.ackedDeliveryRetentionMs).toISOString();
    const deleted = options.db.prepare(`
      DELETE FROM event_deliveries
      WHERE status = 'acked'
        AND updated_at < ?
    `).run(cutoff);

    appendHubMessage(options.db, {
      kind: "event",
      type: "event.system.health",
      source: "cleanup",
      topic: "system",
      correlationId: message.correlationId,
      causationId: message.id,
      payload: {
        component: "cleanup",
        status: "ok",
        severity: "info",
        summary: `Cleanup removed ${deleted.changes} old acked deliveries.`,
        deletedAckedDeliveries: deleted.changes,
      },
    }, appendOptions(options));
  };
}

function appendOptions(options: CleanupOptions) {
  return options.notifier ? { notifier: options.notifier } : {};
}
