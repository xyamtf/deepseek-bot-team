// @ts-check
/**
 * DeepSeek Agent runtime — the standalone replacement for the MiniMax Code Host's agent bridge.
 *
 * `engine.mjs` talks to the Host through `agent.run` / `agent.reply` / `agent.answer` /
 * `agent.models` (see `miniapp-api.ts`). This class implements the same surface on top of a
 * DeepSeek (OpenAI-compatible) `/chat/completions` endpoint: it streams text, runs one tool
 * loop with the Mini App's MCP tools plus a small set of built-in file/shell tools, asks for
 * permission when configured to, and persists each conversation under
 * `<dataDir>/agent-sessions/<sessionId>.json` so a turn can be continued after a restart.
 *
 * The events it emits are exactly the shapes `engine.mjs` consumes; see `docs/host-interface.md`
 * for the contract. Everything is Node built-ins plus the global `fetch`; no SDK, no build step.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Prefix the model sees on the Mini App's own MCP tools. */
export const MCP_TOOL_PREFIX = 'mcp__minimax-bot__';
/** MCP tools that read state only: with `autoApprove:false` they run without asking. */
export const READ_ONLY_MCP_TOOLS = Object.freeze([
  'list_team',
  'list_helpers',
  'get_tasks',
  'recall',
  'list_schedules',
]);

const DEFAULT_MAX_TOOL_ROUNDS = 12;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
/** `run_command` output is cut here; a chatty command must not flood the model's context. */
const COMMAND_OUTPUT_LIMIT = 16 * 1024;
/** A single tool result delivered to the model; the largest legitimate ones are memory reads. */
const TOOL_RESULT_LIMIT = 200_000;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A built-in tool refused its arguments; only the model needs to see it. */
class ToolError extends Error {}

/**
 * @typedef {{ role: string, content?: string | null, tool_calls?: any[], tool_call_id?: string }} AgentMessage
 * @typedef {{
 *   code: string, message: string, retryable?: boolean, reason?: string,
 * }} AgentFailure
 * @typedef {{ type: string, [key: string]: any }} AgentEvent
 */

/** Builds the error `engine.mjs` expects from a thrown runtime failure. */
function runtimeError(code, message, retryable, reason) {
  const error = /** @type {Error & { code: string, retryable?: boolean, reason?: string }} */ (new Error(message));
  error.code = code;
  error.retryable = retryable;
  if (reason) error.reason = reason;
  return error;
}

/** A failure as `run` returns it. */
function turnFailure(code, message, retryable, reason) {
  /** @type {AgentFailure} */
  const failure = { code, message: String(message ?? '').slice(0, 500), retryable };
  if (reason) failure.reason = reason;
  return failure;
}

function errorText(error) {
  if (error instanceof Error) return error.message || error.name;
  return String(error ?? '');
}

function clip(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value;
}

function newSessionId() {
  return `ses_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function newTurnId() {
  return `turn_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function newRequestId() {
  return `apr_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function parseBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/**
 * The per-turn tool limit a caller (engine.mjs, from a Bot's capability packs) may pass:
 * `{ mcp: string[], builtin: string[] }`. `undefined` means "the whole catalogue"; an empty list
 * is a real limit (a Bot with no capabilities gets no tools).
 * @returns {{ mcp: Set<string>, builtin: Set<string> } | undefined}
 */
function normalizeAllow(value) {
  if (!value || typeof value !== 'object') return undefined;
  const hasMcp = Array.isArray(value.mcp);
  const hasBuiltin = Array.isArray(value.builtin);
  if (!hasMcp && !hasBuiltin) return undefined;
  const clean = (list) => new Set((list ?? []).filter((name) => typeof name === 'string' && name));
  return { mcp: clean(hasMcp ? value.mcp : []), builtin: clean(hasBuiltin ? value.builtin : []) };
}

/** A logger that never throws, like the Host contract requires. */
function safeLogger(logger) {
  const sink = logger && typeof logger === 'object' ? logger : {};
  const at = (level) => (message, fields) => {
    try {
      const fn = typeof sink[level] === 'function' ? sink[level] : sink.info;
      if (typeof fn === 'function') fn.call(sink, String(message), fields);
    } catch {
      // A logger that throws must not take a turn down with it.
    }
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

function assertInsideWorkspace(root, target, requested) {
  const relativePath = relative(root, target);
  if (relativePath === '') return;
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new ToolError(`Path is outside the workspace: ${String(requested)}`);
  }
}

function serializeToolValue(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A conversation as it lives in memory and on disk. */
function normalizeStoredMessages(raw) {
  const messages = [];
  if (!Array.isArray(raw)) return messages;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role;
    if (!['user', 'assistant', 'tool', 'system', 'developer'].includes(role)) continue;
    /** @type {AgentMessage} */
    const message = { role };
    if (typeof item.content === 'string') message.content = item.content;
    else if (item.content === null) message.content = null;
    if (role === 'assistant' && Array.isArray(item.tool_calls)) {
      const calls = item.tool_calls.filter((call) => call && typeof call === 'object' && call.id);
      if (calls.length) message.tool_calls = calls;
    }
    if (role === 'tool' && typeof item.tool_call_id === 'string') message.tool_call_id = item.tool_call_id;
    messages.push(message);
  }
  return messages;
}

function formatAnswers(requestId, answers) {
  const lines = [`[Questionnaire answers${requestId ? ` for ${requestId}` : ''}]`];
  for (const answer of answers) {
    lines.push(`- stepId: ${answer.stepId}`);
    lines.push(`  options: ${answer.selectedOptionIds.join(', ') || '(none)'}`);
    if (answer.selectedOther) lines.push('  other option: yes');
    if (answer.otherText) lines.push(`  otherText: ${answer.otherText}`);
    lines.push(`  skipped: ${answer.skipped ? 'yes' : 'no'}`);
  }
  return lines.join('\n');
}

function normalizeAnswers(raw) {
  if (!Array.isArray(raw)) {
    throw runtimeError('INVALID_ARGUMENTS', '`answers` must be an array', false, 'invalid_request');
  }
  return raw.map((answer) => {
    if (!answer || typeof answer !== 'object') {
      throw runtimeError('INVALID_ARGUMENTS', 'Every answer must be an object', false, 'invalid_request');
    }
    return {
      stepId: typeof answer.stepId === 'string' ? answer.stepId : String(answer.stepId ?? ''),
      selectedOptionIds: Array.isArray(answer.selectedOptionIds)
        ? answer.selectedOptionIds.filter((id) => typeof id === 'string')
        : [],
      selectedOther: answer.selectedOther === true,
      otherText: typeof answer.otherText === 'string' ? answer.otherText : undefined,
      skipped: answer.skipped === true,
    };
  });
}

/**
 * The classification §2.1 asks for: HTTP status and body in, `{code, retryable, reason}` out.
 * The reason names the localized `agentError.reason.*` keys engine.mjs knows.
 */
function classifyHttpFailure(status, bodyText) {
  const detail = String(bodyText ?? '').replace(/\s+/g, ' ').trim();
  const lower = detail.toLowerCase();
  const withDetail = (message) => (detail ? `${message}: ${clip(detail, 300)}` : message);
  if (status === 401) {
    return turnFailure('auth', withDetail('The model service rejected the API key (HTTP 401)'), false, 'auth');
  }
  if (status === 402 || status === 429) {
    return turnFailure('quota', withDetail(`The model service is out of quota or rate limited (HTTP ${status})`), false, 'quota');
  }
  if (status === 403) {
    return turnFailure('blocked', withDetail('The model service refused the request (HTTP 403)'), false, 'blocked');
  }
  if (status === 400) {
    if (/invalid\s+model|unknown\s+model|model\s+not\s+found|model\s+does\s+not\s+exist|no\s+such\s+model/.test(lower)) {
      return turnFailure('INVALID_ARGUMENTS', withDetail('The model service does not recognize the requested model'), false, 'invalid_request');
    }
    if (/context|length|too many tokens|maximum.*token/.test(lower)) {
      return turnFailure('context_too_long', withDetail('The conversation is too long for the model'), false, 'context_too_long');
    }
    return turnFailure('invalid_request', withDetail('The model service rejected the request (HTTP 400)'), false, 'invalid_request');
  }
  if (status >= 500) {
    return turnFailure('AGENT_UNAVAILABLE', withDetail(`The model service failed (HTTP ${status})`), true, 'overloaded');
  }
  return turnFailure('AGENT_UNAVAILABLE', withDetail(`The model service returned HTTP ${status}`), true, 'network');
}

function classifyNetworkFailure(error) {
  return turnFailure('AGENT_UNAVAILABLE', `Network error reaching the model service: ${errorText(error)}`, true, 'network');
}

/**
 * The Mini App's Agent runtime.
 *
 * @example
 * const runtime = new AgentRuntime({ dataDir, logger, config });
 * runtime.attachTools({ toolDefs, call });
 * const result = await runtime.run({ text: 'hello' }, { onEvent: (event) => console.log(event) });
 */
export class AgentRuntime {
  /** @param {{ dataDir: string, logger?: any, config?: any }} options */
  constructor({ dataDir, logger, config } = /** @type {any} */ ({})) {
    if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('AgentRuntime needs a dataDir');
    this.dataDir = resolve(dataDir);
    this.config = config && typeof config === 'object' ? config : {};
    this.logger = safeLogger(logger);
    const runtime = this.config.runtime && typeof this.config.runtime === 'object' ? this.config.runtime : {};
    const api = this.config.api && typeof this.config.api === 'object' ? this.config.api : {};

    /** The OpenAI-compatible base URL, without a trailing slash. */
    this.apiBase = String(api.baseURL ?? this.config.apiBase ?? process.env.DSBOT_API_BASE ?? 'https://api.deepseek.com')
      .trim().replace(/\/+$/, '');
    if (!this.apiBase) this.apiBase = 'https://api.deepseek.com';
    this.apiKey = String(api.apiKey ?? this.config.apiKey ?? process.env.DSBOT_API_KEY ?? '').trim();
    this.providerId = typeof runtime.providerId === 'string' && runtime.providerId.trim()
      ? runtime.providerId.trim() : 'deepseek';
    this.maxToolRounds = positiveInteger(runtime.maxToolRounds, DEFAULT_MAX_TOOL_ROUNDS);
    this.requestTimeoutMs = positiveInteger(runtime.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.commandTimeoutMs = positiveInteger(runtime.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
    this.autoApprove = parseBoolean(runtime.autoApprove ?? process.env.DSBOT_AUTO_APPROVE, true);
    this.allowShell = runtime.allowShell !== false;
    const configuredWorkspace = this.config.workspaceRoot ?? runtime.workspaceRoot;
    this.workspaceRoot = typeof configuredWorkspace === 'string' && configuredWorkspace.trim()
      ? resolve(configuredWorkspace.trim())
      : join(this.dataDir, 'workspace');
    // Per-provider endpoints (synced from DSH's model library); `apiBase`/`apiKey` stay the default.
    this.providers = runtime.providers && typeof runtime.providers === 'object' ? runtime.providers : {};
    this.sessionsDir = join(this.dataDir, 'agent-sessions');
    /** Reasoning-effort values the backend takes; the default maps an effort onto itself. */
    this.reasoningEffortMap = runtime.reasoningEffortMap && typeof runtime.reasoningEffortMap === 'object'
      ? runtime.reasoningEffortMap : undefined;

    /** @type {Map<string, any>} in-memory sessions, loaded from disk on first use */
    this.sessions = new Map();
    /** @type {Map<string, { controller: AbortController, done: { promise: Promise<void>, resolve: () => void } }>} */
    this.active = new Map();
    /** @type {Map<string, { requestId: string, sessionId: string, settle: (decision: string) => void }>} */
    this.approvals = new Map();
    /** @type {Array<{ name: string, description?: string, inputSchema?: any }>} */
    this.toolDefs = [];
    /** @type {((name: string, args: any, signal?: AbortSignal) => Promise<any>) | undefined} */
    this.callTool = undefined;
    this.disposed = false;

    // The directories a persisted turn needs are created lazily; best effort so construction
    // can never fail on a read-only data directory (the turn itself will report the write miss).
    void mkdir(this.sessionsDir, { recursive: true }).catch((error) =>
      this.logger.warn('minimax_bot.agent_dir_create_failed', { code: error?.code ?? 'unknown' }));
    void mkdir(this.workspaceRoot, { recursive: true }).catch((error) =>
      this.logger.warn('minimax_bot.workspace_create_failed', { code: error?.code ?? 'unknown' }));
  }

  // ------------------------------------------------------------------ model catalog
  /** @returns {Promise<{ default: { providerId: string, modelId: string }, models: any[] }>} */
  async models() {
    const models = this.#catalog();
    return { default: this.#defaultSelection(models), models };
  }

  /** The catalog entries, built from `config.runtime.models` (or a synthesized default). */
  #catalog() {
    const runtime = this.config.runtime && typeof this.config.runtime === 'object' ? this.config.runtime : {};
    const configured = Array.isArray(runtime.models) ? runtime.models : [];
    /** @type {any[]} */
    const models = [];
    for (const raw of configured) {
      if (typeof raw === 'string' && raw.trim()) {
        models.push({ providerId: this.providerId, modelId: raw.trim() });
      } else if (raw && typeof raw === 'object' && typeof raw.modelId === 'string' && raw.modelId.trim()) {
        models.push(this.#catalogEntry(raw));
      }
    }
    if (!models.length) {
      models.push({ providerId: this.providerId, modelId: this.#defaultModelId() });
    }
    return models;
  }

  /** One configured entry, normalized to the shape the page's model picker reads. */
  #catalogEntry(raw) {
    const modelId = String(raw.modelId).trim();
    const providerId = typeof raw.providerId === 'string' && raw.providerId.trim()
      ? raw.providerId.trim() : this.providerId;
    const efforts = Array.isArray(raw.thinking?.efforts)
      ? raw.thinking.efforts.filter((effort) => typeof effort === 'string' && effort.trim()).map((effort) => effort.trim())
      : Array.isArray(raw.efforts)
        ? raw.efforts.filter((effort) => typeof effort === 'string' && effort.trim()).map((effort) => effort.trim())
        : [];
    const variants = Array.isArray(raw.variants) && raw.variants.length
      ? raw.variants.filter((variant) => typeof variant === 'string')
      : efforts.length ? ['thinking', ''] : undefined;
    /** @type {any} */
    const entry = { providerId, modelId };
    if (typeof raw.displayName === 'string' && raw.displayName.trim()) entry.displayName = raw.displayName.trim();
    if (efforts.length) {
      entry.thinking = { efforts };
      const defaultEffort = typeof raw.thinking?.default === 'string' ? raw.thinking.default : undefined;
      if (defaultEffort && efforts.includes(defaultEffort)) entry.thinking.default = defaultEffort;
    }
    if (variants) entry.variants = variants;
    if (typeof raw.variant === 'string') entry.variant = raw.variant;
    return entry;
  }

  #defaultModelId() {
    const api = this.config.api && typeof this.config.api === 'object' ? this.config.api : {};
    const configured = api.model ?? process.env.DSBOT_MODEL;
    return typeof configured === 'string' && configured.trim() ? configured.trim() : 'deepseek-chat';
  }

  /** The model a turn runs when nothing selected one: the configured default, else the first entry. */
  #defaultSelection(models) {
    const runtime = this.config.runtime && typeof this.config.runtime === 'object' ? this.config.runtime : {};
    const api = this.config.api && typeof this.config.api === 'object' ? this.config.api : {};
    const candidate = runtime.defaultModel ?? api.model ?? process.env.DSBOT_MODEL;
    if (candidate && typeof candidate === 'object') {
      const hit = models.find((entry) =>
        entry.modelId === candidate.modelId &&
        (!candidate.providerId || entry.providerId === candidate.providerId));
      if (hit) return { providerId: hit.providerId, modelId: hit.modelId };
    } else if (typeof candidate === 'string' && candidate.trim()) {
      const hit = models.find((entry) => entry.modelId === candidate.trim());
      if (hit) return { providerId: hit.providerId, modelId: hit.modelId };
    }
    return { providerId: models[0].providerId, modelId: models[0].modelId };
  }

  /**
   * The selection a turn uses: the one the caller passed, the session's own (a continuation keeps
   * it), or the catalog default. A selection the catalog does not contain is rejected before the
   * model runs, which engine.mjs turns into `MODEL_UNAVAILABLE`.
   */
  #resolveModel(requested, session) {
    const models = this.#catalog();
    /** @type {any} */
    const candidate = requested ?? session?.model ?? this.#defaultSelection(models);
    if (!candidate || typeof candidate !== 'object') {
      throw runtimeError('INVALID_ARGUMENTS', 'A model selection must be an object', false, 'invalid_request');
    }
    const modelId = typeof candidate.modelId === 'string' ? candidate.modelId.trim() : '';
    if (!modelId) throw runtimeError('INVALID_ARGUMENTS', 'A model selection needs a modelId', false, 'invalid_request');
    const providerId = typeof candidate.providerId === 'string' && candidate.providerId.trim()
      ? candidate.providerId.trim() : this.providerId;
    if (providerId === 'custom') {
      const baseURL = typeof candidate.baseURL === 'string' ? candidate.baseURL.trim() : '';
      if (!/^https?:\/\//i.test(baseURL)) {
        throw runtimeError('INVALID_ARGUMENTS', 'A custom model needs its own baseURL', false, 'invalid_request');
      }
      /** @type {any} */
      const custom = { providerId, modelId, baseURL };
      if (typeof candidate.apiKey === 'string' && candidate.apiKey) custom.apiKey = candidate.apiKey;
      return custom;
    }
    const entry = models.find((item) => item.modelId === modelId && item.providerId === providerId)
      ?? models.find((item) => item.modelId === modelId);
    if (!entry) {
      throw runtimeError(
        'INVALID_ARGUMENTS',
        `Unknown model ${providerId}/${modelId}; the catalog offers ${models.map((item) => `${item.providerId}/${item.modelId}`).join(', ')}`,
        false,
        'invalid_request',
      );
    }
    /** @type {any} */
    const selection = { providerId: entry.providerId, modelId: entry.modelId };
    // An empty variant means "thinking off" and must survive, unlike an absent one.
    if (typeof candidate.variant === 'string' && candidate.variant.length <= 64) selection.variant = candidate.variant;
    const effort = candidate.thinking?.effort;
    if (typeof effort === 'string' && effort && effort.length <= 32) selection.thinking = { effort };
    return selection;
  }

  /** The backend's `reasoning_effort` value for a selection, if this turn should send one. */
  #reasoningEffort(model) {
    const runtime = this.config.runtime && typeof this.config.runtime === 'object' ? this.config.runtime : {};
    if (runtime.reasoningEffort === false) return undefined;
    if (!model || model.variant === '') return undefined;
    const effort = model.thinking?.effort;
    if (typeof effort !== 'string' || !effort || effort === 'off') return undefined;
    const mapped = this.reasoningEffortMap && Object.hasOwn(this.reasoningEffortMap, effort)
      ? this.reasoningEffortMap[effort] : effort;
    if (mapped === false || mapped === null || mapped === undefined || mapped === '') return undefined;
    return String(mapped);
  }

  /** The base URL and key a selection speaks to: its own for a custom model, else its provider. */
  #endpointFor(model) {
    if (model && model.providerId === 'custom') {
      return { baseURL: String(model.baseURL ?? '').replace(/\/+$/, ''), apiKey: String(model.apiKey ?? '') };
    }
    const provider = model ? this.providers[model.providerId] : undefined;
    if (provider && typeof provider.baseURL === 'string' && provider.baseURL.trim()) {
      return {
        baseURL: provider.baseURL.trim().replace(/\/+$/, ''),
        apiKey: typeof provider.apiKey === 'string' ? provider.apiKey : this.apiKey,
      };
    }
    return { baseURL: this.apiBase, apiKey: this.apiKey };
  }

  // ------------------------------------------------------------------ tool bridge
  /**
   * Hands the Mini App's MCP tools to the runtime. `server.mjs` calls this once, after it built
   * `createMcpHandler`; `call(name, args, signal)` rejects on failure.
   *
   * @param {{ toolDefs?: Array<{ name: string, description?: string, inputSchema?: any }>, call?: Function }} input
   */
  attachTools(input) {
    const defs = Array.isArray(input?.toolDefs) ? input.toolDefs : [];
    this.toolDefs = defs.filter((def) => def && typeof def.name === 'string' && def.name);
    this.callTool = typeof input?.call === 'function' ? /** @type {any} */ (input.call) : undefined;
    this.logger.debug('minimax_bot.agent_tools_attached', { tools: this.toolDefs.length });
  }

  /** The OpenAI `tools` array for one request: built-ins first, then the attached MCP tools. */
  #toolList(allow) {
    /** @type {Array<{ type: 'function', function: { name: string, description: string, parameters: any } }>} */
    const builtins = this.#builtinToolDefs().filter((def) => !allow || allow.builtin.has(def.name));
    const tools = builtins.map((def) => ({
      type: /** @type {const} */ ('function'),
      function: { name: def.name, description: def.description, parameters: def.parameters },
    }));
    if (typeof this.callTool === 'function') {
      for (const def of this.toolDefs) {
        if (allow && !allow.mcp.has(def.name)) continue;
        tools.push({
          type: /** @type {const} */ ('function'),
          function: {
            name: `${MCP_TOOL_PREFIX}${def.name}`,
            description: typeof def.description === 'string' ? def.description : '',
            parameters: def.inputSchema && typeof def.inputSchema === 'object'
              ? def.inputSchema : { type: 'object', properties: {} },
          },
        });
      }
    }
    return tools;
  }

  /** A tool call resolved to where it runs; `undefined` for a name this runtime never offered. */
  #toolTarget(name, allow) {
    if (typeof name !== 'string' || !name) return undefined;
    if (name.startsWith(MCP_TOOL_PREFIX)) {
      const bare = name.slice(MCP_TOOL_PREFIX.length);
      if (typeof this.callTool !== 'function') return undefined;
      if (allow && !allow.mcp.has(bare)) return undefined;
      if (!this.toolDefs.some((def) => def.name === bare)) return undefined;
      return { kind: /** @type {const} */ ('mcp'), bare, name };
    }
    if (this.#builtinToolDefs().some((def) => def.name === name)) {
      if (allow && !allow.builtin.has(name)) return undefined;
      return { kind: /** @type {const} */ ('builtin'), name };
    }
    return undefined;
  }

  /** The built-in tool definitions; `run_command` only when the host allows a shell. */
  #builtinToolDefs() {
    /** @type {Array<{ name: string, description: string, parameters: any }>} */
    const defs = [
      {
        name: 'read_file',
        description: 'Read a UTF-8 text file inside the workspace.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Path relative to the workspace root (or an absolute path inside it).' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        name: 'write_file',
        description: 'Write a UTF-8 text file inside the workspace, creating parent directories.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
      {
        name: 'edit_file',
        description: 'Replace the first exact occurrence of old_string with new_string in a workspace file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
          },
          required: ['path', 'old_string', 'new_string'],
          additionalProperties: false,
        },
      },
      {
        name: 'list_dir',
        description: 'List the entries of a workspace directory.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Directory relative to the workspace root; default is the root.' } },
          additionalProperties: false,
        },
      },
    ];
    if (this.allowShell) {
      defs.push({
        name: 'run_command',
        description: 'Run a shell command in the workspace (default cwd is the workspace root).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            cwd: { type: 'string', description: 'Directory relative to the workspace root.' },
          },
          required: ['command'],
          additionalProperties: false,
        },
      });
    }
    return defs;
  }

  // ------------------------------------------------------------------ public turns
  /**
   * Runs one Agent turn and resolves when it ends.
   *
   * @param {{ text: string, sessionId?: string, model?: any }} input
   * @param {{ signal?: AbortSignal, onEvent?: (event: AgentEvent) => void }} [options]
   * @returns {Promise<{ sessionId: string, turnId: string, status: 'finished'|'error'|'aborted', text?: string, error?: AgentFailure }>}
   */
  async run(input, options = {}) {
    if (this.disposed) throw runtimeError('AGENT_UNAVAILABLE', 'The Agent runtime has been disposed', true, 'network');
    if (!input || typeof input !== 'object' || typeof input.text !== 'string' || !input.text.trim()) {
      throw runtimeError('INVALID_ARGUMENTS', 'A turn needs a non-empty `text`', false, 'invalid_request');
    }
    const sessionId = input.sessionId === undefined || input.sessionId === null
      ? newSessionId()
      : normalizeSessionId(input.sessionId);
    const session = await this.#loadSession(sessionId);
    const model = this.#resolveModel(input.model, session);
    // A turn may be limited to some capability packs; the session remembers it so a
    // questionnaire continuation keeps the same tool surface.
    const allow = normalizeAllow(input.tools);
    if (allow) session.allow = { mcp: [...allow.mcp], builtin: [...allow.builtin] };
    return this.#executeTurn({ session, model, userText: input.text, options, allow: allow ?? normalizeAllow(session.allow) });
  }

  /**
   * Decides a pending permission request raised by `permission.requested`.
   * An unknown request resolves as `REQUEST_NOT_FOUND`; engine.mjs ignores that one.
   *
   * @param {{ sessionId: string, requestId: string, decision: 'allowOnce'|'deny' }} input
   */
  async reply(input) {
    const requestId = typeof input?.requestId === 'string' ? input.requestId : '';
    const approval = this.approvals.get(requestId);
    if (!approval) {
      throw runtimeError('REQUEST_NOT_FOUND', `No pending permission request ${requestId || '(missing)'}`, false);
    }
    approval.settle(input?.decision === 'allowOnce' ? 'allow' : 'deny');
  }

  /**
   * Records questionnaire answers as one user message and continues the same conversation.
   * The continuation turn is observed like `run`.
   *
   * @param {{ sessionId: string, requestId?: string, answers: any[] }} input
   * @param {{ signal?: AbortSignal, onEvent?: (event: AgentEvent) => void }} [options]
   */
  async answer(input, options = {}) {
    if (this.disposed) throw runtimeError('AGENT_UNAVAILABLE', 'The Agent runtime has been disposed', true, 'network');
    const sessionId = normalizeSessionId(input?.sessionId);
    const session = await this.#loadSession(sessionId);
    // A session this process created has no file until its first write lands, and its cached
    // record still says `existed: false`. The conversation it already holds is what proves it
    // exists: a questionnaire answered right after the turn that asked it must be accepted.
    if (!session.existed && session.messages.length === 0) {
      throw runtimeError('SESSION_NOT_FOUND', `Session ${sessionId} does not exist`, false, 'session_not_found');
    }
    const answers = normalizeAnswers(input?.answers);
    const requestId = typeof input?.requestId === 'string' ? input.requestId : '';
    const model = this.#resolveModel(undefined, session);
    return this.#executeTurn({ session, model, userText: formatAnswers(requestId, answers), options, allow: normalizeAllow(session.allow) });
  }

  /** Aborts every running turn and releases every pending approval; safe to call twice. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const approval of [...this.approvals.values()]) approval.settle('aborted');
    this.approvals.clear();
    const waits = [];
    for (const entry of this.active.values()) {
      entry.controller.abort();
      waits.push(entry.done.promise);
    }
    await Promise.allSettled(waits);
    this.active.clear();
  }

  // ------------------------------------------------------------------ turn execution
  /** @returns {Promise<{ sessionId: string, turnId: string, status: 'finished'|'error'|'aborted', text?: string, error?: AgentFailure }>} */
  async #executeTurn({ session, model, userText, options, allow }) {
    const sessionId = session.sessionId;
    const entry = this.#beginSession(sessionId);
    const cleanup = this.#linkSignal(entry.controller, options?.signal);
    const emit = this.#eventEmitter(options?.onEvent);
    const turnId = newTurnId();
    const signal = entry.controller.signal;
    try {
      if (this.disposed) throw runtimeError('AGENT_UNAVAILABLE', 'The Agent runtime has been disposed', true, 'network');
      session.messages.push({ role: 'user', content: userText });
      session.updatedAt = Date.now();
      session.model = model;
      // The user's words are persisted before the model sees them: a crash mid-turn must not
      // lose the message the next continuation starts from.
      await this.#persist(session);
      return await this.#modelLoop({ session, turnId, model, signal, emit, allow });
    } catch (error) {
      // An unexpected failure must still end the turn, so a caller is never left waiting.
      const failure = turnFailure('AGENT_UNAVAILABLE', errorText(error), true, 'network');
      emit({ type: 'turn.finished', sessionId, turnId, status: 'error', error: failure });
      return { sessionId, turnId, status: 'error', error: failure };
    } finally {
      cleanup();
      this.active.delete(sessionId);
      entry.done.resolve();
    }
  }

  #beginSession(sessionId) {
    if (this.active.has(sessionId)) {
      throw runtimeError('BUSY', `Session ${sessionId} is already running a turn`, true, 'busy');
    }
    /** @type {any} */
    const done = {};
    done.promise = new Promise((resolveDone) => { done.resolve = resolveDone; });
    const entry = { controller: new AbortController(), done };
    this.active.set(sessionId, entry);
    return entry;
  }

  /** Follows the caller's signal (engine abort / dispose) through the turn's own controller. */
  #linkSignal(controller, external) {
    if (!external || typeof external.addEventListener !== 'function') return () => {};
    if (external.aborted) {
      controller.abort();
      return () => {};
    }
    const onAbort = () => controller.abort();
    external.addEventListener('abort', onAbort, { once: true });
    return () => external.removeEventListener('abort', onAbort);
  }

  #eventEmitter(onEvent) {
    if (typeof onEvent !== 'function') return () => {};
    return (event) => {
      try {
        onEvent(event);
      } catch (error) {
        this.logger.warn('minimax_bot.agent_event_failed', { type: event?.type, code: error?.code ?? 'unknown' });
      }
    };
  }

  #abortedTurn(session, turnId, emit) {
    const result = { sessionId: session.sessionId, turnId, status: /** @type {const} */ ('aborted') };
    emit({ type: 'turn.finished', sessionId: session.sessionId, turnId, status: 'aborted' });
    return result;
  }

  /** The one model-call loop: stream a reply, run its tool calls, feed them back, repeat. */
  async #modelLoop({ session, turnId, model, signal, emit, allow }) {
    const sessionId = session.sessionId;
    const tools = this.#toolList(allow);
    /** @type {string[]} */
    const texts = [];
    let toolRounds = 0;
    let started = false;
    for (;;) {
      if (signal.aborted) return this.#abortedTurn(session, turnId, emit);
      if (!started) {
        // The turn exists once the model is actually asked; engine.mjs uses this to decide the
        // input reached the Host and must not be sent again.
        emit({ type: 'turn.started', sessionId, turnId });
        started = true;
      }
      let response;
      try {
        response = await this.#streamCompletion({
          model,
          messages: session.messages,
          tools,
          signal,
          emit: (text) => emit({ type: 'text.delta', sessionId, turnId, text }),
        });
      } catch (error) {
        const failure = classifyNetworkFailure(error);
        emit({ type: 'turn.finished', sessionId, turnId, status: 'error', error: failure });
        return { sessionId, turnId, status: 'error', error: failure };
      }
      if (response.aborted) return this.#abortedTurn(session, turnId, emit);
      if (response.error) {
        emit({ type: 'turn.finished', sessionId, turnId, status: 'error', error: response.error });
        return { sessionId, turnId, status: 'error', error: response.error };
      }
      const assistantText = response.text ?? '';
      /** @type {any[]} */
      const toolCalls = response.toolCalls ?? [];
      if (assistantText) {
        // One complete assistant message, while `text.delta` already streamed the same words:
        // engine.mjs de-duplicates by prefix.
        emit({ type: 'message.committed', sessionId, turnId, text: assistantText });
        texts.push(assistantText);
      }
      /** @type {AgentMessage} */
      const assistantMessage = {
        role: 'assistant',
        content: assistantText || (toolCalls.length ? null : ''),
      };
      if (toolCalls.length) {
        assistantMessage.tool_calls = toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments || '{}' },
        }));
      }
      if (assistantText || toolCalls.length) {
        session.messages.push(assistantMessage);
        session.updatedAt = Date.now();
        await this.#persist(session);
      }
      if (!toolCalls.length) {
        const text = texts.join('\n\n');
        const result = { sessionId, turnId, status: /** @type {const} */ ('finished'), text };
        emit({ type: 'turn.finished', sessionId, turnId, status: 'finished', text });
        return result;
      }
      toolRounds += 1;
      if (toolRounds > this.maxToolRounds) {
        // Every tool call must keep a matching tool message, or a later continuation is invalid.
        this.#closeToolCalls(session, toolCalls, 'The turn stopped before this tool call ran.');
        await this.#persist(session);
        const failure = turnFailure(
          'invalid_request',
          `The turn exceeded its ${this.maxToolRounds} tool-call rounds and was stopped before it finished.`,
          false,
          'invalid_request',
        );
        emit({ type: 'turn.finished', sessionId, turnId, status: 'error', error: failure });
        return { sessionId, turnId, status: 'error', error: failure };
      }
      for (let index = 0; index < toolCalls.length; index += 1) {
        const call = toolCalls[index];
        if (signal.aborted) {
          this.#closeToolCalls(session, toolCalls.slice(index), 'The turn was aborted before this tool call ran.');
          await this.#persist(session);
          return this.#abortedTurn(session, turnId, emit);
        }
        emit({ type: 'tool.started', sessionId, turnId, name: call.name });
        const outcome = await this.#executeToolCall({ call, sessionId, turnId, signal, emit, allow });
        emit({ type: 'tool.finished', sessionId, turnId, name: call.name, ok: Boolean(outcome.ok) });
        if (outcome.aborted || signal.aborted) {
          session.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: outcome.content || 'The turn was aborted before this tool finished.',
          });
          this.#closeToolCalls(session, toolCalls.slice(index + 1), 'The turn was aborted before this tool call ran.');
          await this.#persist(session);
          return this.#abortedTurn(session, turnId, emit);
        }
        session.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: String(outcome.content ?? ''),
        });
      }
      session.updatedAt = Date.now();
      await this.#persist(session);
    }
  }

  /** Every assistant `tool_calls` entry needs a tool reply; this supplies the missing ones. */
  #closeToolCalls(session, calls, reason) {
    for (const call of calls) {
      session.messages.push({ role: 'tool', tool_call_id: call.id, content: reason });
    }
    session.updatedAt = Date.now();
  }

  // ------------------------------------------------------------------ tool execution
  async #executeToolCall({ call, sessionId, turnId, signal, emit, allow }) {
    const name = typeof call.name === 'string' ? call.name : '';
    /** @type {any} */
    let args = {};
    if (typeof call.arguments === 'string' && call.arguments.trim()) {
      try {
        args = JSON.parse(call.arguments);
      } catch {
        return { ok: false, content: `Invalid JSON arguments for ${name}: ${clip(call.arguments, 200)}` };
      }
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, content: `The arguments for ${name} must be a JSON object.` };
    }
    const target = this.#toolTarget(name, allow);
    if (!target) return { ok: false, content: `Unknown tool: ${name}` };
    if (target.kind === 'mcp' && !this.autoApprove && !READ_ONLY_MCP_TOOLS.includes(target.bare)) {
      const decision = await this.#requestPermission({ sessionId, turnId, name, args, signal, emit });
      if (decision === 'aborted') return { aborted: true, ok: false, content: '' };
      if (decision !== 'allow') {
        // The model is told why, and the turn continues without running the tool.
        return { ok: false, content: `The user denied permission for this tool call (${target.bare}). Continue without running it.` };
      }
    }
    try {
      if (target.kind === 'mcp') {
        const value = await /** @type {any} */ (this.callTool)(target.bare, args, signal);
        if (signal.aborted) return { aborted: true, ok: false, content: '' };
        return { ok: true, content: clip(serializeToolValue(value), TOOL_RESULT_LIMIT) };
      }
      const value = await this.#runBuiltin(target.name, args, signal);
      if (signal.aborted) return { aborted: true, ok: false, content: '' };
      return { ok: true, content: clip(serializeToolValue(value), TOOL_RESULT_LIMIT) };
    } catch (error) {
      if (signal.aborted) return { aborted: true, ok: false, content: '' };
      // A failed tool is a result for the model, not a crash of the turn.
      return { ok: false, content: `Tool ${target.kind === 'mcp' ? target.bare : target.name} failed: ${errorText(error)}` };
    }
  }

  #requestPermission({ sessionId, turnId, name, args, signal, emit }) {
    if (signal.aborted) return Promise.resolve('aborted');
    const requestId = newRequestId();
    return new Promise((resolveDecision) => {
      let settled = false;
      /** @param {string} decision */
      const settle = (decision) => {
        if (settled) return;
        settled = true;
        this.approvals.delete(requestId);
        signal.removeEventListener('abort', onAbort);
        resolveDecision(decision);
      };
      const onAbort = () => settle('aborted');
      this.approvals.set(requestId, { requestId, sessionId, settle });
      signal.addEventListener('abort', onAbort, { once: true });
      emit({
        type: 'permission.requested',
        sessionId,
        turnId,
        requestId,
        toolName: name,
        toolInput: clip(JSON.stringify(args ?? {}), 1500),
        reason: `The tool ${name} can change state and needs the user's approval before it runs.`,
      });
    });
  }

  // ------------------------------------------------------------------ built-in tools
  async #runBuiltin(name, args, signal) {
    switch (name) {
      case 'read_file':
        return this.#readFile(args);
      case 'write_file':
        return this.#writeFile(args);
      case 'edit_file':
        return this.#editFile(args);
      case 'list_dir':
        return this.#listDir(args);
      case 'run_command':
        return this.#runCommand(args, signal);
      default:
        throw new ToolError(`Unknown built-in tool: ${name}`);
    }
  }

  async #readFile(args) {
    const target = await this.#workspacePath(args.path);
    const content = await readFile(target, 'utf8');
    return { path: String(args.path), content: clip(content, 100_000) };
  }

  async #writeFile(args) {
    if (typeof args.content !== 'string') throw new ToolError('write_file needs a string content');
    const target = await this.#workspacePath(args.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, args.content, 'utf8');
    return { path: String(args.path), bytes: Buffer.byteLength(args.content, 'utf8') };
  }

  async #editFile(args) {
    const oldString = typeof args.old_string === 'string' ? args.old_string : '';
    if (!oldString) throw new ToolError('edit_file needs a non-empty old_string');
    const newString = typeof args.new_string === 'string' ? args.new_string : '';
    const target = await this.#workspacePath(args.path);
    const content = await readFile(target, 'utf8');
    const index = content.indexOf(oldString);
    if (index < 0) throw new ToolError(`old_string was not found in ${String(args.path)}`);
    // A literal splice: a replacement string would interpret `$&`-style patterns.
    const updated = `${content.slice(0, index)}${newString}${content.slice(index + oldString.length)}`;
    await writeFile(target, updated, 'utf8');
    return { path: String(args.path), replaced: true };
  }

  async #listDir(args) {
    const target = await this.#workspacePath(args.path ?? '.');
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(target, { withFileTypes: true });
    return {
      path: String(args.path ?? '.'),
      entries: entries
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** Runs a command through the platform shell. Output is truncated, never streamed. */
  #runCommand(args, signal) {
    if (!this.allowShell) throw new ToolError('Shell commands are disabled for this runtime');
    const command = typeof args.command === 'string' ? args.command : '';
    if (!command.trim()) throw new ToolError('run_command needs a command');
    return new Promise(async (resolvePromise, rejectPromise) => {
      let cwd;
      try {
        cwd = await this.#workspacePath(args.cwd ?? '.');
      } catch (error) {
        rejectPromise(error);
        return;
      }
      const child = spawn(command, {
        shell: true,
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      const collect = (chunk, append) => {
        const text = String(chunk);
        if (append === 'stdout') {
          const room = COMMAND_OUTPUT_LIMIT - stdout.length;
          if (room > 0) stdout += text.slice(0, room);
          if (text.length > room) truncated = true;
        } else {
          const room = COMMAND_OUTPUT_LIMIT - stderr.length;
          if (room > 0) stderr += text.slice(0, room);
          if (text.length > room) truncated = true;
        }
      };
      child.stdout?.on('data', (chunk) => collect(chunk, 'stdout'));
      child.stderr?.on('data', (chunk) => collect(chunk, 'stderr'));
      const onAbort = () => child.kill('SIGKILL');
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.commandTimeoutMs);
      timer.unref?.();
      child.on('error', (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        rejectPromise(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolvePromise({
          command,
          exitCode: typeof code === 'number' ? code : null,
          stdout,
          stderr,
          truncated,
          timedOut,
        });
      });
    });
  }

  /**
   * Resolves a model-supplied path inside the workspace, refusing anything that escapes it.
   * Symlinks are resolved for the nearest existing ancestor so a link cannot walk out either.
   */
  async #workspacePath(rawPath) {
    const root = this.workspaceRoot;
    const requested = typeof rawPath === 'string' && rawPath.trim() ? rawPath : '.';
    const target = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
    assertInsideWorkspace(root, target, requested);
    try {
      const realRoot = await realpath(root);
      let existing = target;
      for (let depth = 0; depth < 32; depth += 1) {
        try {
          const realTarget = await realpath(existing);
          assertInsideWorkspace(realRoot, realTarget, requested);
          break;
        } catch (error) {
          if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error;
          const parent = dirname(existing);
          if (parent === existing) break;
          existing = parent;
        }
      }
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error;
    }
    return target;
  }

  // ------------------------------------------------------------------ backend protocol
  /**
   * Streams one `/chat/completions` call. Text deltas are emitted as they arrive; the returned
   * value is the completed assistant message, or an abort/error classification.
   */
  async #streamCompletion({ model, messages, tools, signal, emit }) {
    /** @type {AbortController} */
    const controller = new AbortController();
    let timedOut = false;
    const onSignalAbort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onSignalAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    timer.unref?.();
    try {
      /** @type {any} */
      const body = {
        model: model.modelId,
        messages: messages.map((message) => ({ ...message })),
        stream: true,
      };
      if (tools.length) body.tools = tools;
      const effort = this.#reasoningEffort(model);
      if (effort) body.reasoning_effort = effort;
      /** @type {Record<string, string>} */
      const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const endpoint = this.#endpointFor(model);
      const response = await fetch(`${endpoint.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { ...headers, ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { error: classifyHttpFailure(response.status, detail) };
      }
      const contentType = String(response.headers.get('content-type') ?? '');
      if (!contentType.includes('text/event-stream')) {
        // Some compatible servers answer a streaming request with one JSON body anyway.
        const text = await response.text();
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          return { error: turnFailure('AGENT_UNAVAILABLE', 'The model service returned an unreadable response', true, 'network') };
        }
        const choice = payload?.choices?.[0];
        if (!choice) {
          return { error: turnFailure('AGENT_UNAVAILABLE', 'The model service returned no completion', true, 'network') };
        }
        const message = choice.message ?? choice.delta ?? {};
        const content = typeof message.content === 'string' ? message.content : '';
        if (content) emit(content);
        return { text: content, toolCalls: normalizeToolCallList(message.tool_calls) };
      }
      const parsed = await this.#readSseEvents(response.body, controller.signal, emit);
      return parsed;
    } catch (error) {
      if (timedOut) {
        return {
          error: turnFailure(
            'AGENT_UNAVAILABLE',
            `The model service did not answer within ${this.requestTimeoutMs} ms`,
            true,
            'timeout',
          ),
        };
      }
      if (controller.signal.aborted || signal.aborted) return { aborted: true };
      return { error: classifyNetworkFailure(error) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onSignalAbort);
    }
  }

  /** Parses an SSE stream into one assistant message (`text` + accumulated tool calls). */
  async #readSseEvents(body, signal, emit) {
    if (!body) {
      return { error: turnFailure('AGENT_UNAVAILABLE', 'The model service returned an empty stream', true, 'network') };
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawData = false;
    let done = false;
    let finishReason;
    const textParts = [];
    /** @type {Map<number, { id: string, name: string, arguments: string }>} */
    const calls = new Map();
    /** @returns {boolean} whether `[DONE]` ended the stream */
    const handleBlock = (block) => {
      let data = '';
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const piece = line.slice(5).replace(/^ /, '');
        data = data ? `${data}\n${piece}` : piece;
      }
      if (!data) return false;
      if (data.trim() === '[DONE]') return true;
      sawData = true;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        return false; // A comment or a malformed frame is skipped, not fatal.
      }
      const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
      if (!choice) return false;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? choice.message ?? {};
      const content = delta.content;
      if (typeof content === 'string' && content) {
        textParts.push(content);
        emit(content);
      } else if (Array.isArray(content)) {
        const joined = content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
        if (joined) {
          textParts.push(joined);
          emit(joined);
        }
      }
      for (const call of delta.tool_calls ?? []) {
        if (!call || typeof call !== 'object') continue;
        const index = Number.isInteger(call.index) ? call.index : 0;
        const entry = calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof call.id === 'string' && call.id) entry.id = call.id;
        if (typeof call.function?.name === 'string' && call.function.name) entry.name = call.function.name;
        if (typeof call.function?.arguments === 'string') entry.arguments += call.function.arguments;
        calls.set(index, entry);
      }
      return false;
    };
    try {
      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (handleBlock(block)) {
            done = true;
            break;
          }
        }
        if (done) break;
      }
      if (!done && buffer.trim()) handleBlock(buffer.replace(/\r\n/g, '\n'));
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed by the deserializer; nothing to release.
      }
    }
    if (signal.aborted) return { aborted: true };
    const toolCalls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, call]) => ({
        id: call.id || `call_${index}_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
        name: call.name,
        arguments: call.arguments,
      }));
    if (!sawData && !textParts.length && !toolCalls.length) {
      return { error: turnFailure('AGENT_UNAVAILABLE', 'The model service stream ended without content', true, 'network') };
    }
    return { text: textParts.join(''), toolCalls, finishReason };
  }

  // ------------------------------------------------------------------ sessions
  #sessionPath(sessionId) {
    return join(this.sessionsDir, `${sessionId}.json`);
  }

  async #loadSession(sessionId) {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    /** @type {any} */
    let stored;
    try {
      const text = await readFile(this.#sessionPath(sessionId), 'utf8');
      stored = JSON.parse(text);
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') {
        stored = undefined;
      } else {
        // A corrupt file is evidence, but not worth failing a turn over: start a fresh session.
        this.logger.warn('minimax_bot.agent_session_read_failed', {
          sessionId,
          code: /** @type {any} */ (error)?.code ?? 'unknown',
        });
        stored = undefined;
      }
    }
    /** @type {any} */
    const session = {
      sessionId,
      createdAt: Number.isFinite(stored?.createdAt) ? stored.createdAt : Date.now(),
      updatedAt: Number.isFinite(stored?.updatedAt) ? stored.updatedAt : Date.now(),
      messages: normalizeStoredMessages(stored?.messages),
      model: stored?.model && typeof stored.model === 'object' ? stored.model : undefined,
      // The tool surface the conversation has been running with, so a later continuation keeps it.
      allow: stored?.allow && typeof stored.allow === 'object'
        ? { mcp: Array.isArray(stored.allow.mcp) ? stored.allow.mcp : [], builtin: Array.isArray(stored.allow.builtin) ? stored.allow.builtin : [] }
        : undefined,
      existed: Boolean(stored),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  /** Writes the session atomically. A failed write is logged; a finished turn still stands. */
  async #persist(session) {
    const path = this.#sessionPath(session.sessionId);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(this.sessionsDir, { recursive: true });
      const handle = await open(tmp, 'w');
      try {
        await handle.writeFile(JSON.stringify({
          sessionId: session.sessionId,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          ...(session.model ? { model: session.model } : {}),
          ...(session.allow ? { allow: session.allow } : {}),
          messages: session.messages,
        }, null, 2), 'utf8');
        // Flush the bytes before the rename; a crash then never leaves a 0-byte session file.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, path);
    } catch (error) {
      this.logger.warn('minimax_bot.agent_session_write_failed', {
        sessionId: session.sessionId,
        code: /** @type {any} */ (error)?.code ?? 'unknown',
      });
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
}

/** A tool-calls array as parsed from a non-streamed completion. */
function normalizeToolCallList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((call) => call && typeof call === 'object')
    .map((call, index) => ({
      id: typeof call.id === 'string' && call.id ? call.id : `call_${index}_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      name: typeof call.function?.name === 'string' ? call.function.name : '',
      arguments: typeof call.function?.arguments === 'string'
        ? call.function.arguments
        : JSON.stringify(call.function?.arguments ?? {}),
    }));
}

/** Session ids name files: refuse anything that could walk out of the sessions directory. */
function normalizeSessionId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw runtimeError('INVALID_ARGUMENTS', 'A sessionId is required', false, 'invalid_request');
  }
  const sessionId = value.trim();
  if (!SESSION_ID_RE.test(sessionId)) {
    throw runtimeError('INVALID_ARGUMENTS', 'The sessionId contains unsupported characters', false, 'invalid_request');
  }
  return sessionId;
}
