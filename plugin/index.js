// @ts-check
/**
 * dsh-bot-team — Host half.
 *
 * Two jobs:
 *
 *  1. Own the local "multi-Bot team" service (the standalone `D:\DSH-Work\deepseek-bot-team`
 *     project): probe it, start it when nothing answers, stop only what it started, and expose
 *     `bot_team_status` / `bot_team_restart` / `bot_team_open` to the model.
 *
 *  2. Make every Bot chattable *inside DSH*: `GET /dsh-bot-team/chat?bot=<id>` resolves (or
 *     creates) a real DSH Session for that Bot, names it after the Bot, and returns its id so the
 *     client can select it with `ctx.uiWorkspace.openSession`. A persona section registered on the
 *     agent's own context gives that session the Bot's name, role and instructions, so the native
 *     DSH chat — streaming, tool calls, approvals, debugging — *is* the Bot conversation.
 *
 * Node built-ins only: the bundle declares no dependencies and registers tools with plain JSON
 * Schema instead of importing `defineTool`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const name = 'dsh-bot-team';
export const inject = ['tools', 'webServer'];

const DEFAULT_PORT = 8790;
/** The developer checkout; a published clone keeps the service beside this bundle instead. */
const LEGACY_PROJECT_DIR = 'D:\\DSH-Work\\deepseek-bot-team';

/** The team service directory: a sibling `service/` when present, else the developer checkout. */
function defaultProjectDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = join(here, '..', 'service');
  if (existsSync(join(sibling, 'bin', 'dsteam.mjs'))) return sibling;
  return LEGACY_PROJECT_DIR;
}
const READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_200;
/** Where `bot -> DSH session` bindings live; the team service owns `bots`, this file owns sessions. */
const SESSION_MAP = 'dsh-sessions.json';

/** @param {any} ctx */
function log(ctx, level, text, fields) {
  try {
    const line = fields ? `${text} ${JSON.stringify(fields)}` : text;
    if (typeof ctx.logger?.[level] === 'function') ctx.logger[level]('dsh-bot-team: %s', line);
  } catch {
    // A logger that throws must never take the plugin down.
  }
}

function settings() {
  const port = Number(process.env.DSH_BOT_TEAM_PORT ?? '') || DEFAULT_PORT;
  const projectDir = process.env.DSH_BOT_TEAM_DIR || defaultProjectDir();
  const dataDir = process.env.DSH_BOT_TEAM_DATA || join(projectDir, 'data');
  return {
    port,
    projectDir,
    dataDir,
    uiUrl: `http://127.0.0.1:${port}/bot`,
    mcpUrl: `http://127.0.0.1:${port}/mcp/minimax-bot`,
    apiUrl: `http://127.0.0.1:${port}/api/state`,
  };
}

/** Resolves after at most `timeoutMs`; never rejects. */
async function probe(port, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: controller.signal });
    if (!response.ok) return undefined;
    const state = await response.json();
    return { bots: Array.isArray(state?.bots) ? state.bots.length : 0, agentAvailable: Boolean(state?.agentAvailable) };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTeamState(config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(config.apiUrl, { signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function nodeCommand() {
  const execPath = /** @type {any} */ (process).execPath;
  const isElectron = Boolean(/** @type {any} */ (process).versions?.electron);
  return { command: execPath, env: isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

function readSessionMap(config) {
  try {
    const parsed = JSON.parse(readFileSync(join(config.dataDir, SESSION_MAP), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSessionMap(config, value) {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(join(config.dataDir, SESSION_MAP), JSON.stringify(value, null, 2), 'utf8');
  } catch {
    // A lost binding only means a new Session next time.
  }
}

/** The text a Bot's own DSH Session is told about itself. */
function personaText(bot) {
  const lines = [
    `<dsh-bot-team>`,
    `You are "${bot.name}", one Bot of a multi-Bot team living in the user's DeepSeek Harness.`,
    bot.role ? `Your role: ${bot.role}` : '',
    bot.instructions ? `Standing instructions from the user:\n${bot.instructions}` : '',
    `This conversation is your own session: the user talks to you here directly.`,
    `The team tools are registered as mcp__bot-team__* (list_team, message_bot, dispatch_tasks, get_tasks,`,
    `create_bot, create_group, post_group, remember, recall, forget, create_schedule, ...). Use list_team`,
    `when you need to know who else is on the team, and message_bot to hand work to another Bot.`,
    `Stay in character: speak as ${bot.name}, not as the Harness.`,
    `</dsh-bot-team>`,
  ];
  return lines.filter(Boolean).join('\n');
}

/** @param {any} ctx */
export function apply(ctx) {
  const config = settings();
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  let stopping = false;
  let lastError = '';

  const entry = join(config.projectDir, 'bin', 'dsteam.mjs');

  /** @returns {Promise<{ ok: boolean, started?: boolean, error?: string }>} */
  async function ensureService() {
    const alive = await probe(config.port);
    if (alive) return { ok: true };
    if (!existsSync(entry)) {
      lastError = `找不到服务入口 ${entry}`;
      return { ok: false, error: lastError };
    }
    if (!child || child.exitCode !== null) {
      const { command, env } = nodeCommand();
      try {
        child = spawn(command, [entry], {
          cwd: config.projectDir,
          env: { ...process.env, ...env, DSBOT_PORT: String(config.port) },
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch (error) {
        lastError = `启动服务失败：${/** @type {any} */ (error)?.message ?? error}`;
        return { ok: false, error: lastError };
      }
      child.on('exit', (code, signal) => {
        log(ctx, 'info', 'team service exited', { code, signal, stopping });
        child = undefined;
      });
      child.on('error', (error) => {
        lastError = `服务进程出错：${/** @type {any} */ (error)?.message ?? error}`;
      });
      log(ctx, 'info', 'team service spawned', { pid: child.pid, port: config.port });
    }
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await probe(config.port, 800)) return { ok: true, started: true };
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    lastError = `服务在 ${READY_TIMEOUT_MS} ms 内没有就绪（端口 ${config.port}）`;
    return { ok: false, error: lastError };
  }

  async function stopService() {
    const own = child;
    if (!own || own.exitCode !== null) return false;
    stopping = true;
    try { own.kill(); } catch { /* already gone */ }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && own.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 100));
    if (own.exitCode === null) {
      try { own.kill('SIGKILL'); } catch { /* ignore */ }
    }
    return true;
  }

  // ------------------------------------------------------------------ Bot -> DSH Session
  /**
   * Resolves the DSH Session that belongs to `botId`, creating one on first use.
   * @param {string} botId
   */
  async function ensureBotSession(botId) {
    const state = await fetchTeamState(config);
    if (!state) throw new Error('团队服务没有响应');
    const bot = (state.bots || []).find((item) => item.id === botId);
    if (!bot) throw new Error(`没有这个 Bot：${botId}`);
    const sessions = ctx.get('sessionController');
    const workspaces = ctx.get('workspaceRegistry');
    if (!sessions || !workspaces) throw new Error('DSH 没有提供 sessionController / workspaceRegistry');

    const bindings = readSessionMap(config);
    const bound = bindings[botId];
    if (bound) {
      const resolved = await sessions.resolveAgent(bound);
      if (resolved && !('error' in resolved)) return { sessionId: bound, bot, created: false };
    }

    const dir = join(config.dataDir, 'bot-workspaces', String(botId).replace(/[^A-Za-z0-9_-]/g, '_'));
    mkdirSync(dir, { recursive: true });
    const workspace = await workspaces.create(dir);
    const sessionId = `bot_${String(botId).replace(/^bot_/, '').slice(0, 12)}_${Date.now().toString(36)}`;
    await sessions.create({ sessionId, workspaceId: workspace.id });
    try {
      await sessions.rename({ sessionId, title: bot.name });
    } catch (error) {
      log(ctx, 'warn', 'could not rename the Bot session', { sessionId, message: String(/** @type {any} */ (error)?.message ?? error) });
    }
    bindings[botId] = sessionId;
    writeSessionMap(config, bindings);
    log(ctx, 'info', 'created a DSH session for a Bot', { botId, name: bot.name, sessionId });
    return { sessionId, bot, created: true };
  }

  // A Bot's own session gets its persona from the agent's context, so the registration follows
  // that agent's lifetime and is restored when the session is reopened after a restart.
  /** @type {Map<string, { botId: string, dispose: () => void }>} */
  const personaDisposers = new Map();
  ctx.on('agent/created', async (/** @type {any} */ payload) => {
    try {
      const agent = payload?.agent;
      if (!agent || personaDisposers.has(agent.id)) return;
      const bindings = readSessionMap(config);
      const botId = Object.keys(bindings).find((key) => bindings[key] === agent.id);
      if (!botId) return;
      const state = await fetchTeamState(config);
      const bot = state && (state.bots || []).find((item) => item.id === botId);
      if (!bot) return;
      const text = personaText(bot);
      const dispose = agent.ctx.systemPrompt.section({
        name: 'dsh-bot-team-persona',
        order: 90,
        text: () => text,
      });
      personaDisposers.set(agent.id, { botId, dispose });
    } catch (error) {
      log(ctx, 'warn', 'could not install the Bot persona', { message: String(/** @type {any} */ (error)?.message ?? error) });
    }
  });
  ctx.on('agent/disposed', (/** @type {any} */ payload) => {
    const id = payload?.agent?.id;
    const entryForAgent = id && personaDisposers.get(id);
    if (!entryForAgent) return;
    try { entryForAgent.dispose?.(); } catch { /* ignore */ }
    personaDisposers.delete(id);
  });

  // ------------------------------------------------------------------ the client's one endpoint
  ctx.inject(['webServer'], (scope) => {
    const disposeRoute = scope.get('webServer').register({
      kind: 'prefix',
      path: '/dsh-bot-team',
      async handler(req, res) {
        const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1');
        const send = (status, value) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(value));
        };
        if (url.pathname === '/dsh-bot-team/chat') {
          const botId = url.searchParams.get('bot') || '';
          try {
            const result = await ensureBotSession(botId);
            send(200, { sessionId: result.sessionId, bot: { id: result.bot.id, name: result.bot.name }, created: result.created });
          } catch (error) {
            send(400, { error: String(/** @type {any} */ (error)?.message ?? error) });
          }
          return;
        }
        if (url.pathname === '/dsh-bot-team/status') {
          const alive = await probe(config.port);
          send(200, { running: Boolean(alive), bots: alive?.bots ?? null, port: config.port });
          return;
        }
        send(404, { error: 'unknown route' });
      },
    });
    ctx.effect(() => disposeRoute);
  });

  // ------------------------------------------------------------------ tools
  const statusTool = {
    name: 'bot_team_status',
    description: 'Report whether the local Bot team service is running, with its UI and MCP URLs.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const alive = await probe(config.port);
      /** @type {Record<string, unknown>} */
      const value = {
        running: Boolean(alive),
        managed: Boolean(child && child.exitCode === null),
        pid: child?.pid ?? null,
        port: config.port,
        ui_url: config.uiUrl,
        mcp_url: config.mcpUrl,
        data_dir: config.dataDir,
        bots: alive?.bots ?? null,
        agent_available: alive?.agentAvailable ?? null,
      };
      if (!alive) value.error = lastError || 'the service did not answer on its port';
      return value;
    },
  };

  const chatTool = {
    name: 'bot_team_chat',
    description: 'Open the DSH Session of one Bot so the user can chat with it natively, and return that session id.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['bot'],
      properties: { bot: { type: 'string', description: 'Bot name or bot_id' } },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const state = await fetchTeamState(config);
      const wanted = String(args?.bot ?? '').trim().toLowerCase();
      const bot = (state?.bots || []).find((item) => item.id.toLowerCase() === wanted || String(item.name).toLowerCase() === wanted);
      if (!bot) return { error: 'no such Bot', bot: args?.bot };
      const result = await ensureBotSession(bot.id);
      return { bot: { id: bot.id, name: bot.name }, session_id: result.sessionId, created: result.created, hint: '在左侧栏点这个 Bot 的「聊天」，或让用户从会话列表打开同名会话。' };
    },
  };

  const restartTool = {
    name: 'bot_team_restart',
    description: 'Restart the local Bot team service. Use it after changing config.json (for example the model API key).',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const stopped = await stopService();
      stopping = false;
      const result = await ensureService();
      return { restarted: result.ok, stopped_previous: stopped, error: result.error, ui_url: config.uiUrl };
    },
  };

  const openTool = {
    name: 'bot_team_open',
    description: 'Return the URL of the team page and its Bots, for reference in chat.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const state = await fetchTeamState(config);
      return {
        ui_url: config.uiUrl,
        bots: (state?.bots || []).map((bot) => ({ id: bot.id, name: bot.name, main: Boolean(bot.isMain) })),
        hint: '点左侧栏的「Dsh bot」，选一个 Bot 的「聊天」即可在 DSH 里直接对话。',
      };
    },
  };

  const disposers = [statusTool, chatTool, restartTool, openTool].map((tool) => ctx.tools.register(tool));

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose?.(); } catch { /* ignore */ }
    }
    for (const entryForAgent of personaDisposers.values()) {
      try { entryForAgent.dispose?.(); } catch { /* ignore */ }
    }
    personaDisposers.clear();
    void stopService();
  });

  void ensureService().then((started) => {
    if (started.ok) log(ctx, 'info', 'team service ready', { url: config.uiUrl, started: started.started ?? false });
    else log(ctx, 'warn', 'team service unavailable', { error: started.error });
  });

  log(ctx, 'info', 'dsh-bot-team host ready', { port: config.port, projectDir: config.projectDir });
}
