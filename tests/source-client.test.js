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
  assert.deepEqual(items, [{ answer: 'ok' }]);
  assert.match(requests[0].url, /\/v2\/actors\/apify~google-search-scraper\/runs\?maxTotalChargeUsd=2$/);
  assert.equal(requests[0].options.headers.authorization, 'Bearer token');
});
