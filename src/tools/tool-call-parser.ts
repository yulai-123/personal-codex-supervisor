import { isRecord } from "../shared/json.js";
import type { ToolCall, ToolResult } from "./registry.js";

export type ParsedToolCalls = {
  toolCalls: ToolCall[];
};

export function parseToolCalls(message: string): ParsedToolCalls | null {
  const candidates = candidateJsonTexts(message);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const calls = extractToolCalls(parsed);
      if (calls.length > 0) {
        return { toolCalls: calls };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function formatToolCallInstructions(): string {
  return `When you need one or more internal system tools, reply with JSON only:

{
  "toolCalls": [
    {
      "id": "call_1",
      "name": "tool.name",
      "input": {}
    }
  ]
}

After tool results are returned, continue the same task. If no tool is needed, answer normally.`;
}

export function formatToolResultsForPrompt(results: ToolResult[]): string {
  return `Internal tool results:

<pcs_tool_results>
${JSON.stringify({ toolResults: results }, null, 2)}
</pcs_tool_results>

Use these results to continue. If you need another internal tool, return another toolCalls JSON object. Otherwise, provide the final answer requested by your role.`;
}

function candidateJsonTexts(message: string): string[] {
  const trimmed = message.trim();
  const candidates = [trimmed];

  const toolBlock = /<pcs_tool_calls>\s*([\s\S]*?)\s*<\/pcs_tool_calls>/i.exec(message);
  if (toolBlock?.[1]) {
    candidates.push(toolBlock[1].trim());
  }

  const fences = message.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const fence of fences) {
    if (fence[1]) {
      candidates.push(fence[1].trim());
    }
  }

  return candidates;
}

function extractToolCalls(value: unknown): ToolCall[] {
  if (!isRecord(value)) {
    return [];
  }

  const rawCalls = value.toolCalls ?? value.tool_calls;
  if (!Array.isArray(rawCalls)) {
    return [];
  }

  return rawCalls.flatMap((item, index) => {
    if (!isRecord(item)) {
      return [];
    }
    const name = typeof item.name === "string" ? item.name : undefined;
    if (!name) {
      return [];
    }
    return [{
      id: typeof item.id === "string" ? item.id : `call_${index + 1}`,
      name,
      input: item.input ?? {},
    }];
  });
}
