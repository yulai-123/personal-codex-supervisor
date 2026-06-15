import { appendHubMessage, type AppendOptions } from "../../kernel/event-hub/append.js";
import type { AppendHubMessageResult } from "../../kernel/event-hub/types.js";
import { nowIso } from "../../shared/time.js";
import type { AppDatabase } from "../../storage/sqlite.js";
import { isAuthorizedWechatId, normalizeWechatId, redactWechatId } from "./auth.js";

export type WechatInboundMedia = {
  type: "image" | "audio" | "video" | "file";
  filePath: string;
  mimeType: string;
  fileName?: string;
};

export type WechatInboundMessageInput = {
  externalMessageId: string;
  senderId: string;
  conversationId?: string;
  text: string;
  contextToken?: string;
  receivedAt?: string;
  media?: WechatInboundMedia;
  dedupeKey?: string;
  priority?: number;
};

export type WechatIngressOptions = AppendOptions & {
  db: AppDatabase;
  ownerUserIds: readonly string[];
};

export function appendWechatInboundMessage(
  options: WechatIngressOptions,
  input: WechatInboundMessageInput,
): AppendHubMessageResult {
  const senderId = normalizeWechatId(input.senderId);
  const providedConversationId = input.conversationId ? normalizeWechatId(input.conversationId) : "";
  const conversationId = providedConversationId || senderId;
  const receivedAt = input.receivedAt ?? nowIso();
  const dedupeKey = input.dedupeKey ?? `wechat:inbound:${input.externalMessageId}`;

  if (!isAuthorizedWechatId({ ownerUserIds: options.ownerUserIds }, senderId)) {
    const redacted = redactWechatId(senderId);
    return appendHubMessage(options.db, {
      kind: "event",
      type: "event.wechat.message_rejected",
      source: "wechat.receiver",
      priority: input.priority ?? 100,
      dedupeKey,
      payload: {
        reason: "unauthorized_sender",
        externalMessageId: input.externalMessageId,
        senderHash: redacted.hash,
        ...(redacted.suffix ? { senderSuffix: redacted.suffix } : {}),
        textLength: input.text.length,
        hasMedia: Boolean(input.media),
        receivedAt,
      },
    }, appendOptions(options));
  }

  const result = appendHubMessage(options.db, {
    kind: "event",
    type: "event.wechat.message_received",
    source: "wechat.receiver",
    priority: input.priority ?? 100,
    dedupeKey,
    payload: {
      externalMessageId: input.externalMessageId,
      conversationId,
      senderId,
      text: input.text,
      receivedAt,
      ...(input.media ? { media: input.media } : {}),
    },
  }, appendOptions(options));

  upsertWechatConversation(options.db, {
    conversationId,
    senderId,
    ...(input.contextToken ? { contextToken: input.contextToken } : {}),
    lastInboundMessageId: result.message.id,
    lastInboundAt: receivedAt,
  });

  return result;
}

export type WechatConversationState = {
  conversation_id: string;
  sender_id: string;
  authorized: number;
  context_token: string | null;
  context_token_updated_at: string | null;
  last_inbound_message_id: string | null;
  last_inbound_at: string | null;
  created_at: string;
  updated_at: string;
};

export function getWechatConversationState(
  db: AppDatabase,
  conversationId: string,
): WechatConversationState | null {
  return db.prepare(`
    SELECT *
    FROM wechat_conversations
    WHERE conversation_id = ?
  `).get(conversationId) as WechatConversationState | undefined ?? null;
}

function upsertWechatConversation(
  db: AppDatabase,
  input: {
    conversationId: string;
    senderId: string;
    contextToken?: string;
    lastInboundMessageId: string;
    lastInboundAt: string;
  },
): void {
  const updatedAt = nowIso();
  db.prepare(`
    INSERT INTO wechat_conversations (
      conversation_id, sender_id, authorized, context_token, context_token_updated_at,
      last_inbound_message_id, last_inbound_at, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      sender_id = excluded.sender_id,
      authorized = 1,
      context_token = COALESCE(excluded.context_token, wechat_conversations.context_token),
      context_token_updated_at = CASE
        WHEN excluded.context_token IS NOT NULL THEN excluded.context_token_updated_at
        ELSE wechat_conversations.context_token_updated_at
      END,
      last_inbound_message_id = excluded.last_inbound_message_id,
      last_inbound_at = excluded.last_inbound_at,
      updated_at = excluded.updated_at
  `).run(
    input.conversationId,
    input.senderId,
    input.contextToken ?? null,
    input.contextToken ? updatedAt : null,
    input.lastInboundMessageId,
    input.lastInboundAt,
    updatedAt,
    updatedAt,
  );
}

function appendOptions(options: WechatIngressOptions): AppendOptions {
  return {
    ...(options.router ? { router: options.router } : {}),
    ...(options.notifier ? { notifier: options.notifier } : {}),
  };
}
