// @ts-check
/**
 * What DSH has installed, in the shape the Bot form needs.
 *
 * The composed inventory is read the way the Loader composes it: every bundle the profile lists,
 * each bundle's own patch rows, then the profile's patch overriding them. That is the same set of
 * plugins the Plugins page shows, so a plugin installed later appears the next time the form opens
 * — nothing is cached.
 *
 * Each row also says which capability pack it corresponds to for a Bot here. Rows this runtime
 * cannot give a Bot are still listed, with the reason, so the form never pretends a switch works.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { dshSources, parseYamlLite } from './model-sync.mjs';

/** Which Bot capability pack a DSH plugin row corresponds to, if any. */
export const PLUGIN_PACKS = {
  'tool-fs': 'files',
  'tool-fs-search': 'files',
  'tool-str-replace-editor': 'files',
  'tool-bash': 'shell',
  'tool-pwsh': 'shell',
  'tool-bash-persistent': 'shell',
  'tool-pwsh-persistent': 'shell',
  'tool-terminal': 'shell',
  terminal: 'shell',
  'tool-subagent': 'helpers',
  'tool-subagent-control': 'helpers',
  'tool-agent-team': 'helpers',
  'agent-team': 'helpers',
  'tool-schedule': 'schedule',
  schedule: 'schedule',
  'tool-skill': 'memory',
  'skill-filesystem': 'memory',
};

/** Composition plumbing rather than a plugin a person installed. */
const NOT_A_PLUGIN = /^cordis:(group|include)$/;

/**
 * The dsh installation this process belongs to. `DSH_INSTALL_DIR` is only injected into agent
 * shells, not into the Electron main process that spawns this service, so it is derived from the
 * executable (Desktop) when the variable is absent.
 */
export function installDirectory(env = process.env) {
  if (env.DSH_INSTALL_DIR) return env.DSH_INSTALL_DIR;
  const execPath = /** @type {any} */ (process).execPath;
  if (!execPath) return '';
  // Desktop: <root>/DeepSeek Harness.exe → <root>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh
  const root = execPath.replace(/[\\/][^\\/]+$/, '');
  const packaged = join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh');
  return existsSync(packaged) ? packaged : '';
}

/** The patch file a package ships, whatever the convention calls it. */
const PATCH_FILE = 'cordis.patch.yml';

/** The bundles the profile composes, in order. */
export function readProfileBundles(profileDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    const list = manifest?.dsh?.profile?.bundles;
    if (Array.isArray(list)) return list.filter((name) => typeof name === 'string');
  } catch {
    // No readable profile manifest: the patch alone still yields the profile's own rows.
  }
  return [];
}

/** Resolves a package directory from the profile first, then from the dsh installation. */
export function resolvePackageDir(moduleName, { profileDir, installDir } = {}) {
  const candidates = [];
  if (profileDir) candidates.push(join(profileDir, 'node_modules', moduleName));
  if (installDir) {
    try {
      const requireFromDsh = createRequire(join(installDir, 'package.json'));
      candidates.push(join(requireFromDsh.resolve(moduleName + '/package.json'), '..'));
    } catch {
      candidates.push(join(installDir, 'node_modules', moduleName));
    }
  }
  return candidates.find((dir) => dir && existsSync(dir));
}

/** One bundle's patch rows, flattened from its insert lists. */
export function readBundleRows(bundleDir) {
  if (!bundleDir) return [];
  const patchPath = join(bundleDir, PATCH_FILE);
  if (!existsSync(patchPath)) return [];
  let rows;
  try {
    const document = parseYamlLite(readFileSync(patchPath, 'utf8'));
    rows = Array.isArray(document) ? document : [];
  } catch {
    return [];
  }
  /** @type {any[]} */
  const out = [];
  for (const entry of rows) {
    const inserted = entry && Array.isArray(entry.insert) ? entry.insert : [];
    for (const row of inserted) {
      if (!row || typeof row !== 'object') continue;
      if (typeof row.id !== 'string' || !row.id) continue;
      if (typeof row.name !== 'string' || !row.name) continue;
      if (NOT_A_PLUGIN.test(row.name)) continue;
      out.push({ id: row.id, moduleName: row.name, disabled: row.disabled === true, config: row.config });
    }
  }
  return out;
}

/** Every mounted row: bundle layers first, then the profile's patch overriding them. */
export function readPluginRows(patchPath, { profileDir, installDir } = {}) {
  /** @type {any[]} */
  const rows = [];
  /** @type {Map<string, any>} */
  const index = new Map();
  const add = (row) => {
    const existing = index.get(row.id);
    if (existing) {
      // The later layer decides enablement, exactly as the Loader composes it.
      if (row.disabled !== undefined) existing.disabled = row.disabled;
      return;
    }
    index.set(row.id, row);
    rows.push(row);
  };
  for (const bundle of readProfileBundles(profileDir ?? '')) {
    const dir = resolvePackageDir(bundle, { profileDir, installDir });
    for (const row of readBundleRows(dir)) add(row);
  }
  if (patchPath && existsSync(patchPath)) {
    let document;
    try {
      document = parseYamlLite(readFileSync(patchPath, 'utf8'));
    } catch {
      document = [];
    }
    for (const entry of Array.isArray(document) ? document : []) {
      if (!entry || typeof entry !== 'object') continue;
      for (const row of Array.isArray(entry.insert) ? entry.insert : []) {
        if (!row || typeof row.id !== 'string' || typeof row.name !== 'string') continue;
        if (NOT_A_PLUGIN.test(row.name)) continue;
        add({ id: row.id, moduleName: row.name, disabled: row.disabled === true, config: row.config });
      }
      // The profile patch also inserts rows directly: `- id: x` + `name: '@scope/pkg'` + config.
      if (typeof entry.id === 'string' && typeof entry.name === 'string' && !NOT_A_PLUGIN.test(entry.name)) {
        add({ id: entry.id, moduleName: entry.name, disabled: entry.disabled === true, config: entry.config });
      }
      if (typeof entry.id === 'string' && index.has(entry.id) && entry.disabled !== undefined) {
        index.get(entry.id).disabled = entry.disabled === true;
      }
    }
  }
  return rows;
}

/** A package's own `meta.title` / `meta.description`, when the package is readable. */
export function packageMeta(moduleName, installDir) {
  const dir = resolvePackageDir(moduleName, { installDir });
  if (!dir) return {};
  /** @type {any} */
  const meta = {};
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (typeof manifest.description === 'string') meta.description = manifest.description;
  } catch {
    // No manifest: the locale files below may still answer.
  }
  for (const locale of ['zh', 'en']) {
    const file = join(dir, 'locale', locale + '.json');
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed?.meta?.title) meta.title = String(parsed.meta.title);
      if (parsed?.meta?.description) meta.description = String(parsed.meta.description);
      break;
    } catch {
      // A malformed locale file falls back to the manifest description.
    }
  }
  return meta;
}

/**
 * The installed plugins, grouped the way the Plugins page groups them, with what a Bot gets from
 * each one here.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function readInstalledPlugins({ env = process.env } = {}) {
  const sources = dshSources(env);
  const installDir = installDirectory(env);
  const profileDir = join(sources.home, 'profiles', sources.profile);
  const rows = readPluginRows(sources.patchPath, { profileDir, installDir });
  /** @type {Array<any>} */
  const plugins = [];
  for (const row of rows) {
    const meta = packageMeta(row.moduleName, installDir);
    const pack = PLUGIN_PACKS[row.id] ?? PLUGIN_PACKS[row.moduleName] ?? null;
    const experimental = /experimental/i.test(row.moduleName) || /experimental/i.test(row.id);
    plugins.push({
      id: row.id,
      module: row.moduleName,
      title: meta.title || row.id,
      description: meta.description || '',
      group: experimental ? 'experimental' : 'builtin',
      enabled: !row.disabled,
      pack,
      // Only a row whose capability this runtime implements can be switched on for a Bot.
      supported: Boolean(pack),
      reason: pack ? '' : '这个插件运行在 DSH 主 Agent 内，Bot 进程加载不了它的工具',
    });
  }
  return { plugins, source: { patchPath: sources.patchPath, found: rows.length > 0 } };
}
