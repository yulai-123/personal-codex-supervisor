import { isAbsolute, relative } from "node:path";
import { inspect } from "node:util";
import { loadConfig } from "./config/load-config.js";
import type { LoadedConfig } from "./config/types.js";
import { openDatabase } from "./storage/sqlite.js";
import { getMigrationStatus, runMigrations } from "./storage/migrations.js";
import { asError } from "./shared/errors.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
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

  throw new Error(`Unknown command: ${args.join(" ")}`);
}

function printHelp(): void {
  console.log(`Personal Codex Supervisor

Usage:
  pnpm db:migrate       Apply SQLite migrations
  pnpm db:status        Show migration status
  pnpm config:show      Print resolved configuration with sensitive keys redacted
  pnpm typecheck        Run TypeScript type checks
  pnpm test             Run tests
`);
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
  return /secret|token|password|credential|key/i.test(key);
}

function toDisplayConfig(loaded: LoadedConfig): LoadedConfig {
  return {
    ...loaded,
    configPath: formatPath(loaded.configPath, loaded.projectRoot),
    projectRoot: ".",
    config: {
      ...loaded.config,
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
