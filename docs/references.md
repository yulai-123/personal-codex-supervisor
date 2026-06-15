# 参考结论

## happyclaw

happyclaw 提供了很多值得参考的实现经验：

- 微信/飞书入口适配。
- 定时任务。
- GroupQueue。
- agent runner 子进程隔离。
- conversation agent。
- scheduled task 的 `group` / `isolated` 上下文模式。
- 通过虚拟 JID 隔离主会话、子会话、定时任务。

但它的能力增长后形成了很多并列功能，缺少一个足够清晰的“主节点 Supervisor + Worker Group”的统一抽象。

本项目不打算 fork happyclaw 做裁剪，而是吸收它的经验后重新收敛。

## OpenClaw

OpenClaw 的设计更体系化，值得借鉴：

- Gateway 汇聚入口。
- 每个 session 串行运行。
- lane-aware queue。
- steer / followup / collect / interrupt 队列模式。
- background tasks 作为 activity ledger。
- prompt 分层装配。
- sub-agent delegation guidance。

本项目会借鉴这些骨架思想，但不复制 OpenClaw 的通用平台复杂度。

## LangChain multi-agent patterns

LangChain 官方多 agent 文档将模式分为：

- Subagents
- Handoffs
- Skills
- Router
- Custom workflow

本项目更接近：

```text
Subagents + Router + Custom workflow
```

不太像 Handoffs。因为用户始终面对同一个微信主助手，第二层任务不直接和用户长期对话。
