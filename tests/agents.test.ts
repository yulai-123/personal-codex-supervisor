import { describe, expect, it } from "vitest";
import { createSupervisorHandler } from "../src/agents/supervisor/runner.js";
import { createWorkerGroupHandler } from "../src/agents/worker/group.js";
import type { CodexRunSummary, CodexRunner, CodexTurnInput } from "../src/codex/index.js";
import { appendHubMessage } from "../src/kernel/event-hub/append.js";
import { runConsumerOnce } from "../src/kernel/event-hub/consumer-runner.js";
import { projectMessage } from "../src/kernel/projections/projector.js";
import type { AppDatabase } from "../src/storage/sqlite.js";
import { createMigratedTestDatabase } from "./helpers.js";

class SequenceRunner implements CodexRunner {
  readonly prompts: CodexTurnInput[] = [];
  private index = 0;

  constructor(private readonly messages: string[]) {}

  async runTurn(input: CodexTurnInput): Promise<CodexRunSummary> {
    this.prompts.push(input);
    const message = this.messages[this.index] ?? this.messages[this.messages.length - 1] ?? "";
    this.index += 1;
    return {
      sessionId: `thread_${this.index}`,
      finalMessage: message,
      commands: [],
      events: [],
    };
  }
}

describe("supervisor and worker agents", () => {
  it("runs a supervisor turn that emits asynchronous task commands through tools", async () => {
    const db = createMigratedTestDatabase("pcs-agent-supervisor-");
    const runner = new SequenceRunner([
      JSON.stringify({
        toolCalls: [
          {
            id: "call_1",
            name: "task.start",
            input: {
              objective: "Inspect repo health",
              priority: 30,
            },
          },
        ],
      }),
      "Accepted and watching for worker results.",
    ]);

    try {
      appendHubMessage(db, {
        kind: "event",
        type: "event.wechat.message_received",
        source: "wechat",
        payload: {
          text: "please inspect repo health",
        },
      });

      const result = await runConsumerOnce(db, {
        groupId: "supervisor_group",
        handler: createSupervisorHandler({
          db,
          runner,
          projectRoot: process.cwd(),
          logicalName: "wechat_main",
        }),
        leaseMs: 60_000,
        maxAttempts: 3,
        workerId: "supervisor-test",
      });

      expect(result).toEqual({ claimed: 1, acked: 1, failed: 0 });
      expect(runner.prompts).toHaveLength(2);
      expect(runner.prompts[1]!.sessionId).toBe("thread_1");

      expect(db.prepare("SELECT logical_name, role, codex_session_id FROM sessions").get()).toMatchObject({
        logical_name: "wechat_main",
        role: "supervisor",
        codex_session_id: "thread_2",
      });
      expect(db.prepare("SELECT type FROM event_log WHERE type = 'command.task.start'").get()).toMatchObject({
        type: "command.task.start",
      });
      expect(db.prepare("SELECT type FROM event_log WHERE type = 'event.supervisor.turn_completed'").get()).toMatchObject({
        type: "event.supervisor.turn_completed",
      });
    } finally {
      db.close();
    }
  });

  it("uses pending handoff summaries when creating a new supervisor session", async () => {
    const db = createMigratedTestDatabase("pcs-agent-supervisor-handoff-");
    const runner = new SequenceRunner(["No user-visible action needed."]);

    try {
      db.prepare(`
        INSERT INTO session_handoffs (
          id, logical_name, status, summary_json, requested_at, archived_at, created_at, updated_at
        ) VALUES (
          'handoff_1',
          'wechat_main',
          'archived',
          '{"generatedBy":"maintenance","nextSupervisorInstructions":["resume carefully"]}',
          '2026-06-15T00:00:00.000Z',
          '2026-06-15T00:00:00.000Z',
          '2026-06-15T00:00:00.000Z',
          '2026-06-15T00:00:00.000Z'
        )
      `).run();
      appendHubMessage(db, {
        kind: "event",
        type: "event.wechat.message_received",
        source: "wechat",
        payload: {
          text: "hello",
        },
      });

      const result = await runConsumerOnce(db, {
        groupId: "supervisor_group",
        handler: createSupervisorHandler({
          db,
          runner,
          projectRoot: process.cwd(),
          logicalName: "wechat_main",
        }),
        leaseMs: 60_000,
        maxAttempts: 3,
        workerId: "supervisor-handoff-test",
      });

      expect(result).toEqual({ claimed: 1, acked: 1, failed: 0 });
      expect(runner.prompts[0]!.prompt).toContain("Pending handoff summary");
      expect(runner.prompts[0]!.prompt).toContain("resume carefully");
      expect(db.prepare("SELECT status, new_session_id FROM session_handoffs WHERE id = 'handoff_1'").get())
        .toMatchObject({
          status: "activated",
          new_session_id: expect.stringMatching(/^session_/),
        });
    } finally {
      db.close();
    }
  });

  it("runs a worker command and records terminal task state", async () => {
    const db = createMigratedTestDatabase("pcs-agent-worker-");
    const runner = new SequenceRunner([
      JSON.stringify({
        status: "success",
        severity: "notice",
        summary: "Repository health inspected",
        shouldNotifyUser: "yes",
        needsSupervisorDecision: false,
        artifacts: [],
      }),
    ]);

    try {
      const command = appendHubMessage(db, {
        kind: "command",
        type: "command.task.start",
        source: "supervisor",
        priority: 25,
        correlationId: "corr_worker",
        payload: {
          taskId: "task_worker_1",
          objective: "Inspect repo health",
          context: { source: "test" },
        },
      });

      const result = await runConsumerOnce(db, {
        groupId: "worker_group",
        handler: createWorkerGroupHandler({
          db,
          runner,
          projectRoot: process.cwd(),
        }),
        leaseMs: 60_000,
        maxAttempts: 3,
        workerId: "worker-test",
      });
      await drainProjectionGroup(db);

      expect(result).toEqual({ claimed: 1, acked: 1, failed: 0 });
      expect(runner.prompts).toHaveLength(1);
      expect(db.prepare("SELECT task_id, status FROM task_runs").get()).toMatchObject({
        task_id: "task_worker_1",
        status: "success",
      });
      expect(db.prepare("SELECT task_id, status, summary FROM task_events").get()).toMatchObject({
        task_id: "task_worker_1",
        status: "success",
        summary: "Repository health inspected",
      });
      expect(db.prepare("SELECT task_id, status, summary FROM tasks_current_state WHERE task_id = ?").get("task_worker_1"))
        .toMatchObject({
          task_id: "task_worker_1",
          status: "success",
          summary: "Repository health inspected",
        });
      expect(db.prepare("SELECT count(*) AS count FROM event_log WHERE causation_id = ?").get(command.message.id))
        .toMatchObject({ count: 2 });
    } finally {
      db.close();
    }
  });
});

async function drainProjectionGroup(db: AppDatabase): Promise<void> {
  for (;;) {
    const result = await runConsumerOnce(db, {
      groupId: "projection_group",
      handler: ({ message }) => projectMessage(db, message),
      leaseMs: 60_000,
      maxAttempts: 3,
      batchSize: 10,
      workerId: "projection-agent-test",
    });
    if (result.claimed === 0) {
      return;
    }
  }
}
