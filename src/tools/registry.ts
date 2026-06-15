import { z } from "zod";
import type { EventHubNotifier } from "../kernel/event-hub/notifier.js";
import type { AppDatabase } from "../storage/sqlite.js";

export type ToolRiskLevel = "read" | "write" | "external";

export type ToolExecutionContext = {
  db: AppDatabase;
  source: string;
  notifier?: EventHubNotifier;
};

export type ToolDefinition<TInput = unknown, TOutput = unknown> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  riskLevel: ToolRiskLevel;
  usage?: ToolUsageGuide;
  handler: (context: ToolExecutionContext, input: TInput) => Promise<TOutput> | TOutput;
};

export type ToolUsageGuide = {
  useWhen?: string[];
  doNotUseWhen?: string[];
  returns?: string;
  exampleInput?: unknown;
};

export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type ToolResult = {
  id: string;
  name: string;
  ok: boolean;
  output?: unknown;
  error?: string;
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as z.ZodType<unknown>,
      riskLevel: tool.riskLevel,
      ...(tool.usage ? { usage: tool.usage } : {}),
      handler: (context, input) => tool.handler(context, input as TInput),
    });
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async execute(context: ToolExecutionContext, call: ToolCall): Promise<ToolResult> {
    const tool = this.get(call.name);
    if (!tool) {
      return {
        id: call.id,
        name: call.name,
        ok: false,
        error: `Unknown tool: ${call.name}`,
      };
    }

    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      return {
        id: call.id,
        name: call.name,
        ok: false,
        error: z.prettifyError(parsed.error),
      };
    }

    try {
      return {
        id: call.id,
        name: call.name,
        ok: true,
        output: await tool.handler(context, parsed.data),
      };
    } catch (error) {
      return {
        id: call.id,
        name: call.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function formatToolListForPrompt(registry: ToolRegistry): string {
  const tools = registry.list();
  if (tools.length === 0) {
    return "No internal tools are available.";
  }

  return tools
    .map((tool) => {
      const lines = [
        `- ${tool.name}`,
        `  risk: ${tool.riskLevel}`,
        `  description: ${tool.description}`,
        `  input_schema: ${JSON.stringify(toPromptJsonSchema(tool.inputSchema))}`,
      ];
      if (tool.usage?.useWhen?.length) {
        lines.push(`  use_when: ${tool.usage.useWhen.join(" | ")}`);
      }
      if (tool.usage?.doNotUseWhen?.length) {
        lines.push(`  do_not_use_when: ${tool.usage.doNotUseWhen.join(" | ")}`);
      }
      if (tool.usage?.returns) {
        lines.push(`  returns: ${tool.usage.returns}`);
      }
      if (tool.usage?.exampleInput !== undefined) {
        lines.push(`  example_tool_call: ${JSON.stringify({
          toolCalls: [
            {
              id: `call_${tool.name.replace(/[^a-z0-9]+/gi, "_")}`,
              name: tool.name,
              input: tool.usage.exampleInput,
            },
          ],
        })}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

function toPromptJsonSchema(schema: z.ZodType<unknown>): unknown {
  try {
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    const { $schema: _schema, ...rest } = jsonSchema;
    return rest;
  } catch {
    return { type: "object", description: "See tool description for accepted input." };
  }
}
