# 架构设计

## 总览

本项目采用操作系统式运行时架构。外部输入和输出都只是插件，核心不是微信，也不是定时器，而是本地 Event Hub Kernel。

```text
外部设备插件
  -> Event Hub Kernel
  -> Supervisor / Worker Group / Sidecars
  -> Tool Syscalls
  -> Event Hub Kernel
  -> 外部设备插件或查询投影
```

更完整的技术方案见 [technical-design.md](technical-design.md)。

## 分层

### 外部设备层

外部设备层负责接入真实世界：

```text
输入设备：微信接收、CLI、定时器、本机事件、监控
输出设备：微信发送、系统通知、未来飞书或邮件
```

输入设备只写 event，不直接调用 Supervisor。输出设备只消费 command，不直接参与智能判断。

### 事件通信层

Event Hub Kernel 是模块间唯一可靠业务通信通道。它负责：

```text
append-only event log
command/event 分类
topic 路由
priority 调度
consumer group 投递
ack / lease / retry
dead letter
dedupe
correlation / causation
event replay
```

`command` 是希望系统做某事，`event` 是某事已经发生。

### 内核执行层

内核执行层包含：

```text
Supervisor Process
Worker Group
Sidecar Processes
Tool Syscalls
```

Supervisor 是长期 Codex session，负责理解用户、编排任务和统一对用户发言。Worker Group 消费任务 command，每个 worker run 默认使用新的 Codex session。Sidecars 负责 session maintenance、health monitor、cleanup 等旁载功能。

### 状态与存储层

SQLite WAL 是本地状态真相源。事件日志记录发生过什么，查询投影记录当前状态。

建议状态：

```text
event_log
event_deliveries
consumer_groups
dead_letters
projection_offsets
tasks
task_runs
sessions
artifacts
```

建议投影：

```text
tasks_current_state
task_runs_current_state
sessions_current_state
outbox_current_state
recent_task_events
system_health_current_state
```

## 主节点 Supervisor

Supervisor 是长期 Codex session，逻辑身份稳定：

```text
wechat_main -> current_supervisor_session_id
```

底层 session 可以更换。每天凌晨 02:00 或达到阈值后，session maintenance 可以生成 handoff summary，创建新 session，并更新 current 指针。

Supervisor 消费高价值事件：

```text
event.wechat.message_received
event.task.completed
event.task.failed
event.task.needs_decision
event.system.alert
event.maintenance.handoff_required
```

Supervisor 通过工具调用系统能力。读工具查 projection，写工具向 Event Hub 追加 command。

## Worker Group

Worker Group 消费：

```text
command.task.start
command.task.continue
command.task.cancel
```

每个 worker run 默认创建新的 Codex session，并保存 `worker_session_id`，方便主节点后续查询、追溯或继续。

Worker 不直接通知用户。它只输出结构化任务事件，例如：

```text
event.task.completed
event.task.failed
event.task.needs_decision
event.task.progress_updated
```

## Tool Syscalls

工具是 Codex agent 调用运行时能力的入口。

```text
读工具：同步查询 projection，不进入 Event Hub
写工具：追加 command 或 event 到 Event Hub
```

例如：

```text
task.get_status -> 读 projection
task.start -> command.task.start
message.send_wechat -> command.message.send_wechat
task_event.emit -> event.task.completed / failed / needs_decision
```

## 实现边界

第一版实现仍然是本地单进程 daemon + SQLite WAL + launchd。架构上保留 consumer group、lease、ack、retry 和 projection，但不引入分布式消息队列。
