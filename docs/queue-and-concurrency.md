# 事件中枢与调度模型

## 基本原则

系统不再使用简单的单队列模型，而是使用 Event Hub Kernel：

```text
event_log
  -> router
  -> event_deliveries
  -> consumer groups
```

Event Hub 同时承载 command 和 event。command 表示希望系统做某事，event 表示某事已经发生。

## Consumer Group

建议的 consumer groups：

```text
supervisor_group
worker_group
wechat_sender_group
projection_group
maintenance_group
monitor_group
```

每个 group 都有独立的投递状态、ack、lease、retry 和 dead letter。一个消息可以投递给多个 group。例如任务完成事件可以同时投递给 `projection_group` 和 `supervisor_group`。

## 投递状态

```text
pending -> running -> acked
                 -> failed -> pending
                 -> dead_letter
```

核心字段：

```text
group_id
message_id
status
priority
available_at
lease_until
attempts
locked_by
last_error
```

消费者通过 `claimReadyDeliveries(group_id)` 原子领取消息，处理成功后 ack。处理失败后按 retry policy 重新变为 pending，多次失败后进入 dead letter。

## Notifier / WakeSignal

`WakeSignal` 是 Event Hub 内部的调度优化，不是业务通信通道。

```text
append message
  -> 写 event_log
  -> 写 event_deliveries
  -> commit
  -> wake affected consumer groups
```

消费者运行循环：

```text
while running:
  deliveries = claimReadyDeliveries(group)
  if deliveries is empty:
    wait notifier wake or timeout
  else:
    process deliveries
```

可靠性靠 SQLite；低延迟靠 wake；兜底靠 fallback scan。

## 优先级

建议优先级从高到低：

```text
P0 用户消息、critical system alert
P1 task.needs_decision、task.failed
P2 手动任务完成、用户正在追问的相关任务事件
P3 定时任务摘要、普通 notice
P4 session maintenance、cleanup
P5 debug / low value progress
```

高优先级消息不抢占已经运行中的 Supervisor turn。Supervisor 使用 run-to-completion，当前 turn 完成后再领取下一条最高优先级消息。

## 并发

```text
supervisor_group concurrency = 1
worker_group concurrency = configurable, default 5
wechat_sender_group concurrency = configurable
projection_group concurrency = 1 initially
```

Supervisor 代表长期连续判断，必须单飞执行。Worker Group 可以并发，因为每个 worker run 默认是独立 Codex session。

## 事件合并

不是所有任务事件都应该唤醒 Supervisor。

```text
task.progress_updated -> 默认只投影，不唤醒 Supervisor
task.completed + should_notify_user=no -> 只投影
task.completed + uncertain -> 可合并为摘要
task.failed / needs_decision -> 投递给 supervisor_group
用户正在追问相关任务 -> 立即投递给 supervisor_group
```

事件合并属于 routing / projection 策略，不应让 Worker 直接决定是否通知用户。

## 不做常规抢占

不做常规抢占式 interrupt。AI turn 已经产生的副作用难以回滚。

异常兜底可以包括：

```text
Supervisor turn 超时
Codex 进程无输出超时
daemon 收到关闭信号
系统资源不足
```

正常产品行为应该靠事件优先级、任务拆分和 Worker Group 并发解决。
