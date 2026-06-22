import {
  loadAssistantSignalStandards,
  type AssistantRuntimeConfig,
  type AssistantSignalStandard,
  type AssistantStateStatus,
  type AssistantStateView,
} from "../assistant/index.js";
import { getDueAssistantFollowups, listAssistantState, markAssistantFollowupTriggered } from "../assistant/state.js";
import { appendHubMessage, type AppendHubMessageResult } from "../kernel/event-hub/index.js";
import type { EventHubNotifier } from "../kernel/event-hub/notifier.js";
import { parseJsonObject } from "../shared/json.js";
import type { RuntimeComponent } from "../runtime/component.js";
import type { Logger } from "../runtime/logger.js";
import { sleep } from "../runtime/sleep.js";
import type { AppDatabase } from "../storage/sqlite.js";
import { evaluateAttentionGate, isWithinNaturalWindow } from "./gate.js";

export type AttentionSidecarOptions = {
  db: AppDatabase;
  config: AssistantRuntimeConfig;
  timezone: string;
  logger: Logger;
  notifier?: EventHubNotifier;
};

export function createAttentionSidecar(options: AttentionSidecarOptions): RuntimeComponent {
  const intervalMs = getAttentionLoopIntervalMs(options.config);

  return {
    name: "assistant_attention",
    start: async (signal) => {
      runAttentionTick(options, new Date());
      while (!signal.aborted) {
        const result = await sleep(intervalMs, signal);
        if (result === "aborted") {
          return;
        }
        runAttentionTick(options, new Date());
      }
    },
  };
}

export function getAttentionLoopIntervalMs(config: AssistantRuntimeConfig): number {
  return Math.min(config.attention.intervalMs, config.attention.urgentIntervalMs);
}

export function runAttentionTick(options: AttentionSidecarOptions, now: Date): AppendHubMessageResult[] {
  if (!options.config.enabled || !options.config.attention.enabled) {
    return [];
  }

  const results: AppendHubMessageResult[] = [];
  const nowIso = now.toISOString();

  for (const followup of getDueAssistantFollowups(options.db, nowIso, 10)) {
    if (!markAssistantFollowupTriggered(options.db, followup.id)) {
      continue;
    }
    results.push(appendHubMessage(options.db, {
      kind: "event",
      type: "event.assistant.followup_due",
      source: "assistant_attention",
      topic: "assistant",
      priority: followup.priority,
      payload: {
        followupId: followup.id,
        capabilityId: followup.capability_id,
        purpose: followup.purpose,
        dueAt: followup.due_at,
        payload: parseJsonObject(followup.payload_json),
      },
      dedupeKey: `assistant.followup_due:${followup.id}`,
    }, appendOptions(options)));
  }

  const standards = loadAssistantSignalStandards(options.config);
  const currentState = new Map(
    listAssistantState(options.db, { limit: 500, now: nowIso })
      .map((state) => [`${state.capabilityId}:${state.key}`, state]),
  );
  const dueByCapability = new Map<string, DueAttentionSignal[]>();

  for (const standard of standards) {
    const state = currentState.get(`${standard.capabilityId}:${standard.key}`);
    const stateStatus = state?.status ?? "unknown";
    if (stateStatus === "known") {
      continue;
    }
    if (stateStatus === "unknown" && state && !unknownLongEnough(state.updatedAt, now, standard.maxUnknownHours)) {
      continue;
    }
    if (!isWithinNaturalWindow(now, options.timezone, standard.naturalWindows)) {
      continue;
    }

    const items = dueByCapability.get(standard.capabilityId) ?? [];
    items.push({ standard, state, stateStatus });
    dueByCapability.set(standard.capabilityId, items);
  }

  for (const [capabilityId, signals] of dueByCapability) {
    if (signals.length === 0) {
      continue;
    }
    const priority = Math.min(...signals.map((signal) => signal.standard.priority));
    const gate = evaluateAttentionGate(options.db, {
      capabilityId,
      priority,
      now,
      timezone: options.timezone,
      maxDailyMessages: options.config.attention.maxDailyMessages,
      minMinutesBetweenMessages: options.config.attention.minMinutesBetweenMessages,
      unansweredBackoffMs: options.config.attention.unansweredBackoffMs,
      quietHours: options.config.attention.quietHours,
    });

    if (!gate.allowed) {
      options.logger.debug("assistant attention suppressed", {
        capabilityId,
        keys: signals.map((signal) => signal.standard.key),
        reason: gate.reason,
      });
      continue;
    }

    const primary = signals[0]!;

    results.push(appendHubMessage(options.db, {
      kind: "event",
      type: "event.assistant.attention_requested",
      source: "assistant_attention",
      topic: "assistant",
      priority,
      payload: {
        capabilityId,
        reason: primary.state ? "state_stale" : "state_unknown",
        signal: toPayloadSignal(primary),
        signals: signals.map(toPayloadSignal),
        observedState: primary.state ?? null,
        observedStates: signals.map((signal) => ({
          key: signal.standard.key,
          state: signal.state ?? null,
        })),
        gateReason: gate.reason,
      },
      dedupeKey: `assistant.attention:${capabilityId}:${attentionKey(signals)}:${attentionBucket(now)}`,
    }, appendOptions(options)));
  }

  if (results.length > 0) {
    options.logger.debug("assistant attention emitted events", {
      count: results.length,
      types: results.map((result) => result.message.type),
    });
  }

  return results;
}

function attentionBucket(now: Date): string {
  const bucketMs = 30 * 60 * 1_000;
  return String(Math.floor(now.getTime() / bucketMs));
}

type DueAttentionSignal = {
  standard: AssistantSignalStandard;
  state: AssistantStateView | undefined;
  stateStatus: AssistantStateStatus;
};

function toPayloadSignal(signal: DueAttentionSignal) {
  return {
    key: signal.standard.key,
    label: signal.standard.label,
    status: signal.stateStatus,
    askStyle: signal.standard.askStyle,
    priority: signal.standard.priority,
    naturalWindows: signal.standard.naturalWindows,
  };
}

function attentionKey(signals: DueAttentionSignal[]): string {
  return signals.map((signal) => signal.standard.key).join("+");
}

function unknownLongEnough(updatedAt: string, now: Date, maxUnknownHours: number): boolean {
  const updated = new Date(updatedAt);
  if (Number.isNaN(updated.getTime())) {
    return true;
  }
  return now.getTime() - updated.getTime() >= maxUnknownHours * 60 * 60 * 1_000;
}

function appendOptions(options: AttentionSidecarOptions) {
  return options.notifier ? { notifier: options.notifier } : {};
}
