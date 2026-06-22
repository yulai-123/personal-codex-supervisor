import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/runtime/logger.js";
import { runAttentionTick } from "../src/attention/index.js";
import type { AssistantRuntimeConfig } from "../src/assistant/index.js";
import { createSupervisorToolRegistry } from "../src/tools/supervisor-tools.js";
import { createMigratedTestDatabase } from "./helpers.js";

describe("assistant runtime", () => {
  it("records observations and preserves stale state explicitly", async () => {
    const db = createMigratedTestDatabase("pcs-assistant-state-");

    try {
      const registry = createSupervisorToolRegistry();
      const result = await registry.execute(
        { db, source: "supervisor" },
        {
          id: "call_1",
          name: "assistant.observation.record",
          input: {
            capabilityId: "default",
            key: "example.primary_check",
            value: { status: "reported" },
            source: "user_report",
            confidence: "high",
            observedAt: "2026-06-22T09:00:00.000Z",
            staleAfter: "2026-06-22T12:00:00.000Z",
          },
        },
      );

      expect(result.ok).toBe(true);
      const state = await registry.execute(
        { db, source: "supervisor" },
        {
          id: "call_2",
          name: "assistant.state.get",
          input: {
            capabilityId: "default",
            keys: ["example.primary_check"],
          },
        },
      );

      expect(state.ok).toBe(true);
      expect(state.output).toEqual([
        expect.objectContaining({
          capabilityId: "default",
          key: "example.primary_check",
          value: { status: "reported" },
          confidence: "high",
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("loads private assistant context through supervisor tools without requiring committed content", async () => {
    const db = createMigratedTestDatabase("pcs-assistant-context-");
    const configDir = mkdtempSync(join(tmpdir(), "pcs-assistant-config-"));
    mkdirSync(join(configDir, "capabilities/default"), { recursive: true });
    writeFileSync(join(configDir, "persona.md"), "A private global persona placeholder.");
    writeFileSync(join(configDir, "profile.md"), "A private user profile placeholder.");
    writeFileSync(join(configDir, "capabilities/default/SKILL.md"), "Handle a private capability.");

    try {
      const registry = createSupervisorToolRegistry({
        assistantConfig: testAssistantConfig(configDir),
      });
      const result = await registry.execute(
        { db, source: "supervisor" },
        {
          id: "call_1",
          name: "assistant.context.get",
          input: {
            capabilityId: "default",
          },
        },
      );

      expect(result.ok).toBe(true);
      expect(result.output).toMatchObject({
        context: {
          enabled: true,
          persona: "A private global persona placeholder.",
          profile: "A private user profile placeholder.",
          capabilities: [
            {
              id: "default",
              skill: "Handle a private capability.",
            },
          ],
        },
      });
    } finally {
      db.close();
    }
  });

  it("attention sidecar emits internal attention requests for stale or unknown signals", () => {
    const db = createMigratedTestDatabase("pcs-assistant-attention-");
    const configDir = mkdtempSync(join(tmpdir(), "pcs-assistant-attention-config-"));
    mkdirSync(join(configDir, "capabilities/default"), { recursive: true });
    writeFileSync(
      join(configDir, "capabilities/default/service-standards.toml"),
      `
        [[signals]]
        key = "example.midday_check"
        label = "Midday check"
        max_unknown_hours = 6
        natural_windows = ["12:00-14:30"]
        priority = 35
        ask_style = "concrete_check"
      `,
    );

    try {
      const results = runAttentionTick({
        db,
        config: testAssistantConfig(configDir),
        timezone: "Asia/Shanghai",
        logger: createLogger({ level: "error" }),
      }, new Date("2026-06-22T05:20:00.000Z"));

      expect(results.map((result) => result.message.type)).toContain("event.assistant.attention_requested");
      const attention = results.find((result) => result.message.type === "event.assistant.attention_requested");
      expect(attention?.deliveryGroupIds).toEqual(expect.arrayContaining([
        "projection_group",
        "supervisor_group",
      ]));
      expect(attention?.message.payload).toMatchObject({
        capabilityId: "default",
        reason: "state_unknown",
        signal: {
          key: "example.midday_check",
          status: "unknown",
        },
      });
    } finally {
      db.close();
    }
  });
});

function testAssistantConfig(configDir: string): AssistantRuntimeConfig {
  return {
    enabled: true,
    configDir,
    maxPromptChars: 12_000,
    attention: {
      enabled: true,
      intervalMs: 30 * 60 * 1_000,
      urgentIntervalMs: 15 * 60 * 1_000,
      maxDailyMessages: 5,
      minMinutesBetweenMessages: 60,
      unansweredBackoffMs: 2 * 60 * 60 * 1_000,
      quietHours: ["00:30-08:30"],
    },
  };
}
