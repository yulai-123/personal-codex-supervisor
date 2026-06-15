import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/codex/session-registry.js";
import { appendHubMessage } from "../src/kernel/event-hub/append.js";
import { runConsumerOnce } from "../src/kernel/event-hub/consumer-runner.js";
import { createCleanupHandler, createHealthMonitorHandler, createMaintenanceHandler } from "../src/sidecars/index.js";
import { createMigratedTestDatabase } from "./helpers.js";

describe("sidecars", () => {
  it("maintenance archives the active supervisor session on handoff", async () => {
    const db = createMigratedTestDatabase("pcs-sidecar-maintenance-");

    try {
      const registry = new SessionRegistry(db);
      const session = registry.create({
        logicalName: "wechat_main",
        codexSessionId: "thread_active",
        role: "supervisor",
      });
      appendHubMessage(db, {
        kind: "event",
        type: "event.maintenance.handoff_required",
        source: "test",
        payload: {},
      });

      const result = await runConsumerOnce(db, {
        groupId: "maintenance_group",
        handler: createMaintenanceHandler({
          db,
          supervisorLogicalName: "wechat_main",
        }),
        leaseMs: 60_000,
        maxAttempts: 3,
        workerId: "maintenance-test",
      });

      expect(result).toEqual({ claimed: 1, acked: 1, failed: 0 });
      expect(registry.getActive("wechat_main", "supervisor")).toBeNull();
      expect(db.prepare("SELECT status, handoff_summary FROM sessions WHERE id = ?").get(session.id))
        .toMatchObject({
          status: "archived",
          handoff_summary: expect.stringContaining("\"generatedBy\":\"maintenance\""),
        });
      expect(db.prepare("SELECT logical_name, status, old_session_id FROM session_handoffs").get())
        .toMatchObject({
          logical_name: "wechat_main",
          status: "archived",
          old_session_id: session.id,
        });
      expect(db.prepare("SELECT type FROM event_log WHERE type = 'event.session.archived'").get())
        .toMatchObject({ type: "event.session.archived" });
    } finally {
      db.close();
    }
  });

  it("health monitor emits system health on monitor ticks", async () => {
    const db = createMigratedTestDatabase("pcs-sidecar-monitor-");

    try {
      appendHubMessage(db, {
        kind: "event",
        type: "event.monitor.tick",
        source: "test",
        payload: {},
      });

      const result = await runConsumerOnce(db, {
        groupId: "monitor_group",
        handler: createHealthMonitorHandler({ db }),
        leaseMs: 60_000,
        maxAttempts: 3,
        workerId: "monitor-test",
      });

      expect(result).toEqual({ claimed: 1, acked: 1, failed: 0 });
      expect(db.prepare("SELECT type FROM event_log WHERE type = 'event.system.health'").get())
        .toMatchObject({ type: "event.system.health" });
    } finally {
      db.close();
    }
  });

  it("cleanup removes only old acked deliveries", async () => {
    const db = createMigratedTestDatabase("pcs-sidecar-cleanup-");

    try {
      const oldMessage = appendHubMessage(db, {
        kind: "event",
        type: "event.system.health",
        source: "test",
        payload: {},
      });
      db.prepare(`
        UPDATE event_deliveries
        SET status = 'acked',
            updated_at = '2000-01-01T00:00:00.000Z'
        WHERE message_id = ?
      `).run(oldMessage.message.id);

      appendHubMessage(db, {
        kind: "event",
        type: "event.cleanup.requested",
        source: "test",
        payload: {},
      });

      const result = await runConsumerOnce(db, {
        groupId: "cleanup_group",
        handler: createCleanupHandler({
          db,
          ackedDeliveryRetentionMs: 1,
        }),
        leaseMs: 60_000,
        maxAttempts: 3,
        workerId: "cleanup-test",
      });

      expect(result).toEqual({ claimed: 1, acked: 1, failed: 0 });
      expect(db.prepare(`
        SELECT count(*) AS count
        FROM event_deliveries
        WHERE message_id = ?
      `).get(oldMessage.message.id)).toMatchObject({ count: 0 });
      expect(db.prepare("SELECT type FROM event_log WHERE type = 'event.system.health' AND source = 'cleanup'").get())
        .toMatchObject({ type: "event.system.health" });
    } finally {
      db.close();
    }
  });
});
