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

  it("tells the supervisor how to handle scheduled triggers and external context references", () => {
    const db = createMigratedTestDatabase("pcs-prompt-supervisor-schedule-");

    try {
      const prompt = buildSupervisorPrompt({
        db,
        trigger: createScheduledTriggerMessage(),
        registry: createSupervisorToolRegistry(),
        session: null,
      });

      expect(prompt).toContain("Scheduled event rules");
      expect(prompt).toContain('source "scheduler"');
      expect(prompt).toContain('payload.channel === "schedule"');
      expect(prompt).toContain("Scheduled triggers still go through the Supervisor first");
      expect(prompt).toContain("message.send_wechat directly");
      expect(prompt).toContain('payload.executionHint === "start_worker"');
      expect(prompt).toContain("contextRef");
      expect(prompt).toContain('origin "scheduler"');
      expect(prompt).toContain("local-only/schedules/class-context.md");
      expect(prompt).toContain("task.start");
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

function createScheduledTriggerMessage(): HubMessage {
  return {
    id: "evt_prompt_schedule_1",
    kind: "event",
    type: "event.user.message_received",
    topic: "user",
    source: "scheduler",
    priority: 300,
    payload: {
      channel: "schedule",
      title: "Daily class schedule check",
      text: "Check whether there is a class today and notify the user if needed.",
      executionHint: "start_worker",
      contextSize: "large",
      contextMode: "external_ref",
      contextRef: "local-only/schedules/class-context.md",
      jobId: "job_prompt_schedule_1",
      jobName: "class_schedule",
      scheduledAt: "2026-06-15T23:35:00.000Z",
    },
    correlationId: "evt_prompt_schedule_1",
    createdAt: "2026-06-15T23:35:00.000Z",
  };
}
