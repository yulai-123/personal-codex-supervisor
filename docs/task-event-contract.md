# 任务事件契约

Worker 不应该随便输出一大段自然语言给用户。它应该写入结构化任务事件，让 Supervisor 判断如何处理。

## Task Event Schema 草案

```json
{
  "event_id": "evt_...",
  "task_id": "task_...",
  "run_id": "run_...",
  "worker_session_id": "session_...",
  "status": "success",
  "severity": "info",
  "summary": "任务完成，未发现异常。",
  "details": "可选的详细说明。",
  "user_impact": "对用户是否有影响。",
  "recommended_action": "建议主节点怎么处理。",
  "should_notify_user": "no",
  "needs_supervisor_decision": false,
  "artifacts": [],
  "created_at": "2026-06-15T00:00:00+08:00"
}
```

## status

```text
success
warning
error
needs_decision
cancelled
timed_out
```

## severity

```text
debug
info
notice
warning
error
critical
```

## should_notify_user

```text
yes
no
uncertain
```

默认由主节点决定是否发微信。`yes` 也不代表任务直接发消息，而是代表它应该进入主节点高优先级队列。

在 Event Hub 中，任务事件会映射为：

```text
event.task.completed
event.task.failed
event.task.needs_decision
event.task.progress_updated
event.task.cancelled
event.task.timed_out
```

## delivery_mode

未来可以支持：

```text
supervisor
direct
silent
```

默认是 `supervisor`。

`direct` 只用于系统级紧急告警，例如主节点不可用、服务无法运行、发送凭证失效。

## 任务输出原则

- 给主节点的是结构化事实，不是面向用户的长篇回复。
- 任务可以建议通知，但不替主节点决定最终表达。
- 任务必须提供足够的可追溯信息：run id、日志、产物路径、失败原因。
- 任务不要轮询主节点。
- 任务不能直接发送微信或其它外部消息。
- 如果需要用户确认，输出 `needs_decision`，由主节点决定是否询问用户。
