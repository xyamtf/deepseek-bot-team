# Dsh bot

把「一支长期在线的多 Bot 团队」接进 DeepSeek Harness：入口在左侧栏（和 **插件 / Superagent / 自动化任务** 并排的一行 **Dsh bot**），
点某个 Bot 的「聊天」就在 **DSH 自己的会话界面里**和它对话——流式输出、工具调用、审批、执行记录、调试，全是原生的。

## 聊天发生在哪里

- 点左侧栏 **Dsh bot** → 中间主区域**就是完整团队界面**（内嵌在面板里，不再另开网页/标签页）：
  Bot 列表、私聊、群聊、记忆、任务、用量、设置、换皮肤、上传头像——全都在这一屏。
- 面板标题栏有两个视图，默认就是完整界面：
  - **完整界面**（默认）：iframe 直接嵌入 `http://127.0.0.1:8790/bot`，功能与网页版一模一样；
  - **聊天**：更轻的原生聊天视图（Bot 列表 + 气泡 + 停止/清空），想快速问一句时用。
  - **刷新** 重载 iframe；**↗** 万一内嵌被环境挡住，就在右侧边栏/新标签页打开。
- 数据都走团队服务的 REST/SSE：`/api/state`、`/api/chats/bot:<id>/messages`、`/cancel`、`/reset` 等；
  服务开放了环回跨域与 `OPTIONS` 预检，所以 DSH 页面能直接读写。
- 交互参考了开源项目 [OpenMausBot](https://github.com/milind-soni/OpenMausBot) 的 Bot 列表 + 每 Bot 独立线程、
  头像与气泡那套做法（代码仍是本仓库自己的实现）。



## 插件清单：与 DSH 已安装插件同步

「新建 Bot / 编辑 Bot」的「插件与能力」下面会列出**你这台 DSH 装了哪些插件**，每次打开表单实时读取，
以后新装的插件不用重启就会出现：

- **能给 Bot 用的**：按能力包归类显示，例如「文件读写 ← 文件读写工具」「命令行 ← Bash 命令工具」。
  勾上对应能力包，这个 Bot 就真的拿到那些工具。
- **只能在 DSH 主 Agent 内运行的**：折叠在「另有 N 个插件运行在 DSH 主 Agent 内，Bot 进程加载不了」里，
  点开能看到名字（网页搜索、语音识别、自动授权审查等）。这些不是开关坏了，而是它们的实现跑在 DSH 自己的
  Cordis 运行时里，独立进程的 Bot 拿不到 —— 界面如实说明，不假装能开。

清单与 DSH 插件页同源：profile 的 `package.json` 列出 bundle → 每个 bundle 的 `cordis.patch.yml` →
profile 自己的 `cordis.patch.yml` 覆盖（启用/禁用、自己插入的插件行）。接口：`GET /api/plugins`。

## 能力（按 Bot 加载的插件式工具包）

新建/编辑 Bot 时，「推理强度」下面多了一组 **能力** 勾选框，决定这个 Bot 能加载哪些工具：

| 能力包 | 解锁的工具 |
|---|---|
| `team` 团队协作 | list_team、message_bot、dispatch_tasks、get_tasks、cancel_tasks、post_group、create/update/delete_bot、create/update/delete_group |
| `helpers` 后台助手 | start_helper、list_helpers、stop_helper |
| `memory` 长期记忆 | remember、recall、forget |
| `schedule` 定时任务 | create_schedule、list_schedules、delete_schedule |
| `files` 文件读写 | read_file、write_file、edit_file、list_dir |
| `shell` 命令行 | run_command |

- 不勾的能力包**既不会出现在模型的工具目录里，也无法被执行**：运行时会拒绝清单外的调用，提示词里也会写明
  「这个 Bot 只加载了这些能力」。
- 全不勾 = 这个 Bot 一个工具都没有（纯聊天）；全勾 = 和以前一样。
- 老 Bot 没有这个字段，等价于「全部」，行为不变。
- 主 Bot 始终保留 `team`（否则管不了团队），创建/提升为主 Bot 时自动加回。
- 接口：`POST /api/bots` / `PATCH /api/bots/<id>` 都接受 `capabilities: ["memory", …]`；
  MCP 的 `create_bot` / `update_bot` 同样接受 `capabilities`，未知 id 会以 400 / 工具错误拒绝并列出可用值。

## 头像：默认小鲸鱼，可自定义

三条路都能换，都在面板里完成，不用开别的窗口：

1. **新建 Bot 的预览卡**（就是弹窗左边那张大头像）：直接点大头像 = 选一张自己的图片（自动居中裁成
   256 正方形、存进本地头像库并选中）；头像下面一排缩略图 = **12 种皮肤** + 头像库里已有的图 + 「+」上传，
   点一下就切换，预览和最终创建出来的 Bot 同步变化。
2. **聊天视图头部**（点「聊天」切过去）：点头像上传自定义图片，右侧下拉切皮肤，有自定义头像时出现「恢复皮肤」。
3. **Bot 详情 / 完整界面**：同样的「形象」区块与头像库批量导入；也可以让主 Bot 用 `update_bot` 的 `skin` / `avatar` 设置。


- 默认：蓝色小鲸鱼（`skins/whale.svg`）。
- 12 种皮肤：小鲸鱼、蓝色毛绒、泡泡、粉色玻璃、金色、翡翠、毛绒、华夫饼、像素、笑脸球、玩具、月岩。
- 头像库按内容哈希存盘（`data/avatars/`），跨 Bot 复用，换皮肤、删 Bot 都不会丢；重复导入自动去重。
- 接口：`POST /api/avatars`（data URL，≤512KB）→ `PATCH /api/bots/<id>` `{avatar}` / `{skin}` / `{avatar:null}`。


## 工具

| 工具 | 作用 |
|---|---|
| `bot_team_status` | 服务是否在跑、端口、UI/MCP 地址、Bot 数量、是否由插件托管 |
| `bot_team_chat` | 解析/创建某个 Bot 的 DSH 会话并返回 `session_id` |
| `bot_team_open` | 返回团队页地址与 Bot 清单 |
| `bot_team_restart` | 重启本地团队服务（改完 `config.json` 的 Key/端口后使用） |

团队自己的 21 个工具通过 `@deepseek-ai/dsh-mcp-client` 注册为 `mcp__bot-team__*`：
`list_team`、`message_bot`、`dispatch_tasks`、`get_tasks`、`cancel_tasks`、`post_group`、
`create_bot`、`update_bot`、`delete_bot`、`create_group`、`update_group`、`delete_group`、
`start_helper`、`list_helpers`、`stop_helper`、`remember`、`recall`、`forget`、
`create_schedule`、`list_schedules`、`delete_schedule`。

## 数据

- 团队数据（Bot、群、消息、记忆、用量）：`D:\DSH-Work\deepseek-bot-team\data\`（`state.json`、`messages/`、
  `usage.jsonl`、`memory/`、`avatars/`、`agent-sessions/`）。
- Bot 与 DSH 会话的绑定：`data/dsh-sessions.json`。
- 每个 Bot 的会话工作目录：`data/bot-workspaces/<botId>/`。

## 限制

- 团队服务是**本地子进程**（`bin/dsteam.mjs`，只监听 `127.0.0.1:8790`），由本插件按需拉起；DSH 退出时只关它
  自己拉起的那个进程。
- Bot 的模型由团队服务的 `config.json` 决定（默认 DeepSeek `chat/completions`），与 DSH 当前会话所选的模型
  **不是**同一个：DSH 会话里的人格来自本插件，回答由团队服务的运行时产生。
- 改了 `client.js`（左侧栏那一行与团队页）后需要刷新 DSH 页面（Ctrl+R）才生效；改 `index.js`（Host 半边）
  需要重载插件行（插件页里关掉再打开，或重启 DSH）。
- 端口被非本服务占用时 `bot_team_status` 会报错；改 `config.json` 的 `port` 并同步环境变量 `DSH_BOT_TEAM_PORT`。
