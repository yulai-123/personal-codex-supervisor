# Personal Codex Supervisor

一个个人优先的 Codex 助手架构实验。

这个仓库目前只沉淀产品方向、架构结论、隐私边界和后续实现约束，不包含可运行代码。它的目标不是做一个通用的 OpenClaw / happyclaw 替代品，而是探索一种更小、更可靠、更适合个人长期使用的助手服务。

## 核心想法

个人助手不应该只是“微信机器人 + 定时任务”。更合理的模型是：

```text
微信 / 定时器 / 本机事件
  -> 事件层
  -> 主节点 Supervisor
  -> 第二层任务节点 Task Workers
  -> 任务结果事件
  -> 主节点判断是否通知用户、是否继续动作
```

主节点负责理解用户、维护对话连续性、编排任务、决定是否通知用户。第二层任务节点负责真正执行复杂工作、定时任务、文件/代码/系统操作，并把结构化结果反馈给主节点。

## 设计原则

- 单用户优先，而不是多租户平台。
- 微信是第一入口，后续可以扩展飞书，但不让多入口增加核心复杂度。
- 底层优先复用本机 `~/.codex` 和 Codex CLI session。
- 主节点使用长期 Codex session，但定期通过 handoff summary 开启新 session，避免上下文无限增长。
- 主节点不并发执行，不抢占中断；事件按优先级排队，主节点 run-to-completion。
- 复杂执行进入第二层任务节点，任务可以并发，主节点只做编排和判断。
- 所有对用户可见的普通业务消息默认由主节点发出，系统级紧急告警可以绕过主节点直接发送。
- SQLite 作为本地状态真相，记录 events、sessions、tasks、task_runs、task_events、outbox。

## 当前状态

这是一个设计仓库，暂不实现服务代码。

已经沉淀的内容：

- [产品方向](docs/product-direction.md)
- [架构设计](docs/architecture.md)
- [架构图 HTML](docs/architecture-diagram.html)
- [主节点契约](docs/supervisor-contract.md)
- [任务事件契约](docs/task-event-contract.md)
- [队列和并发模型](docs/queue-and-concurrency.md)
- [隐私与开源边界](docs/privacy-and-open-source.md)
- [OpenClaw / happyclaw 参考结论](docs/references.md)

## 为什么不是直接使用 OpenClaw 或 happyclaw

OpenClaw 的 Gateway、Queue、Task Ledger、Agent Loop 设计很值得参考，但它面向更通用的平台场景，能力边界更大。happyclaw 提供了微信/飞书/定时任务/agent runner 等很多能力，但功能增长后复杂度和稳定性压力明显。

这个项目只保留个人助手真正需要的骨架：

```text
Gateway / Event Inbox
Priority Queue
Supervisor Codex Session
Task Ledger
Task Workers
Outbox
```

## 隐私声明

这个仓库不应该包含任何个人部署信息、微信凭据、Codex 登录态、消息记录、任务运行结果、机器路径、真实联系人、真实日程或私有 prompt。

开源仓库只放通用框架、协议、文档和未来可复用代码。个人实例配置必须放在本地 ignored 文件中。
