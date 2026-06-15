import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/storage/migrations.js";
import { openDatabase, type AppDatabase } from "../src/storage/sqlite.js";

export function createMigratedTestDatabase(prefix: string): AppDatabase {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  const db = openDatabase({ path: join(tempDir, "state/app.sqlite") });
  runMigrations(db, join(process.cwd(), "migrations"));
  return db;
}
