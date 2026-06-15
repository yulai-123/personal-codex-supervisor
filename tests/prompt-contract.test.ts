import { describe, expect, it } from "vitest";
import { buildSupervisorPrompt } from "../src/agents/supervisor/context-builder.js";
import { buildWorkerPrompt } from "../src/agents/worker/context-builder.js";
import type { HubMessage } from "../src/kernel/event-hub/types.js";
import { createSupervisorToolRegistry } from "../src/tools/supervisor-tools.js";
import { createWorkerToolRegistry } from "../src/tools/worker-tools.js";
import { createMigratedTestDatabase } from "./helpers.js";

describe("agent prompt contracts", () => {
  it("tells the supervisor how to dispatch asynchronous work and send user-visible replies", () => {
    const db = createMigratedTestDatabase("pcs-prompt-supervisor-");

    try {
      const prompt = buildSupervisorPrompt({
        db,
        trigger: createTriggerMessage(),
        registry: createSupervisorToolRegistry(),
        session: null,
      });

      expect(prompt).toContain("# Supervisor Operating Skill");
      expect(prompt).toContain("Do not wait for worker completion");
      expect(prompt).toContain("Use message.send_wechat");
      expect(prompt).toContain("Work is complex, slow, file/code/browser/system-heavy");
      expect(prompt).toContain("task.start");
      expect(prompt).toContain("input_schema");
      expect(prompt).toContain("example_tool_call");
      expect(prompt).toContain("Completion or send success arrives later as events");
    } finally {
      db.close();
    }
  });

  it("tells workers how to execute, report progress, ask decisions, and finish with JSON", () => {
    const prompt = buildWorkerPrompt({
      taskId: "task_prompt_1",
      runId: "run_prompt_1",
      objective: "Inspect repository health",
      context: {
        userRequest: "Inspect whether the project is healthy.",
      },
      expectedOutput: "Summary of checks and next steps.",
      registry: createWorkerToolRegistry({
        taskId: "task_prompt_1",
        runId: "run_prompt_1",
        workerSessionId: "session_prompt_1",
      }),
    });

    expect(prompt).toContain("# Worker Operating Skill");
    expect(prompt).toContain("Do not send external messages to the user");
    expect(prompt).toContain("task.report_progress");
    expect(prompt).toContain("task.register_artifact");
    expect(prompt).toContain("task.needs_decision");
    expect(prompt).toContain("Final output must be JSON only");
    expect(prompt).toContain("input_schema");
    expect(prompt).toContain("example_tool_call");
  });
});

function createTriggerMessage(): HubMessage {
  return {
    id: "evt_prompt_1",
    kind: "event",
    type: "event.wechat.message_received",
    topic: "wechat",
    source: "test",
    priority: 100,
    payload: {
      text: "Please inspect whether the project is healthy.",
    },
    correlationId: "evt_prompt_1",
    createdAt: "2026-06-15T00:00:00.000Z",
  };
}
