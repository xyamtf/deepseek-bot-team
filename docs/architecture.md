# 架构说明：DeepSeek Bot Team（minimax-bot 独立化移植）

## 1. 一句话

把一个 AI 编程助手变成一支**长期在线的多 Bot 团队**：每个 Bot 有独立 Agent 会话、自己的记忆与模型设置，
Bot 之间可以私聊派活、拉群接力；所有能力通过 21 个 MCP 工具暴露给模型，并带一套原生 JS 的 Web UI。
本仓库是 `minimax-bot` 0.7.24（MIT）的移植版：**保留原服务端、页面与全部契约，把 MiniMax Code Host 的
Agent 桥接换成自研的 DeepSeek 运行时**，因此可以脱离 MiniMax Code 独立运行。

## 2. 进程与分层

```
┌──────────────────────────────────────────────────────────────────────┐
│ bin/dsteam.mjs             CLI：参数/配置文件/环境变量 → 启动 → 优雅退出  │
└───────────────┬──────────────────────────────────────────────────────┘
                │ startHost(config)
┌───────────────▼──────────────────────────────────────────────────────┐
│ miniapp/node/standalone-host.mjs                                     │
│   · 组装 MiniAppContext（pluginRoot / dataDir / listen / signal /     │
│     logger / agent），这是原 Host 注入的那份对象                        │
│   · logger → 控制台 + <dataDir>/logs/host.log (JSONL)，永不抛异常      │
│   · 生命周期：config.signal abort → dispose() → 关监听 → 关 agent      │
└───────────────┬──────────────────────────────────────────────────────┘
                │ server.start(context)
┌───────────────▼──────────────────────────────────────────────────────┐
│ miniapp/node/server.mjs    HTTP 服务（唯一入口，未改动行为）            │
│   · /bot                       Web UI（miniapp/client，无构建、原生 ESM）│
│   · /api/*                     REST：state/chats/messages/bots/groups/  │
│                               memory/usage/schedules/avatars/uploads/   │
│                               models/settings/events(SSE)               │
│   · /mcp/minimax-bot           Streamable HTTP MCP（同一进程）           │
│   · /api/media, /api/avatars   本会话引用过的本机文件、头像库            │
│   ├── engine.mjs               ★ 回合调度：重试、上下文装配、模型调用、   │
│   │                              用量台账、审批与问卷、群接力驱动         │
│   ├── team.mjs                 Bot / 群 / 管理员 / 权限 / 头像库         │
│   ├── store.mjs                JSON 持久化：原子写、分页、纪要、用量      │
│   ├── task-dispatcher.mjs      后台任务与批次：并发、幂等、状态机、回交    │
│   ├── mcp.mjs                  ★ 21 个 MCP 工具 schema + 处理函数        │
│   ├── relay-guard.mjs          点名规则、标记清洗、跳数上限、结论交接     │
│   ├── memory*.mjs / group-note.mjs / user-inbox.mjs / reactions.mjs     │
│   └── agent-runtime.mjs        ★ 自研 DeepSeek Agent 运行时（本移植新增） │
└──────────────────────────────────────────────────────────────────────┘
                │ agent.run / agent.reply / agent.answer / agent.models
                ▼
        OpenAI 兼容后端（默认 https://api.deepseek.com，POST /chat/completions，stream=true）
```

`engine.mjs` 是心脏，`mcp.mjs` 是对外接口，`store.mjs`/`team.mjs` 是数据层，`agent-runtime.mjs` 是模型侧。

## 3. 一个回合发生了什么

以「用户私聊 Bot」为例：

1. `POST /api/chats/bot:<id>/messages` → `engine.sendUserMessage` 落盘（含 `clientMessageId` 幂等）并广播 SSE。
2. 回合进入该聊天的串行队列（`user-inbox`），`engine.runBotTurn` 组装上下文：
   常驻简报（团队名单、群公告、Bot 角色与指令）+ 记忆简报（6000 字符预算）+ 用户输入。
3. `agent.run({ text, sessionId, model })` → `AgentRuntime`：
   - 请求 `POST {apiBase}/chat/completions`（`stream:true`，带 `tools`）；
   - SSE 解析 → 依次发 `turn.started / text.delta / message.committed / tool.* / turn.finished`；
   - 若模型要工具：MCP 工具名是 `mcp__minimax-bot__<tool>`，直接调用**同一份** `mcp.mjs` 处理函数
     （`attachTools({ toolDefs, call })`），结果作为 `tool` 消息回灌，进入下一轮，最多 `maxToolRounds` 轮；
   - 会话消息持久化到 `<dataDir>/agent-sessions/<sessionId>.json`（临时文件 + fsync + rename）。
4. `engine` 按事件写入消息分片、工具记录、审批、用量台账（只统计模型真正运行的时间）。
5. 群聊时 `engine.driveGroup` 按成员名单生成发言队列，`@名字` 优先；`relay-guard` 负责点名边界与协议标记清洗，
   达到跳数上限则由刚发言的 Bot 收尾。

## 4. 数据模型（`<dataDir>/state.json`）

```jsonc
{
  "bots":     [{ "id":"bot_x","name":"Chief","role":"总管","instructions":"…","isMain":true,
                 "skin":"fuzzy","model":"default","effort":"default","avatar":"" }],
  "groups":   [{ "id":"grp_x","name":"写作组","adminId":"bot_x","memberIds":["bot_x","bot_y"],
                 "replyMode":"admin|all","maxHops":0,"handover":false,"notes":false }],
  "settings": { "language":"auto|zh|en", "userName":"" },
  "sessions": { "bot:bot_x": { "bot_x": { "sessionId":"ses_…", "stamp":"…", "model":"…" } } },
  "schedules":[…], "helpers":[…], "taskBatches":[…], "usage":{…}
}
```

其余数据分文件：`messages/<chatId>.json`、`usage.jsonl`、`memory/`、`uploads/`、`avatars/`、
`agent-sessions/`、`logs/host.log`、`workspace/`。

## 5. 关键不变量（改动前必须读）

| 不变量 | 位置 |
|---|---|
| 写文件必须「临时文件 + fsync + rename」，读不出改名为 `*.corrupt-<时间>` | `store.mjs` |
| 单文件写失败不得让已完成的回合失败（只记日志） | `store.mjs`/`engine.mjs` |
| `request_id` 稳定幂等；`unknown` 不代表失败，绝不自动重派 | `task-dispatcher.mjs` |
| 回合重试 `[8000, 20000] ms`；`auth/quota/context_too_long/blocked/invalid_request` 不重试 | `engine.mjs` `NO_RETRY_REASONS` |
| 用量只统计模型真正运行的时间；`aborted` 有字数/工具但无耗时 | `engine.mjs` |
| 点名：空格分词文字里字母/数字/下划线/组合符号紧贴 `@` 失效，中日韩可直接贴；名字后紧跟名字字符则未结束 | `relay-guard.mjs` |
| 协议标记（插件标记 + 宿主块标签）必须从不可信文本剥掉，`<media src>` 不受影响 | `relay-guard.mjs` `neutralizeMarks` |
| 群发言队列只按成员名单生成，管理员不在名单则由首位成员接替 | `team.mjs`/`engine.mjs` |
| 记忆：单条 ≤1200 字符、每份 ≤100k 字符且 ≤1000 条、每轮注入 ≤6000 字符、拒绝疑似密钥 | `memory*.mjs` |

## 6. Agent 运行时（本移植新增）

`miniapp/node/agent-runtime.mjs` 实现 `miniapp-api.ts` 里的四个能力：

| Host 原接口 | 本实现 |
|---|---|
| `agent.run({ text, sessionId?, model? })` | OpenAI 兼容流式请求 + 工具循环；无 `sessionId` 新建 `ses_*`，有则续 |
| `agent.reply({ sessionId, requestId, decision })` | 结算待审批的工具调用（`allowOnce`/`deny`） |
| `agent.answer({ sessionId, requestId, answers })` | 答案作为一条 user 消息追加后继续同一会话 |
| `agent.models()` | 由 `config.runtime.models` 合成 `{ default, models[] }`（含 `thinking.efforts`） |
| （Host 内建工具） | `read_file` / `write_file` / `edit_file` / `list_dir` / `run_command`，限制在 `workspaceRoot` 内 |
| （Host 的 MCP 目录） | `attachTools({ toolDefs, call })`：把 21 个 MCP 工具以 `mcp__minimax-bot__*` 暴露给模型 |

错误码与 `engine.mjs` 的词汇对齐：`auth`(401) / `quota`(402,429) / `blocked`(403) /
`context_too_long`(400+context) / `invalid_request`(400) / `AGENT_UNAVAILABLE`(5xx、网络、超时，可重试) /
`INVALID_ARGUMENTS`(未知模型) / `SESSION_NOT_FOUND` / `BUSY`。

## 7. 可观测性

- `logs/host.log`：宿主生命周期（`deepseek_host.starting|listening|agent_ready|stopped|*_failed`），JSON Lines。
- `<dataDir>/usage.jsonl`：每回合一行（回合数、字数、工具调用、耗时、状态），用量面板读它。
- `/api/events`：SSE 推给页面（消息增量、任务、审批、纪要等）。
- 执行记录面板：按回合展示每次工具调用的开始/成功/失败与整轮失败原因。

## 8. 安全边界（与宿主版一致，勿夸大）

- 只监听 `127.0.0.1`，无登录鉴权；本机任意进程都可访问 → 不要暴露到公网。
- MCP 的 `caller_bot_id` 由调用方自报，权限是**行为约束**不是安全边界。
- 内置文件/命令工具被限制在 `workspaceRoot` 内；`allowShell:false` 可完全关掉 `run_command`。
- API Key 只从配置/环境变量读取，不落日志；`dataDir` 属普通用户数据，按需备份。
