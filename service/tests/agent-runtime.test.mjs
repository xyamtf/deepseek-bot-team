// @ts-check
/**
 * The standalone DeepSeek runtime, exercised against a scripted OpenAI-compatible backend.
 *
 * Every test starts a real local HTTP server that answers `/chat/completions` with SSE frames or
 * a plain JSON body, so the runtime's streaming parser, tool loop, permission flow and error
 * classification all run as they would against a real provider. No API key or network is used.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRuntime, MCP_TOOL_PREFIX } from '../miniapp/node/agent-runtime.mjs';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** One SSE frame carrying a chat-completion chunk. */
const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
/** An assistant text chunk. */
const textChunk = (text) => ({ choices: [{ index: 0, delta: { content: text } }] });
/** An assistant tool-call chunk (spread arguments across chunks like a real provider). */
const toolChunk = (index, id, name, args) => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }] } }],
});

/**
 * A scripted backend. Each request pops one step from the queue:
 *  - `{ sse: [...frames], hang? }` streams frames (and keeps the response open when `hang`)
 *  - `{ json, status?, contentType? }` answers one JSON body
 *  - `{ status, errorText }` answers an HTTP error
 */
async function mockBackend(t) {
  /** @type {Array<any>} */
  const queue = [];
  /** @type {Array<{ url: string, headers: any, body: any, raw: string }>} */
  const requests = [];
  /** @type {Set<any>} */
  const sockets = new Set();

  const apply = (step, res) => {
    if (step.hang && !step.sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return;
    }
    if (step.errorText !== undefined) {
      res.writeHead(step.status, { 'content-type': 'application/json' });
      res.end(step.errorText);
      return;
    }
    if (step.json !== undefined) {
      res.writeHead(step.status ?? 200, { 'content-type': step.contentType ?? 'application/json' });
      res.end(typeof step.json === 'string' ? step.json : JSON.stringify(step.json));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const item of step.sse ?? []) res.write(typeof item === 'string' ? item : frame(item));
    if (step.hang) return;
    res.write('data: [DONE]\n\n');
    res.end();
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { body = undefined; }
      requests.push({ url: String(req.url), headers: req.headers, body, raw });
      const step = queue.shift();
      if (!step) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no scripted response left' }));
        return;
      }
      apply(step, res);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {any} */ (server.address());
  t.after(async () => {
    // A hanging response keeps a socket open; destroy it so the server can close.
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    push(...steps) { queue.push(...steps); return this; },
    remaining() { return queue.length; },
  };
}

/** A runtime over a fresh data directory and a scripted backend. */
async function setup(t, { runtime: runtimeConfig = {}, api: apiConfig = {}, logger = silentLogger } = {}) {
  const backend = await mockBackend(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-runtime-'));
  const config = {
    api: { baseURL: backend.baseURL, apiKey: 'test-key', model: 'deepseek-chat', ...apiConfig },
    runtime: { ...runtimeConfig },
  };
  const runtime = new AgentRuntime({ dataDir, logger, config });
  t.after(async () => {
    await runtime.dispose();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { backend, dataDir, runtime, config };
}

/** Collects every event a turn emits. */
function record() {
  /** @type {any[]} */
  const events = [];
  return { events, onEvent: (event) => events.push(event), types: () => events.map((event) => event.type) };
}

test('models() reflects the configured catalog and its default', async (t) => {
  const { runtime } = await setup(t, {
    runtime: {
      providerId: 'deepseek',
      models: [
        { modelId: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner', thinking: { efforts: ['low', 'high'] } },
        { modelId: 'deepseek-chat' },
      ],
    },
    api: { model: 'deepseek-chat' },
  });
  const catalog = await runtime.models();
  assert.deepEqual(catalog.default, { providerId: 'deepseek', modelId: 'deepseek-chat' });
  assert.equal(catalog.models.length, 2);
  const reasoner = catalog.models.find((entry) => entry.modelId === 'deepseek-reasoner');
  assert.equal(reasoner.displayName, 'DeepSeek Reasoner');
  assert.deepEqual(reasoner.thinking.efforts, ['low', 'high']);
});

test('a plain turn streams text and emits the contract events in order', async (t) => {
  const { runtime, backend } = await setup(t);
  backend.push({ sse: [textChunk('Hello'), textChunk(' world')] });
  const recorder = record();
  const result = await runtime.run({ text: 'Say hello' }, { onEvent: recorder.onEvent });

  assert.equal(result.status, 'finished');
  assert.equal(result.text, 'Hello world');
  assert.match(result.sessionId, /^ses_/);
  assert.ok(result.turnId);
  assert.deepEqual(recorder.types(), ['turn.started', 'text.delta', 'text.delta', 'message.committed', 'turn.finished']);
  const committed = recorder.events.find((event) => event.type === 'message.committed');
  assert.equal(committed.text, 'Hello world');
  const finished = recorder.events.at(-1);
  assert.equal(finished.status, 'finished');
  assert.equal(finished.text, 'Hello world');
});

test('the request carries the model, streaming flag, tools and the API key', async (t) => {
  const { runtime, backend } = await setup(t);
  backend.push({ sse: [textChunk('ok')] });
  await runtime.run({ text: 'hi' });
  const request = backend.requests[0];
  assert.equal(request.url, '/chat/completions');
  assert.equal(request.body.model, 'deepseek-chat');
  assert.equal(request.body.stream, true);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(request.headers.authorization, 'Bearer test-key');
  const names = request.body.tools.map((tool) => tool.function.name);
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('write_file'));
  assert.ok(names.includes('run_command'));
  // No MCP tool is offered until the Mini App attaches its catalogue.
  assert.ok(!names.some((name) => name.startsWith(MCP_TOOL_PREFIX)));
});

test('a selected model and its reasoning effort reach the request', async (t) => {
  const { runtime, backend } = await setup(t, {
    runtime: { models: [{ modelId: 'deepseek-reasoner', thinking: { efforts: ['low', 'high'] } }, { modelId: 'deepseek-chat' }] },
  });
  backend.push({ sse: [textChunk('deep')] });
  await runtime.run({
    text: 'think',
    model: { providerId: 'deepseek', modelId: 'deepseek-reasoner', thinking: { effort: 'high' } },
  });
  assert.equal(backend.requests[0].body.model, 'deepseek-reasoner');
  assert.equal(backend.requests[0].body.reasoning_effort, 'high');

  // An empty variant means "thinking off" and must suppress the effort field.
  backend.push({ sse: [textChunk('plain')] });
  await runtime.run({
    text: 'plain',
    model: { providerId: 'deepseek', modelId: 'deepseek-reasoner', variant: '', thinking: { effort: 'high' } },
  });
  assert.equal(backend.requests[1].body.reasoning_effort, undefined);
});

test('an unknown model is refused before the backend is called', async (t) => {
  const { runtime, backend } = await setup(t);
  await assert.rejects(
    runtime.run({ text: 'x', model: { providerId: 'deepseek', modelId: 'not-in-catalog' } }),
    (error) => /** @type {any} */ (error).code === 'INVALID_ARGUMENTS',
  );
  assert.equal(backend.requests.length, 0);
});

test('an MCP tool call is bridged, its result fed back, and the turn continues', async (t) => {
  const { runtime, backend } = await setup(t);
  /** @type {Array<{ name: string, args: any }>} */
  const calls = [];
  runtime.attachTools({
    toolDefs: [{ name: 'list_team', description: 'List every Bot', inputSchema: { type: 'object', properties: {} } }],
    call: async (name, args) => { calls.push({ name, args }); return { bots: [{ id: 'bot_a' }] }; },
  });

  backend.push({
    sse: [
      toolChunk(0, 'call_1', `${MCP_TOOL_PREFIX}list_team`, '{"reason":'),
      toolChunk(0, 'call_1', `${MCP_TOOL_PREFIX}list_team`, '"check"}'),
    ],
  });
  backend.push({ sse: [textChunk('There is one Bot.')] });

  const recorder = record();
  const result = await runtime.run({ text: 'Who is on the team?' }, { onEvent: recorder.onEvent });

  assert.equal(result.status, 'finished');
  assert.equal(result.text, 'There is one Bot.');
  assert.deepEqual(calls, [{ name: 'list_team', args: { reason: 'check' } }]);
  const started = recorder.events.filter((event) => event.type === 'tool.started');
  const finished = recorder.events.filter((event) => event.type === 'tool.finished');
  assert.equal(started.length, 1);
  assert.equal(started[0].name, `${MCP_TOOL_PREFIX}list_team`);
  assert.equal(finished[0].ok, true);

  // The model's catalogue now offers the attached tool under the prefixed name.
  assert.ok(backend.requests[0].body.tools.some((tool) => tool.function.name === `${MCP_TOOL_PREFIX}list_team`));
  // The tool result went back to the model as a tool message on the same call id.
  const second = backend.requests[1].body.messages;
  const assistant = second.find((message) => message.role === 'assistant');
  assert.equal(assistant.tool_calls[0].id, 'call_1');
  assert.equal(assistant.tool_calls[0].function.name, `${MCP_TOOL_PREFIX}list_team`);
  const toolMessage = second.find((message) => message.role === 'tool');
  assert.equal(toolMessage.tool_call_id, 'call_1');
  assert.deepEqual(JSON.parse(toolMessage.content), { bots: [{ id: 'bot_a' }] });
});

test('a failing MCP tool is reported to the model instead of failing the turn', async (t) => {
  const { runtime, backend } = await setup(t);
  runtime.attachTools({
    toolDefs: [{ name: 'create_bot', inputSchema: { type: 'object', properties: {} } }],
    call: async () => { throw new Error('a Bot needs a name'); },
  });
  backend.push({ sse: [toolChunk(0, 'call_1', `${MCP_TOOL_PREFIX}create_bot`, '{}')] });
  backend.push({ sse: [textChunk('I need a name first.')] });
  const recorder = record();
  const result = await runtime.run({ text: 'make a bot' }, { onEvent: recorder.onEvent });

  assert.equal(result.status, 'finished');
  assert.equal(result.text, 'I need a name first.');
  const finished = recorder.events.find((event) => event.type === 'tool.finished');
  assert.equal(finished.ok, false);
  const toolMessage = backend.requests[1].body.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /needs a name/);
});

test('a session continues across turns, is persisted, and reloads in a new runtime', async (t) => {
  const { runtime, backend, dataDir, config } = await setup(t);
  backend.push({ sse: [textChunk('First')] });
  const first = await runtime.run({ text: 'one' });
  assert.equal(first.text, 'First');

  backend.push({ sse: [textChunk('Second')] });
  const second = await runtime.run({ text: 'two', sessionId: first.sessionId });
  assert.equal(second.sessionId, first.sessionId);
  const messages = backend.requests[1].body.messages;
  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user']);
  assert.deepEqual(messages.map((message) => message.content), ['one', 'First', 'two']);

  const onDisk = JSON.parse(await readFile(join(dataDir, 'agent-sessions', `${first.sessionId}.json`), 'utf8'));
  assert.deepEqual(onDisk.messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(onDisk.messages.map((message) => message.content), ['one', 'First', 'two', 'Second']);

  // A restart keeps the same conversation: the runtime reads the persisted session back.
  const restarted = new AgentRuntime({ dataDir, logger: silentLogger, config });
  t.after(async () => { await restarted.dispose(); });
  backend.push({ sse: [textChunk('Third')] });
  const third = await restarted.run({ text: 'three', sessionId: first.sessionId });
  assert.equal(third.text, 'Third');
  assert.deepEqual(
    backend.requests[2].body.messages.map((message) => message.content),
    ['one', 'First', 'two', 'Second', 'three'],
  );
});

test('an aborted turn returns aborted and still ends with turn.finished', async (t) => {
  const { runtime, backend } = await setup(t);
  backend.push({ sse: [textChunk('partial')], hang: true });
  const controller = new AbortController();
  const recorder = record();
  const run = runtime.run({ text: 'go' }, {
    signal: controller.signal,
    onEvent: (event) => {
      recorder.onEvent(event);
      if (event.type === 'text.delta') controller.abort();
    },
  });
  const result = await run;
  assert.equal(result.status, 'aborted');
  const last = recorder.events.at(-1);
  assert.equal(last.type, 'turn.finished');
  assert.equal(last.status, 'aborted');
});

test('backend failures are classified into the codes engine.mjs retries by', async (t) => {
  const { runtime, backend } = await setup(t);
  const cases = [
    { step: { status: 401, errorText: '{"error":"invalid api key"}' }, code: 'auth', retryable: false },
    { step: { status: 429, errorText: '{"error":"rate limited"}' }, code: 'quota', retryable: false },
    { step: { status: 402, errorText: '{"error":"insufficient balance"}' }, code: 'quota', retryable: false },
    { step: { status: 400, errorText: '{"error":"maximum context length exceeded"}' }, code: 'context_too_long', retryable: false },
    { step: { status: 403, errorText: '{"error":"blocked by policy"}' }, code: 'blocked', retryable: false },
    { step: { status: 400, errorText: '{"error":"invalid model: foo"}' }, code: 'INVALID_ARGUMENTS', retryable: false },
    { step: { status: 503, errorText: '{"error":"overloaded"}' }, code: 'AGENT_UNAVAILABLE', retryable: true },
  ];
  for (const item of cases) {
    backend.push(item.step);
    const recorder = record();
    const result = await runtime.run({ text: `probe ${item.code}` }, { onEvent: recorder.onEvent });
    assert.equal(result.status, 'error', `expected an error result for HTTP ${item.step.status}`);
    assert.equal(result.error.code, item.code);
    assert.equal(result.error.retryable, item.retryable);
    assert.equal(recorder.events.at(-1).type, 'turn.finished');
    assert.equal(recorder.events.at(-1).status, 'error');
  }
});

test('built-in tools read, write, edit and list inside the workspace', async (t) => {
  const { runtime, backend, dataDir } = await setup(t);
  backend.push({
    sse: [
      toolChunk(0, 'call_w', 'write_file', JSON.stringify({ path: 'notes/a.txt', content: 'hello' })),
      toolChunk(1, 'call_r', 'read_file', JSON.stringify({ path: 'notes/a.txt' })),
    ],
  });
  backend.push({ sse: [textChunk('written')] });
  const result = await runtime.run({ text: 'write it' });
  assert.equal(result.text, 'written');
  assert.equal(await readFile(join(dataDir, 'workspace', 'notes', 'a.txt'), 'utf8'), 'hello');
  const toolMessages = backend.requests[1].body.messages.filter((message) => message.role === 'tool');
  assert.deepEqual(JSON.parse(toolMessages[0].content), { path: 'notes/a.txt', bytes: 5 });
  assert.deepEqual(JSON.parse(toolMessages[1].content), { path: 'notes/a.txt', content: 'hello' });

  backend.push({
    sse: [
      toolChunk(0, 'call_e', 'edit_file', JSON.stringify({ path: 'notes/a.txt', old_string: 'hello', new_string: 'bye' })),
      toolChunk(1, 'call_l', 'list_dir', JSON.stringify({ path: '.' })),
    ],
  });
  backend.push({ sse: [textChunk('edited')] });
  const edited = await runtime.run({ text: 'edit it' });
  assert.equal(edited.text, 'edited');
  assert.equal(await readFile(join(dataDir, 'workspace', 'notes', 'a.txt'), 'utf8'), 'bye');
  const listing = JSON.parse(
    backend.requests[3].body.messages.filter((message) => message.role === 'tool')[1].content,
  );
  assert.deepEqual(listing.entries, [{ name: 'notes', type: 'directory' }]);
});

test('a path outside the workspace is refused and the turn keeps going', async (t) => {
  const { runtime, backend } = await setup(t);
  backend.push({ sse: [toolChunk(0, 'call_1', 'write_file', JSON.stringify({ path: '../../escape.txt', content: 'x' }))] });
  backend.push({ sse: [textChunk('I stayed inside the workspace.')] });
  const recorder = record();
  const result = await runtime.run({ text: 'escape' }, { onEvent: recorder.onEvent });
  assert.equal(result.status, 'finished');
  assert.equal(result.text, 'I stayed inside the workspace.');
  const finished = recorder.events.find((event) => event.type === 'tool.finished');
  assert.equal(finished.ok, false);
  const toolMessage = backend.requests[1].body.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /outside the workspace/);
});

test('autoApprove=false asks before a state-changing tool and runs it on allowOnce', async (t) => {
  const { runtime, backend } = await setup(t, { runtime: { autoApprove: false } });
  const calls = [];
  runtime.attachTools({
    toolDefs: [{ name: 'create_bot', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } }],
    call: async (name, args) => { calls.push({ name, args }); return { created: 'Scout' }; },
  });
  backend.push({ sse: [toolChunk(0, 'call_1', `${MCP_TOOL_PREFIX}create_bot`, '{"name":"Scout"}')] });
  backend.push({ sse: [textChunk('Created Scout.')] });

  const recorder = record();
  let replied = false;
  const result = await runtime.run({ text: 'add a bot' }, {
    onEvent: (event) => {
      recorder.onEvent(event);
      if (event.type === 'permission.requested') {
        replied = true;
        // A synchronous settle: the approval is registered before the event is emitted.
        runtime.reply({ sessionId: event.sessionId, requestId: event.requestId, decision: 'allowOnce' });
      }
    },
  });
  assert.equal(replied, true);
  assert.equal(result.text, 'Created Scout.');
  assert.deepEqual(calls, [{ name: 'create_bot', args: { name: 'Scout' } }]);
  const request = recorder.events.find((event) => event.type === 'permission.requested');
  assert.equal(request.toolName, `${MCP_TOOL_PREFIX}create_bot`);
  assert.match(request.toolInput, /Scout/);
  assert.equal(recorder.events.find((event) => event.type === 'tool.finished').ok, true);
});

test('autoApprove=false does not run a denied tool and tells the model why', async (t) => {
  const { runtime, backend } = await setup(t, { runtime: { autoApprove: false } });
  let called = 0;
  runtime.attachTools({
    toolDefs: [{ name: 'delete_bot', inputSchema: { type: 'object', properties: {} } }],
    call: async () => { called += 1; return { deleted: 'Scout' }; },
  });
  backend.push({ sse: [toolChunk(0, 'call_1', `${MCP_TOOL_PREFIX}delete_bot`, '{"bot":"bot_b"}')] });
  backend.push({ sse: [textChunk('I will not delete it.')] });
  const result = await runtime.run({ text: 'delete it' }, {
    onEvent: (event) => {
      if (event.type === 'permission.requested') {
        runtime.reply({ sessionId: event.sessionId, requestId: event.requestId, decision: 'deny' });
      }
    },
  });
  assert.equal(called, 0);
  assert.equal(result.text, 'I will not delete it.');
  const toolMessage = backend.requests[1].body.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /denied permission/);
});

test('read-only MCP tools run without a permission prompt', async (t) => {
  const { runtime, backend } = await setup(t, { runtime: { autoApprove: false } });
  let called = 0;
  runtime.attachTools({
    toolDefs: [{ name: 'list_team', inputSchema: { type: 'object', properties: {} } }],
    call: async () => { called += 1; return { bots: [] }; },
  });
  backend.push({ sse: [toolChunk(0, 'call_1', `${MCP_TOOL_PREFIX}list_team`, '{}')] });
  backend.push({ sse: [textChunk('Nobody yet.')] });
  const recorder = record();
  await runtime.run({ text: 'who?' }, { onEvent: recorder.onEvent });
  assert.equal(called, 1);
  assert.equal(recorder.types().includes('permission.requested'), false);
});

test('the tool loop stops after maxToolRounds and every call keeps a reply', async (t) => {
  const { runtime, backend, dataDir } = await setup(t, { runtime: { maxToolRounds: 1 } });
  const missing = JSON.stringify({ path: 'missing.txt' });
  backend.push({ sse: [toolChunk(0, 'call_1', 'read_file', missing)] });
  backend.push({ sse: [toolChunk(0, 'call_2', 'read_file', missing)] });
  const result = await runtime.run({ text: 'loop forever' });
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'invalid_request');
  assert.equal(result.error.retryable, false);

  const stored = JSON.parse(await readFile(join(dataDir, 'agent-sessions', `${result.sessionId}.json`), 'utf8'));
  const toolMessages = stored.messages.filter((message) => message.role === 'tool');
  const assistantCalls = stored.messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.tool_calls ?? []);
  // Every assistant tool call has a matching tool reply, or the next continuation is invalid.
  assert.deepEqual(toolMessages.map((message) => message.tool_call_id), assistantCalls.map((call) => call.id));
  assert.match(toolMessages.at(-1).content, /stopped before this tool call ran/);
});

test('answer() records questionnaire answers and continues the same session', async (t) => {
  const { runtime, backend } = await setup(t);
  backend.push({ sse: [textChunk('Which colour?')] });
  const first = await runtime.run({ text: 'pick a colour' });

  backend.push({ sse: [textChunk('Blue it is.')] });
  const recorder = record();
  const result = await runtime.answer({
    sessionId: first.sessionId,
    requestId: 'q1',
    answers: [{ stepId: 'colour', selectedOptionIds: ['blue'], selectedOther: true, otherText: 'sky blue', skipped: false }],
  }, { onEvent: recorder.onEvent });

  assert.equal(result.status, 'finished');
  assert.equal(result.text, 'Blue it is.');
  assert.deepEqual(recorder.types().slice(0, 2), ['turn.started', 'text.delta']);
  const answered = backend.requests[1].body.messages.at(-1);
  assert.equal(answered.role, 'user');
  assert.match(answered.content, /Questionnaire answers for q1/);
  assert.match(answered.content, /stepId: colour/);
  assert.match(answered.content, /options: blue/);
  assert.match(answered.content, /otherText: sky blue/);
});

test('answer() refuses a session that does not exist', async (t) => {
  const { runtime, backend } = await setup(t);
  await assert.rejects(
    runtime.answer({ sessionId: 'ses_missing', requestId: 'q', answers: [] }),
    (error) => /** @type {any} */ (error).code === 'SESSION_NOT_FOUND',
  );
  assert.equal(backend.requests.length, 0);
});

test('a backend that ignores stream:true still returns its single JSON body', async (t) => {
  const { runtime, backend } = await setup(t);
  backend.push({ json: { choices: [{ message: { content: 'Non-streamed reply' } }] } });
  const result = await runtime.run({ text: 'hello' });
  assert.equal(result.status, 'finished');
  assert.equal(result.text, 'Non-streamed reply');
});

test('allowShell=false hides run_command and a call to it is refused', async (t) => {
  const { runtime, backend } = await setup(t, { runtime: { allowShell: false } });
  backend.push({ sse: [toolChunk(0, 'call_1', 'run_command', '{"command":"echo hi"}')] });
  backend.push({ sse: [textChunk('No shell here.')] });
  const recorder = record();
  const result = await runtime.run({ text: 'run it' }, { onEvent: recorder.onEvent });
  assert.equal(result.text, 'No shell here.');
  const names = backend.requests[0].body.tools.map((tool) => tool.function.name);
  assert.equal(names.includes('run_command'), false);
  const toolMessage = backend.requests[1].body.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /Unknown tool: run_command/);
  assert.equal(recorder.events.find((event) => event.type === 'tool.finished').ok, false);
});

test('dispose() aborts a running turn and refuses new work', async (t) => {
  const { runtime, backend } = await setup(t);
  backend.push({ sse: [textChunk('start')], hang: true });
  const started = record();
  const run = runtime.run({ text: 'long' }, { onEvent: started.onEvent });
  // Wait until the turn is really streaming before disposing.
  for (let i = 0; i < 200 && !started.events.some((event) => event.type === 'text.delta'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await runtime.dispose();
  const result = await run;
  assert.equal(result.status, 'aborted');
  await assert.rejects(runtime.run({ text: 'again' }), (error) => /** @type {any} */ (error).code === 'AGENT_UNAVAILABLE');
});
