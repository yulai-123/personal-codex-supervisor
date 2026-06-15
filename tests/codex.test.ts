import { describe, expect, it } from "vitest";
import { parseCodexJsonl, summarizeCodexEvents } from "../src/codex/output-parser.js";
import { SessionRegistry } from "../src/codex/session-registry.js";
import { createMigratedTestDatabase } from "./helpers.js";

describe("Codex runner support", () => {
  it("parses Codex JSONL output into a turn summary", () => {
    const events = parseCodexJsonl([
      JSON.stringify({ type: "thread.started", thread_id: "thread_1" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "pnpm test",
          aggregated_output: "ok",
          exit_code: 0,
          status: "completed",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "done",
        },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10 } }),
    ].join("\n"));

    expect(summarizeCodexEvents(events)).toMatchObject({
      sessionId: "thread_1",
      finalMessage: "done",
      commands: [
        {
          id: "item_1",
          command: "pnpm test",
          output: "ok",
          exitCode: 0,
          status: "completed",
        },
      ],
      usage: { input_tokens: 10 },
    });
  });

  it("registers, updates, and archives Codex sessions", () => {
    const db = createMigratedTestDatabase("pcs-codex-session-");

    try {
      const registry = new SessionRegistry(db);
      const created = registry.create({
        logicalName: "wechat_main",
        codexSessionId: "thread_old",
        role: "supervisor",
        metadata: { owner: "test" },
      });

      expect(registry.getActive("wechat_main", "supervisor")).toMatchObject({
        id: created.id,
        codexSessionId: "thread_old",
        metadata: { owner: "test" },
      });

      registry.updateCodexSessionId(created.id, "thread_new");
      expect(registry.getActive("wechat_main", "supervisor")).toMatchObject({
        codexSessionId: "thread_new",
      });

      registry.archive(created.id, "daily handoff");
      expect(registry.getActive("wechat_main", "supervisor")).toBeNull();
    } finally {
      db.close();
    }
  });
});
