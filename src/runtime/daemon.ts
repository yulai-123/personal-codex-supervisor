import { createSupervisorHandler } from "../agents/supervisor/runner.js";
import { createWorkerGroupHandler } from "../agents/worker/group.js";
import { CliCodexRunner } from "../codex/runner.js";
import type { LoadedConfig } from "../config/types.js";
import { EventHubNotifier } from "../kernel/event-hub/notifier.js";
import { projectMessage } from "../kernel/projections/projector.js";
import { createSchedulerComponent } from "../plugins/scheduler/index.js";
import {
  ClawbotWechatAdapter,
  HttpClawbotClient,
  StdoutWechatAdapter,
  createClawbotReceiverComponent,
  createWechatSenderHandler,
} from "../plugins/wechat/index.js";
import { createCleanupHandler, createHealthMonitorHandler, createMaintenanceHandler } from "../sidecars/index.js";
import { runMigrations } from "../storage/migrations.js";
import { openDatabase } from "../storage/sqlite.js";
import { createConsumerComponent } from "./consumer-component.js";
import { runRuntimeComponents, type RuntimeComponent } from "./component.js";
import { createLogger } from "./logger.js";

export type RuntimeDaemonOptions = {
  loaded: LoadedConfig;
  signal?: AbortSignal;
};

export async function runRuntimeDaemon(options: RuntimeDaemonOptions): Promise<void> {
  const { loaded, signal } = options;
  const { config } = loaded;
  const db = openDatabase({ path: config.paths.databasePath });
  const notifier = new EventHubNotifier();
  const logger = createLogger({
    level: config.logging.level,
    base: {
      app: config.runtime.appName,
    },
  });
  const codexRunner = new CliCodexRunner({
    executable: config.codex.executable,
    bypassApprovalsAndSandbox: config.codex.bypassApprovalsAndSandbox,
  });

  try {
    runMigrations(db, config.paths.migrationsDir);
    logger.info("runtime daemon starting", { databasePath: config.paths.databasePath });

    const common = {
      notifier,
      fallbackScanMs: config.eventHub.fallbackScanMs,
      leaseMs: config.eventHub.defaultLeaseMs,
      maxAttempts: config.eventHub.maxAttempts,
    };

    const components: RuntimeComponent[] = [
      createConsumerComponent(db, {
        ...common,
        groupId: "projection_group",
        batchSize: 50,
        workerId: "runtime_projection",
        handler: ({ message }) => projectMessage(db, message),
      }),
      createConsumerComponent(db, {
        ...common,
        groupId: "supervisor_group",
        batchSize: 1,
        workerId: "runtime_supervisor",
        handler: createSupervisorHandler({
          db,
          runner: codexRunner,
          projectRoot: loaded.projectRoot,
          logicalName: config.supervisor.logicalName,
          ...(config.codex.model ? { model: config.codex.model } : {}),
          maxToolIterations: config.codex.maxToolIterations,
          notifier,
        }),
      }),
      createConsumerComponent(db, {
        ...common,
        groupId: "worker_group",
        batchSize: config.workers.concurrency,
        workerId: "runtime_worker",
        handler: createWorkerGroupHandler({
          db,
          runner: codexRunner,
          projectRoot: loaded.projectRoot,
          ...(config.codex.model ? { model: config.codex.model } : {}),
          maxToolIterations: config.codex.maxToolIterations,
          notifier,
        }),
      }),
    ];

    if (config.plugins.scheduler.enabled) {
      components.push(createSchedulerComponent({
        db,
        notifier,
        logger: logger.child({ component: "scheduler" }),
        timezone: config.runtime.timezone,
        handoffTime: config.supervisor.handoffTime,
        monitorIntervalMs: config.plugins.scheduler.monitorIntervalMs,
        cleanupIntervalMs: config.plugins.scheduler.cleanupIntervalMs,
        handoffCheckIntervalMs: config.plugins.scheduler.handoffCheckIntervalMs,
      }));
    }

    if (config.plugins.wechat.enabled) {
      const adapter = config.plugins.wechat.adapter === "clawbot"
        ? new ClawbotWechatAdapter({
          db,
          client: new HttpClawbotClient(),
          logger: logger.child({ component: "wechat_clawbot_adapter" }),
          ...(config.plugins.wechat.ownerUserIds[0]
            ? { defaultTargetId: config.plugins.wechat.ownerUserIds[0] }
            : {}),
        })
        : new StdoutWechatAdapter(logger.child({ component: "wechat_adapter" }));

      if (config.plugins.wechat.adapter === "clawbot" && adapter instanceof ClawbotWechatAdapter) {
        components.push(createClawbotReceiverComponent({
          db,
          stateDir: config.plugins.wechat.clawbotStateDir,
          ownerUserIds: config.plugins.wechat.ownerUserIds,
          adapter,
          logger: logger.child({ component: "wechat_clawbot_receiver" }),
          notifier,
          ...(config.plugins.wechat.accountId ? { accountId: config.plugins.wechat.accountId } : {}),
        }));
      }

      components.push(createConsumerComponent(db, {
        ...common,
        groupId: "wechat_sender_group",
        batchSize: config.plugins.wechat.senderConcurrency,
        workerId: "runtime_wechat_sender",
        handler: createWechatSenderHandler({
          db,
          adapter,
          notifier,
          allowedTargetIds: config.plugins.wechat.ownerUserIds,
        }),
      }));
    }

    if (config.sidecars.maintenance.enabled) {
      components.push(createConsumerComponent(db, {
        ...common,
        groupId: "maintenance_group",
        batchSize: 1,
        workerId: "runtime_maintenance",
        handler: createMaintenanceHandler({
          db,
          supervisorLogicalName: config.supervisor.logicalName,
          notifier,
        }),
      }));
    }

    if (config.sidecars.monitor.enabled) {
      components.push(createConsumerComponent(db, {
        ...common,
        groupId: "monitor_group",
        batchSize: 5,
        workerId: "runtime_monitor",
        handler: createHealthMonitorHandler({
          db,
          notifier,
        }),
      }));
    }

    if (config.sidecars.cleanup.enabled) {
      components.push(createConsumerComponent(db, {
        ...common,
        groupId: "cleanup_group",
        batchSize: 1,
        workerId: "runtime_cleanup",
        handler: createCleanupHandler({
          db,
          ackedDeliveryRetentionMs: config.sidecars.cleanup.ackedDeliveryRetentionMs,
          notifier,
        }),
      }));
    }

    await runRuntimeComponents({ components, logger, ...(signal ? { signal } : {}) });
  } finally {
    db.close();
    logger.info("runtime daemon stopped");
  }
}
