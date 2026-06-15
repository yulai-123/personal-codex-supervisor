# launchd 部署说明

本项目可以作为本机 daemon 运行。launchd 配置必须使用本机私有路径，因此仓库只提供模板，不提交真实部署文件。

## 前置步骤

```bash
pnpm install
pnpm build
pnpm db:migrate
```

建议把个人配置放在 ignored 文件中：

```text
local-only/config.toml
```

不要把 Codex 登录态、微信凭据、代理配置、真实联系人或消息记录写入仓库。

## 模板

复制模板：

```bash
cp examples/com.personal-codex-supervisor.plist.example local-only/com.personal-codex-supervisor.plist
```

然后只在 `local-only/` 下替换占位符：

```text
/ABS/PATH/TO/NODE
/ABS/PATH/TO/REPO
/ABS/PATH/TO/REPO/local-only/config.toml
```

## 加载

```bash
cp local-only/com.personal-codex-supervisor.plist ~/Library/LaunchAgents/com.personal-codex-supervisor.plist
launchctl load ~/Library/LaunchAgents/com.personal-codex-supervisor.plist
launchctl start com.personal-codex-supervisor
```

## 停止和卸载

```bash
launchctl stop com.personal-codex-supervisor
launchctl unload ~/Library/LaunchAgents/com.personal-codex-supervisor.plist
```

## 日志

模板把 stdout/stderr 指向：

```text
/ABS/PATH/TO/REPO/local-only/logs/daemon.out.log
/ABS/PATH/TO/REPO/local-only/logs/daemon.err.log
```

`local-only/` 默认 ignored，不应提交。
