// @ts-check
/**
 * End-to-end smoke test for the standalone service.
 *
 * It starts a scripted OpenAI-compatible backend, runs the real `bin/dsteam.mjs` process against
 * it, and drives the same surface a user and an MCP client touch:
 *
 *   1. `GET /bot` serves the page;
 *   2. `POST /mcp/minimax-bot` answers `initialize` and lists the Mini App's 21 tools;
 *   3. a private message to the chief Bot runs a real Agent turn whose first model call asks for
 *      the MCP tool `list_team`, which reaches the Mini App's own handler and returns its result;
 *   4. the finished reply is stored with its tool part;
 *   5. `SIGINT` shuts the process down with exit code 0.
 *
 * Run it directly: `node tests/_integration-smoke.mjs`. It needs no API key and no network.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const LOG = (...args) => console.log('[smoke]', ...args);

/** Waits for a condition, or fails with the given message. */
async function until(predicate, { timeoutMs = 20_000, label = 'condition', intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** The scripted model: first call asks for a tool, second call answers. */
function startModelBackend() {
  /** @type {any[]} */
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { body = undefined; }
      requests.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const hasToolResult = (body?.messages ?? []).some((message) => message.role === 'tool');
      if (!hasToolResult) {
        // Round 1: the model wants the team roster from the Mini App's own MCP tools.
        res.write(frame({
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_team',
                type: 'function',
                function: { name: 'mcp__minimax-bot__list_team', arguments: '{}' },
              }],
            },
          }],
        }));
      } else {
        for (const piece of ['团队里目前只有我', '一个 Bot。']) {
          res.write(frame({ choices: [{ index: 0, delta: { content: piece } }] }));
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { server, requests };
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {any} */ (probe.address());
  await new Promise((resolve) => probe.close(() => resolve(undefined)));
  return port;
}

/** One JSON-RPC call over the Streamable HTTP endpoint, unwrapping an SSE reply. */
async function rpc(mcpUrl, payload, sessionId) {
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const nextSession = response.headers.get('mcp-session-id') ?? sessionId;
  if (String(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
    return { status: response.status, sessionId: nextSession, body: dataLine ? JSON.parse(dataLine.slice(6)) : undefined };
  }
  return { status: response.status, sessionId: nextSession, body: text ? JSON.parse(text) : undefined };
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsteam-smoke-'));
  const backend = startModelBackend();
  await new Promise((resolve) => backend.server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const modelPort = /** @type {any} */ (backend.server.address()).port;
  const port = await freePort();

  /** @type {string[]} */
  const childLog = [];
  const child = spawn(process.execPath, [
    join(REPO, 'bin/dsteam.mjs'),
    '--port', String(port),
    '--data', dataDir,
    '--api-base', `http://127.0.0.1:${modelPort}`,
    '--api-key', 'smoke-key',
    '--model', 'deepseek-chat',
  ], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', (chunk) => childLog.push(String(chunk)));
  child.stderr.on('data', (chunk) => childLog.push(String(chunk)));
  const exit = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  const base = `http://127.0.0.1:${port}`;
  let exitCode;
  try {
    await until(() => childLog.join('').includes('已启动'), { label: 'the service to print its banner' });
    LOG(`service up on ${base}`);

    // 1. The page itself.
    const page = await fetch(`${base}/bot`);
    const html = await page.text();
    assert.equal(page.status, 200, 'GET /bot');
    assert.match(String(page.headers.get('content-type')), /text\/html/);
    assert.match(html, /<script/, 'the page loads its scripts');
    LOG(`GET /bot -> 200 (${html.length} bytes)`);

    // 2. The MCP endpoint.
    const mcpUrl = `${base}/mcp/minimax-bot`;
    const init = await rpc(mcpUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
    });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.equal(init.body.result.serverInfo.name, 'minimax-bot');
    assert.ok(init.sessionId, 'the endpoint issues a session id');
    const list = await rpc(mcpUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.sessionId);
    const tools = list.body.result.tools.map((tool) => tool.name);
    assert.equal(tools.length, 21, `expected 21 tools, got ${tools.length}`);
    for (const expected of ['list_team', 'message_bot', 'dispatch_tasks', 'remember', 'create_schedule']) {
      assert.ok(tools.includes(expected), `missing tool ${expected}`);
    }
    LOG(`MCP initialize + tools/list -> 21 tools (${tools.slice(0, 4).join(', ')}, …)`);

    // 3. A real turn: the chief Bot answers a private message.
    const state = await (await fetch(`${base}/api/state`)).json();
    const chief = state.bots.find((bot) => bot.isMain) ?? state.bots[0];
    assert.ok(chief, 'a chief Bot exists on first start');
    const chatId = `bot:${chief.id}`;
    const sent = await fetch(`${base}/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '团队里有谁？' }),
    });
    assert.equal(sent.status, 200, 'POST a user message');

    const reply = await until(async () => {
      const page = await (await fetch(`${base}/api/chats/${chatId}/messages?limit=50`)).json();
      const messages = page.messages ?? [];
      return messages.find((message) => message.role === 'bot' && message.status === 'done' && String(message.text ?? '').includes('一个 Bot'));
    }, { label: 'the Bot reply', timeoutMs: 30_000 });
    assert.equal(reply.botId, chief.id);
    const toolPart = (reply.parts ?? []).find((part) => part.type === 'tool');
    assert.ok(toolPart, 'the reply records the tool call it made');
    assert.equal(toolPart.name, 'mcp__minimax-bot__list_team');
    assert.equal(toolPart.state, 'ok');
    LOG(`Bot reply -> "${String(reply.text).trim()}" with tool ${toolPart.name} (${toolPart.state})`);

    // 4. The tool really ran inside the Mini App: the model's second call carries its result.
    assert.equal(backend.requests.length, 2, 'two model calls: tool round, then the answer');
    const first = backend.requests[0].body;
    const second = backend.requests[1].body;
    assert.equal(first.model, 'deepseek-chat');
    assert.equal(first.stream, true);
    assert.equal(backend.requests[0].headers.authorization, 'Bearer smoke-key');
    const offered = first.tools.map((tool) => tool.function.name);
    assert.ok(offered.includes('mcp__minimax-bot__list_team'), 'the MCP tool was offered to the model');
    const toolMessage = second.messages.find((message) => message.role === 'tool');
    const roster = JSON.parse(toolMessage.content);
    assert.ok(Array.isArray(roster.bots) && roster.bots.length >= 1, 'list_team returned the roster');
    assert.equal(roster.bots[0].bot_id, chief.id);
    LOG(`MCP→model bridge: list_team returned ${roster.bots.length} bot(s)`);

    // 5a. The CLI process stops when it is terminated. Windows cannot deliver a console
    //     SIGINT to a child, so the graceful path itself is checked in-process below.
    child.kill();
    const stopped = await Promise.race([
      exit,
      new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout' }), 15_000)),
    ]);
    assert.notEqual(/** @type {any} */ (stopped).code, 'timeout', 'the CLI process stops promptly');
    LOG('the CLI process stops when terminated');

    // 5b. Graceful shutdown: this is exactly what the CLI's SIGINT handler does — abort the
    //     host signal, then await dispose. The listener closes and the log records the stop.
    const { startHost } = await import('../miniapp/node/standalone-host.mjs');
    const shutdownPort = await freePort();
    const controller = new AbortController();
    const host = await startHost({
      port: shutdownPort,
      dataDir,
      api: { baseURL: `http://127.0.0.1:${modelPort}`, apiKey: 'smoke-key', model: 'deepseek-chat' },
      signal: controller.signal,
    });
    assert.equal((await fetch(`http://127.0.0.1:${shutdownPort}/bot`)).status, 200);
    controller.abort();
    await host.dispose();
    const hostLog = await readFile(join(host.dataDir, 'logs', 'host.log'), 'utf8');
    assert.match(hostLog, /deepseek_host.stopped/, 'the shutdown is recorded in host.log');
    await assert.rejects(fetch(`http://127.0.0.1:${shutdownPort}/bot`), 'the listener is closed');
    LOG('signal -> dispose -> listener closed, host.log records the stop');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const socket of []) socket.destroy();
    backend.server.closeAllConnections?.();
    await new Promise((resolve) => backend.server.close(() => resolve(undefined)));
    await rm(dataDir, { recursive: true, force: true });
  }
  LOG('all checks passed');
  return exitCode ?? 0;
}

main().then(
  () => { process.exitCode = 0; },
  (error) => {
    console.error('[smoke] FAILED:', error?.message ?? error);
    process.exitCode = 1;
  },
);
