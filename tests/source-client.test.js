import test from 'node:test';
import assert from 'node:assert/strict';
import { ApifySourceClient } from '../src/source-client.js';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

test('uses the documented Apify Actor run and dataset endpoints', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('/runs')) return response(201, { data: { id: 'run-1', status: 'RUNNING' } });
    if (url.includes('/actor-runs/')) return response(200, { data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'dataset-1' } });
    if (url.includes('/datasets/')) return response(200, [{ answer: 'ok' }]);
    throw new Error(`unexpected URL ${url}`);
  };
  const client = new ApifySourceClient({ token: 'token', baseUrl: 'https://api.example.test', fetchImpl, sleep: async () => {} });
  const items = await client.runActor('apify/google-search-scraper', { queries: ['test'] }, { maxTotalChargeUsd: 2 });
  assert.deepEqual(items.items, [{ answer: 'ok' }]);
  assert.equal(items.run.id, 'run-1');
  const startUrl = new URL(requests[0].url);
  assert.equal(startUrl.pathname, '/v2/actors/apify~google-search-scraper/runs');
  assert.equal(startUrl.searchParams.get('maxTotalChargeUsd'), '2');
  assert.equal(startUrl.searchParams.get('timeout'), '300');
  assert.equal(requests[0].options.headers.authorization, 'Bearer token');
});

test('timeouts abort the child and retain its final charge metadata', async () => {
  let clock = 0;
  const requests = [];
  const client = new ApifySourceClient({ token: 'token', now: () => clock, sleep: async (ms) => { clock += ms; }, fetchImpl: async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('/runs?')) return response(201, { data: { id: 'slow', status: 'RUNNING' } });
    if (url.endsWith('/abort')) return response(200, { data: { id: 'slow', status: 'ABORTED', usageTotalUsd: 0.03 } });
    return response(200, { data: { id: 'slow', status: 'RUNNING' } });
  } });
  await assert.rejects(client.runActor('actor', {}, { timeoutSeconds: 1, maxTotalChargeUsd: 0.1 }), (error) => {
    assert.match(error.message, /deadline/);
    assert.equal(error.run.status, 'ABORTED');
    assert.equal(error.run.usageTotalUsd, 0.03);
    return true;
  });
  assert.equal(requests.at(-1).options.method, 'POST');
  assert.match(requests.at(-1).url, /\/actor-runs\/slow\/abort$/);
  assert.equal(new URL(requests[0].url).searchParams.get('timeout'), '1');
});

test('failed runs carry usageTotalUsd rather than becoming uncharged exceptions', async () => {
  const client = new ApifySourceClient({ token: 'token', fetchImpl: async () => response(201, { data: { id: 'failed', status: 'FAILED', usageTotalUsd: 0.07 } }) });
  await assert.rejects(client.runActor('actor', {}), (error) => error.run.usageTotalUsd === 0.07 && error.run.status === 'FAILED');
});

test('resuming a child reads its existing run and dataset without creating another run', async () => {
  const methods = [];
  const client = new ApifySourceClient({ token: 'token', fetchImpl: async (url, options = {}) => {
    methods.push(options.method ?? 'GET');
    return url.includes('/datasets/') ? response(200, [{ answer: 'Recovered answer' }]) : response(200, { data: { id: 'known', status: 'SUCCEEDED', defaultDatasetId: 'dataset', usageTotalUsd: 0 } });
  } });
  const result = await client.resumeRun('known');
  assert.deepEqual(methods, ['GET', 'GET']);
  assert.equal(result.run.usageTotalUsd, 0);
});

test('uncertain launch responses are distinguished from rejected launches', async () => {
  for (const status of [400, 401, 403, 408, 429, 500, 503]) {
    const client = new ApifySourceClient({ token: 'token', fetchImpl: async () => response(status, { error: 'rejected' }) });
    await assert.rejects(client.runActor('actor', {}), (error) => {
      assert.equal(error.definitiveRejection, status < 500 && status !== 408);
      assert.equal(error.launchUncertain, status >= 500 || status === 408);
      return true;
    });
  }
});

test('an unconfirmed abort preserves the known run ID and unresolved status', async () => {
  let clock = 0;
  const client = new ApifySourceClient({ token: 'token', now: () => clock, sleep: async (ms) => { clock += ms; }, fetchImpl: async (url) => {
    if (url.endsWith('/abort')) throw new Error('abort network failure');
    return response(200, { data: { id: 'known', status: 'RUNNING' } });
  } });
  await assert.rejects(client.runActor('actor', {}, { timeoutSeconds: 0 }), (error) => {
    assert.equal(error.run.id, 'known');
    assert.equal(error.run.status, 'RUNNING');
    assert.equal(error.abortError, 'abort network failure');
    return true;
  });
});

test('malformed polling responses still abort the known child', async () => {
  const client = new ApifySourceClient({ token: 'token', sleep: async () => {}, fetchImpl: async (url) => {
    if (url.includes('/runs?')) return response(201, { data: { id: 'known', status: 'RUNNING' } });
    if (url.endsWith('/abort')) return response(200, { data: { id: 'known', status: 'ABORTED' } });
    return response(200, { data: null });
  } });
  await assert.rejects(client.runActor('actor', {}), (error) => {
    assert.match(error.message, /status response/);
    assert.equal(error.run.id, 'known');
    assert.equal(error.run.status, 'ABORTED');
    return true;
  });
});
