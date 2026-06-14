# 队列与并发模型

## 基本原则

主节点使用非抢占式调度。

```text
pending -> running -> done / failed / deferred
```

同一时间只允许一个主节点 turn 运行。

## 优先级

```text
P0 微信用户消息
P1 任务失败 / needs_decision / critical system alert
P2 手动任务完成
P3 定时任务批量摘要
P4 session maintenance
```

微信消息最高优先级，但不抢占当前运行中的主节点 turn。

## Lane

```text
supervisor_lane concurrency = 1
task_lane concurrency = 2 initially
system_alert direct path = limited
```

`task_lane` 的并发不应该一开始追求很高。实际瓶颈不是 CPU，而是：

- Codex 登录态和限流。
- 本机文件和 `~/.codex` 状态。
- 主节点处理任务结果的能力。
- 用户注意力。

## 事件合并

普通任务成功不应该每次唤醒主节点。

```text
success + should_notify_user=no -> 只记录
success + uncertain -> 合并到批量摘要
warning/error/needs_decision -> 进入主节点队列
用户正在追问相关任务 -> 立即带入下一轮主节点上下文
```

## 不做常规中断

不建议第一阶段实现抢占式 interrupt。AI turn 已经产生的副作用难以回滚。

如果未来需要，可以只作为异常兜底：

```text
主节点卡死
Codex 进程无输出超时
系统关闭
```

正常产品行为应该靠队列和任务拆分解决。

