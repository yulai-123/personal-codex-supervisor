import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type AppDatabase = Database.Database;

export type OpenDatabaseOptions = {
  path: string;
};

export function openDatabase(options: OpenDatabaseOptions): AppDatabase {
  mkdirSync(dirname(options.path), { recursive: true });

  const db = new Database(options.path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function closeDatabase(db: AppDatabase): void {
  db.close();
}
