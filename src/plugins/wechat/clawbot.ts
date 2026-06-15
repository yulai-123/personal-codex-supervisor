import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendHubMessage } from "../../kernel/event-hub/append.js";
import type { EventHubNotifier } from "../../kernel/event-hub/notifier.js";
import type { RuntimeComponent } from "../../runtime/component.js";
import type { Logger } from "../../runtime/logger.js";
import { sleep } from "../../runtime/sleep.js";
import { createId } from "../../shared/ids.js";
import { nowIso } from "../../shared/time.js";
import type { AppDatabase } from "../../storage/sqlite.js";
import type { WechatAdapter, WechatSendMessageInput, WechatSendMessageResult } from "./adapter.js";
import { redactWechatId } from "./auth.js";
import { appendWechatInboundMessage, getWechatConversationState } from "./ingress.js";

const FIXED_LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_CLAW_BOT_TYPE = "3";
const DEFAULT_API_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_LOGIN_TIMEOUT_MS = 8 * 60_000;
const QR_STATUS_TIMEOUT_MS = 35_000;
const QR_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const SESSION_EXPIRED_ERRCODE = -14;

const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

const MessageType = {
  BOT: 2,
} as const;

const MessageState = {
  FINISH: 2,
} as const;

export type ClawbotAccount = {
  accountId: string;
  baseUrl: string;
  token?: string;
  userId?: string;
  savedAt?: string;
};

export type ClawbotAccountStatus = {
  accountId: string;
  baseUrl: string;
  configured: boolean;
  userId?: string;
  savedAt?: string;
};

export type ClawbotLoginResult = {
  account: ClawbotAccountStatus;
  ownerUserId?: string;
};

export type ClawbotClient = {
  getUpdates(input: {
    account: ClawbotAccount;
    getUpdatesBuf: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<GetUpdatesResp>;
  sendTextMessage(input: {
    account: ClawbotAccount;
    toUserId: string;
    contextToken: string;
    text: string;
  }): Promise<{ messageId: string }>;
};

export type ClawbotFetch = typeof fetch;

export class HttpClawbotClient implements ClawbotClient {
  constructor(private readonly fetchImpl: ClawbotFetch = fetch) {}

  async getUpdates(input: {
    account: ClawbotAccount;
    getUpdatesBuf: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<GetUpdatesResp> {
    try {
      const raw = await apiPost({
        fetchImpl: this.fetchImpl,
        baseUrl: input.account.baseUrl,
        endpoint: "ilink/bot/getupdates",
        timeoutMs: input.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
        body: {
          get_updates_buf: input.getUpdatesBuf,
          base_info: buildBaseInfo(),
        },
        ...(input.account.token ? { token: input.account.token } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return parseJson<GetUpdatesResp>(raw);
    } catch (error) {
      if (isAbortError(error) && !input.signal?.aborted) {
        return { ret: 0, msgs: [], get_updates_buf: input.getUpdatesBuf };
      }
      throw error;
    }
  }

  async sendTextMessage(input: {
    account: ClawbotAccount;
    toUserId: string;
    contextToken: string;
    text: string;
  }): Promise<{ messageId: string }> {
    if (!input.contextToken) {
      throw new Error("wechat context token is required");
    }

    const messageId = createId("wechat_clawbot");
    await apiPost({
      fetchImpl: this.fetchImpl,
      baseUrl: input.account.baseUrl,
      endpoint: "ilink/bot/sendmessage",
      timeoutMs: DEFAULT_API_TIMEOUT_MS,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: input.toUserId,
          client_id: messageId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{
            type: MessageItemType.TEXT,
            text_item: {
              text: markdownToPlainText(input.text),
            },
          }],
          context_token: input.contextToken,
        },
        base_info: buildBaseInfo(),
      },
      ...(input.account.token ? { token: input.account.token } : {}),
    });

    return { messageId };
  }
}

export type ClawbotWechatAdapterOptions = {
  db: AppDatabase;
  client: ClawbotClient;
  defaultTargetId?: string;
  logger?: Logger;
};

export class ClawbotWechatAdapter implements WechatAdapter {
  private account: ClawbotAccount | null = null;

  constructor(private readonly options: ClawbotWechatAdapterOptions) {}

  setAccount(account: ClawbotAccount): void {
    this.account = account;
  }

  clearAccount(): void {
    this.account = null;
  }

  async sendMessage(input: WechatSendMessageInput): Promise<WechatSendMessageResult> {
    const account = this.account;
    if (!account) {
      throw new Error("wechat clawbot account is not ready");
    }

    const target = input.target ?? account.userId ?? this.options.defaultTargetId;
    if (!target) {
      throw new Error("wechat target is not configured");
    }

    const conversation = getWechatConversationState(this.options.db, target);
    if (!conversation?.context_token) {
      throw new Error("wechat context token is missing; send a WeChat message to the bot first");
    }

    const result = await this.options.client.sendTextMessage({
      account,
      toUserId: target,
      contextToken: conversation.context_token,
      text: input.text,
    });
    this.options.logger?.info("wechat clawbot message sent", {
      commandMessageId: input.commandMessageId,
      externalMessageId: result.messageId,
      targetHash: redactWechatId(target).hash,
    });
    return { externalMessageId: result.messageId };
  }
}

export type ClawbotReceiverOptions = {
  db: AppDatabase;
  stateDir: string;
  ownerUserIds: readonly string[];
  accountId?: string;
  adapter: ClawbotWechatAdapter;
  client?: ClawbotClient;
  notifier?: EventHubNotifier;
  logger: Logger;
  longPollTimeoutMs?: number;
};

export function createClawbotReceiverComponent(options: ClawbotReceiverOptions): RuntimeComponent {
  return {
    name: "wechat_clawbot_receiver",
    async start(signal) {
      const client = options.client ?? new HttpClawbotClient();
      const account = resolveClawbotAccount(options.stateDir, options.accountId);
      options.adapter.setAccount(account);
      options.logger.info("wechat clawbot receiver starting", {
        accountId: account.accountId,
        userHash: account.userId ? redactWechatId(account.userId).hash : null,
      });

      try {
        await runClawbotPollLoop({
          ...options,
          client,
          account,
          signal,
        });
      } finally {
        options.adapter.clearAccount();
      }
    },
  };
}

export async function loginClawbot(options: {
  stateDir: string;
  log?: (line: string) => void;
  timeoutMs?: number;
  fetchImpl?: ClawbotFetch;
}): Promise<ClawbotLoginResult> {
  const log = options.log ?? console.log;
  const fetchImpl = options.fetchImpl ?? fetch;
  const qrcode = await fetchQrCode(fetchImpl);
  log("使用微信扫描以下链接完成 ClawBot 连接：");
  log(qrcode.qrcodeUrl);
  log("等待扫码确认...");

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
  let scannedLogged = false;
  let statusBaseUrl = FIXED_LOGIN_BASE_URL;

  while (Date.now() < deadline) {
    const status = await pollQrStatus(fetchImpl, statusBaseUrl, qrcode.qrcode);
    if (status.status === "scaned" && !scannedLogged) {
      scannedLogged = true;
      log("已扫码，请在微信中确认。");
    }

    if (status.status === "scaned_but_redirect" && status.redirect_host) {
      statusBaseUrl = `https://${status.redirect_host}`;
    }

    if (status.status === "expired") {
      throw new Error("微信登录二维码已过期，请重新运行 wechat login");
    }

    if (status.status === "confirmed") {
      if (!status.ilink_bot_id || !status.bot_token || !status.ilink_user_id) {
        throw new Error("微信登录成功但缺少必要账号信息");
      }
      const account = saveClawbotAccount(options.stateDir, {
        accountId: normalizeAccountId(status.ilink_bot_id),
        token: status.bot_token,
        baseUrl: status.baseurl || DEFAULT_API_BASE_URL,
        userId: status.ilink_user_id,
        savedAt: nowIso(),
      });
      return {
        account: toAccountStatus(account),
        ...(account.userId ? { ownerUserId: account.userId } : {}),
      };
    }
  }

  throw new Error("微信登录等待超时");
}

export function logoutClawbot(stateDir: string): void {
  const dir = resolveClawbotStateDir(stateDir);
  rmSync(dir, { recursive: true, force: true });
}

export function listClawbotAccountStatus(stateDir: string): ClawbotAccountStatus[] {
  return listClawbotAccounts(stateDir).map(toAccountStatus);
}

export function isClawbotLoggedIn(stateDir: string): boolean {
  return listClawbotAccounts(stateDir).some((account) => Boolean(account.token));
}

async function runClawbotPollLoop(options: ClawbotReceiverOptions & {
  client: ClawbotClient;
  account: ClawbotAccount;
  signal: AbortSignal;
}): Promise<void> {
  let getUpdatesBuf = loadSyncBuf(options.stateDir, options.account.accountId);
  let consecutiveFailures = 0;
  let nextTimeoutMs = options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;

  while (!options.signal.aborted) {
    try {
      const response = await options.client.getUpdates({
        account: options.account,
        getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        signal: options.signal,
      });

      if (typeof response.longpolling_timeout_ms === "number" && response.longpolling_timeout_ms > 0) {
        nextTimeoutMs = response.longpolling_timeout_ms;
      }

      if (isErrorResponse(response)) {
        if (response.errcode === SESSION_EXPIRED_ERRCODE || response.ret === SESSION_EXPIRED_ERRCODE) {
          appendWechatHealthEvent(options, "event.system.alert", {
            component: "wechat_clawbot",
            status: "failed",
            severity: "error",
            summary: "WeChat ClawBot session expired; run wechat login again.",
          });
          await sleep(60 * 60 * 1_000, options.signal);
          continue;
        }

        consecutiveFailures += 1;
        options.logger.warn("wechat clawbot getupdates failed", {
          ret: response.ret ?? null,
          errcode: response.errcode ?? null,
          errmsg: response.errmsg ?? "",
          consecutiveFailures,
        });
        await sleep(consecutiveFailures >= 3 ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, options.signal);
        if (consecutiveFailures >= 3) {
          consecutiveFailures = 0;
        }
        continue;
      }

      consecutiveFailures = 0;
      if (response.get_updates_buf) {
        getUpdatesBuf = response.get_updates_buf;
        saveSyncBuf(options.stateDir, options.account.accountId, getUpdatesBuf);
      }

      for (const message of response.msgs ?? []) {
        processClawbotInboundMessage(options, message);
      }
    } catch (error) {
      if (options.signal.aborted) {
        return;
      }
      consecutiveFailures += 1;
      options.logger.warn("wechat clawbot poll error", {
        error: error instanceof Error ? error.message : String(error),
        consecutiveFailures,
      });
      await sleep(consecutiveFailures >= 3 ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, options.signal);
      if (consecutiveFailures >= 3) {
        consecutiveFailures = 0;
      }
    }
  }
}

function processClawbotInboundMessage(
  options: ClawbotReceiverOptions & { account: ClawbotAccount },
  message: WeixinMessage,
): void {
  const senderId = message.from_user_id ?? "";
  const externalMessageId = getExternalMessageId(options.account.accountId, message);
  const text = bodyFromItemList(message.item_list);
  const createdAt = typeof message.create_time_ms === "number"
    ? new Date(message.create_time_ms).toISOString()
    : nowIso();

  const result = appendWechatInboundMessage({
    db: options.db,
    ownerUserIds: options.ownerUserIds,
    ...(options.notifier ? { notifier: options.notifier } : {}),
  }, {
    externalMessageId,
    senderId,
    conversationId: senderId,
    text,
    ...(message.context_token ? { contextToken: message.context_token } : {}),
    receivedAt: createdAt,
    dedupeKey: `wechat:clawbot:${options.account.accountId}:${externalMessageId}`,
  });

  options.logger.info("wechat clawbot inbound message", {
    eventType: result.message.type,
    duplicate: result.duplicate,
    senderHash: senderId ? redactWechatId(senderId).hash : null,
    textLength: text.length,
  });
}

function appendWechatHealthEvent(
  options: ClawbotReceiverOptions,
  type: "event.system.health" | "event.system.alert",
  payload: Record<string, unknown>,
): void {
  appendHubMessage(options.db, {
    kind: "event",
    type,
    source: "wechat.clawbot",
    payload,
  }, { ...(options.notifier ? { notifier: options.notifier } : {}) });
}

async function fetchQrCode(fetchImpl: ClawbotFetch): Promise<{ qrcode: string; qrcodeUrl: string }> {
  const raw = await apiGet({
    fetchImpl,
    baseUrl: FIXED_LOGIN_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(DEFAULT_CLAW_BOT_TYPE)}`,
    timeoutMs: QR_FETCH_TIMEOUT_MS,
  });
  const parsed = parseJson<{ qrcode?: string; qrcode_img_content?: string }>(raw);
  if (!parsed.qrcode || !parsed.qrcode_img_content) {
    throw new Error("微信登录二维码接口没有返回二维码");
  }
  return {
    qrcode: parsed.qrcode,
    qrcodeUrl: parsed.qrcode_img_content,
  };
}

async function pollQrStatus(
  fetchImpl: ClawbotFetch,
  baseUrl: string,
  qrcode: string,
): Promise<QrStatusResp> {
  try {
    const raw = await apiGet({
      fetchImpl,
      baseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs: QR_STATUS_TIMEOUT_MS,
    });
    return parseJson<QrStatusResp>(raw);
  } catch (error) {
    if (isAbortError(error)) {
      return { status: "wait" };
    }
    throw error;
  }
}

async function apiGet(input: {
  fetchImpl: ClawbotFetch;
  baseUrl: string;
  endpoint: string;
  timeoutMs: number;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const url = new URL(input.endpoint, ensureTrailingSlash(input.baseUrl));
    const response = await input.fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`wechat api get ${response.status}: ${raw}`);
    }
    return raw;
  } finally {
    clearTimeout(timer);
  }
}

async function apiPost(input: {
  fetchImpl: ClawbotFetch;
  baseUrl: string;
  endpoint: string;
  token?: string;
  timeoutMs: number;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<string> {
  const body = JSON.stringify(input.body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const url = new URL(input.endpoint, ensureTrailingSlash(input.baseUrl));
    const response = await input.fetchImpl(url, {
      method: "POST",
      headers: buildHeaders(input.token, body),
      body,
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`wechat api post ${response.status}: ${raw}`);
    }
    return raw;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

function buildHeaders(token: string | undefined, body: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64"),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function buildBaseInfo(): { channel_version: string } {
  return { channel_version: "personal-codex-supervisor" };
}

function resolveClawbotStateDir(stateDir: string): string {
  return stateDir || join(homedir(), ".personal-codex-supervisor", "wechat-clawbot");
}

function resolveAccountsIndexPath(stateDir: string): string {
  return join(resolveClawbotStateDir(stateDir), "accounts.json");
}

function resolveAccountsDir(stateDir: string): string {
  return join(resolveClawbotStateDir(stateDir), "accounts");
}

function resolveAccountPath(stateDir: string, accountId: string): string {
  return join(resolveAccountsDir(stateDir), `${normalizeAccountId(accountId)}.json`);
}

function resolveSyncBufPath(stateDir: string, accountId: string): string {
  return join(resolveClawbotStateDir(stateDir), "sync", `${normalizeAccountId(accountId)}.json`);
}

function listClawbotAccounts(stateDir: string): ClawbotAccount[] {
  const indexPath = resolveAccountsIndexPath(stateDir);
  if (!existsSync(indexPath)) {
    return [];
  }
  const parsed = parseJson<unknown>(readFileSync(indexPath, "utf8"));
  const ids = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  return ids.flatMap((id) => {
    const account = loadClawbotAccount(stateDir, id);
    return account ? [account] : [];
  });
}

function loadClawbotAccount(stateDir: string, accountId: string): ClawbotAccount | null {
  const filePath = resolveAccountPath(stateDir, accountId);
  if (!existsSync(filePath)) {
    return null;
  }
  const parsed = parseJson<Partial<ClawbotAccount>>(readFileSync(filePath, "utf8"));
  if (!parsed.accountId) {
    return null;
  }
  return {
    accountId: normalizeAccountId(parsed.accountId),
    baseUrl: parsed.baseUrl || DEFAULT_API_BASE_URL,
    ...(parsed.token ? { token: parsed.token } : {}),
    ...(parsed.userId ? { userId: parsed.userId } : {}),
    ...(parsed.savedAt ? { savedAt: parsed.savedAt } : {}),
  };
}

function saveClawbotAccount(stateDir: string, account: ClawbotAccount): ClawbotAccount {
  const normalized: ClawbotAccount = {
    ...account,
    accountId: normalizeAccountId(account.accountId),
    baseUrl: account.baseUrl || DEFAULT_API_BASE_URL,
  };
  mkdirSync(resolveAccountsDir(stateDir), { recursive: true });
  writeFileSync(resolveAccountPath(stateDir, normalized.accountId), JSON.stringify(normalized, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(resolveAccountsIndexPath(stateDir), JSON.stringify([normalized.accountId], null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return normalized;
}

function resolveClawbotAccount(stateDir: string, accountId?: string): ClawbotAccount {
  const account = accountId
    ? loadClawbotAccount(stateDir, accountId)
    : listClawbotAccounts(stateDir)[0] ?? null;
  if (!account?.token) {
    throw new Error("No configured WeChat ClawBot account. Run wechat login first.");
  }
  return account;
}

function loadSyncBuf(stateDir: string, accountId: string): string {
  const filePath = resolveSyncBufPath(stateDir, accountId);
  if (!existsSync(filePath)) {
    return "";
  }
  const parsed = parseJson<{ getUpdatesBuf?: string }>(readFileSync(filePath, "utf8"));
  return parsed.getUpdatesBuf ?? "";
}

function saveSyncBuf(stateDir: string, accountId: string, getUpdatesBuf: string): void {
  const filePath = resolveSyncBufPath(stateDir, accountId);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ getUpdatesBuf, updatedAt: nowIso() }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function normalizeAccountId(value: string): string {
  return value.trim().toLowerCase().replace(/[@.]/g, "-");
}

function toAccountStatus(account: ClawbotAccount): ClawbotAccountStatus {
  return {
    accountId: account.accountId,
    baseUrl: account.baseUrl,
    configured: Boolean(account.token),
    ...(account.userId ? { userId: account.userId } : {}),
    ...(account.savedAt ? { savedAt: account.savedAt } : {}),
  };
}

function getExternalMessageId(accountId: string, message: WeixinMessage): string {
  const id = message.message_id ?? message.client_id ?? message.seq;
  return id ? String(id) : createId(`wechat_${normalizeAccountId(accountId)}`);
}

function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) {
    return "";
  }
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) {
        return text;
      }
      const parts = [ref.title, ref.message_item ? bodyFromItemList([ref.message_item]) : undefined]
        .filter((part): part is string => Boolean(part));
      return parts.length > 0 ? `[引用: ${parts.join(" | ")}]\n${text}` : text;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

function markdownToPlainText(text: string): string {
  return text
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim())
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\|[\s:|-]+\|$/gm, "")
    .replace(/^\|(.+)\|$/gm, (_, inner: string) => inner.split("|").map((cell) => cell.trim()).join(" "))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isErrorResponse(response: GetUpdatesResp): boolean {
  return (response.ret !== undefined && response.ret !== 0)
    || (response.errcode !== undefined && response.errcode !== 0);
}

type QrStatusResp = {
  status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
};

type GetUpdatesResp = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
};

type WeixinMessage = {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  item_list?: MessageItem[];
  context_token?: string;
};

type MessageItem = {
  type?: number;
  text_item?: {
    text?: string;
  };
  voice_item?: {
    text?: string;
  };
  ref_msg?: {
    title?: string;
    message_item?: MessageItem;
  };
};
