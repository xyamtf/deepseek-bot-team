---
name: dsh-bot
description: 把一支长期在线的多 Bot 团队装进 DeepSeek Harness（DSH）。当用户想在自己的 AI 助手里拥有一支「长期在线的 Bot 团队」——可创建角色化 Bot、私聊派活、拉群 @名字 接力、后台任务、长期记忆、定时任务、用量台账——就用这个 skill：安装 DSH 插件、配置模型、建 Bot、验收团队协作。
license: MIT
---

# Dsh bot：多 Bot 团队（DSH 插件 + 独立服务）

把 `minimax-bot 0.7.24`（MIT）的团队系统独立化移植，并做成 DeepSeek Harness 插件：
左侧栏一行入口，面板里是完整团队界面；每个 Bot 有自己的会话、头像、能力包与模型，
Bot 之间能派活与群聊接力，全部通过 21 个 MCP 工具暴露给 Agent。

## 什么时候用

- 用户说「我想要一个团队 / 一群助手 / 不同角色的 Bot 帮我分工」
- 用户想在一个 AI 客户端里长期养着多个助手，各自有记忆、能互相派活
- 用户已经有 DeepSeek Harness，希望团队就长在里面，而不是另开网页
- 用户想给自己的 AI 加「群聊式协作」：拉群、@某人、后台跑任务、定时提醒

## 安装（DSH）

1. 把本仓库放到本机任意目录。
2. DSH → **插件** → **添加插件** → 选择 `plugin/` 目录。
3. 插件会自动起停 `service/`（默认 `127.0.0.1:8790`），并把 21 个工具注册为 `mcp__bot-team__*`。
4. 需要覆盖模型设置时，编辑 `service/config.json`（从 `service/config.example.json` 复制），
   然后调用 `bot_team_restart` 或重启 DSH。

不装 DSH 也能独立用：`cd service && node bin/dsteam.mjs --port 8790`，打开 `http://127.0.0.1:8790/bot`。

## 使用

- 左下 **Dsh bot** → 面板即完整界面（Bot 列表 / 群聊 / 记忆 / 任务 / 用量 / 设置）。
- **新建 Bot**：名字、角色、指令、头像（默认小鲸鱼，12 种皮肤或上传图片）、
  **插件与能力**（团队协作 / 后台助手 / 长期记忆 / 定时任务 / 文件读写 / 命令行）、
  模型（DSH 模型库自动同步，或填自定义 Base URL + 模型名 + Key）。
- 直接和主 Bot 说人话：「建三个 Bot：产品经理、写手、审稿」「拉个群让它们讨论这个方案」
  「每天早上 9 点提醒我复盘」「记住我偏好简短回答」。
- 群聊里 Bot 用 `@名字` 接力；没有新内容回 `[PASS]` 会被跳过。

## 关键行为（排障时看这几条）

- 能力包没勾 = 工具**不在**目录里，也无法调用；提示词会写明「只加载了这些能力」。
- 任务状态机：`queued / running / waiting_for_tasks / waiting_for_user / paused / done / failed / cancelled / unknown`；
  **`unknown` 不等于失败，绝不自动重放**。
- 重试复用稳定 `request_id`；`auth / quota / context_too_long / blocked / invalid_request` 不自动重试。
- 用量只统计模型真正运行的时间；`aborted` 有字数与工具数但没有耗时。
- 群接力的点名规则：名字后面紧跟仍是名字的字符就不算点名（`@某人帮忙` 不点名），
  空格或标点才算（`@某人 帮忙`）。
- 服务只监听 `127.0.0.1`，无鉴权；`run_command` 限制在 Bot 工作目录内，不是安全沙箱。

## 目录

```
plugin/    DSH 插件（宿主半边 + 界面半边 + cordis.patch.yml）
service/   团队服务（Node，无构建）：engine / task-dispatcher / relay-guard / memory / mcp / store
            + miniapp/client Web UI + tests（433 个用例）
docs/      架构、移植差异说明、插件详情
```

## 验证

```bash
cd service/tests && npm install --no-audit --no-fund
node --test                                   # 433 个用例
node ../service/tests/_integration-smoke.mjs  # 端到端：真进程 + 脚本化模型后端
```

## 许可

MIT（衍生自 `minimax-bot 0.7.24`，Copyright (c) 2026 MiniMax，保留原许可声明）。
