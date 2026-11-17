// The DSH plugin inventory under the Bot form's capability picker.
//
// Read live on every form open, so a plugin installed later shows up without a restart. Plugins
// this runtime can hand a Bot are grouped by the capability pack they map to; the rest are listed
// as staying inside DSH's own agent, with the count, so the form never implies a switch exists.
import { t } from './i18n.js';

/**
 * @param {HTMLFormElement} form
 * @param {(tag: string, props?: any, ...children: any[]) => HTMLElement} h
 */
export async function loadInstalledPlugins(form, h) {
  const note = form.querySelector('.plugin-note');
  if (!note) return;
  let data;
  try {
    const response = await fetch('/api/plugins', { headers: { accept: 'application/json' } });
    if (!response.ok) return;
    data = await response.json();
  } catch {
    return;
  }
  const plugins = Array.isArray(data?.plugins) ? data.plugins : [];
  if (!plugins.length) return;

  const supported = plugins.filter((plugin) => plugin.supported);
  const other = plugins.filter((plugin) => !plugin.supported && plugin.enabled);
  /** @type {Map<string, any[]>} */
  const byPack = new Map();
  for (const plugin of supported) {
    const list = byPack.get(plugin.pack) ?? [];
    list.push(plugin);
    byPack.set(plugin.pack, list);
  }

  const rows = [];
  for (const [pack, list] of byPack) {
    rows.push(h('div', { class: 'plugin-row' },
      h('span', { class: 'plugin-pack' }, t('panels.capability.' + pack)),
      h('span', { class: 'plugin-from' }, list.map((plugin) => plugin.title).join('、'))));
  }

  const children = [h('div', { class: 'plugin-head' }, t('panels.bot.pluginsInstalled', { n: plugins.length }))];
  children.push(...rows);
  if (other.length) {
    children.push(h('details', { class: 'plugin-rest' },
      h('summary', null, t('panels.bot.pluginsUnavailable', { n: other.length })),
      h('ul', null, ...other.map((plugin) => h('li', { title: plugin.description || '' }, plugin.title)))));
  }
  note.hidden = false;
  note.replaceChildren(...children);
}
