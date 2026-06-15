# 微信接入方案

## 结论

`weixin-agent-sdk` 不是微信官方项目。它的 README 明确声明“非微信官方项目”，因此本项目不把它作为依赖，也不把它加入运行时依赖树。

当前实现保留 `WechatAdapter` 边界，并提供一个内置 `clawbot` bridge。它参考 OpenClaw / weixin-agent-sdk 的公开 ClawBot 流程，把微信作为外部设备接入 Event Hub。

```text
微信扫码登录
  -> 本地 ignored state
  -> ClawBot 长轮询
  -> owner allowlist
  -> Event Hub
```

## 当前内置方案：ClawBot bridge

当前仓库不引入 `openclaw-weixin` 或 `weixin-agent-sdk` 依赖，而是在 `src/plugins/wechat/clawbot.ts` 内实现最小可用 bridge：

```text
wechat login
  -> 获取二维码链接
  -> 轮询扫码状态
  -> 保存 accountId / bot token / owner user id 到 local-only/wechat-clawbot

daemon start + adapter="clawbot"
  -> 长轮询 ilink/bot/getupdates
  -> 保存 get_updates_buf
  -> 文本 / 语音转文字消息进入 event.wechat.message_received
  -> 保存 context_token 到 wechat_conversations

message.send_wechat
  -> command.message.send_wechat
  -> ClawBot sender 使用 context_token 调 ilink/bot/sendmessage
  -> event.message.sent / event.message.send_failed
```

当前支持：

```text
扫码登录
登录状态查看 / 退出登录
私聊文本入站
语音转文字入站
私聊文本出站
owner allowlist
context_token 回复
get_updates_buf 断点续拉
```

当前不支持：

```text
群聊
主动给任意联系人发消息
联系人列表
媒体下载 / 解密 / 上传
自研私有协议扩展
```

## 本地配置

真实配置只写 `local-only/config.toml`：

```toml
[plugins.wechat]
enabled = true
adapter = "clawbot"
owner_user_ids = ["<wechat owner user id from wechat status>"]
clawbot_state_dir = "local-only/wechat-clawbot"
```

登录命令：

```text
pnpm dev -- wechat login
pnpm dev -- wechat status
pnpm dev -- wechat logout
```

## 方案 B：微信官方接口

如果能接受产品形态变化，最稳的是使用官方接口：

```text
公众号消息接口
企业微信 / WeCom bot 或应用消息
```

优点：

```text
官方文档清晰
安全边界明确
更适合长期运行和公开项目
```

限制：

```text
不是个人微信私聊体验
主动消息、群聊、联系人能力受官方规则限制
```

## 不建议：私自解密或逆向协议

本项目不应实现以下内容：

```text
提取或硬编码微信密钥
绕过官方 SDK 或插件的媒体解密流程
逆向私有协议
把登录态、token、cookie、联系人或消息明文提交到仓库
```

如果 OpenClaw 微信插件或官方接口已经返回可用文本、媒体路径或解密后的文件，本项目可以消费这些结果；但不在本项目里复刻解密逻辑。

## 当前代码边界

当前仓库只提供：

```text
WechatAdapter interface
Wechat ingress allowlist
wechat_conversations runtime state
StdoutWechatAdapter
ClawbotWechatAdapter
Clawbot receiver component
WechatSender consumer
```

真实微信接入应作为 adapter 或独立 bridge 实现，并把所有私有配置放在 ignored 的 `local-only/` 或系统钥匙串中。

## Owner allowlist

微信接入默认只允许个人使用。真实 receiver 在把消息写入 Event Hub 前，必须调用 `appendWechatInboundMessage`，并传入本地配置中的 `plugins.wechat.owner_user_ids`。

行为：

```text
sender_id 在 owner_user_ids 中
  -> 写 event.wechat.message_received
  -> 投递 supervisor_group
  -> 更新 wechat_conversations 中的 context_token

sender_id 不在 owner_user_ids 中
  -> 写 event.wechat.message_rejected
  -> 只保留脱敏 senderHash / senderSuffix
  -> 不投递 supervisor_group
  -> 不保存会话 context_token
```

出站同样受限制：如果 `command.message.send_wechat` 指定了 `target`，`wechat.sender` 会校验它必须属于 `owner_user_ids`，否则写入 `event.message.send_failed`。

示例配置只保留空数组：

```toml
[plugins.wechat]
owner_user_ids = []
```

真实微信用户 ID 只能写入 ignored 的 `local-only/config.toml` 或外部 secret store，不能提交到仓库。
