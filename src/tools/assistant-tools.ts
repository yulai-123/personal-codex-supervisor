import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadAssistantPromptContext, type AssistantRuntimeConfig } from "../assistant/index.js";
import {
  completeAssistantFollowup,
  createAssistantFollowup,
  listAssistantState,
  markAssistantStateUnknown,
  recordAssistantIntervention,
  recordAssistantObservation,
  upsertAssistantDailySummary,
} from "../assistant/state.js";
import type { ToolRegistry } from "./registry.js";

const DEFAULT_CAPABILITY_ID = "default";

export type AssistantToolOptions = {
  assistantConfig?: AssistantRuntimeConfig;
};

export function registerAssistantSupervisorTools(registry: ToolRegistry, options: AssistantToolOptions = {}): ToolRegistry {
  return registry
    .register({
      name: "assistant.context.get",
      description: "Read enabled private assistant persona/profile/capability context and current assistant state.",
      riskLevel: "read",
      usage: {
        useWhen: [
          "the Supervisor needs global persona, capability guidance, service standards, or private assistant memory",
          "a trigger is about user state, follow-up, attention, or assistant behavior",
        ],
        doNotUseWhen: [
          "the task does not involve assistant behavior or user state",
        ],
        returns: "assistant context files plus current assistant state; private data stays local and is not committed",
        exampleInput: {
          capabilityId: "default",
        },
      },
      inputSchema: z.object({
        capabilityId: z.string().min(1).optional(),
      }),
      handler: ({ db }, input) => {
        const context = options.assistantConfig
          ? loadAssistantPromptContext(options.assistantConfig)
          : {
            enabled: false,
            configDir: "",
            persona: null,
            profile: null,
            capabilities: [],
          };
        return {
          context,
          state: listAssistantState(db, {
            ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
            limit: 100,
          }),
        };
      },
    })
    .register({
      name: "assistant.state.get",
      description: "Read current assistant-maintained private state signals.",
      riskLevel: "read",
      usage: {
        useWhen: [
          "the Supervisor needs to know what is known, stale, or unknown before asking the user",
          "the Supervisor is handling an assistant attention request or follow-up",
        ],
        returns: "current state rows with effective known/stale/unknown status",
        exampleInput: {
          capabilityId: "default",
          keys: ["example.primary_check", "example.midday_check"],
        },
      },
      inputSchema: z.object({
        capabilityId: z.string().min(1).optional(),
        keys: z.array(z.string().min(1)).optional(),
        limit: z.number().int().positive().max(200).optional(),
      }),
      handler: ({ db }, input) => listAssistantState(db, {
        capabilityId: input.capabilityId ?? DEFAULT_CAPABILITY_ID,
        ...(input.keys ? { keys: input.keys } : {}),
        limit: input.limit ?? 100,
      }),
    })
    .register({
      name: "assistant.observation.record",
      description: "Record a user-state observation without treating missing information as failure.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "the user reports information relevant to a configured private assistant signal",
          "the assistant asks a check-in question and receives an answer",
        ],
        doNotUseWhen: [
          "the assistant only suspects something from silence; use assistant.state.mark_unknown instead",
        ],
        returns: "observation id and updated state",
        exampleInput: {
          capabilityId: "default",
          key: "example.primary_check",
          value: { status: "reported" },
          source: "user_report",
          confidence: "high",
          staleAfter: "2026-06-24T12:00:00.000Z",
        },
      },
      inputSchema: z.object({
        capabilityId: z.string().min(1).optional(),
        key: z.string().min(1),
        value: z.unknown(),
        source: z.enum(["user_report", "assistant_question", "inferred", "schedule", "tool", "worker", "system"]),
        confidence: z.enum(["high", "medium", "low"]),
        observedAt: z.string().datetime().optional(),
        staleAfter: z.string().datetime().nullable().optional(),
        sourceMessageId: z.string().min(1).nullable().optional(),
      }),
      handler: ({ db }, input) => recordAssistantObservation(db, {
        capabilityId: input.capabilityId ?? DEFAULT_CAPABILITY_ID,
        key: input.key,
        value: input.value,
        source: input.source,
        confidence: input.confidence,
        ...(input.observedAt ? { observedAt: input.observedAt } : {}),
        staleAfter: input.staleAfter ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
      }),
    })
    .register({
      name: "assistant.state.mark_unknown",
      description: "Mark an assistant state key as unknown when the assistant lacks reliable information.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "the assistant needs to explicitly preserve uncertainty instead of inferring a behavior",
          "a signal is important but has no reliable recent user report",
        ],
        returns: "updated unknown state row",
        exampleInput: {
          capabilityId: "default",
          key: "example.primary_check",
          reason: "No recent user report; silence is not evidence.",
        },
      },
      inputSchema: z.object({
        capabilityId: z.string().min(1).optional(),
        key: z.string().min(1),
        reason: z.string().optional(),
      }),
      handler: ({ db }, input) => markAssistantStateUnknown(db, {
        capabilityId: input.capabilityId ?? DEFAULT_CAPABILITY_ID,
        key: input.key,
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    })
    .register({
      name: "assistant.intervention.record",
      description: "Record an assistant intervention decision, including silence and suppressed decisions.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "the Supervisor decides to ask, remind, stay silent, suppress, or create a follow-up",
          "the assistant should keep an audit trail to avoid repeated nudges",
        ],
        returns: "intervention id",
        exampleInput: {
          capabilityId: "default",
          action: "silence",
          status: "skipped",
          reason: "No clear state risk and user was recently contacted.",
          stateTags: ["example"],
        },
      },
      inputSchema: z.object({
        capabilityId: z.string().min(1).optional(),
        action: z.enum(["silence", "record", "ask", "remind", "follow_up", "task", "schedule"]),
        reason: z.string().min(1),
        userMessage: z.string().nullable().optional(),
        status: z.enum(["planned", "sent", "suppressed", "skipped", "failed"]),
        sentMessageId: z.string().min(1).nullable().optional(),
        stateTags: z.array(z.string().min(1)).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      handler: ({ db }, input) => recordAssistantIntervention(db, {
        capabilityId: input.capabilityId ?? DEFAULT_CAPABILITY_ID,
        action: input.action,
        reason: input.reason,
        userMessage: input.userMessage ?? null,
        status: input.status,
        sentMessageId: input.sentMessageId ?? null,
        stateTags: input.stateTags ?? [],
        metadata: input.metadata ?? {},
      }),
    })
    .register({
      name: "assistant.followup.create",
      description: "Create a one-off assistant follow-up that the attention sidecar will surface later.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "the assistant should check back later without creating a permanent schedule",
          "the user state would benefit from delayed, low-noise follow-up",
        ],
        returns: "follow-up id",
        exampleInput: {
          capabilityId: "default",
          purpose: "Check a configured private signal after an earlier uncertain state.",
          dueAt: "2026-06-22T14:30:00.000Z",
          priority: 120,
        },
      },
      inputSchema: z.object({
        capabilityId: z.string().min(1).optional(),
        purpose: z.string().min(1),
        dueAt: z.string().datetime(),
        payload: z.record(z.string(), z.unknown()).optional(),
        priority: z.number().int().positive().optional(),
      }),
      handler: ({ db }, input) => createAssistantFollowup(db, {
        capabilityId: input.capabilityId ?? DEFAULT_CAPABILITY_ID,
        purpose: input.purpose,
        dueAt: input.dueAt,
        payload: input.payload ?? {},
        priority: input.priority ?? 300,
      }),
    })
    .register({
      name: "assistant.followup.complete",
      description: "Mark a pending or triggered assistant follow-up as completed.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "the assistant has handled a follow-up or the follow-up is obsolete",
        ],
        returns: "whether the follow-up was completed",
        exampleInput: {
          followupId: "asst_followup_example",
        },
      },
      inputSchema: z.object({
        followupId: z.string().min(1),
      }),
      handler: ({ db }, input) => ({
        completed: completeAssistantFollowup(db, input.followupId),
        followupId: input.followupId,
      }),
    })
    .register({
      name: "assistant.daily_summary.upsert",
      description: "Create or update a private assistant daily summary in SQLite.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "the assistant is consolidating a day of observations into a compact private summary",
          "a daily or weekly review needs stable structured memory without editing files",
        ],
        returns: "daily summary id",
        exampleInput: {
          capabilityId: "default",
          localDate: "2026-06-22",
          summary: "User reported a mixed day with sleep debt but completed dinner and a short walk.",
        },
      },
      inputSchema: z.object({
        capabilityId: z.string().min(1).optional(),
        localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        summary: z.string().min(1),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      handler: ({ db }, input) => upsertAssistantDailySummary(db, {
        capabilityId: input.capabilityId ?? DEFAULT_CAPABILITY_ID,
        localDate: input.localDate,
        summary: input.summary,
        metadata: input.metadata ?? {},
      }),
    })
    .register({
      name: "assistant.memory.append",
      description: "Append generated private assistant memory to local-only assistant memory files.",
      riskLevel: "write",
      usage: {
        useWhen: [
          "a weekly or explicit memory consolidation found stable user preferences or patterns",
          "the assistant should preserve learned private context across future Supervisor turns",
        ],
        doNotUseWhen: [
          "the information is a one-off dynamic state; use assistant.observation.record instead",
          "the information is uncertain or based only on user silence",
        ],
        returns: "path and appended timestamp",
        exampleInput: {
          capabilityId: "default",
          heading: "Weekly pattern",
          text: "User tends to recover better after concrete cleanup actions than vague short tidying.",
        },
      },
      inputSchema: z.object({
        capabilityId: z.string().min(1).optional(),
        heading: z.string().min(1).max(120).optional(),
        text: z.string().min(1),
      }),
      handler: (_context, input) => {
        if (!options.assistantConfig?.enabled) {
          throw new Error("assistant runtime is disabled");
        }

        const capabilityId = input.capabilityId ?? DEFAULT_CAPABILITY_ID;
        assertSafeCapabilityId(capabilityId);
        const capabilityDir = join(options.assistantConfig.configDir, "capabilities", capabilityId);
        mkdirSync(capabilityDir, { recursive: true });
        const path = join(capabilityDir, "memory.generated.md");
        const appendedAt = new Date().toISOString();
        const heading = input.heading ? `### ${input.heading}` : "### Generated memory";
        appendFileSync(path, `\n\n${heading}\n\nRecorded at: ${appendedAt}\n\n${input.text.trim()}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        return {
          path,
          appendedAt,
        };
      },
    });
}

function assertSafeCapabilityId(capabilityId: string): void {
  if (!/^[a-zA-Z0-9_.-]+$/.test(capabilityId)) {
    throw new Error("capabilityId may only contain letters, numbers, dots, underscores, and dashes");
  }
}
