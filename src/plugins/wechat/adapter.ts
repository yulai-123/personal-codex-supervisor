import { createId } from "../../shared/ids.js";
import type { Logger } from "../../runtime/logger.js";

export type WechatSendMessageInput = {
  text: string;
  target?: string;
  commandMessageId: string;
};

export type WechatSendMessageResult = {
  externalMessageId: string;
};

export type WechatAdapter = {
  sendMessage(input: WechatSendMessageInput): Promise<WechatSendMessageResult>;
};

export class StdoutWechatAdapter implements WechatAdapter {
  constructor(private readonly logger: Logger) {}

  async sendMessage(input: WechatSendMessageInput): Promise<WechatSendMessageResult> {
    const externalMessageId = createId("wechat_stdout");
    this.logger.info("wechat stdout adapter send", {
      commandMessageId: input.commandMessageId,
      target: input.target ?? null,
      textLength: input.text.length,
      externalMessageId,
    });
    return { externalMessageId };
  }
}
