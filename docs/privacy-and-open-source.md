# 隐私与开源边界

这个项目可以开源，但必须把“通用产品代码”和“个人实例数据”分开。

## 可以开源

- 架构文档。
- 通用代码。
- SQLite schema。
- 任务事件协议。
- 示例配置模板。
- 示例 prompt。
- 本地运行说明。
- 测试用假数据。

## 不应该开源

- 微信 token、context token、登录态。
- Codex `~/.codex/auth.json`。
- 真实聊天记录。
- 真实定时任务内容。
- 真实任务运行日志。
- 真实文件路径、项目路径、联系人、日程。
- 个人长期记忆。
- 私人 prompt。
- Mac mini 的公网地址、Tailscale 名称、SSH 信息。

## 推荐目录边界

```text
repo/
  src/
  docs/
  examples/
  config.example.toml

local-only/
  config.toml
  secrets.toml
  state/
  logs/
  artifacts/
```

`local-only/` 不应该进入 git。

## .gitignore 必须覆盖

```text
.env
.env.*
config.local.*
secrets.*
state/
data/
logs/
artifacts/
*.sqlite
*.sqlite-shm
*.sqlite-wal
auth.json
context_tokens.json
```

## 开源定位

这个项目可以是“个人助手架构参考实现”，而不是“开箱即用的通用 SaaS”。

README 中应该明确：

- 这是 personal-first 项目。
- 默认单用户。
- 默认本地运行。
- 默认用户自己承担执行权限风险。
- 微信接入可能依赖非稳定或第三方 API，需要用户自行确认合规性。

## 隐私策略建议

未来实现时，默认行为应该是：

- 不上传聊天记录。
- 不上传任务日志。
- 不内置遥测。
- 不把本地状态同步到远程。
- 示例数据必须是伪造数据。
- 发布 issue 时提供脱敏模板。

