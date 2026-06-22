import { isAbsolute, relative } from "node:path";
import { inspect } from "node:util";
import { loadConfig } from "./config/load-config.js";
import type { LoadedConfig } from "./config/types.js";
import { openDatabase } from "./storage/sqlite.js";
import { getMigrationStatus, runMigrations } from "./storage/migrations.js";
import { asError } from "./shared/errors.js";
import { runRuntimeDaemon } from "./runtime/daemon.js";
import {
  appendCliUserMessage,
  getCliTask,
  listCliEvents,
  listCliHealth,
  listCliOutbox,
  listCliTasks,
} from "./plugins/cli/index.js";
import {
  isClawbotLoggedIn,
  listClawbotAccountStatus,
  loginClawbot,
  logoutClawbot,
} from "./plugins/wechat/index.js";

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const [domain, action] = args;

  if (!domain || domain === "help" || domain === "--help" || domain === "-h") {
    printHelp();
    return;
  }

  if (domain === "config" && action === "show") {
    const loaded = loadConfig();
    console.log(JSON.stringify(redact(toDisplayConfig(loaded)), null, 2));
    return;
  }

  if (domain === "db" && action === "migrate") {
    const loaded = loadConfig();
    const db = openDatabase({ path: loaded.config.paths.databasePath });
    try {
      const result = runMigrations(db, loaded.config.paths.migrationsDir);
      console.log(
        JSON.stringify(
          {
            databasePath: formatPath(loaded.config.paths.databasePath, loaded.projectRoot),
            applied: result.applied.map((migration) => migration.name),
          },
          null,
          2,
        ),
      );
    } finally {
      db.close();
    }
    return;
  }

  if (domain === "db" && action === "status") {
    const loaded = loadConfig();
    const db = openDatabase({ path: loaded.config.paths.databasePath });
    try {
      const status = getMigrationStatus(db, loaded.config.paths.migrationsDir);
      console.log(
        JSON.stringify(
          status.map((item) => ({
            id: item.migration.id,
            name: item.migration.name,
            status: item.status,
            appliedAt: item.applied?.appliedAt ?? null,
          })),
          null,
          2,
        ),
      );
    } finally {
      db.close();
    }
    return;
  }

  if (domain === "daemon" && action === "start") {
    const loaded = loadConfig();
    const controller = new AbortController();
    const stop = (signalName: NodeJS.Signals) => {
      console.log(`Received ${signalName}; stopping runtime daemon...`);
      controller.abort();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    await runRuntimeDaemon({ loaded, signal: controller.signal });
    return;
  }

  if (domain === "wechat") {
    const loaded = loadConfig();
    const stateDir = loaded.config.plugins.wechat.clawbotStateDir;

    if (action === "login") {
      const result = await loginClawbot({
        stateDir,
        log: (line) => console.log(line),
      });
      console.log(JSON.stringify({
        loggedIn: true,
        account: result.account,
        ownerUserId: result.ownerUserId,
        stateDir: formatPath(stateDir, loaded.projectRoot),
      }, null, 2));
      return;
    }

    if (action === "status") {
      console.log(JSON.stringify({
        loggedIn: isClawbotLoggedIn(stateDir),
        stateDir: formatPath(stateDir, loaded.projectRoot),
        accounts: listClawbotAccountStatus(stateDir),
      }, null, 2));
      return;
    }

    if (action === "logout") {
      logoutClawbot(stateDir);
      console.log(JSON.stringify({
        loggedIn: false,
        stateDir: formatPath(stateDir, loaded.projectRoot),
      }, null, 2));
      return;
    }
  }

  if (domain === "cli") {
    const loaded = loadConfig();
    const db = openDatabase({ path: loaded.config.paths.databasePath });
    try {
      runMigrations(db, loaded.config.paths.migrationsDir);
      if (action === "send") {
        const text = args.slice(2).join(" ").trim();
        if (!text) {
          throw new Error("Usage: pnpm dev -- cli send <message>");
        }
        const result = appendCliUserMessage(db, { text });
        console.log(JSON.stringify({
          accepted: !result.duplicate,
          duplicate: result.duplicate,
          messageId: result.message.id,
          deliveryGroupIds: result.deliveryGroupIds,
        }, null, 2));
        return;
      }

      if (action === "tasks") {
        console.log(JSON.stringify(listCliTasks(db, parseLimit(args[2])), null, 2));
        return;
      }

      if (action === "task") {
        const taskId = args[2];
        if (!taskId) {
          throw new Error("Usage: pnpm dev -- cli task <task_id>");
        }
        console.log(JSON.stringify(getCliTask(db, taskId), null, 2));
        return;
      }

      if (action === "outbox") {
        console.log(JSON.stringify(listCliOutbox(db, parseLimit(args[2])), null, 2));
        return;
      }

      if (action === "events") {
        console.log(JSON.stringify(listCliEvents(db, parseLimit(args[2])), null, 2));
        return;
      }

      if (action === "health") {
        console.log(JSON.stringify(listCliHealth(db), null, 2));
        return;
      }
    } finally {
      db.close();
    }
  }

  throw new Error(`Unknown command: ${args.join(" ")}`);
}

function printHelp(): void {
  console.log(`Personal Codex Supervisor

Usage:
  pnpm db:migrate       Apply SQLite migrations
  pnpm db:status        Show migration status
  pnpm dev -- daemon start
                       Start supervisor, worker, and projection consumer loops
  pnpm dev -- cli send <message>
                       Append a local user message event
  pnpm dev -- cli tasks [limit]
                       List projected tasks
  pnpm dev -- cli task <task_id>
                       Show one projected task and recent events
  pnpm dev -- cli outbox [limit]
                       List outbound message state
  pnpm dev -- cli events [limit]
                       List recent Event Hub messages
  pnpm dev -- cli health
                       List projected system health
  pnpm dev -- wechat login
                       Log in to the built-in WeChat ClawBot bridge
  pnpm dev -- wechat status
                       Show local WeChat ClawBot account status without tokens
  pnpm dev -- wechat logout
                       Remove local WeChat ClawBot credentials
  pnpm config:show      Print resolved configuration with sensitive keys redacted
  pnpm typecheck        Run TypeScript type checks
  pnpm test             Run tests
`);
}

function parseLimit(value: string | undefined): number {
  if (!value) {
    return 20;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 200) {
    throw new Error("limit must be an integer between 1 and 200");
  }
  return parsed;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = shouldRedact(key) ? "[redacted]" : redact(item);
  }
  return output;
}

function shouldRedact(key: string): boolean {
  return /secret|token|password|credential|key|ownerUserIds/i.test(key);
}

function toDisplayConfig(loaded: LoadedConfig): LoadedConfig {
  return {
    ...loaded,
    configPath: formatPath(loaded.configPath, loaded.projectRoot),
    projectRoot: ".",
    config: {
      ...loaded.config,
      plugins: {
        ...loaded.config.plugins,
        wechat: {
          ...loaded.config.plugins.wechat,
          clawbotStateDir: formatPath(loaded.config.plugins.wechat.clawbotStateDir, loaded.projectRoot),
        },
      },
      assistant: {
        ...loaded.config.assistant,
        configDir: formatPath(loaded.config.assistant.configDir, loaded.projectRoot),
      },
      paths: {
        stateDir: formatPath(loaded.config.paths.stateDir, loaded.projectRoot),
        logsDir: formatPath(loaded.config.paths.logsDir, loaded.projectRoot),
        artifactsDir: formatPath(loaded.config.paths.artifactsDir, loaded.projectRoot),
        databasePath: formatPath(loaded.config.paths.databasePath, loaded.projectRoot),
        migrationsDir: formatPath(loaded.config.paths.migrationsDir, loaded.projectRoot),
      },
    },
  };
}

function formatPath(path: string, projectRoot: string): string {
  if (!isAbsolute(path)) {
    return path;
  }
  const relativePath = relative(projectRoot, path);
  if (!relativePath.startsWith("..")) {
    return relativePath === "" ? "." : relativePath;
  }
  return "[outside-project]";
}

main().catch((error: unknown) => {
  const err = asError(error);
  console.error(err.message);
  if (process.env.DEBUG) {
    console.error(inspect(err, { depth: 5 }));
  }
  process.exitCode = 1;
});
