import { appendHubMessage } from "../../kernel/event-hub/append.js";
import type { EventHubNotifier } from "../../kernel/event-hub/notifier.js";
import type { ConsumerHandler } from "../../kernel/event-hub/types.js";
import { isRecord } from "../../shared/json.js";
import type { AppDatabase } from "../../storage/sqlite.js";
import { isAuthorizedWechatId } from "./auth.js";
import type { WechatAdapter } from "./adapter.js";

export type WechatSenderOptions = {
  db: AppDatabase;
  adapter: WechatAdapter;
  notifier?: EventHubNotifier;
  allowedTargetIds?: readonly string[];
};

export function createWechatSenderHandler(options: WechatSenderOptions): ConsumerHandler {
  return async ({ message }) => {
    const payload = isRecord(message.payload) ? message.payload : {};
    const text = typeof payload.text === "string" ? payload.text : "";
    const target = typeof payload.target === "string" ? payload.target : undefined;

    if (!text.trim()) {
      appendHubMessagePayload(options, message, "event.message.send_failed", {
        commandMessageId: message.id,
        error: "message text is empty",
      });
      return;
    }

    if (target && !isAuthorizedWechatId({ ownerUserIds: options.allowedTargetIds ?? [] }, target)) {
      appendHubMessagePayload(options, message, "event.message.send_failed", {
        commandMessageId: message.id,
        error: "wechat target is not authorized",
      });
      return;
    }

    try {
      const result = await options.adapter.sendMessage({
        text,
        ...(target ? { target } : {}),
        commandMessageId: message.id,
      });
      appendHubMessagePayload(options, message, "event.message.sent", {
        commandMessageId: message.id,
        externalMessageId: result.externalMessageId,
      });
    } catch (error) {
      appendHubMessagePayload(options, message, "event.message.send_failed", {
        commandMessageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

function appendHubMessagePayload(
  options: WechatSenderOptions,
  message: Parameters<ConsumerHandler>[0]["message"],
  type: string,
  payload: Record<string, unknown>,
): void {
  appendHubMessage(options.db, {
    kind: "event",
    type,
    source: "wechat.sender",
    correlationId: message.correlationId,
    causationId: message.id,
    payload,
  }, { ...(options.notifier ? { notifier: options.notifier } : {}) });
}
