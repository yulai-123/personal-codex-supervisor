import type { CodexRunner, CodexRunSummary } from "../codex/index.js";
import { parseToolCalls, formatToolResultsForPrompt } from "../tools/tool-call-parser.js";
import type { ToolExecutionContext, ToolRegistry, ToolResult } from "../tools/registry.js";

export type CodexToolLoopOptions = {
  runner: CodexRunner;
  cwd: string;
  prompt: string;
  sessionId?: string;
  model?: string;
  env?: Record<string, string | undefined>;
  registry: ToolRegistry;
  toolContext: ToolExecutionContext;
  maxToolIterations?: number;
};

export type CodexToolLoopResult = {
  sessionId?: string;
  finalMessage: string;
  turns: CodexRunSummary[];
  toolResults: ToolResult[];
};

export async function runCodexToolLoop(options: CodexToolLoopOptions): Promise<CodexToolLoopResult> {
  const maxToolIterations = options.maxToolIterations ?? 4;
  const turns: CodexRunSummary[] = [];
  const allToolResults: ToolResult[] = [];
  let currentSessionId = options.sessionId;
  let prompt = options.prompt;

  for (let iteration = 0; iteration <= maxToolIterations; iteration += 1) {
    const turn = await options.runner.runTurn({
      prompt,
      cwd: options.cwd,
      ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    turns.push(turn);
    currentSessionId = turn.sessionId ?? currentSessionId;

    const parsed = parseToolCalls(turn.finalMessage);
    if (!parsed) {
      return {
        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
        finalMessage: turn.finalMessage,
        turns,
        toolResults: allToolResults,
      };
    }

    const toolResults = await Promise.all(
      parsed.toolCalls.map((call) => options.registry.execute(options.toolContext, call)),
    );
    allToolResults.push(...toolResults);

    if (!currentSessionId) {
      return {
        finalMessage: "Codex requested tools but did not return a resumable session id.",
        turns,
        toolResults: allToolResults,
      };
    }

    prompt = formatToolResultsForPrompt(toolResults);
  }

  return {
    ...(currentSessionId ? { sessionId: currentSessionId } : {}),
    finalMessage: "Tool iteration limit reached.",
    turns,
    toolResults: allToolResults,
  };
}
