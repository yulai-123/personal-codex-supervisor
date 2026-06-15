import { appendHubMessage } from "../../kernel/event-hub/append.js";
import type { EventHubNotifier } from "../../kernel/event-hub/notifier.js";
import type { ClaimedDelivery, ConsumerHandler } from "../../kernel/event-hub/types.js";
import { createId } from "../../shared/ids.js";
import { parseJsonObject } from "../../shared/json.js";
import type { AppDatabase } from "../../storage/sqlite.js";
import type { CodexRunner } from "../../codex/runner.js";
import { SessionRegistry } from "../../codex/session-registry.js";
import { createSupervisorToolRegistry } from "../../tools/supervisor-tools.js";
import { runCodexToolLoop } from "../tool-loop.js";
import { buildSupervisorPrompt } from "./context-builder.js";

export type SupervisorRunnerOptions = {
  db: AppDatabase;
  runner: CodexRunner;
  projectRoot: string;
  logicalName?: string;
  model?: string;
  env?: Record<string, string | undefined>;
  maxToolIterations?: number;
  notifier?: EventHubNotifier;
};

export function createSupervisorHandler(options: SupervisorRunnerOptions): ConsumerHandler {
  return async (delivery: ClaimedDelivery) => {
    await runSupervisorTurn(options, delivery);
  };
}

export async function runSupervisorTurn(
  options: SupervisorRunnerOptions,
  delivery: ClaimedDelivery,
): Promise<void> {
  const logicalName = options.logicalName ?? "wechat_main";
  const registry = new SessionRegistry(options.db);
  const toolRegistry = createSupervisorToolRegistry();
  const existingSession = registry.getActive(logicalName, "supervisor");
  const pendingHandoff = existingSession ? null : getPendingHandoff(options.db, logicalName);
  const prompt = buildSupervisorPrompt({
    db: options.db,
    trigger: delivery.message,
    registry: toolRegistry,
    session: existingSession,
    ...(pendingHandoff ? { handoffSummary: pendingHandoff.summary } : {}),
  });

  const result = await runCodexToolLoop({
    runner: options.runner,
    cwd: options.projectRoot,
    prompt,
    ...(existingSession ? { sessionId: existingSession.codexSessionId } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.env ? { env: options.env } : {}),
    registry: toolRegistry,
    toolContext: {
      db: options.db,
      source: "supervisor",
      ...(options.notifier ? { notifier: options.notifier } : {}),
    },
    ...(options.maxToolIterations === undefined ? {} : { maxToolIterations: options.maxToolIterations }),
  });

  if (existingSession) {
    if (result.sessionId && result.sessionId !== existingSession.codexSessionId) {
      registry.updateCodexSessionId(existingSession.id, result.sessionId);
    }
  } else {
    const created = registry.create({
      logicalName,
      codexSessionId: result.sessionId ?? createId("codex_session_unknown"),
      role: "supervisor",
      metadata: {
        createdBy: "supervisor_runner",
        triggerMessageId: delivery.message.id,
        ...(pendingHandoff ? { handoffId: pendingHandoff.id } : {}),
      },
    });
    if (pendingHandoff) {
      markHandoffActivated(options.db, pendingHandoff.id, created.id);
    }
  }

  appendHubMessage(options.db, {
    kind: "event",
    type: "event.supervisor.turn_completed",
    source: "supervisor",
    correlationId: delivery.message.correlationId,
    causationId: delivery.message.id,
    payload: {
      triggerMessageId: delivery.message.id,
      finalMessage: result.finalMessage,
      toolResultCount: result.toolResults.length,
    },
  }, { ...(options.notifier ? { notifier: options.notifier } : {}) });
}

type PendingHandoff = {
  id: string;
  summary: Record<string, unknown>;
};

function getPendingHandoff(db: AppDatabase, logicalName: string): PendingHandoff | null {
  const row = db.prepare(`
    SELECT id, summary_json
    FROM session_handoffs
    WHERE logical_name = ?
      AND status = 'archived'
      AND new_session_id IS NULL
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(logicalName) as { id: string; summary_json: string } | undefined;

  return row ? { id: row.id, summary: parseJsonObject(row.summary_json) } : null;
}

function markHandoffActivated(db: AppDatabase, handoffId: string, newSessionId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE session_handoffs
    SET status = 'activated',
        new_session_id = ?,
        activated_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(newSessionId, now, now, handoffId);
}
