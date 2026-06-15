import { isRecord } from "../shared/json.js";

export type CodexJsonEvent = Record<string, unknown>;

export type CodexCommandItem = {
  id?: string;
  command: string;
  output: string;
  exitCode: number | null;
  status?: string;
};

export type CodexRunSummary = {
  sessionId?: string;
  finalMessage: string;
  commands: CodexCommandItem[];
  usage?: Record<string, unknown>;
  events: CodexJsonEvent[];
};

export function parseCodexJsonl(text: string): CodexJsonEvent[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isRecord);
}

export function summarizeCodexEvents(events: CodexJsonEvent[]): CodexRunSummary {
  const commands: CodexCommandItem[] = [];
  let sessionId: string | undefined;
  let finalMessage = "";
  let usage: Record<string, unknown> | undefined;

  for (const event of events) {
    if (!sessionId) {
      sessionId = getString(event, "thread_id") ?? getString(event, "session_id") ?? getString(event, "sessionId");
    }

    if (event.type === "turn.completed" && isRecord(event.usage)) {
      usage = event.usage;
    }

    const item = isRecord(event.item) ? event.item : null;
    if (!item) {
      continue;
    }

    if (item.type === "command_execution") {
      const command: CodexCommandItem = {
        command: getString(item, "command") ?? "",
        output: getString(item, "aggregated_output") ?? "",
        exitCode: getNumberOrNull(item, "exit_code"),
      };
      const id = getString(item, "id");
      const status = getString(item, "status");
      if (id) command.id = id;
      if (status) command.status = status;
      commands.push(command);
    }

    if (item.type === "agent_message") {
      finalMessage = getString(item, "text") ?? finalMessage;
    }
  }

  return {
    ...(sessionId ? { sessionId } : {}),
    finalMessage,
    commands,
    ...(usage ? { usage } : {}),
    events,
  };
}

function getString(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  return typeof item === "string" ? item : undefined;
}

function getNumberOrNull(value: Record<string, unknown>, key: string): number | null {
  const item = value[key];
  if (item === null) return null;
  return typeof item === "number" && Number.isFinite(item) ? item : null;
}
