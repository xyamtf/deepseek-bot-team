// @ts-check
/**
 * The DSH model-library sync: the profile patch is parsed, keys resolve from the credential
 * store, and providers this runtime cannot speak to are reported instead of offered.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findProviders, parseYamlLite, readDotEnv, readDshModels, readCredentialRefs } from '../miniapp/node/model-sync.mjs';
import { normalizeModel } from '../miniapp/node/store.mjs';

const PATCH = `# profile patch
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      workbuddy:
        displayName: workbuddy
        apiKeyEnv: WORKBUDDY_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:3065/v1
        models:
          - id: glm-5.3
            name: GLM-5.3
            contextWindow: 1000000
            maxTokens: 64000
            input:
              - text
              - image
          - id: deepseek-v4.1-flash
            name: DeepSeek-V4.1-Flash
      ark:
        apiKeyEnv: ARK_KEY
        api: anthropic-messages
        baseURL: https://ark.example.com/api/plan
        models:
          - id: kimi-k3
      nokey:
        api: openai-completions
        baseURL: https://nokey.example.com/v1
        models:
          - id: something
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: workbuddy
    model: deepseek-v4.1-flash
`;

const CREDENTIALS = `version: 1
records:
  deepseek-account-platform/default:
    kind: secret
    payload:
      token: abcdef
refs:
  WORKBUDDY_API_KEY: sk-test-workbuddy
  ARK_KEY: ark-test
`;

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bot-model-sync-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  const credentialsPath = join(dir, '.credentials.yaml');
  const envPath = join(dir, '.env');
  await writeFile(patchPath, PATCH, 'utf8');
  await writeFile(credentialsPath, CREDENTIALS, 'utf8');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, patchPath, credentialsPath, envPath };
}

test('the patch parses into the provider table DSH writes', () => {
  const document = parseYamlLite(PATCH);
  const providers = findProviders(document);
  assert.ok(providers);
  assert.deepEqual(Object.keys(providers), ['workbuddy', 'ark', 'nokey']);
  assert.equal(providers.workbuddy.baseURL, 'http://127.0.0.1:3065/v1');
  assert.equal(providers.workbuddy.api, 'openai-completions');
  assert.equal(Array.isArray(providers.workbuddy.models), true);
  assert.equal(providers.workbuddy.models.length, 2);
  assert.equal(providers.workbuddy.models[0].id, 'glm-5.3');
  assert.deepEqual(providers.workbuddy.models[0].input, ['text', 'image']);
  assert.equal(providers.workbuddy.models[1].id, 'deepseek-v4.1-flash');
});

test('a scalar keeps # inside quotes and drops a trailing comment', () => {
  const document = parseYamlLite('a: "x # not a comment"\nb: value # comment\nc: 3\n');
  assert.equal(document.a, 'x # not a comment');
  assert.equal(document.b, 'value');
  // Scalars stay strings: a purely numeric model id must not turn into a number.
  assert.equal(document.c, '3');
});

test('credentials and dotenv files resolve by name', async (t) => {
  const { credentialsPath, envPath } = await fixture(t);
  await writeFile(envPath, 'FROM_DOTENV=dotenv-value\nexport ALSO=yes\n', 'utf8');
  const refs = readCredentialRefs(credentialsPath);
  assert.equal(refs.WORKBUDDY_API_KEY, 'sk-test-workbuddy');
  assert.equal(refs.ARK_KEY, 'ark-test');
  const dotenv = readDotEnv(envPath);
  assert.equal(dotenv.FROM_DOTENV, 'dotenv-value');
  assert.equal(dotenv.ALSO, 'yes');
});

test('the sync keeps OpenAI-compatible providers, skips the rest, and resolves keys', async (t) => {
  const { patchPath, credentialsPath, envPath } = await fixture(t);
  const out = readDshModels({
    env: { FROM_ENV: 'env-value' },
    sources: { home: '', profile: '', patchPath, credentialsPath, envPath },
  });
  assert.equal(out.source.found, true);
  assert.deepEqual(Object.keys(out.providers).sort(), ['nokey', 'workbuddy']);
  assert.equal(out.providers.workbuddy.apiKey, 'sk-test-workbuddy');
  assert.equal(out.providers.nokey.apiKey, '');
  assert.deepEqual(out.skipped, [{ providerId: 'ark', api: 'anthropic-messages' }]);
  assert.deepEqual(out.models.map((entry) => entry.providerId + '/' + entry.modelId), [
    'workbuddy/glm-5.3',
    'workbuddy/deepseek-v4.1-flash',
    'nokey/something',
  ]);
  // A display name that repeats the id is not stored twice.
  assert.equal(out.models[1].displayName, 'DeepSeek-V4.1-Flash');
});

test('the environment wins over the credential store for a key', async (t) => {
  const { patchPath, credentialsPath, envPath } = await fixture(t);
  const out = readDshModels({
    env: { WORKBUDDY_API_KEY: 'from-env' },
    sources: { home: '', profile: '', patchPath, credentialsPath, envPath },
  });
  assert.equal(out.providers.workbuddy.apiKey, 'from-env');
});

test('an unreadable or missing patch is an empty library, not an error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-model-missing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = readDshModels({
    env: {},
    sources: { home: dir, profile: 'x', patchPath: join(dir, 'nope.yml'), credentialsPath: join(dir, 'nope.yaml'), envPath: join(dir, 'nope.env') },
  });
  assert.deepEqual(out, { providers: {}, models: [], skipped: [], source: { patchPath: join(dir, 'nope.yml'), found: false } });
});

test('a custom model needs its own http(s) endpoint, and keeps it', () => {
  assert.equal(normalizeModel({ providerId: 'custom', modelId: 'x' }), undefined);
  assert.equal(normalizeModel({ providerId: 'custom', modelId: 'x', baseURL: 'ftp://nope' }), undefined);
  const kept = normalizeModel({ providerId: 'custom', modelId: 'x', baseURL: 'https://api.example.com/v1', apiKey: 'sk-1' });
  assert.deepEqual(kept, { providerId: 'custom', modelId: 'x', baseURL: 'https://api.example.com/v1', apiKey: 'sk-1' });
  // An ordinary catalog selection keeps ignoring endpoint fields.
  assert.deepEqual(normalizeModel({ providerId: 'p', modelId: 'm', baseURL: 'https://x' }), { providerId: 'p', modelId: 'm' });
});
