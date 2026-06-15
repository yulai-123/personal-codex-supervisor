# Personal Codex Supervisor

一个个人优先的 Codex 助手运行时架构实验。

这个仓库目前沉淀产品方向、架构结论、技术方案、隐私边界和后续实现约束，并开始搭建 TypeScript 本地运行时骨架。它的目标不是做一个通用的 OpenClaw / happyclaw 替代品，而是探索一种更小、更可靠、更适合个人长期使用的助手运行时。

## 核心想法

个人助手不应该只是“微信机器人 + 定时任务”。更合理的模型是一个本地运行的 Personal Assistant Runtime：

```text
外部设备插件
  -> Event Hub Kernel
  -> Supervisor / Worker Group / Sidecars
  -> Tool Syscalls
  -> Event Hub Kernel
  -> 外部设备插件或查询投影
```

外部设备包括微信、定时器、CLI、本机事件和未来可能接入的飞书、邮件或系统通知。它们不是核心流程本身，而是插件。Event Hub Kernel 是模块间唯一的可靠业务通信通道。主节点 Supervisor 负责理解用户、维护对话连续性、编排任务、决定是否通知用户。Worker Group 负责执行复杂工作、定时任务、文件/代码/系统操作，并把结构化结果反馈到 Event Hub。

## 设计原则

- 单用户优先，而不是多租户平台。
- 微信是首个主要外部设备插件，后续可以扩展飞书等插件，但不让多入口增加核心复杂度。
- 底层优先复用本机 `~/.codex` 和 Codex CLI session。
- 主节点使用长期 Codex session，但定期通过 handoff summary 开启新 session，避免上下文无限增长。
- 主节点不并发执行，不抢占中断；它作为 `supervisor_group` 消费者 run-to-completion。
- 复杂执行进入 Worker Group，worker run 默认使用新的 Codex session，并保存 `worker_session_id` 方便追溯或继续。
- 所有跨模块副作用通过 Event Hub command 表达，例如启动任务、发送微信、创建定时任务。
- 所有对用户可见的普通业务消息默认由主节点决定，再通过消息发送插件执行；系统级紧急告警可以走旁路插件。
- SQLite 作为本地状态真相，记录 event log、deliveries、sessions、tasks、task_runs、task_events、projections、artifacts。

## 当前状态

这是一个早期项目。当前已经完成 TypeScript 本地运行时骨架、SQLite migration、Event Hub、query projections、Codex runner/session registry、内部工具注册表、Supervisor runner、Worker Group，以及可启动的本地 daemon 入口。微信等外部设备插件仍在后续实现。

已经沉淀的内容：

- [产品方向](docs/product-direction.md)
- [架构设计](docs/architecture.md)
- [技术方案](docs/technical-design.md)
- [主节点契约](docs/supervisor-contract.md)
- [任务事件契约](docs/task-event-contract.md)
- [事件中枢和调度模型](docs/queue-and-concurrency.md)
- [隐私与开源边界](docs/privacy-and-open-source.md)
- [OpenClaw / happyclaw 参考结论](docs/references.md)

## 为什么不是直接使用 OpenClaw 或 happyclaw

OpenClaw 的 Gateway、Queue、Task Ledger、Agent Loop 设计很值得参考，但它面向更通用的平台场景，能力边界更大。happyclaw 提供了微信/飞书/定时任务/agent runner 等很多能力，但功能增长后复杂度和稳定性压力明显。

这个项目只保留个人助手真正需要的运行时骨架：

```text
External Device Plugins
Event Hub Kernel
Supervisor Codex Session
Worker Group
Tool Syscalls
Query Projections
```

## 隐私声明

这个仓库不应该包含任何个人部署信息、微信凭据、Codex 登录态、消息记录、任务运行结果、机器路径、真实联系人、真实日程或私有 prompt。

开源仓库只放通用框架、协议、文档和未来可复用代码。个人实例配置必须放在本地 ignored 文件中。
