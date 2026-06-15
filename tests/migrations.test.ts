import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/sqlite.js";
import { getMigrationStatus, runMigrations } from "../src/storage/migrations.js";

describe("SQLite migrations", () => {
  it("applies initial schema once", () => {
    const projectRoot = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), "pcs-migrations-"));
    const db = openDatabase({ path: join(tempDir, "state/app.sqlite") });

    try {
      const first = runMigrations(db, join(projectRoot, "migrations"));
      const second = runMigrations(db, join(projectRoot, "migrations"));
      const status = getMigrationStatus(db, join(projectRoot, "migrations"));
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("event_log") as { name: string } | undefined;

      expect(first.applied).toHaveLength(1);
      expect(second.applied).toHaveLength(0);
      expect(status.every((item) => item.status === "applied")).toBe(true);
      expect(table?.name).toBe("event_log");
    } finally {
      db.close();
    }
  });
});
