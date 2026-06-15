import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendCliUserMessage } from "../src/plugins/cli/index.js";
import { runDueScheduledJobs, seedSystemScheduledJobs } from "../src/plugins/scheduler/index.js";
import {
  ClawbotWechatAdapter,
  createClawbotReceiverComponent,
  appendWechatInboundMessage,
  createWechatSenderHandler,
  getWechatConversationState,
  loginClawbot,
  type ClawbotClient,
  type ClawbotAccount,
  type WechatAdapter,
  type WechatSendMessageInput,
} from "../src/plugins/wechat/index.js";
import { appendHubMessage } from "../src/kernel/event-hub/append.js";
import { runConsumerOnce } from "../src/kernel/event-hub/consumer-runner.js";
import { createLogger } from "../src/runtime/logger.js";
import { createMigratedTestDatabase } from "./helpers.js";

describe("plugins", () => {
  it("CLI send appends a local user message routed to supervisor", () => {
    const db = createMigratedTestDatabase("pcs-plugin-cli-");

    try {
      const result = appendCliUserMessage(db, {
        text: "Inspect project health",
      });

      expect(result.message.type).toBe("event.user.message_received");
      expect(result.deliveryGroupIds).toEqual(expect.arrayContaining([
        "projection_group",
        "supervisor_group",
      ]));
    } finally {
      db.close();
    }
  });

  it("scheduler emits monitor, cleanup, and handoff events", () => {
    const db = createMigratedTestDatabase("pcs-plugin-scheduler-");

    try {
      seedSystemScheduledJobs(db, {
        timezone: "UTC",
        handoffTime: "02:00",
        monitorIntervalMs: 60_000,
        cleanupIntervalMs: 60_000,
        now: new Date("2026-06-15T01:00:00.000Z"),
      });
      const results = runDueScheduledJobs({
        db,
        logger: createLogger({ level: "error" }),
      }, new Date("2026-06-15T03:00:00.000Z"));

      expect(results.map((result) => result.message.type)).toEqual(expect.arrayContaining([
        "event.monitor.tick",
        "event.cleanup.requested",
        "event.maintenance.handoff_required",
      ]));
      expect(results.flatMap((result) => result.deliveryGroupIds)).toEqual(expect.arrayContaining([
        "monitor_group",
        "cleanup_group",
        "maintenance_group",
      ]));
    } finally {
      db.close();
    }
  });

  it("scheduler advances cron jobs using the configured timezone", () => {
    const db = createMigratedTestDatabase("pcs-plugin-scheduler-cron-");

    try {
      db.prepare(`
        INSERT INTO scheduled_jobs (
          id, name, enabled, schedule_type, schedule_value, timezone,
          next_run_at, event_type, topic, payload_json, priority, created_at, updated_at
        ) VALUES (
          'job_drink_water', 'drink_water', 1, 'cron', '5 9,12,15,18,21 * * *', 'Asia/Shanghai',
          '2026-06-15T10:05:00.000Z', 'event.user.message_received', 'user',
          '{"channel":"schedule","text":"drink water"}', 300,
          '2026-06-15T00:00:00.000Z', '2026-06-15T00:00:00.000Z'
        )
      `).run();

      const results = runDueScheduledJobs({
        db,
        logger: createLogger({ level: "error" }),
      }, new Date("2026-06-15T10:05:00.000Z"));

      expect(results).toHaveLength(1);
      expect(results[0]?.message).toMatchObject({
        type: "event.user.message_received",
        source: "scheduler",
      });
      expect(results[0]?.message.payload).toMatchObject({
        channel: "schedule",
        text: "drink water",
        jobName: "drink_water",
        scheduledAt: "2026-06-15T10:05:00.000Z",
      });
      expect(db.prepare("SELECT next_run_at FROM scheduled_jobs WHERE id = 'job_drink_water'").get())
        .toMatchObject({ next_run_at: "2026-06-15T13:05:00.000Z" });
    } finally {
      db.close();
    }
  });

  it("scheduler reseeds system job next runs when timezone changes", () => {
    const db = createMigratedTestDatabase("pcs-plugin-scheduler-reseed-");

    try {
      seedSystemScheduledJobs(db, {
        timezone: "UTC",
        handoffTime: "02:00",
        monitorIntervalMs: 60_000,
        cleanupIntervalMs: 60_000,
        now: new Date("2026-06-15T01:00:00.000Z"),
      });
      seedSystemScheduledJobs(db, {
        timezone: "Asia/Shanghai",
        handoffTime: "02:00",
        monitorIntervalMs: 60_000,
        cleanupIntervalMs: 60_000,
        now: new Date("2026-06-15T01:00:00.000Z"),
      });

      expect(db.prepare(`
        SELECT timezone, next_run_at
        FROM scheduled_jobs
        WHERE name = 'system.maintenance.handoff_required'
      `).get()).toMatchObject({
        timezone: "Asia/Shanghai",
        next_run_at: "2026-06-15T18:00:00.000Z",
      });
    } finally {
      db.close();
    }
  });

  it("wechat sender turns outbound commands into sent events", async () => {
    const db = createMigratedTestDatabase("pcs-plugin-wechat-");
    const adapter = new FakeWechatAdapter();

    try {
      const command = appendHubMessage(db, {
        kind: "command",
        type: "command.message.send_wechat",
        source: "test",
        payload: {
          text: "hello",
          target: "test-user",
        },
      });

      const result = await runConsumerOnce(db, {
        groupId: "wechat_sender_group",
        handler: createWechatSenderHandler({
          db,
          adapter,
          allowedTargetIds: ["test-user"],
        }),
        leaseMs: 60_000,
        maxAttempts: 3,
        workerId: "wechat-test",
      });

      expect(result).toEqual({ claimed: 1, acked: 1, failed: 0 });
      expect(adapter.sent).toHaveLength(1);
      expect(db.prepare("SELECT type, causation_id FROM event_log WHERE type = 'event.message.sent'").get())
        .toMatchObject({
          type: "event.message.sent",
          causation_id: command.message.id,
        });
    } finally {
      db.close();
    }
  });

  it("wechat ingress routes only authorized owner messages to supervisor", () => {
    const db = createMigratedTestDatabase("pcs-plugin-wechat-ingress-");

    try {
      const result = appendWechatInboundMessage({
        db,
        ownerUserIds: ["owner-test"],
      }, {
        externalMessageId: "wx-msg-1",
        senderId: "owner-test",
        conversationId: "",
        text: "run project health check",
        contextToken: "context-token-test",
      });

      expect(result.message.type).toBe("event.wechat.message_received");
      expect(result.deliveryGroupIds).toEqual(expect.arrayContaining([
        "projection_group",
        "supervisor_group",
      ]));
      expect(result.message.payload).toMatchObject({
        conversationId: "owner-test",
        senderId: "owner-test",
        text: "run project health check",
      });
      expect(result.message.payload).not.toHaveProperty("contextToken");
      expect(getWechatConversationState(db, "owner-test")).toMatchObject({
        conversation_id: "owner-test",
        sender_id: "owner-test",
        authorized: 1,
        context_token: "context-token-test",
        last_inbound_message_id: result.message.id,
      });
    } finally {
      db.close();
    }
  });

  it("wechat ingress rejects non-owner messages before supervisor delivery", () => {
    const db = createMigratedTestDatabase("pcs-plugin-wechat-reject-");

    try {
      const result = appendWechatInboundMessage({
        db,
        ownerUserIds: ["owner-test"],
      }, {
        externalMessageId: "wx-msg-2",
        senderId: "other-user",
        text: "please run something",
      });

      expect(result.message.type).toBe("event.wechat.message_rejected");
      expect(result.deliveryGroupIds).toEqual(["projection_group"]);
      expect(result.message.payload).toMatchObject({
        reason: "unauthorized_sender",
        externalMessageId: "wx-msg-2",
        textLength: "please run something".length,
      });
      expect(result.message.payload).toHaveProperty("senderHash");
      expect(result.message.payload).not.toHaveProperty("senderId");
      expect(getWechatConversationState(db, "other-user")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("wechat sender refuses targets outside the owner allowlist", async () => {
    const db = createMigratedTestDatabase("pcs-plugin-wechat-target-auth-");
    const adapter = new FakeWechatAdapter();

    try {
      appendHubMessage(db, {
        kind: "command",
        type: "command.message.send_wechat",
        source: "test",
        payload: {
          text: "hello",
          target: "other-user",
        },
      });

      const result = await runConsumerOnce(db, {
        groupId: "wechat_sender_group",
        handler: createWechatSenderHandler({
          db,
          adapter,
          allowedTargetIds: ["owner-test"],
        }),
        leaseMs: 60_000,
        maxAttempts: 3,
        workerId: "wechat-test",
      });

      expect(result).toEqual({ claimed: 1, acked: 1, failed: 0 });
      expect(adapter.sent).toHaveLength(0);
      expect(db.prepare("SELECT type, payload_json FROM event_log WHERE type = 'event.message.send_failed'").get())
        .toMatchObject({
          type: "event.message.send_failed",
        });
    } finally {
      db.close();
    }
  });

  it("clawbot login stores account status without external packages", async () => {
    const stateDir = mkTempStateDir("pcs-clawbot-login-");

    const result = await loginClawbot({
      stateDir,
      log: () => {},
      fetchImpl: createFakeLoginFetch(),
    });

    expect(result.account).toMatchObject({
      accountId: "bot-test",
      baseUrl: "https://weixin.test",
      configured: true,
      userId: "owner-test",
    });
    expect(result.ownerUserId).toBe("owner-test");
  });

  it("clawbot receiver turns polled messages into authorized Event Hub events", async () => {
    const db = createMigratedTestDatabase("pcs-clawbot-receiver-");
    const stateDir = mkTempStateDir("pcs-clawbot-receiver-state-");
    await loginClawbot({
      stateDir,
      log: () => {},
      fetchImpl: createFakeLoginFetch(),
    });

    const controller = new AbortController();
    const client = new FakeClawbotClient(() => controller.abort());
    const adapter = new ClawbotWechatAdapter({
      db,
      client,
      defaultTargetId: "owner-test",
    });

    try {
      const component = createClawbotReceiverComponent({
        db,
        stateDir,
        ownerUserIds: ["owner-test"],
        adapter,
        client,
        logger: createLogger({ level: "error" }),
      });

      await component.start(controller.signal);

      expect(db.prepare("SELECT type FROM event_log WHERE type = 'event.wechat.message_received'").get())
        .toMatchObject({ type: "event.wechat.message_received" });
      expect(getWechatConversationState(db, "owner-test")).toMatchObject({
        context_token: "context-token-test",
      });
    } finally {
      db.close();
    }
  });

  it("clawbot adapter sends text with the stored context token", async () => {
    const db = createMigratedTestDatabase("pcs-clawbot-send-");
    const client = new FakeClawbotClient();
    const adapter = new ClawbotWechatAdapter({
      db,
      client,
      defaultTargetId: "owner-test",
    });
    adapter.setAccount({
      accountId: "bot-test",
      baseUrl: "https://weixin.test",
      token: "token-test",
      userId: "owner-test",
    });

    try {
      appendWechatInboundMessage({
        db,
        ownerUserIds: ["owner-test"],
      }, {
        externalMessageId: "wx-context-source",
        senderId: "owner-test",
        text: "hi",
        contextToken: "context-token-test",
      });

      const result = await adapter.sendMessage({
        text: "hello",
        commandMessageId: "cmd-test",
      });

      expect(result.externalMessageId).toBe("sent-test");
      expect(client.sent).toEqual([{
        accountId: "bot-test",
        toUserId: "owner-test",
        contextToken: "context-token-test",
        text: "hello",
      }]);
    } finally {
      db.close();
    }
  });
});

class FakeWechatAdapter implements WechatAdapter {
  readonly sent: WechatSendMessageInput[] = [];

  async sendMessage(input: WechatSendMessageInput) {
    this.sent.push(input);
    return { externalMessageId: "external_test_message" };
  }
}

class FakeClawbotClient implements ClawbotClient {
  readonly sent: Array<{
    accountId: string;
    toUserId: string;
    contextToken: string;
    text: string;
  }> = [];
  private getUpdatesCalls = 0;

  constructor(private readonly afterFirstGetUpdates?: () => void) {}

  async getUpdates() {
    this.getUpdatesCalls += 1;
    if (this.getUpdatesCalls === 1) {
      this.afterFirstGetUpdates?.();
      return {
        ret: 0,
        get_updates_buf: "sync-buf-test",
        msgs: [{
          message_id: 123,
          from_user_id: "owner-test",
          create_time_ms: Date.parse("2026-06-15T01:00:00.000Z"),
          context_token: "context-token-test",
          item_list: [{
            type: 1,
            text_item: {
              text: "hello from wechat",
            },
          }],
        }],
      };
    }
    return {
      ret: 0,
      get_updates_buf: "sync-buf-test",
      msgs: [],
    };
  }

  async sendTextMessage(input: {
    account: ClawbotAccount;
    toUserId: string;
    contextToken: string;
    text: string;
  }) {
    this.sent.push({
      accountId: input.account.accountId,
      toUserId: input.toUserId,
      contextToken: input.contextToken,
      text: input.text,
    });
    return { messageId: "sent-test" };
  }
}

function createFakeLoginFetch(): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("get_bot_qrcode")) {
      return new Response(JSON.stringify({
        qrcode: "qr-test",
        qrcode_img_content: "https://weixin.test/qr",
      }), { status: 200 });
    }
    if (url.includes("get_qrcode_status")) {
      return new Response(JSON.stringify({
        status: "confirmed",
        bot_token: "token-test",
        ilink_bot_id: "bot@test",
        baseurl: "https://weixin.test",
        ilink_user_id: "owner-test",
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

function mkTempStateDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
