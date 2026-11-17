#!/usr/bin/env node
// @ts-check
/**
 * `dsteam` — start the DeepSeek Bot Team standalone service.
 *
 *     node bin/dsteam.mjs [--port N] [--data DIR] [--config FILE] [--api-key K]
 *                         [--api-base URL] [--model M] [--auto-approve|--no-auto-approve]
 *
 * Precedence: command line > config file > environment > built-in defaults.
 * The UI is served at `/bot`; the same process exposes the Mini App's Streamable HTTP MCP at
 * `/mcp/minimax-bot`. SIGINT/SIGTERM abort the host signal, drain the service and exit 0.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLUGIN_ROOT, startHost } from '../miniapp/node/standalone-host.mjs';

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(HERE));

const USAGE = `用法：node bin/dsteam.mjs [选项]

选项：
  --port <N>             监听端口（默认 8790，仅绑定 127.0.0.1）
  --data <DIR>           数据目录（默认 ~/.deepseek-bot-team；相对路径相对仓库根）
  --config <FILE>        配置文件路径（默认 $DSBOT_CONFIG，其次 <仓库>/config.json，存在才读）
  --api-key <KEY>        模型 API Key（也可用 DSBOT_API_KEY）
  --api-base <URL>       OpenAI 兼容 API 地址（默认 https://api.deepseek.com）
  --model <MODEL>        默认模型（默认 deepseek-chat）
  --auto-approve         Agent 工具调用自动通过（默认；也可用 DSBOT_AUTO_APPROVE=true）
  --no-auto-approve      每次工具调用都需要审批
  -h, --help             显示本帮助

优先级：命令行 > 配置文件 > 环境变量 > 内置默认值。
环境变量：DSBOT_API_KEY、DSBOT_API_BASE、DSBOT_MODEL、DSBOT_PORT、DSBOT_DATA_DIR、
          DSBOT_CONFIG、DSBOT_AUTO_APPROVE（true/false/1/0）。

启动成功后打印 UI / MCP 地址与数据目录；Ctrl+C（或 SIGTERM）会优雅关闭。`;

/** A startup/config failure whose message is safe and useful to print. */
function readableError(message) {
  return /** @type {Error} */ (new Error(message));
}

/**
 * Parses the small, explicit flag surface. Unknown flags and missing values fail rather than
 * being ignored: a typo in a port is better seen than silently replaced by the default.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const flags = /** @type {{ port?: string, data?: string, config?: string, apiKey?: string, apiBase?: string, model?: string, autoApprove?: boolean, help?: boolean }} */ ({});
  const valueOf = (name, inline, argv, index) => {
    if (inline !== undefined) return { value: inline, next: index };
    const value = argv[index + 1];
    if (value === undefined || value === '') throw readableError(`${name} 缺少取值`);
    return { value, next: index + 1 };
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    const inline = equals >= 0 ? arg.slice(equals + 1) : undefined;
    switch (name) {
      case '-h':
      case '--help':
        flags.help = true;
        break;
      case '--port': {
        const read = valueOf(name, inline, argv, index);
        flags.port = read.value;
        index = read.next;
        break;
      }
      case '--data': {
        const read = valueOf(name, inline, argv, index);
        flags.data = read.value;
        index = read.next;
        break;
      }
      case '--config': {
        const read = valueOf(name, inline, argv, index);
        flags.config = read.value;
        index = read.next;
        break;
      }
      case '--api-key': {
        const read = valueOf(name, inline, argv, index);
        flags.apiKey = read.value;
        index = read.next;
        break;
      }
      case '--api-base': {
        const read = valueOf(name, inline, argv, index);
        flags.apiBase = read.value;
        index = read.next;
        break;
      }
      case '--model': {
        const read = valueOf(name, inline, argv, index);
        flags.model = read.value;
        index = read.next;
        break;
      }
      case '--auto-approve':
        if (inline !== undefined) throw readableError('--auto-approve 不接收取值');
        flags.autoApprove = true;
        break;
      case '--no-auto-approve':
        if (inline !== undefined) throw readableError('--no-auto-approve 不接收取值');
        flags.autoApprove = false;
        break;
      default:
        throw readableError(`未知参数 ${JSON.stringify(arg)}（--help 查看可用选项）`);
    }
  }
  return flags;
}

/**
 * `--config` > `$DSBOT_CONFIG` > `<repo>/config.json` (only when it exists).
 * An explicitly named file must exist; the conventional one is optional.
 * @param {ReturnType<typeof parseArgs>} flags
 * @param {NodeJS.ProcessEnv} env
 */
function resolveConfigFile(flags, env) {
  if (flags.config) {
    const path = resolve(flags.config);
    if (!existsSync(path)) throw readableError(`找不到配置文件 ${path}`);
    return { path, explicit: true };
  }
  const fromEnv = env.DSBOT_CONFIG;
  if (fromEnv) {
    const path = resolve(fromEnv);
    if (!existsSync(path)) throw readableError(`DSBOT_CONFIG 指向的配置文件不存在 ${path}`);
    return { path, explicit: true };
  }
  const conventional = join(REPO_ROOT, 'config.json');
  if (existsSync(conventional)) return { path: conventional, explicit: false };
  return { path: undefined, explicit: false };
}

/** @param {string} path */
function readConfigFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw readableError(`读取配置文件失败 ${path}：${/** @type {any} */ (error)?.message ?? error}`);
  }
  try {
    // Windows editors often add a BOM; JSON.parse does not accept it.
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw readableError(`配置文件必须是一个 JSON 对象：${path}`);
    }
    return parsed;
  } catch (error) {
    if (/** @type {any} */ (error)?.message?.startsWith('配置文件必须')) throw error;
    throw readableError(`配置文件不是合法 JSON：${path}\n  ${/** @type {any} */ (error)?.message ?? error}`);
  }
}

/**
 * @param {string} name
 * @param {string | undefined} raw
 * @returns {boolean | undefined}
 */
function parseEnvBoolean(name, raw) {
  if (raw === undefined || raw === '') return undefined;
  const text = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw readableError(`环境变量 ${name}=${JSON.stringify(raw)} 不是布尔值（true/false/1/0）`);
}

/**
 * Builds the host config from the three sources, in precedence order.
 * @param {{ flags: ReturnType<typeof parseArgs>, file: any, env: NodeJS.ProcessEnv, signal: AbortSignal }} input
 */
function buildConfig({ flags, file, env, signal }) {
  const api = file.api && typeof file.api === 'object' ? file.api : {};
  const runtime = file.runtime && typeof file.runtime === 'object' ? file.runtime : {};
  const autoApprove = flags.autoApprove
    ?? (typeof runtime.autoApprove === 'boolean' ? runtime.autoApprove : parseEnvBoolean('DSBOT_AUTO_APPROVE', env.DSBOT_AUTO_APPROVE));
  return {
    port: flags.port ?? file.port ?? env.DSBOT_PORT,
    dataDir: flags.data ?? file.dataDir ?? env.DSBOT_DATA_DIR,
    logLevel: file.logLevel,
    api: {
      baseURL: flags.apiBase ?? api.baseURL ?? env.DSBOT_API_BASE,
      apiKey: flags.apiKey ?? api.apiKey ?? env.DSBOT_API_KEY,
      model: flags.model ?? api.model ?? env.DSBOT_MODEL,
    },
    runtime: {
      ...runtime,
      ...(autoApprove === undefined ? {} : { autoApprove }),
    },
    signal,
  };
}

/** @param {any} host @param {string | undefined} configPath */
function printStarted(host, configPath) {
  const hasKey = Boolean(host.config?.api?.apiKey);
  const lines = [
    '',
    'DeepSeek Bot Team 已启动',
    `  UI        ${host.url}`,
    `  MCP       ${host.mcpUrl}`,
    `  数据目录  ${host.dataDir}`,
    `  日志      ${host.logger?.logFile ?? '(仅控制台)'}`,
    `  配置      ${configPath ?? '默认（无配置文件）'}`,
    // A missing key is the one thing that makes the page look broken: say it up front.
    ...(hasKey ? [] : [
      '',
      '  ⚠ 没有配置模型 API Key：页面可以打开，但每个 Bot 回合都会失败（auth）。',
      '    用 --api-key "sk-..." 启动，或先 $env:DSBOT_API_KEY = "sk-..."（bash: export DSBOT_API_KEY=...）。',
    ]),
    '',
    '  按 Ctrl+C 退出',
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** @param {any} error */
function printFailure(error) {
  const message = String(/** @type {any} */ (error)?.message ?? error);
  process.stderr.write(`\n启动失败：${message}\n`);
  const cause = /** @type {any} */ (error)?.cause;
  if (cause?.code && !message.includes(String(cause.code))) {
    process.stderr.write(`  原因：${cause.code}${cause.message ? ` ${cause.message}` : ''}\n`);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const env = process.env;
  const configFile = resolveConfigFile(flags, env);
  const file = configFile.path ? readConfigFile(configFile.path) : {};

  const controller = new AbortController();
  /** @type {boolean} */
  let stopping = false;
  /** @type {any} */
  let host;
  /** @type {Promise<void> | undefined} */
  let shutdownPromise;
  /** @type {(() => void) | undefined} */
  let resolveStopped;
  const stopped = new Promise((done) => {
    resolveStopped = () => done(undefined);
  });

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    // The signal shuts the host down even if it is still starting; `dispose()` below is idempotent.
    controller.abort();
    shutdownPromise = (async () => {
      try {
        await host?.dispose();
      } catch {
        // Never let shutdown itself fail the exit code.
      }
      resolveStopped?.();
    })();
    return shutdownPromise;
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });

  let config;
  try {
    config = buildConfig({ flags, file, env, signal: controller.signal });
  } catch (error) {
    printFailure(error);
    return 1;
  }

  try {
    host = await startHost(config);
  } catch (error) {
    if (stopping) {
      // Ctrl+C while starting: not a failure.
      return 0;
    }
    printFailure(error);
    return 1;
  }

  if (stopping) {
    // A signal arrived while `startHost` was running; the host may already be disposing itself.
    await shutdown();
    await host?.dispose();
    return 0;
  }

  printStarted(host, configFile.path);
  // The HTTP listener keeps the process alive; the signal handler resolves this.
  await stopped;
  await shutdown();
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    printFailure(error);
    process.exitCode = 1;
  },
);
