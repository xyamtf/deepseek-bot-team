// @ts-check
/**
 * Capability packs: a Bot can load only some of what the team offers.
 *
 * The three layers must agree 鈥?the store maps pack ids to tool names, the team layer validates
 * and persists a Bot's list, and the runtime offers the model exactly that list for its turns.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store, CAPABILITY_IDS, CAPABILITY_PACKS, normalizeCapabilities, resolveCapabilities } from '../miniapp/node/store.mjs';
import { MemoryStore } from '../miniapp/node/memory.mjs';
import { Team } from '../miniapp/node/team.mjs';
import { Engine } from '../miniapp/node/engine.mjs';
import { AgentRuntime, MCP_TOOL_PREFIX } from '../miniapp/node/agent-runtime.mjs';
import { setLocale } from '../miniapp/node/i18n.mjs';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** A team fixture: a real store on a temp directory and the layers above it. */
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bot-capabilities-'));
  const store = new Store(dir);
  await store.init();
  const memory = new MemoryStore(dir);
  await memory.init();
  setLocale('en');
  store.state.bots = [{ id: 'bot_main', name: 'Chief', isMain: true, skin: 'whale', role: 'Coordinator' }];
  await store.save();
  const engine = new Engine({ store, memory, logger: silentLogger, broadcast() {} });
  const team = new Team({ store, memory, engine, broadcast() {} });
  t.after(async () => {
    engine.dispose();
    await store.writeChain;
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, store, memory, engine, team };
}

/** A backend that answers one scripted turn and records the request it received. */
async function backend(t) {
  /** @type {any[]} */
  const requests = [];
  /** @type {any[]} */
  const queue = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { body = undefined; }
      requests.push(body);
      const step = queue.shift() ?? { frames: [] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of step.frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {any} */ (server.address());
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });
  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    push(...steps) { queue.push(...steps); return this; },
  };
}

const textChunk = (text) => ({ choices: [{ index: 0, delta: { content: text } }] });
const toolChunk = (id, name, args) => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] } }],
});

test('pack ids map to the tools each one unlocks, split by where they run', () => {
  assert.deepEqual(CAPABILITY_IDS, ['team', 'helpers', 'memory', 'schedule', 'files', 'shell']);
  const all = resolveCapabilities(CAPABILITY_IDS);
  assert.ok(all);
  assert.ok(all.mcp.includes('list_team'));
  assert.ok(all.mcp.includes('remember'));
  assert.ok(all.builtin.includes('read_file'));
  assert.ok(all.builtin.includes('run_command'));
  // Built-ins never leak into the MCP half and vice versa.
  assert.equal(all.mcp.includes('read_file'), false);
  assert.equal(all.builtin.includes('list_team'), false);

  const memoryOnly = resolveCapabilities(['memory']);
  assert.deepEqual(memoryOnly, { mcp: ['remember', 'recall', 'forget'], builtin: [] });
  // No list at all means every tool, which is how Bots made before this work.
  assert.equal(resolveCapabilities(undefined), undefined);
  assert.deepEqual(resolveCapabilities([]), { mcp: [], builtin: [] });
});

test('stored capability lists drop unknown ids and keep the canonical order', () => {
  assert.deepEqual(normalizeCapabilities(['memory', 'nope', 'team']), ['team', 'memory']);
  assert.deepEqual(normalizeCapabilities([]), []);
  assert.equal(normalizeCapabilities(undefined), undefined);
  assert.equal(normalizeCapabilities('team'), undefined);
});

test('a Bot is created with the packs it was given, and unknown ids are refused', async (t) => {
  const { team } = await fixture(t);
  const bot = await team.createBot(undefined, { name: 'Writer', capabilities: ['memory', 'files'] });
  assert.deepEqual(bot.capabilities, ['memory', 'files']);

  await assert.rejects(
    team.createBot(undefined, { name: 'Nope', capabilities: ['memory', 'telepathy'] }),
    (error) => /** @type {any} */ (error).code === 'invalid' && /telepathy/.test(String(error.message)),
  );
  await assert.rejects(
    team.createBot(undefined, { name: 'Shape', capabilities: 'memory' }),
    (error) => /** @type {any} */ (error).code === 'invalid',
  );
  // A Bot created without the field keeps every capability.
  const plain = await team.createBot(undefined, { name: 'Plain' });
  assert.equal(plain.capabilities, undefined);
});

test('the main Bot always keeps the team pack', async (t) => {
  const { team } = await fixture(t);
  const bot = await team.createBot(undefined, { name: 'Boss', isMain: true, capabilities: ['memory'] });
  assert.deepEqual(bot.capabilities, ['team', 'memory']);

  // Promoting a limited Bot to main adds the pack back through the same rule.
  const helper = await team.createBot(undefined, { name: 'Helper', capabilities: ['memory'] });
  assert.deepEqual(helper.capabilities, ['memory']);
  const promoted = await team.updateBot(undefined, helper.id, { isMain: true });
  assert.deepEqual(promoted.capabilities, ['team', 'memory']);
});

test('update accepts a new list and a full list means every pack again', async (t) => {
  const { team } = await fixture(t);
  const bot = await team.createBot(undefined, { name: 'Scout', capabilities: ['memory'] });
  const narrowed = await team.updateBot(undefined, bot.id, { capabilities: ['files', 'shell'] });
  assert.deepEqual(narrowed.capabilities, ['files', 'shell']);
  const restored = await team.updateBot(undefined, bot.id, { capabilities: CAPABILITY_IDS });
  assert.deepEqual(restored.capabilities, CAPABILITY_IDS);
});

test('a runtime turn offers only the allowed tools, and refuses the rest', async (t) => {
  const server = await backend(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'bot-cap-runtime-'));
  const runtime = new AgentRuntime({ dataDir, logger: silentLogger, config: { api: { baseURL: server.baseURL, apiKey: 'k' } } });
  runtime.attachTools({
    toolDefs: [
      { name: 'list_team', description: 'roster', inputSchema: { type: 'object', properties: {} } },
      { name: 'message_bot', description: 'delegate', inputSchema: { type: 'object', properties: {} } },
    ],
    call: async () => ({ ok: true }),
  });
  t.after(async () => {
    await runtime.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  const allow = resolveCapabilities(['memory', 'files']);
  assert.ok(allow);
  server.push(
    { frames: [toolChunk('c1', `${MCP_TOOL_PREFIX}list_team`, '{}')] },
    { frames: [toolChunk('c2', 'read_file', JSON.stringify({ path: 'x.txt' }))] },
    { frames: [textChunk('done')] },
  );
  /** @type {any[]} */
  const events = [];
  const result = await runtime.run({ text: 'go', tools: allow }, { onEvent: (event) => events.push(event) });

  const offered = server.requests[0].tools.map((tool) => tool.function.name);
  assert.deepEqual(offered.sort(), ['edit_file', 'list_dir', 'read_file', 'write_file']);
  assert.equal(offered.includes(`${MCP_TOOL_PREFIX}list_team`), false);

  // A tool the turn was not offered is refused, and the refusal reaches the model.
  const refused = server.requests[1].messages.filter((message) => message.role === 'tool').at(0);
  assert.match(refused.content, /Unknown tool/);
  const finished = events.filter((event) => event.type === 'tool.finished');
  assert.equal(finished.length, 2);
  assert.equal(finished[0].ok, false);

  // The allowed built-in still ran (the workspace file does not exist, so it failed for that reason).
  const secondTool = server.requests[2].messages.filter((message) => message.role === 'tool').at(-1);
  assert.doesNotMatch(secondTool.content, /Unknown tool/);
  assert.equal(result.status, 'finished');
});

test('a limited session keeps its tool surface across the questionnaire answer', async (t) => {
  const server = await backend(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'bot-cap-answer-'));
  const runtime = new AgentRuntime({ dataDir, logger: silentLogger, config: { api: { baseURL: server.baseURL, apiKey: 'k' } } });
  runtime.attachTools({
    toolDefs: [{ name: 'list_team', inputSchema: { type: 'object', properties: {} } }],
    call: async () => ({ ok: true }),
  });
  t.after(async () => {
    await runtime.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  server.push({ frames: [textChunk('Which colour?')] }, { frames: [textChunk('Blue.')] });
  const first = await runtime.run({ text: 'pick', tools: { mcp: [], builtin: [] } });
  const second = await runtime.answer({ sessionId: first.sessionId, requestId: 'q', answers: [] });
  assert.equal(second.status, 'finished');
  for (const request of server.requests) {
    assert.equal(request.tools, undefined, 'a session with no capabilities offers no tools at all');
  }
});

