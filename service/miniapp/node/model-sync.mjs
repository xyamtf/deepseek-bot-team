// @ts-check
/**
 * Sync the Bot team's model library with the one DeepSeek Harness already has.
 *
 * DSH keeps its providers in the profile's `cordis.patch.yml` (the `llm-pi-ai` row) and the keys
 * those rows name (`apiKeyEnv`) in `$DSH_HOME/.credentials.yaml` or the environment. This module
 * reads both, keeps the providers this runtime can actually speak to (OpenAI-compatible
 * `chat/completions`), and returns the catalog plus a per-provider base URL and key for the
 * runtime. Nothing here contacts the network and no key value is ever logged.
 *
 * The parser is a deliberately small YAML subset: mappings, `- ` list items, quoted scalars and
 * comments — the shape DSH writes. A file it cannot read yields an empty result, not a crash.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where DSH keeps the profile patch and its credentials. */
export function dshSources(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh');
  const profile = env.DSH_PROFILE || 'desktop';
  return {
    home,
    profile,
    patchPath: env.DSH_MODEL_PATCH || join(home, 'profiles', profile, 'cordis.patch.yml'),
    credentialsPath: env.DSH_CREDENTIALS || join(home, '.credentials.yaml'),
    envPath: join(home, '.env'),
  };
}

/** Strips a trailing `# comment` that is not inside quotes, then unquotes a scalar. */
function scalar(raw) {
  let text = String(raw ?? '').trim();
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) { text = text.slice(0, i).trim(); break; }
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text;
}

/**
 * A small YAML-subset parser: enough for the profile patch. Returns nested objects/arrays.
 * @param {string} text
 */
export function parseYamlLite(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  // A document whose first meaningful line is a list item has a list root; anything else is a map.
  const firstMeaningful = lines.find((line) => line.trim() && !/^\s*#/.test(line)) ?? '';
  /** @type {any} */
  const root = /^\s*-\s/.test(firstMeaningful) ? [] : {};
  /** @type {Array<{ indent: number, container: any, isList: boolean, key?: string, parent?: any }>} */
  const stack = [{ indent: -1, container: root, isList: Array.isArray(root) }];

  /** Starts a child container for `key:` and remembers where to re-attach a list. */
  const openChild = (frame, key, indent) => {
    const container = {};
    if (frame.isList) frame.container.push({ [key]: container });
    else frame.container[key] = container;
    stack.push({ indent, container, isList: false, key, parent: frame });
  };

  for (const rawLine of lines) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const frame = stack[stack.length - 1];

    if (line === '-' || line.startsWith('- ')) {
      const rest = line.slice(1).trim();
      if (!frame.isList) {
        // The list belongs to the frame's key, so it replaces the empty placeholder there.
        const list = [];
        if (frame.parent) frame.parent.container[frame.key] = list;
        else frame.container[frame.key] = list;
        // The list belongs to the key line, so its indent anchors siblings of that key.
        stack.push({ indent: frame.indent, container: list, isList: true });
      }
      const listFrame = stack[stack.length - 1];
      if (!rest) { listFrame.container.push(null); continue; }
      const pair = /^([^:]+):\s?(.*)$/.exec(rest);
      if (pair) {
        const itemKey = String(scalar(pair[1]));
        const itemValue = pair[2].trim();
        /** @type {any} */
        const item = {};
        listFrame.container.push(item);
        if (!itemValue || itemValue.startsWith('#')) {
          // `- key:` opens a block for that key: a following list or mapping belongs to it.
          const child = {};
          item[itemKey] = child;
          stack.push({ indent, container: child, isList: false, key: itemKey, parent: { container: item } });
        } else {
          item[itemKey] = scalar(itemValue);
          stack.push({ indent, container: item, isList: false });
        }
      } else {
        listFrame.container.push(scalar(rest));
      }
      continue;
    }

    const pair = /^([^:]+):\s?(.*)$/.exec(line);
    if (!pair) continue;
    const key = String(scalar(pair[1]));
    const value = pair[2].trim();
    if (!value || value.startsWith('#') || value.startsWith('!!')) {
      openChild(frame, key, indent);
    } else if (frame.isList) {
      frame.container.push({ [key]: scalar(value) });
    } else {
      frame.container[key] = scalar(value);
    }
  }
  return root;
}

/** The `llm-pi-ai` row's provider table, wherever it sits in the patch list. */
export function findProviders(document) {
  /** @type {any[]} */
  const queue = Array.isArray(document) ? [...document] : [document];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (node.id === 'llm-pi-ai' && node.config && node.config.providers) return node.config.providers;
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return undefined;
}

/** `NAME=value` lines from a dotenv file, or an empty map. */
export function readDotEnv(path) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!path || !existsSync(path)) return out;
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      out[match[1]] = value;
    }
  } catch {
    // An unreadable file simply contributes nothing.
  }
  return out;
}

/** The `refs:` table of `$DSH_HOME/.credentials.yaml`, which may hold the literal values. */
export function readCredentialRefs(path) {
  if (!path || !existsSync(path)) return {};
  try {
    const document = parseYamlLite(readFileSync(path, 'utf8'));
    const refs = document && typeof document === 'object' ? document.refs : undefined;
    return refs && typeof refs === 'object' ? refs : {};
  } catch {
    return {};
  }
}

/** Keeps only what this runtime can speak to: OpenAI-compatible chat completions. */
function supportedApi(value) {
  const api = String(value ?? 'openai-completions').trim();
  return api === 'openai-completions' || api === 'openai-chat' ? 'openai-completions' : undefined;
}

/**
 * Reads the DSH model library.
 *
 * @param {{ env?: NodeJS.ProcessEnv, sources?: ReturnType<typeof dshSources> }} [options]
 * @returns {{
 *   providers: Record<string, { baseURL: string, apiKey: string, api: 'openai-completions', displayName?: string }>,
 *   models: Array<{ providerId: string, modelId: string, displayName?: string }>,
 *   skipped: Array<{ providerId: string, api: string }>,
 *   source: { patchPath: string, found: boolean },
 * }}
 */
export function readDshModels({ env = process.env, sources = dshSources(env) } = {}) {
  /** @type {any} */
  const result = { providers: {}, models: [], skipped: [], source: { patchPath: sources.patchPath, found: false } };
  if (!sources.patchPath || !existsSync(sources.patchPath)) return result;
  let document;
  try {
    document = parseYamlLite(readFileSync(sources.patchPath, 'utf8'));
  } catch {
    return result;
  }
  const table = findProviders(document);
  if (!table || typeof table !== 'object') return result;
  result.source.found = true;

  const dotEnv = readDotEnv(sources.envPath);
  const refs = readCredentialRefs(sources.credentialsPath);
  const keyFor = (name) => {
    if (!name) return '';
    const fromEnv = env[name];
    if (typeof fromEnv === 'string' && fromEnv) return fromEnv;
    const fromDotEnv = dotEnv[name];
    if (typeof fromDotEnv === 'string' && fromDotEnv) return fromDotEnv;
    const fromRefs = refs[name];
    return typeof fromRefs === 'string' ? fromRefs : '';
  };

  for (const [providerId, raw] of Object.entries(table)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = /** @type {any} */ (raw);
    const api = supportedApi(entry.api);
    if (!api) {
      result.skipped.push({ providerId, api: String(entry.api ?? '') });
      continue;
    }
    const baseURL = typeof entry.baseURL === 'string' ? entry.baseURL.trim() : '';
    if (!baseURL) continue;
    const apiKey = keyFor(entry.apiKeyEnv);
    result.providers[providerId] = {
      baseURL,
      apiKey,
      api,
      ...(entry.displayName ? { displayName: String(entry.displayName) } : {}),
    };
    const models = Array.isArray(entry.models) ? entry.models : [];
    for (const model of models) {
      const modelId = typeof model?.id === 'string' ? model.id : typeof model === 'string' ? model : '';
      if (!modelId) continue;
      result.models.push({
        providerId,
        modelId,
        ...(typeof model.name === 'string' && model.name && model.name !== modelId ? { displayName: model.name } : {}),
      });
    }
  }
  return result;
}
