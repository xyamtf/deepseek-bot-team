// Clicking a Bot's avatar anywhere opens that Bot's settings drawer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../miniapp/client/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/bot' });
for (const key of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Node', 'Element', 'FormData', 'KeyboardEvent', 'Event']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
window.matchMedia = () => ({ matches: false, addEventListener() {} });
window.HTMLElement.prototype.scrollTo = function () {};
window.HTMLElement.prototype.scrollIntoView = function () {};
window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
URL.createObjectURL = () => 'blob:test';
URL.revokeObjectURL = () => {};
class FakeEventSource {
  static current;
  readyState = 1;
  constructor() { FakeEventSource.current = this; }
  close() { this.readyState = 2; }
}
globalThis.EventSource = FakeEventSource;

const fixture = {
  bots: [
    { id: 'bot_a', name: 'Rob', color: 'ocean', skin: 'fuzzy', isMain: true },
    { id: 'bot_b', name: 'Writer', color: 'ocean', skin: 'fuzzy', role: '写手' },
  ],
  groups: [], schedules: [], helpers: [], busyChats: [], turns: [], chats: {}, approvals: [], sessions: {}, agentAvailable: true,
  locale: 'en', settings: { language: 'en', userName: 'Test' }, user: { name: 'Test', systemName: 'Test' },
};
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

globalThis.fetch = async (url) => {
  const parsed = new URL(url, 'http://localhost');
  if (parsed.pathname === '/api/state') return response(structuredClone(fixture));
  if (parsed.pathname === '/api/locale') return response({});
  if (parsed.pathname === '/api/usage') return response({ byBot: [], totals: { turns: 0 } });
  if (parsed.pathname.startsWith('/api/memory/')) return response({ entries: [], budget: { used: 0, max: 4000, remaining: 4000 } });
  if (parsed.pathname.endsWith('/messages')) return response({ messages: [] });
  throw new Error('Unexpected request: ' + url);
};

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async () => { await tick(); await tick(); await tick(); };

// The app keeps a polling interval alive; unref it so this test process can exit on its own.
const setIntervalOriginal = globalThis.setInterval;
globalThis.setInterval = (...args) => { const id = setIntervalOriginal(...args); id.unref?.(); return id; };

await import('../miniapp/client/app.js');
const { state } = await import('../miniapp/client/core.js');
await settle();

const sidebarRows = () => [...document.querySelectorAll('#side-list .row')];
const rowFor = (name) => sidebarRows().find((row) => row.textContent.includes(name));

test('the sidebar avatar opens that Bot settings, not just the chat', async () => {
  const row = rowFor('Writer');
  assert.ok(row, 'Writer row is rendered');
  const avatar = row.querySelector('.mark-button');
  assert.ok(avatar, 'the row carries a clickable avatar');
  assert.equal(avatar.getAttribute('role'), 'button');
  assert.match(avatar.getAttribute('aria-label') ?? '', /Writer/);

  avatar.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();

  assert.equal(state.current, 'bot:bot_b', 'the Bot is selected');
  assert.equal(state.drawer.open, true, 'the drawer opens');
  assert.equal(state.drawer.view, 'settings', 'and shows its settings');
  assert.ok(document.getElementById('drawer').textContent.includes('Writer'), 'the drawer belongs to Writer');
});

test('the chat header avatar opens the settings of the open Bot', async () => {
  state.drawer.open = false;
  state.drawer.view = 'overview';
  const header = document.querySelector('.chat-head .mark-button') ?? document.querySelector('.pill .mark-button');
  assert.ok(header, 'the conversation header carries a clickable avatar');

  header.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();

  assert.equal(state.drawer.view, 'settings');
  assert.equal(state.current, 'bot:bot_b', 'clicking the header avatar keeps the context');
});

test('Enter on a focused avatar does the same as a click', async () => {
  state.drawer.open = false;
  // The main Bot is the big tile above the list, not a row.
  const avatar = document.querySelector('.tile-mark .mark-button');
  assert.ok(avatar, 'the main Bot tile carries a clickable avatar');
  avatar.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle();
  assert.equal(state.current, 'bot:bot_a');
  assert.equal(state.drawer.view, 'settings');
});
