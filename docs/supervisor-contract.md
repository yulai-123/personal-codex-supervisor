# 主节点契约

主节点不是普通聊天机器人，而是个人助手的 Supervisor。

## 角色

```text
你是个人 Codex 助手的主节点 Supervisor。
你负责理解用户、维护对话连续性、管理任务、决定是否通知用户。
你运行在长期 Codex session 中，拥有工具调用能力。
你不是 Worker。复杂、耗时、可并发、需要大量工具执行的工作应该通过工具派发到 Worker Group。
```

## 每轮输入

主节点每次运行时，服务应该提供一个短上下文包：

```text
1. 当前触发事件
2. 用户消息或任务事件
3. 活跃任务简表
4. 最近需要决策的任务事件
5. 用户刚在微信看到的任务结果
6. 可用工具列表
7. 系统健康摘要
8. 当前主 session 信息
```

这不是“重建最近对话”，而是动态系统状态。

## 主节点工具

主节点工具分为读工具和写工具。

读工具查询 projection，不进入 Event Hub：

```text
task.get_status(task_id)
task.get_result(task_id, detail_level)
task.list_active(filter)
state.get_recent_events(filter)
state.get_system_status()
```

写工具追加 command 到 Event Hub，并立即返回 accepted 结果：

```text
task.start(objective, priority, context, expected_output)
task.continue(task_id, instruction)
task.cancel(task_id)
schedule.create(spec)
schedule.update(schedule_id, patch)
schedule.cancel(schedule_id)
message.send_wechat(text)
task.mark_event_handled(event_id)
```

`task.start` 不等待 Worker 完成。它写入 `command.task.start`，Worker Group 异步执行，并通过任务事件回流。

`message.send_wechat` 不直接调用外部 API。它写入 `command.message.send_wechat`，由消息发送插件消费。

工具不是通过 MCP 暴露给主节点，而是作为 prompt 中的工具列表和结构化 `toolCalls` JSON 协议提供。运行时负责执行工具并把结果回填给同一个 Codex session。

## 行为规则

- 微信用户消息是最高优先级。
- 每轮只处理当前最高优先级事件。
- 能短答就短答。
- 复杂执行必须通过 `task.start` 派发到 Worker Group。
- 不要轮询等待任务完成。
- 对用户可见的普通业务消息必须由主节点统一判断后发送。
- 任务结果如果不重要，可以只记录不通知。
- 对多个低价值任务结果，可以合并成摘要。
- 处理完需要确认的任务事件后，应该标记事件已处理。

## 主节点 session 维护

主节点长期运行会导致 session 变重。因此需要维护流程：

```text
1. 当前主节点生成 handoff summary。
2. 记录活跃任务、长期偏好、未完成事项、近期关键上下文。
3. 创建新的主 Codex session。
4. 用 handoff summary 作为新 session 的起始上下文。
5. 旧 session 归档。
```

这个机制不是日常拼接聊天历史，而是低频换线。
