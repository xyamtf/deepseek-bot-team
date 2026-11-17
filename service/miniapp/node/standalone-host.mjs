// @ts-check
/**
 * Standalone host for the DeepSeek Bot Team Mini App.
 *
 * The MiniMax Code Host used to provide the `MiniAppContext` (data dir, logger, signal and the
 * `agent` bridge) and to mount this Mini App's Node service. This module builds the same context
 * by itself, so `miniapp/node/server.mjs` can run in a plain Node process:
 *
 *     bin/dsteam.mjs  ->  startHost(config)  ->  server.start(context)
 *
 * It owns:
 *  - config normalization: port, dataDir (`~` expansion, relative paths against the repo root),
 *    api / runtime defaults, absolute workspaceRoot;
 *  - a logger that never throws: console plus `<dataDir>/logs/host.log` (JSON Lines);
 *  - the DeepSeek `AgentRuntime` (or an injected `config.agent`, handy for smoke tests);
 *  - process-lifetime wiring: an external `config.signal` (or the returned `abort()`) shuts the
 *    service down once, awaiting the Mini App lifecycle and the agent.
 *
 * The returned object is `{ url, mcpUrl, dataDir, dispose, ... }`; `dispose()` is idempotent and
 * safe to call from a `SIGINT`/`SIGTERM` handler.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readDshModels } from './model-sync.mjs';
import { start } from './server.mjs';

const HERE = fileURLToPath(import.meta.url);

/** Repository root (this file lives in `<repo>/miniapp/node/`). */
export const PLUGIN_ROOT = dirname(dirname(dirname(HERE)));

/** The identifier this Mini App is known by in the standalone build. */
export const PLUGIN_ID = 'deepseek-bot-team';

/** MCP server name declared by `miniapp/miniapp.json` (the endpoint path keeps it). */
export const MCP_SERVER = 'minimax-bot';

export const DEFAULT_PORT = 8790;
export const DEFAULT_API_BASE = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-chat';
export const DEFAULT_DATA_DIR_NAME = '.deepseek-bot-team';

const LOG_LEVELS = /** @type {const} */ ({ debug: 10, info: 20, warn: 30, error: 40 });
/** @typedef {'debug'|'info'|'warn'|'error'} LogLevel */

/** Turns any config value into one of the four levels; unknown values fall back to `info`. */
export function normalizeLogLevel(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text in LOG_LEVELS ? /** @type {LogLevel} */ (text) : 'info';
}

/** A JSON-safe projection of a log field object; never throws. */
function fieldsText(fields) {
  try {
    const text = JSON.stringify(fields);
    return text === undefined ? '{}' : text;
  } catch {
    // Circular, BigInt or a throwing toJSON: keep the log line rather than the payload.
    return '"[unserializable]"';
  }
}

/**
 * The host logger. Every method is guarded: a full disk, a closed stream or a console that throws
 * must never take the service down. Lines are written to `<dataDir>/logs/host.log` as JSON Lines
 * (`{ts, level, msg, ...fields}`) and mirrored to the console.
 *
 * @param {{ dataDir: string, level?: string, console?: Console, logger?: never }} [options]
 */
export function createLogger({ dataDir, level = 'info', console: sink = console } = /** @type {any} */ ({})) {
  const threshold = LOG_LEVELS[/** @type {LogLevel} */ (normalizeLogLevel(level))];
  const logFile = dataDir ? join(dataDir, 'logs', 'host.log') : undefined;
  /** @type {import('node:fs').WriteStream | undefined} */
  let stream;
  let closed = false;
  if (logFile) {
    try {
      // startHost() creates the directory too; this keeps `createLogger` usable on its own.
      mkdirSync(join(dataDir, 'logs'), { recursive: true });
      stream = createWriteStream(logFile, { flags: 'a' });
      // A failed open (permissions, disk) only disables file logging.
      stream.on('error', () => {
        stream = undefined;
      });
    } catch {
      stream = undefined;
    }
  }

  /**
   * @param {LogLevel} level
   * @param {string} message
   * @param {unknown} [fields]
   */
  function write(level, message, fields) {
    try {
      if (closed || LOG_LEVELS[level] < threshold) return;
      const text = String(message ?? '');
      const record = {
        ts: new Date().toISOString(),
        level,
        msg: text,
        ...(fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {}),
      };
      let line;
      try {
        line = JSON.stringify(record);
      } catch {
        line = JSON.stringify({ ts: record.ts, level, msg: text, fields: fieldsText(fields) });
      }
      if (stream) {
        try {
          stream.write(`${line}\n`);
        } catch {
          stream = undefined;
        }
      }
      try {
        const print = level === 'error' ? sink.error : level === 'warn' ? sink.warn : sink.log;
        print.call(sink, `[dsteam] ${level} ${text}`, fields && typeof fields === 'object' ? fields : '');
      } catch {
        // An unusable console (piped stdio closed, custom sink) must not matter.
      }
    } catch {
      // Logging is best effort, always.
    }
  }

  return {
    level: /** @type {LogLevel} */ (normalizeLogLevel(level)),
    logFile,
    /** @param {string} message @param {unknown} [fields] */
    debug: (message, fields) => write('debug', message, fields),
    /** @param {string} message @param {unknown} [fields] */
    info: (message, fields) => write('info', message, fields),
    /** @param {string} message @param {unknown} [fields] */
    warn: (message, fields) => write('warn', message, fields),
    /** @param {string} message @param {unknown} [fields] */
    error: (message, fields) => write('error', message, fields),
    /** Stops file logging. Never throws, and safe to call twice. */
    close() {
      if (closed) return;
      closed = true;
      try {
        stream?.end();
      } catch {
        // Already gone.
      }
      stream = undefined;
    },
  };
}

/** Expands `~`, then resolves a relative path against `base`. Never throws. */
export function resolveUserPath(value, base = PLUGIN_ROOT) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  try {
    if (text === '~') return homedir();
    if (text.startsWith('~/') || text.startsWith('~\\')) return resolve(homedir(), text.slice(2));
    return isAbsolute(text) ? resolve(text) : resolve(base, text);
  } catch {
    return undefined;
  }
}

/** @param {unknown} value */
function textOr(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

/** A readable error: `bin/dsteam.mjs` prints its message and exits 1. */
function readableError(message, cause) {
  const error = /** @type {Error & { code?: string }} */ (new Error(message));
  if (cause) error.cause = cause;
  return error;
}

/**
 * Validates a port: a whole number from 1 to 65535. `0` is not supported because
 * `server.start()` does not report the port the listener actually bound.
 * @param {unknown} value
 */
export function resolvePort(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_PORT;
  const port = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw readableError(`无效端口 ${JSON.stringify(value)}：需要 1-65535 之间的整数`);
  }
  return port;
}

/**
 * Normalizes whatever `bin/dsteam.mjs` merged from flags, the config file and the environment
 * into the object the host (and `AgentRuntime`) use. Unknown top-level keys are dropped on
 * purpose: `signal` and an injected `agent` are not configuration.
 *
 * @param {any} [raw]
 * @param {{ pluginRoot?: string }} [options]
 */
export function normalizeConfig(raw = {}, { pluginRoot = PLUGIN_ROOT } = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const api = input.api && typeof input.api === 'object' ? input.api : {};
  const runtime = input.runtime && typeof input.runtime === 'object' ? input.runtime : {};

  const dataDir = resolveUserPath(input.dataDir, pluginRoot) ?? join(homedir(), DEFAULT_DATA_DIR_NAME);
  const workspaceRaw = typeof runtime.workspaceRoot === 'string' ? runtime.workspaceRoot.trim() : '';
  // Empty means "runtime's own default": `<dataDir>/workspace`.
  const workspaceRoot = workspaceRaw ? resolveUserPath(workspaceRaw, pluginRoot) : '';

  return {
    port: resolvePort(input.port),
    dataDir,
    logLevel: normalizeLogLevel(input.logLevel),
    api: {
      baseURL: textOr(api.baseURL, DEFAULT_API_BASE),
      apiKey: typeof api.apiKey === 'string' ? api.apiKey : '',
      model: textOr(api.model, DEFAULT_MODEL),
    },
    runtime: {
      ...runtime,
      // Documented defaults; an explicit config value always wins.
      maxToolRounds: Number.isInteger(runtime.maxToolRounds) && runtime.maxToolRounds > 0 ? runtime.maxToolRounds : 12,
      requestTimeoutMs: Number.isInteger(runtime.requestTimeoutMs) && runtime.requestTimeoutMs > 0 ? runtime.requestTimeoutMs : 120_000,
      autoApprove: typeof runtime.autoApprove === 'boolean' ? runtime.autoApprove : true,
      allowShell: typeof runtime.allowShell === 'boolean' ? runtime.allowShell : true,
      ...(workspaceRoot ? { workspaceRoot } : { workspaceRoot: '' }),
    },
  };
}

/**
 * Creates the real DeepSeek runtime. `agent-runtime.mjs` is imported lazily so this host can be
 * developed and smoke-tested with an injected stub before the runtime lands; when it is missing
 * the failure is explained instead of turning into a bare module resolution error.
 *
 * @param {{ config: any, logger: any }} deps
 */
async function createAgentRuntime({ config, logger }) {
  let mod;
  try {
    // Keep the specifier in a variable: a missing file is a runtime concern, not a parse error.
    const moduleName = './agent-runtime.mjs';
    mod = await import(moduleName);
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ERR_MODULE_NOT_FOUND' && /agent-runtime/.test(String(/** @type {any} */ (error)?.message))) {
      throw readableError(
        '找不到 DeepSeek Agent 运行时 miniapp/node/agent-runtime.mjs（模块尚未实现）；'
        + '可用 config.agent 注入自实现运行时，或等待运行时模块落地后重试',
        error,
      );
    }
    throw error;
  }
  const AgentRuntime = /** @type {any} */ (mod).AgentRuntime ?? /** @type {any} */ (mod).default;
  if (typeof AgentRuntime !== 'function') {
    throw readableError('miniapp/node/agent-runtime.mjs 没有导出 AgentRuntime 类');
  }
  const agent = new AgentRuntime({ dataDir: config.dataDir, logger, config });
  logger.info('deepseek_host.agent_ready', { runtime: 'miniapp/node/agent-runtime.mjs' });
  return agent;
}

/**
 * Explains the common reasons `server.start()` refuses to listen.
 * @param {any} error
 * @param {{ port: number, dataDir: string }} facts
 */
function describeStartFailure(error, { port, dataDir }) {
  const code = /** @type {any} */ (error)?.code;
  if (code === 'EADDRINUSE') {
    return readableError(`端口 ${port} 已被占用：换一个端口（--port 或 config.port），或先停掉占用它的进程`, error);
  }
  if (code === 'EACCES') {
    return readableError(`没有权限监听端口 ${port}：换一个 1024 以上的端口试试`, error);
  }
  if (code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
    return readableError(`无法使用数据目录 ${dataDir}：${/** @type {any} */ (error)?.message ?? code}`, error);
  }
  return error;
}

/**
 * Starts the standalone service. Resolves once the HTTP listener accepts connections and the
 * MCP endpoint is mounted; rejects with a readable `Error` when it cannot start.
 *
 * @param {any} [rawConfig] config shaped like `config.example.json`, plus two optional
 *   non-serializable fields: `signal` (an external AbortSignal; aborting it shuts the host down)
 *   and `agent` (a pre-built runtime, replacing `AgentRuntime`).
 * @returns {Promise<{
 *   url: string, mcpUrl: string, dataDir: string, port: number, pluginRoot: string,
 *   config: any, logger: any, agent: any, signal: AbortSignal,
 *   dispose: () => Promise<void>, abort: () => void,
 * }>}
 */
export async function startHost(rawConfig = {}) {
  const input = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const pluginRoot = typeof input.pluginRoot === 'string' && input.pluginRoot ? input.pluginRoot : PLUGIN_ROOT;
  const config = normalizeConfig(input, { pluginRoot });
  // The model library follows DSH's: providers and models DSH already configured join this
  // runtime's catalog, with their keys read from DSH's credential store. Anything DSH speaks to
  // in a protocol this runtime does not implement is reported, never silently offered.
  let modelSync = { models: [], providers: {}, skipped: [], source: { found: false } };
  try {
    modelSync = readDshModels();
  } catch {
    modelSync = { models: [], providers: {}, skipped: [], source: { found: false } };
  }
  const externalSignal = /** @type {AbortSignal | undefined} */ (input.signal);
  const providedAgent = input.agent;

  // 1. Data dir first: logging lives there, and server.start() needs it too.
  try {
    await mkdir(join(config.dataDir, 'logs'), { recursive: true });
  } catch (error) {
    throw readableError(
      `无法创建数据目录 ${config.dataDir}：${/** @type {any} */ (error)?.message ?? error}`
      + '（用 --data 或 config.dataDir 换一个有写权限的目录）',
      error,
    );
  }
  const logger = createLogger({ dataDir: config.dataDir, level: config.logLevel });
  if (modelSync.models.length) {
    config.runtime.providers = { ...(config.runtime.providers ?? {}), ...modelSync.providers };
    const existing = Array.isArray(config.runtime.models) ? config.runtime.models : [];
    const seen = new Set(existing.map((entry) => entry.providerId + '/' + entry.modelId));
    config.runtime.models = existing.concat(modelSync.models.filter((entry) => !seen.has(entry.providerId + '/' + entry.modelId)));
  }
  logger.info('deepseek_host.models_synced', {
    models: modelSync.models.length,
    providers: Object.keys(modelSync.providers),
    skipped: modelSync.skipped,
    source: modelSync.source.found,
  });
  if (input.logLevel !== undefined && input.logLevel !== null
    && !(String(input.logLevel).trim().toLowerCase() in LOG_LEVELS)) {
    logger.warn('deepseek_host.unknown_log_level', { value: input.logLevel, used: config.logLevel });
  }
  logger.info('deepseek_host.starting', { port: config.port, dataDir: config.dataDir, pluginRoot });
  // Starting without a key is legal (the page still works), but every Bot turn would fail with
  // `auth`. Say so once at startup instead of leaving it to the first message.
  if (!config.api.apiKey && !providedAgent) {
    logger.warn('deepseek_host.missing_api_key', {
      hint: 'set api.apiKey in the config file, pass --api-key, or set DSBOT_API_KEY',
    });
  }

  // 2. The agent bridge server.mjs expects (`context.agent`).
  let agent;
  try {
    agent = providedAgent ?? (await createAgentRuntime({ config, logger }));
  } catch (error) {
    logger.error('deepseek_host.agent_failed', { message: /** @type {any} */ (error)?.message });
    logger.close();
    throw error;
  }
  if (!agent || typeof agent.run !== 'function') {
    logger.error('deepseek_host.agent_invalid', {});
    logger.close();
    throw readableError('config.agent 不是可用的 AgentRuntime：缺少 run() 方法');
  }

  const controller = new AbortController();
  const started = Date.now();
  let lifecycle;
  try {
    lifecycle = await start({
      pluginId: PLUGIN_ID,
      pluginRoot,
      dataDir: config.dataDir,
      listen: { host: /** @type {const} */ ('127.0.0.1'), port: config.port },
      signal: controller.signal,
      logger,
      agent,
    });
  } catch (error) {
    logger.error('deepseek_host.listen_failed', { port: config.port, message: /** @type {any} */ (error)?.message });
    try {
      await agent.dispose?.();
    } catch {
      // Best effort: the start failure is what the caller needs to see.
    }
    logger.close();
    throw describeStartFailure(error, { port: config.port, dataDir: config.dataDir });
  }

  const url = `http://127.0.0.1:${config.port}/bot`;
  const mcpUrl = `http://127.0.0.1:${config.port}/mcp/${MCP_SERVER}`;

  /** @type {Promise<void> | undefined} */
  let disposePromise;
  /**
   * Shuts everything down once: Mini App lifecycle first (it drains its writes and closes the
   * listener), then the agent, then the internal signal and the log file. Idempotent; never throws.
   */
  const dispose = () => {
    if (disposePromise) return disposePromise;
    disposePromise = (async () => {
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      try {
        await lifecycle?.dispose?.();
      } catch (error) {
        logger.error('deepseek_host.dispose_lifecycle_failed', { message: /** @type {any} */ (error)?.message });
      }
      try {
        await agent.dispose?.();
      } catch (error) {
        logger.error('deepseek_host.dispose_agent_failed', { message: /** @type {any} */ (error)?.message });
      }
      try {
        controller.abort();
      } catch {
        // An abort listener that throws is not our business.
      }
      logger.info('deepseek_host.stopped', { port: config.port, uptimeMs: Date.now() - started });
      logger.close();
    })();
    return disposePromise;
  };

  /** The external signal is the caller's way to stop us; it is not the context's signal. */
  const onExternalAbort = () => {
    void dispose();
  };
  if (externalSignal) {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    if (externalSignal.aborted) {
      // Aborted before the listener existed: stop right away, like a SIGINT during startup.
      void dispose();
    }
  }

  logger.info('deepseek_host.listening', { url, mcpUrl, dataDir: config.dataDir });

  return {
    url,
    mcpUrl,
    dataDir: config.dataDir,
    port: config.port,
    pluginRoot,
    config,
    logger,
    agent,
    signal: controller.signal,
    dispose,
    /** Shorthand for `void dispose()`; the returned promise settles the shutdown. */
    abort: () => {
      void dispose();
    },
  };
}
