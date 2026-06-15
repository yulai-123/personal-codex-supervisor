# 第三方参考说明

## WeChat ClawBot bridge

本项目的内置 `clawbot` bridge 没有引入 `openclaw-weixin` 或 `weixin-agent-sdk` 作为依赖。

实现参考了以下公开项目的 ClawBot 登录、长轮询、消息发送和 `context_token` 流程：

```text
Tencent/openclaw-weixin
wong2/weixin-agent-sdk
```

`weixin-agent-sdk` 使用 MIT License。若未来迁移更多与其高度相似的实现片段，应继续保留本说明，并在需要时补充更完整的 license notice。
