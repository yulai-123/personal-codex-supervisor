import { appendHubMessage } from "../../kernel/event-hub/append.js";
import type { EventHubNotifier } from "../../kernel/event-hub/notifier.js";
import type { ClaimedDelivery, ConsumerHandler } from "../../kernel/event-hub/types.js";
import { createId } from "../../shared/ids.js";
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
  const prompt = buildSupervisorPrompt({
    db: options.db,
    trigger: delivery.message,
    registry: toolRegistry,
    session: existingSession,
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
    registry.create({
      logicalName,
      codexSessionId: result.sessionId ?? createId("codex_session_unknown"),
      role: "supervisor",
      metadata: {
        createdBy: "supervisor_runner",
        triggerMessageId: delivery.message.id,
      },
    });
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
