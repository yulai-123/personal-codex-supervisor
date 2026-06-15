import type { AppDatabase } from "../storage/sqlite.js";
import { createId } from "../shared/ids.js";
import { parseJsonObject, stringifyJson } from "../shared/json.js";
import { nowIso } from "../shared/time.js";

export type SessionRole = "supervisor" | "worker";
export type SessionStatus = "active" | "archived" | "failed";

export type RegisteredSession = {
  id: string;
  logicalName: string;
  codexSessionId: string;
  role: SessionRole;
  status: SessionStatus;
  handoffSummary?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  archivedAt?: string;
};

export type CreateSessionInput = {
  logicalName: string;
  codexSessionId: string;
  role: SessionRole;
  status?: SessionStatus;
  handoffSummary?: string;
  metadata?: Record<string, unknown>;
  id?: string;
};

export class SessionRegistry {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateSessionInput): RegisteredSession {
    const id = input.id ?? createId("session");
    const createdAt = nowIso();
    const status = input.status ?? "active";

    this.db.prepare(`
      INSERT INTO sessions (
        id, logical_name, codex_session_id, role, status, handoff_summary,
        metadata_json, created_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id,
      input.logicalName,
      input.codexSessionId,
      input.role,
      status,
      input.handoffSummary ?? null,
      stringifyJson(input.metadata ?? {}),
      createdAt,
    );

    return {
      id,
      logicalName: input.logicalName,
      codexSessionId: input.codexSessionId,
      role: input.role,
      status,
      ...(input.handoffSummary ? { handoffSummary: input.handoffSummary } : {}),
      metadata: input.metadata ?? {},
      createdAt,
    };
  }

  getActive(logicalName: string, role: SessionRole): RegisteredSession | null {
    const row = this.db.prepare(`
      SELECT *
      FROM sessions
      WHERE logical_name = ? AND role = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(logicalName, role) as SessionRow | undefined;

    return row ? mapSessionRow(row) : null;
  }

  updateCodexSessionId(sessionId: string, codexSessionId: string): void {
    this.db.prepare(`
      UPDATE sessions
      SET codex_session_id = ?
      WHERE id = ?
    `).run(codexSessionId, sessionId);
  }

  markFailed(sessionId: string, reason?: string): void {
    const row = this.db.prepare("SELECT metadata_json FROM sessions WHERE id = ?").get(sessionId) as
      | { metadata_json: string }
      | undefined;
    const metadata = {
      ...(row ? parseJsonObject(row.metadata_json) : {}),
      ...(reason ? { failureReason: reason } : {}),
    };

    this.db.prepare(`
      UPDATE sessions
      SET status = 'failed',
          metadata_json = ?
      WHERE id = ?
    `).run(stringifyJson(metadata), sessionId);
  }

  archive(sessionId: string, handoffSummary?: string): void {
    this.db.prepare(`
      UPDATE sessions
      SET status = 'archived',
          handoff_summary = COALESCE(?, handoff_summary),
          archived_at = ?
      WHERE id = ?
    `).run(handoffSummary ?? null, nowIso(), sessionId);
  }
}

type SessionRow = {
  id: string;
  logical_name: string;
  codex_session_id: string;
  role: SessionRole;
  status: SessionStatus;
  handoff_summary: string | null;
  metadata_json: string;
  created_at: string;
  archived_at: string | null;
};

function mapSessionRow(row: SessionRow): RegisteredSession {
  return {
    id: row.id,
    logicalName: row.logical_name,
    codexSessionId: row.codex_session_id,
    role: row.role,
    status: row.status,
    ...(row.handoff_summary ? { handoffSummary: row.handoff_summary } : {}),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
  };
}
