import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AppError } from "../shared/errors.js";
import { nowIso } from "../shared/time.js";
import type { AppDatabase } from "./sqlite.js";

export type Migration = {
  id: string;
  name: string;
  path: string;
  sql: string;
  checksum: string;
};

export type AppliedMigration = {
  id: string;
  name: string;
  checksum: string;
  appliedAt: string;
};

export type MigrationStatus = {
  migration: Migration;
  applied: AppliedMigration | null;
  status: "pending" | "applied" | "checksum_mismatch";
};

export type MigrationResult = {
  applied: AppliedMigration[];
  pending: number;
};

export function ensureMigrationTable(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function loadMigrations(migrationsDir: string): Migration[] {
  if (!existsSync(migrationsDir)) {
    throw new AppError(`Migrations directory does not exist: ${migrationsDir}`, "MIGRATIONS_NOT_FOUND");
  }

  return readdirSync(migrationsDir)
    .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
    .sort()
    .map((fileName) => {
      const path = join(migrationsDir, fileName);
      const sql = readFileSync(path, "utf8");
      const id = fileName.slice(0, fileName.indexOf("_"));
      const checksum = createHash("sha256").update(sql).digest("hex");
      return {
        id,
        name: basename(fileName),
        path,
        sql,
        checksum,
      };
    });
}

export function getAppliedMigrations(db: AppDatabase): AppliedMigration[] {
  ensureMigrationTable(db);
  const rows = db
    .prepare("SELECT id, name, checksum, applied_at AS appliedAt FROM schema_migrations ORDER BY id ASC")
    .all() as AppliedMigration[];
  return rows;
}

export function getMigrationStatus(db: AppDatabase, migrationsDir: string): MigrationStatus[] {
  const migrations = loadMigrations(migrationsDir);
  const applied = new Map(getAppliedMigrations(db).map((migration) => [migration.id, migration]));

  return migrations.map((migration) => {
    const appliedMigration = applied.get(migration.id) ?? null;
    if (!appliedMigration) {
      return { migration, applied: null, status: "pending" };
    }
    if (appliedMigration.checksum !== migration.checksum) {
      return { migration, applied: appliedMigration, status: "checksum_mismatch" };
    }
    return { migration, applied: appliedMigration, status: "applied" };
  });
}

export function runMigrations(db: AppDatabase, migrationsDir: string): MigrationResult {
  ensureMigrationTable(db);
  const statuses = getMigrationStatus(db, migrationsDir);
  const mismatch = statuses.find((status) => status.status === "checksum_mismatch");
  if (mismatch) {
    throw new AppError(
      `Migration checksum mismatch for ${mismatch.migration.name}`,
      "MIGRATION_CHECKSUM_MISMATCH",
    );
  }

  const applied: AppliedMigration[] = [];
  for (const status of statuses) {
    if (status.status !== "pending") {
      continue;
    }
    const record = applyMigration(db, status.migration);
    applied.push(record);
  }

  return {
    applied,
    pending: statuses.length - applied.length,
  };
}

function applyMigration(db: AppDatabase, migration: Migration): AppliedMigration {
  const appliedAt = nowIso();
  db.exec("BEGIN");
  try {
    db.exec(migration.sql);
    db.prepare(
      "INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(migration.id, migration.name, migration.checksum, appliedAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw new AppError(`Failed to apply migration ${migration.name}`, "MIGRATION_FAILED", error);
  }

  return {
    id: migration.id,
    name: migration.name,
    checksum: migration.checksum,
    appliedAt,
  };
}
