import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readInputFromEnvironment } from '../src/input.js';
import { ApifyStorage, LocalStorage, createStorage } from '../src/storage.js';
import { ApifySourceClient } from '../src/source-client.js';
import { run } from '../src/index.js';

const input = { brand: { name: 'Notion', domains: ['notion.com'] }, queries: ['Notion official website'] };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('reads the current Actor input store and platform input record key', async () => {
  const requests = [];
  const result = await readInputFromEnvironment({
    env: {
      APIFY_TOKEN: 'test-token',
      ACTOR_DEFAULT_KEY_VALUE_STORE_ID: 'current-store',
      ACTOR_INPUT_KEY: 'custom/input',
      APIFY_DEFAULT_KEY_VALUE_STORE_ID: 'legacy-store',
      APIFY_API_BASE_URL: 'https://api.example.test/',
    },
    fetchImpl: async (url, options) => {
      requests.push(url);
      assert.equal(options.headers.authorization, 'Bearer test-token');
      return jsonResponse(input);
    },
  });
  assert.deepEqual(result, input);
  assert.deepEqual(requests, ['https://api.example.test/v2/key-value-stores/current-store/records/custom%2Finput']);
});

test('retains legacy input store fallback and defaults the record key to INPUT', async () => {
  const requests = [];
  const result = await readInputFromEnvironment({
    env: {
      APIFY_API_TOKEN: 'test-token',
      APIFY_INPUT_KEY_VALUE_STORE_ID: 'input-store',
      APIFY_DEFAULT_KEY_VALUE_STORE_ID: 'default-store',
    },
    fetchImpl: async (url) => {
      requests.push(url);
      return url.includes('/input-store/') ? jsonResponse({}, 404) : jsonResponse(input);
    },
  });
  assert.deepEqual(result, input);
  assert.deepEqual(requests, [
    'https://api.apify.com/v2/key-value-stores/input-store/records/INPUT',
    'https://api.apify.com/v2/key-value-stores/default-store/records/INPUT',
  ]);
});

test('missing input diagnostics distinguish credentials, storage, and record failures', async () => {
  await assert.rejects(readInputFromEnvironment({ env: {} }), /Apify API token is missing/);
  await assert.rejects(readInputFromEnvironment({ env: { APIFY_TOKEN: 'test-token' } }), /ACTOR_DEFAULT_KEY_VALUE_STORE_ID is missing/);
  await assert.rejects(readInputFromEnvironment({
    env: { APIFY_TOKEN: 'test-token', ACTOR_DEFAULT_KEY_VALUE_STORE_ID: 'store' },
    fetchImpl: async () => jsonResponse({}, 404),
  }), /record "INPUT" was not found/);
});

test('authorization errors are surfaced instead of falling back to demo input', async () => {
  await assert.rejects(readInputFromEnvironment({
    env: { APIFY_TOKEN: 'test-token', ACTOR_DEFAULT_KEY_VALUE_STORE_ID: 'store', GEO_USE_EXAMPLE: '1' },
    readFile: async () => { throw new Error('demo input must not be read'); },
    fetchImpl: async () => jsonResponse({}, 403),
  }), /Unable to read Apify INPUT record \(403\)/);
});

test('explicit local inputs remain available without Apify runtime variables', async () => {
  const fetchImpl = async () => { throw new Error('network must not be used'); };
  assert.deepEqual(await readInputFromEnvironment({ env: { GEO_INPUT_JSON: JSON.stringify(input) }, fetchImpl }), input);
  assert.deepEqual(await readInputFromEnvironment({
    env: { GEO_INPUT_FILE: 'live-input.json' },
    fetchImpl,
    readFile: async (path) => {
      assert.equal(path, 'live-input.json');
      return JSON.stringify(input);
    },
  }), input);
});

test('selects current cloud storage IDs before legacy IDs and keeps local runs local', () => {
  const storage = createStorage({ env: {
    APIFY_TOKEN: 'test-token',
    ACTOR_DEFAULT_DATASET_ID: 'current-dataset',
    ACTOR_DEFAULT_KEY_VALUE_STORE_ID: 'current-store',
    APIFY_DEFAULT_DATASET_ID: 'legacy-dataset',
    APIFY_DEFAULT_KEY_VALUE_STORE_ID: 'legacy-store',
  } });
  assert.ok(storage instanceof ApifyStorage);
  assert.equal(storage.datasetId, 'current-dataset');
  assert.equal(storage.storeId, 'current-store');
  const legacy = createStorage({ env: {
    APIFY_API_TOKEN: 'test-token',
    APIFY_DEFAULT_DATASET_ID: 'legacy-dataset',
    APIFY_DEFAULT_KEY_VALUE_STORE_ID: 'legacy-store',
  } });
  assert.ok(legacy instanceof ApifyStorage);
  assert.equal(legacy.datasetId, 'legacy-dataset');
  assert.equal(legacy.storeId, 'legacy-store');
  assert.ok(createStorage({ env: {} }) instanceof LocalStorage);
});

test('an incomplete cloud environment fails instead of silently writing local output', () => {
  for (const env of [
    { APIFY_IS_AT_HOME: '1' },
    { ACTOR_RUN_ID: 'run-id', APIFY_TOKEN: 'test-token' },
    { ACTOR_DEFAULT_DATASET_ID: 'dataset', APIFY_TOKEN: 'test-token' },
  ]) {
    assert.throws(() => createStorage({ env }), /Apify storage is not configured/);
  }
});

test('missing history is allowed but failed dataset or history writes are surfaced', async () => {
  const storage = new ApifyStorage({
    token: 'test-token', datasetId: 'dataset', storeId: 'store', env: {},
    fetchImpl: async () => jsonResponse({ error: 'not found' }, 404),
  });
  assert.equal(await storage.loadJson('history'), null);
  await assert.rejects(storage.pushItems([{ type: 'report_summary' }]), /storage request failed \(404\)/);
  await assert.rejects(storage.saveJson('history', []), /storage request failed \(404\)/);
});

test('reads Console input and publishes live-test snapshots using only current Actor variables', async () => {
  const liveInput = JSON.parse(await readFile(new URL('../examples/live-input.json', import.meta.url), 'utf8'));
  const env = {
    APIFY_IS_AT_HOME: '1',
    APIFY_TOKEN: 'test-token',
    ACTOR_DEFAULT_KEY_VALUE_STORE_ID: 'run-store',
    ACTOR_DEFAULT_DATASET_ID: 'run-dataset',
    ACTOR_INPUT_KEY: 'INPUT',
    APIFY_API_BASE_URL: 'https://api.example.test',
  };
  const writes = [];
  const sourceCalls = [];
  const fetchImpl = async (url, options = {}) => {
    assert.equal(options.headers.authorization, 'Bearer test-token');
    const { pathname, searchParams } = new URL(url);
    const method = options.method ?? 'GET';
    if (pathname === '/v2/key-value-stores/run-store/records/INPUT') return jsonResponse(liveInput);
    if (pathname === '/v2/key-value-stores/run-store/records/NOTION_LIVE_TEST') {
      if (method === 'GET') return jsonResponse({}, 404);
      assert.equal(method, 'PUT');
      writes.push({ resource: 'history', body: JSON.parse(options.body) });
      return jsonResponse({});
    }
    if (pathname === '/v2/actors/apify~google-search-scraper/runs') {
      assert.equal(method, 'POST');
      assert.equal(searchParams.get('maxTotalChargeUsd'), '0.5');
      sourceCalls.push(JSON.parse(options.body));
      return jsonResponse({ data: { id: 'source-run', status: 'SUCCEEDED', defaultDatasetId: 'source-dataset' } }, 201);
    }
    if (pathname === '/v2/datasets/source-dataset/items') {
      return jsonResponse([{ organicResults: [{ position: 1, title: 'Notion', url: 'https://www.notion.com/' }] }]);
    }
    if (pathname === '/v2/datasets/run-dataset/items') {
      assert.equal(method, 'POST');
      writes.push({ resource: 'dataset', body: JSON.parse(options.body) });
      return jsonResponse({});
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  const raw = await readInputFromEnvironment({ env, fetchImpl });
  const result = await run(raw, {
    sourceClient: new ApifySourceClient({ token: env.APIFY_TOKEN, baseUrl: env.APIFY_API_BASE_URL, fetchImpl }),
    storage: createStorage({ env, fetchImpl }),
  });
  assert.equal(sourceCalls.length, 1);
  assert.equal(sourceCalls[0].queries, 'Notion official website');
  assert.equal(result.report.status, 'succeeded');
  assert.equal(result.report.snapshotCount, 1);
  assert.equal(result.report.errorCount, 0);
  const dataset = writes.find((write) => write.resource === 'dataset').body;
  assert.deepEqual(dataset.map((item) => item.type), ['visibility_snapshot', 'report_summary']);
  assert.equal(dataset[0].sourceRecordCount, 1);
  assert.equal(dataset[0].ownedCitation, true);
  assert.equal(writes.find((write) => write.resource === 'history').body.length, 1);
});
