import { createSupervisorHandler } from "../agents/supervisor/runner.js";
import { createWorkerGroupHandler } from "../agents/worker/group.js";
import { CliCodexRunner } from "../codex/runner.js";
import type { LoadedConfig } from "../config/types.js";
import { runConsumerLoop } from "../kernel/event-hub/consumer-runner.js";
import { EventHubNotifier } from "../kernel/event-hub/notifier.js";
import { projectMessage } from "../kernel/projections/projector.js";
import { runMigrations } from "../storage/migrations.js";
import { openDatabase } from "../storage/sqlite.js";

export type RuntimeDaemonOptions = {
  loaded: LoadedConfig;
  signal?: AbortSignal;
};

export async function runRuntimeDaemon(options: RuntimeDaemonOptions): Promise<void> {
  const { loaded, signal } = options;
  const { config } = loaded;
  const db = openDatabase({ path: config.paths.databasePath });
  const notifier = new EventHubNotifier();
  const codexRunner = new CliCodexRunner({
    executable: config.codex.executable,
    bypassApprovalsAndSandbox: config.codex.bypassApprovalsAndSandbox,
  });

  try {
    runMigrations(db, config.paths.migrationsDir);
    console.log(`Runtime daemon started with database ${config.paths.databasePath}`);

    const common = {
      notifier,
      fallbackScanMs: config.eventHub.fallbackScanMs,
      leaseMs: config.eventHub.defaultLeaseMs,
      maxAttempts: config.eventHub.maxAttempts,
    };

    await Promise.all([
      runConsumerLoop(
        db,
        {
          ...common,
          groupId: "projection_group",
          batchSize: 50,
          workerId: "runtime_projection",
          handler: ({ message }) => projectMessage(db, message),
        },
        signal,
      ),
      runConsumerLoop(
        db,
        {
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
        },
        signal,
      ),
      runConsumerLoop(
        db,
        {
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
        },
        signal,
      ),
    ]);
  } finally {
    db.close();
    console.log("Runtime daemon stopped");
  }
}
