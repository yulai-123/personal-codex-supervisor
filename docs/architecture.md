# 架构设计

## 总览

```text
外部入口
  微信
  定时器
  本机事件

事件层
  Inbox
  Priority Queue
  Task Event Bridge

第一层
  Supervisor Codex Session

第二层
  Task Orchestrator
  Task Workers

持久化
  SQLite WAL
  Codex sessions
  Artifacts
  Logs
```

## 第一层：主节点 Supervisor

主节点是一个长期 Codex session，映射为：

```text
wechat_main -> codex_thread_id
```

它负责：

- 理解用户微信消息。
- 管理活跃任务。
- 判断是否启动第二层任务。
- 判断任务结果是否需要通知用户。
- 统一生成对用户可见的普通业务消息。
- 定期生成 handoff summary，开启新 session。

它不应该负责：

- 长时间跑命令。
- 大量读取/分析项目。
- 长时间轮询。
- 并发处理多个事件。

## 第二层：任务节点

任务节点是可持久化的后台执行单元。

任务来源：

- 定时任务触发。
- 主节点手动派生。
- 用户显式手动触发。
- 系统维护任务。

任务节点可以拥有自己的 Codex run/session，也可以是简单脚本。任务完成后不直接把自然语言结果塞给用户，而是写入结构化 `task_event`。

## 事件层

所有入口先写事件。

```text
wechat_message
timer_due
task_completed
task_failed
system_alert
maintenance_due
```

事件层负责：

- 去重。
- 幂等。
- 排队。
- 优先级。
- 合并低价值事件。
- 给主节点提供短状态面板。

## 数据流

### 微信消息

```text
微信消息
  -> inbox event
  -> supervisor_queue P0
  -> resume wechat_main Codex session
  -> 主节点回复或启动任务
  -> outbox
  -> 微信
```

### 定时任务

```text
timer_due
  -> task_orchestrator
  -> task_worker
  -> task_event
  -> supervisor_queue, if important
  -> 主节点决定是否发微信
```

### 手动复杂任务

```text
用户微信消息
  -> 主节点判断复杂
  -> start_task
  -> task_worker
  -> task_event
  -> 主节点解释结果
  -> 微信
```

## 持久化表草案

```text
events
sessions
supervisor_runs
tasks
task_runs
task_events
outbox
context_tokens
artifacts
settings
```

## 实现边界

第一阶段不做复杂分布式系统。SQLite + 单进程 daemon + launchd 足够。

