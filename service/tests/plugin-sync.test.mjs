// @ts-check
/**
 * The installed-plugin list under the Bot form's capability picker.
 *
 * The list comes from `/api/plugins`, which reads the composed profile inventory live: bundle
 * patches first, then the profile's own layer. These tests pin the inventory parser against a
 * synthetic profile (bundles, overrides, a later-installed plugin) and check the form's note.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PLUGIN_PACKS, readBundleRows, readInstalledPlugins, readPluginRows, readProfileBundles, resolvePackageDir } from '../miniapp/node/plugin-sync.mjs';

const BASE_PATCH = `- insert:
    - id: tool-fs
      name: '@deepseek-ai/dsh-tool-fs'
    - id: tool-bash
      name: '@deepseek-ai/dsh-tool-bash'
    - id: tool-web
      name: '@deepseek-ai/dsh-tool-web'
    - id: cordis:group
      name: cordis:group
`;

const PROFILE_PATCH = `# profile layer
- id: tool-bash
  disabled: true
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
`;

/** A profile whose manifest lists one bundle, plus a package with locale metadata. */
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'bot-plugins-'));
  const profileDir = join(home, 'profiles', 'desktop');
  const bundleDir = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-base');
  const localeDir = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-tool-fs');
  await mkdir(bundleDir, { recursive: true });
  await mkdir(join(localeDir, 'locale'), { recursive: true });
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }), 'utf8');
  await writeFile(join(bundleDir, 'cordis.patch.yml'), BASE_PATCH, 'utf8');
  await writeFile(join(localeDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tool-fs', description: 'File tools' }), 'utf8');
  await writeFile(join(localeDir, 'locale', 'zh.json'), JSON.stringify({ meta: { title: '文件读写工具', description: '读写文件' } }), 'utf8');
  const patchPath = join(profileDir, 'cordis.patch.yml');
  await writeFile(patchPath, PROFILE_PATCH, 'utf8');
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, profileDir, patchPath };
}

test('a profile manifest lists its bundles', async (t) => {
  const { profileDir } = await fixture(t);
  assert.deepEqual(readProfileBundles(profileDir), ['@deepseek-ai/dsh-base']);
});

test('a bundle patch flattens insert rows and drops composition plumbing', async (t) => {
  const { profileDir } = await fixture(t);
  const dir = resolvePackageDir('@deepseek-ai/dsh-base', { profileDir });
  assert.ok(dir);
  const rows = readBundleRows(dir);
  assert.deepEqual(rows.map((row) => row.id), ['tool-fs', 'tool-bash', 'tool-web']);
});

test('the profile layer overrides enablement and inserts its own rows', async (t) => {
  const { profileDir, patchPath } = await fixture(t);
  const rows = readPluginRows(patchPath, { profileDir });
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  // Bundle order first, then the rows the profile itself mounts; an override never duplicates.
  assert.deepEqual(rows.map((row) => row.id), ['tool-fs', 'tool-bash', 'tool-web', 'locale', 'tool-pwsh']);
  assert.equal(byId['tool-bash'].disabled, true);
  assert.equal(byId['tool-fs'].disabled, false);
  assert.equal(byId['tool-pwsh'].moduleName, '@deepseek-ai/dsh-tool-pwsh');
});

test('the inventory maps packs, reads locale metadata and explains the rest', async (t) => {
  const { home, profileDir } = await fixture(t);
  const out = readInstalledPlugins({
    env: { DSH_HOME: home, DSH_PROFILE: 'desktop', DSH_INSTALL_DIR: profileDir },
  });
  assert.equal(out.source.found, true);
  const byId = Object.fromEntries(out.plugins.map((plugin) => [plugin.id, plugin]));

  assert.equal(byId['tool-fs'].title, '文件读写工具');
  assert.equal(byId['tool-fs'].pack, PLUGIN_PACKS['tool-fs']);
  assert.equal(byId['tool-fs'].supported, true);
  assert.equal(byId['tool-fs'].group, 'builtin');

  // A disabled row is still listed, flagged, so the form can explain the state.
  assert.equal(byId['tool-bash'].enabled, false);

  // A plugin this runtime cannot hand to a Bot says so instead of offering a switch.
  assert.equal(byId['tool-web'].supported, false);
  assert.match(byId['tool-web'].reason, /DSH 主 Agent/);

  // The plan checks the CORS preflight the page sends.
  assert.ok(out.plugins.every((plugin) => typeof plugin.title === 'string'));
});
