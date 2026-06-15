import type { RegisteredSession } from "../../codex/session-registry.js";
import type { AppDatabase } from "../../storage/sqlite.js";
import { formatToolListForPrompt, type ToolRegistry } from "../../tools/registry.js";
import { formatToolCallInstructions } from "../../tools/tool-call-parser.js";
import type { HubMessage } from "../../kernel/event-hub/types.js";
import { supervisorOperatingSkill, toolProtocolSkill } from "../skills/index.js";

export type SupervisorContextInput = {
  db: AppDatabase;
  trigger: HubMessage;
  registry: ToolRegistry;
  session?: RegisteredSession | null;
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

  return `${supervisorOperatingSkill}

${toolProtocolSkill}

# Runtime Context

Current supervisor session:
${JSON.stringify(input.session ?? null, null, 2)}

Current trigger event:
${JSON.stringify(input.trigger, null, 2)}

Active tasks:
${JSON.stringify(activeTasks, null, 2)}

Recent decision events:
${JSON.stringify(recentDecisionEvents, null, 2)}

System health:
${JSON.stringify(systemHealth, null, 2)}

Available internal tools:
${formatToolListForPrompt(input.registry)}

${formatToolCallInstructions()}`;
}
