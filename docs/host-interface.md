# 独立运行接口契约（Lead 制定，runtime / host / 集成按此实现）

本仓库是 `minimax-bot` v0.7.24（MIT）的独立化移植：保留原 `miniapp/node` + `miniapp/client` + `tests/`，
把 MiniMax Code Host 的 `agent` 桥接替换成**自己实现的 DeepSeek Agent 运行时**，让整套系统可以脱离
MiniMax Code 单独运行（HTTP 服务 + Web UI + MCP 端点）。

目标入口：`bin/dsteam.mjs` → `miniapp/node/standalone-host.mjs` → `miniapp/node/server.mjs`。
运行时：`miniapp/node/agent-runtime.mjs`。

## 1. `MiniAppContext`（server.start 需要的全部输入）

```js
{
  pluginId: 'deepseek-bot-team',
  pluginRoot: <仓库根目录>,            // server 内部 join(pluginRoot, 'miniapp/client')
  dataDir: <持久化目录>,
  listen: { host: '127.0.0.1', port: <number> },
  signal: AbortSignal,
  logger: { debug, info, warn, error },  // 任意实现，不能抛异常
  agent: AgentRuntime,                  // 见 §2
  // hostConnector 可以不提供
}
```

`server.start(context)` 返回 `{ dispose() }`；`context.signal` abort 时自动 dispose。

## 2. AgentRuntime（`miniapp/node/agent-runtime.mjs`）

`engine.mjs` 只依赖下面这些成员（不要改 engine 的这一侧）：

```js
export class AgentRuntime {
  constructor({ dataDir, logger, config }) {}

  // 模型目录。engine.modelCatalog() 会同步调用再 await；返回 Promise 也可以。
  // 形状由 store.mjs 的 toSelection/withEffort 决定：
  async models(): Promise<{
    default: { providerId: string, modelId: string },
    models: Array<{
      providerId: string, modelId: string, displayName?: string,
      thinking?: { efforts: string[] },      // 例如 ['low','medium','high']
      variant?: string,
    }>,
  }>

  // 跑一个 Agent 回合。
  // input.model: undefined | { providerId, modelId, variant?, thinking?: { effort } }
  async run(input: { text: string, sessionId?: string, model?: object },
            options?: { signal?: AbortSignal, onEvent?: (event) => void })
    : Promise<{ sessionId, turnId, status: 'finished'|'error'|'aborted', text?, error?: {code, message, retryable?, reason?} }>

  // 处理待审批的工具调用（engine.replyApproval 调用）
  async reply(input: { sessionId: string, requestId: string, decision: 'allowOnce'|'deny' }): Promise<void>

  // 回答问卷：把答案写进同一会话并继续这一回合，语义同 run
  async answer(input: { sessionId: string, requestId: string, answers: Array },
               options?: { signal, onEvent }): Promise<同 run 的返回>

  // server 在 MCP handler 建好后调用一次，用于把 21 个 MCP 工具交给模型
  attachTools({ toolDefs, call }) {}
  //   toolDefs: [{ name, description, inputSchema }]（mcp.mjs toolDefs() 的数组）
  //   call(name, args, signal) => Promise<value>；失败时 throw

  async dispose(): Promise<void>
}
```

### 2.1 事件语义（`onEvent`，与 engine.mjs 的 onEvent 完全对齐）

必须按顺序、按以下 `type`/字段发出；engine 只认这些：

| 事件 | 字段 | 说明 |
|---|---|---|
| `turn.started` | `sessionId`, `turnId` | 模型真正开始跑（engine 用它判定"回合已交给 Host"） |
| `text.delta` | `sessionId`, `turnId`, `text` | 文本增量 |
| `message.committed` | `sessionId`, `turnId`, `text` | 一条完整 assistant 文本（engine 会按前缀去重） |
| `tool.started` | `sessionId`, `turnId`, `name` | MCP 工具的 `name` 必须是 `mcp__minimax-bot__<tool>` |
| `tool.finished` | `sessionId`, `turnId`, `name`, `ok` | 同上命名 |
| `permission.requested` | `sessionId`, `requestId`, `toolName`, `toolInput?`, `reason` | 仅 `autoApprove:false` 时 |
| `turn.finished` | `sessionId`, `turnId`, `status`, `text?`, `error?` | 最后一条 |

`run` 返回：`{ sessionId, turnId, status, text?, error? }`。`aborted` 时 `status:'aborted'`。
抛出的错误对象：`{ code, retryable, reason? }`；`code` 用 engine 的词汇：
`auth` / `quota` / `context_too_long` / `blocked` / `invalid_request`（这五个不自动重试，
见 engine.mjs 的 `NO_RETRY_REASONS`），其余用 `MODEL_UNAVAILABLE` / `SESSION_NOT_FOUND` /
`AGENT_UNAVAILABLE` / `BUSY` / `INVALID_ARGUMENTS`。HTTP 401→`auth`，429→`quota`，
400 且含 context/length→`context_too_long`，403→`blocked`。

### 2.2 会话

- `run` 不带 `sessionId`：新建会话 `ses_<随机>`；带：接着该会话（找不到就新建并以给定 id 继续）。
- 会话消息持久化在 `<dataDir>/agent-sessions/<sessionId>.json`（临时文件+fsync+rename，失败只记日志，
  不影响已完成的回合）；重启后可继续。
- 模型回复以 assistant 消息进会话；工具结果以 tool 消息进会话。
- 每轮可配置 `maxToolRounds`（默认 12），超出后按 `error`/`invalid_request` 结束并说明。

### 2.3 后端协议（DeepSeek / OpenAI 兼容）

`POST {apiBase}/chat/completions`，`stream:true`，`messages` + `tools`（function calling）。
`apiBase` 默认 `https://api.deepseek.com`，`apiKey` 来自配置/环境变量。
请求体 `model` 取选择的 `modelId`；`thinking.effort` 存在时按配置映射追加 `reasoning_effort`（默认如此），
`variant:''` / effort `off` 时不追加。所有请求可被 `signal` 中止。

### 2.4 内置工具（Agent 的"完整能力"最小集，名称不要带 `mcp__` 前缀）

`read_file(path)`、`write_file(path, content)`、`edit_file(path, old_string, new_string)`、
`list_dir(path)`、`run_command(command, cwd?)`。文件类工具限制在 `config.workspaceRoot` 内（默认 `<dataDir>/workspace`），
越界拒绝；`run_command` 在 `workspaceRoot` 执行，超时可配，默认 60s，输出截断 16KiB。
`config.allowShell:false` 时不提供 `run_command`。

## 3. 工具桥接（MCP）

`server.mjs` 在 `createMcpHandler` 之后把工具交给运行时（Host 里由宿主直接提供，独立版要我们接线）：

```js
if (typeof context.agent?.attachTools === 'function') {
  context.agent.attachTools({
    toolDefs: handleMcp.toolDefs,
    call: (name, args, signal) => handleMcp.callTool(name, args, signal),
  });
}
```

为此 `mcp.mjs` 在 `createMcpHandler` 的 return 前给函数挂两个属性（最小改动、不影响现有测试）：

```js
handleMcp.toolDefs = toolDefs();
handleMcp.callTool = callTool;
return handleMcp;
```

模型看到的 MCP 工具名用 `mcp__minimax-bot__<tool>`（`tool.started/finished` 用同名）。
工具参数 schema 直接用 `inputSchema`。工具结果 JSON 序列化后作为 tool 消息回给模型；失败时把错误文本回给模型
（`tool.finished` 的 `ok:false`），不要让回合直接崩掉。

## 4. 配置与 CLI

`config.example.json`（同时支持 `$DSBOT_CONFIG`、`--config <path>`）：

```jsonc
{
  "port": 8790,
  "dataDir": "./data",
  "api": { "baseURL": "https://api.deepseek.com", "apiKey": "", "model": "deepseek-chat" },
  "runtime": {
    "providerId": "deepseek",
    "models": [ { "modelId": "deepseek-chat", "displayName": "DeepSeek Chat",
                  "thinking": { "efforts": ["low","medium","high"] } } ],
    "maxToolRounds": 12,
    "requestTimeoutMs": 120000,
    "autoApprove": true,
    "workspaceRoot": "",          // 空则 dataDir/workspace
    "allowShell": true
  },
  "logLevel": "info"
}
```

环境变量（优先级低于显式 CLI/配置文件字段？——按需实现，文档写清楚即可）：
`DSBOT_API_KEY`、`DSBOT_API_BASE`、`DSBOT_MODEL`、`DSBOT_PORT`、`DSBOT_DATA_DIR`、`DSBOT_AUTO_APPROVE`。

CLI：`node bin/dsteam.mjs [--port N] [--data DIR] [--config FILE] [--api-key K] [--api-base URL] [--model M]`。
启动成功打印：`UI http://127.0.0.1:<port>/bot` 和 `MCP http://127.0.0.1:<port>/mcp/minimax-bot`。
SIGINT/SIGTERM：abort context.signal → dispose，正常退出。

## 5. 边界（不要改的东西）

- 不要改 `tests/` 现有用例的语义；新增用例只加到新文件。
- 不要改 `miniapp/client/**`（UI 已完整）。
- 不要改 `store.mjs` / `team.mjs` / `relay-guard.mjs` / `memory*.mjs` / `group-note.mjs` / `task-dispatcher.mjs` 的行为。
- `server.mjs`、`mcp.mjs` 只允许上面 §3 的最小接线改动（host 负责）。
- Lead 负责 `engine.mjs` 的 Windows 失败修复与集成验收。

## 6. 测试注意（本机沙箱限制）

本会话运行在 DSH Windows 沙箱里：`node --test` 会因为子进程 `stdio:'pipe'` 报 `spawn EPERM`，
**不要**用 `node --test`；单个文件直接 `node tests/<file>.test.mjs` 可以跑（已有 45 个文件均已验证）。
最终验收由 Lead 在放开限制后跑全套。

