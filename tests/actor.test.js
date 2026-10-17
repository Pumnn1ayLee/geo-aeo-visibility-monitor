import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.js';

class FakeClient {
  calls = [];

  async runActor(actorId, input) {
    this.calls.push({ actorId, input });
    return [{
      organicResults: [{ position: 1, title: 'Example brand', url: 'https://example.com', snippet: 'Example brand is recommended.' }],
      aiOverview: { citations: ['https://example.com'] },
    }];
  }
}

class FakeStorage {
  saved = null;
  items = [];

  async loadJson() { return [{ engine: 'google', market: { countryCode: 'US', languageCode: 'en' }, query: 'old query', visibilityScore: 10 }]; }
  async saveJson(_key, value) { this.saved = value; }
  async pushItems(items) { this.items.push(...items); }
}

test('runs every market/query/engine and persists a report', async () => {
  const client = new FakeClient();
  const storage = new FakeStorage();
  const result = await run({
    brand: { name: 'Example brand', domains: ['example.com'] },
    competitors: [],
    queries: ['best tool', 'best alternative'],
    markets: [{ countryCode: 'US', languageCode: 'en' }],
    engines: [{ name: 'google', actorId: 'apify/google-search-scraper' }],
  }, { sourceClient: client, storage, logger: { error() {} } });
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].input.queries, 'best tool');
  assert.equal(client.calls[0].input.countryCode, 'us');
  assert.equal(client.calls[0].input.maxPagesPerQuery, 1);
  assert.equal(result.snapshots.length, 2);
  assert.equal(result.report.status, 'succeeded');
  assert.equal(storage.items.filter((item) => item.type === 'report_summary').length, 1);
  assert.equal(storage.saved.length, 3);
  assert.equal(storage.saved.some((item) => item.query === 'old query'), true);
});
