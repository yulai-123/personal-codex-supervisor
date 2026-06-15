import { formatToolListForPrompt, type ToolRegistry } from "../../tools/registry.js";
import { formatToolCallInstructions } from "../../tools/tool-call-parser.js";
import { toolProtocolSkill, workerOperatingSkill } from "../skills/index.js";
import { formatWorkerFinalOutputInstructions } from "./output-schema.js";

export type WorkerPromptInput = {
  taskId: string;
  runId: string;
  objective: string;
  context: Record<string, unknown>;
  expectedOutput?: string;
  registry: ToolRegistry;
};

export function buildWorkerPrompt(input: WorkerPromptInput): string {
  return `${workerOperatingSkill}

${toolProtocolSkill}

# Runtime Context

Task:
${JSON.stringify({
  taskId: input.taskId,
  runId: input.runId,
  objective: input.objective,
  context: input.context,
  expectedOutput: input.expectedOutput ?? null,
}, null, 2)}

Available internal tools:
${formatToolListForPrompt(input.registry)}

${formatToolCallInstructions()}

${formatWorkerFinalOutputInstructions()}`;
}
