import type { RegisteredSession } from "../../codex/session-registry.js";
import type { AppDatabase } from "../../storage/sqlite.js";
import { formatToolListForPrompt, type ToolRegistry } from "../../tools/registry.js";
import { formatToolCallInstructions } from "../../tools/tool-call-parser.js";
import type { HubMessage } from "../../kernel/event-hub/types.js";
import { supervisorOperatingSkill, toolProtocolSkill } from "../skills/index.js";
import { loadAssistantPromptContext, listAssistantState, type AssistantRuntimeConfig } from "../../assistant/index.js";

export type SupervisorContextInput = {
  db: AppDatabase;
  trigger: HubMessage;
  registry: ToolRegistry;
  session?: RegisteredSession | null;
  handoffSummary?: unknown;
  assistantConfig?: AssistantRuntimeConfig;
};

export function buildSupervisorPrompt(input: SupervisorContextInput): string {
  const activeTasks = input.db.prepare(`
    SELECT task_id, objective, status, priority, summary, should_notify_user, needs_supervisor_decision, updated_at
    FROM tasks_current_state
    WHERE status IN ('pending', 'running', 'needs_decision')
    ORDER BY priority ASC, updated_at DESC
    LIMIT 20
  `).all();

  const recentDecisionEvents = input.db.prepare(`
    SELECT event_id, task_id, run_id, status, severity, summary, should_notify_user, created_at
    FROM recent_task_events
    WHERE needs_supervisor_decision = 1
    ORDER BY created_at DESC
    LIMIT 10
  `).all();

  const systemHealth = input.db.prepare(`
    SELECT component, status, severity, summary, updated_at
    FROM system_health_current_state
    ORDER BY updated_at DESC
    LIMIT 10
  `).all();

  const assistantContext = input.assistantConfig
    ? loadAssistantPromptContext(input.assistantConfig)
    : null;
  const assistantState = input.assistantConfig?.enabled
    ? listAssistantState(input.db, { limit: 50 })
    : [];
  const dueAssistantFollowups = input.assistantConfig?.enabled
    ? input.db.prepare(`
        SELECT id, capability_id, purpose, due_at, status, priority, payload_json, updated_at
        FROM assistant_followups
        WHERE status IN ('pending', 'triggered')
        ORDER BY due_at ASC, priority ASC
        LIMIT 20
      `).all()
    : [];
  const todayAssistantInterventions = input.assistantConfig?.enabled
    ? input.db.prepare(`
        SELECT id, capability_id, action, status, reason, state_tags_json, created_at
        FROM assistant_interventions
        ORDER BY created_at DESC
        LIMIT 20
      `).all()
    : [];

  return `${supervisorOperatingSkill}

${toolProtocolSkill}

# Runtime Context

Current supervisor session:
${JSON.stringify(input.session ?? null, null, 2)}

Pending handoff summary:
${JSON.stringify(input.handoffSummary ?? null, null, 2)}

Current trigger event:
${JSON.stringify(input.trigger, null, 2)}

Active tasks:
${JSON.stringify(activeTasks, null, 2)}

Recent decision events:
${JSON.stringify(recentDecisionEvents, null, 2)}

System health:
${JSON.stringify(systemHealth, null, 2)}

Assistant runtime:
${formatAssistantRuntimeContext({
  context: assistantContext,
  state: assistantState,
  followups: dueAssistantFollowups,
  interventions: todayAssistantInterventions,
})}

Available internal tools:
${formatToolListForPrompt(input.registry)}

${formatToolCallInstructions()}`;
}

function formatAssistantRuntimeContext(input: {
  context: unknown;
  state: unknown[];
  followups: unknown[];
  interventions: unknown[];
}): string {
  if (!input.context || (typeof input.context === "object" && input.context !== null && "enabled" in input.context && input.context.enabled === false)) {
    return "Assistant runtime is disabled or no private assistant context is configured.";
  }

  return JSON.stringify({
    context: input.context,
    currentState: input.state,
    activeFollowups: input.followups,
    recentInterventions: input.interventions,
    operatingNote: [
      "There is only one user-facing assistant: the Supervisor uses the global persona plus enabled capabilities.",
      "Enabled capabilities should preserve uncertainty: unknown is not a failure and silence is not evidence.",
      "For assistant attention/follow-up triggers, decide whether to stay silent, record, ask, remind, start a task, or create follow-up.",
      "Record observations and interventions with assistant.* tools when useful.",
    ],
  }, null, 2);
}
