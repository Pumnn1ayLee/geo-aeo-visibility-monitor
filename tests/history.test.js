import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { run } from '../src/index.js';
import { History, comparisonKey } from '../src/history.js';
import { normalizeInput, buildSourceInput } from '../src/input.js';
import { ApifyStorage, LocalStorage } from '../src/storage.js';
import { MemoryStorage, TestClient, exampleInput, quiet } from './helpers.js';

test('independent run stores share named history, compare gains/losses and exclude raw data', async () => {
  const stores = new Map();
  const storageA = new MemoryStorage({ stores, name: 'run-a' });
  const first = await run({ ...exampleInput, includeRawSource: true }, { sourceClient: new TestClient(), storage: storageA, runId: 'first', now: () => Date.parse('2026-10-17T00:00:00Z'), logger: quiet });
  assert.equal(first.report.changes[0].scoreDelta, null);
  const storageB = new MemoryStorage({ stores, name: 'run-b' });
  const second = await run({ ...exampleInput, includeRawSource: true }, { sourceClient: new TestClient({ items: [{ organicResults: [{ title: 'Competitor', url: 'https://other.org' }] }] }), storage: storageB, runId: 'second', now: () => Date.parse('2026-10-18T00:00:00Z'), logger: quiet });
  const change = second.report.changes[0];
  assert.equal(change.baselineRunId, 'first');
  assert.equal(change.brandMentionChange, 'lost');
  assert.equal(change.scoreDelta, -100);
  assert.deepEqual(change.citationDomainsGained, ['other.org']);
  assert.deepEqual(change.citationDomainsLost, ['example.com']);
  assert.ok(change.baselineCapturedAt);
  const history = stores.get(second.report.history.storeName);
  assert.equal(history.size, 2);
  for (const value of history.values()) assert.equal(value.snapshots[0].rawSource, undefined);
});

test('history is isolated by project, brand, competitors, location, engine and AI options', async () => {
  const storage = new MemoryStorage();
  await run(exampleInput, { sourceClient: new TestClient(), storage, runId: 'baseline', logger: quiet });
  const variants = [
    { monitorId: 'different-project' }, { historyKey: 'other-namespace' }, { brand: 'Other brand' },
    { competitors: [{ name: 'Competitor' }] }, { markets: [{ countryCode: 'GB' }] },
    { markets: [{ countryCode: 'US', languageCode: 'fr' }] }, { markets: [{ countryCode: 'US', location: 'New York' }] },
    { engines: [{ name: 'google', actorId: 'other/actor' }] }, { engines: [{ name: 'other', actorId: 'apify/google-search-scraper' }] },
    { sourceActorInput: { aiModeSearch: { enableAiMode: true } } },
    { brand: { ...exampleInput.brand, aliases: ['Different alias'] } }, { maxResultsPerQuery: 20 },
  ];
  for (const [i, variant] of variants.entries()) {
    const result = await run({ ...exampleInput, ...variant }, { sourceClient: new TestClient(), storage, runId: `variant-${i}`, logger: quiet });
    assert.equal(result.report.changes[0].baselineRunId, null, JSON.stringify(variant));
  }
});

test('new queries retain existing baselines, and failed/empty/budget-skipped observations preserve them', async () => {
  const storage = new MemoryStorage();
  const baseTime = Date.parse('2026-10-18T00:00:00Z');
  const execute = (input, sourceClient, i) => run(input, { sourceClient, storage, runId: `r${i}`, now: () => baseTime + i * 1000, logger: quiet });
  await execute(exampleInput, new TestClient(), 0);
  for (const [i, items] of [[], [{ organicResults: [], searchQuery: { term: 'Example brand' } }]].entries()) {
    const empty = await execute(exampleInput, new TestClient({ items }), i + 1);
    assert.equal(empty.snapshots.length, 0);
    assert.equal(empty.report.status, 'failed');
  }
  await execute(exampleInput, new TestClient({ status: 'FAILED' }), 3);
  await execute({ ...exampleInput, maxSourceBudgetUsd: 0 }, new TestClient(), 4);
  const result = await execute({ ...exampleInput, queries: ['best tool', 'new query'] }, new TestClient(), 5);
  assert.equal(result.report.changes[0].baselineRunId, 'r0');
  assert.equal(result.report.changes[1].baselineRunId, null);
  assert.equal(result.report.history.baselineCount, 1);
});

test('a newer partial run cannot displace an older valid baseline for another query', async () => {
  const storage = new MemoryStorage();
  const input = { ...exampleInput, queries: ['a', 'b'] };
  const time = Date.parse('2026-10-18T00:00:00Z');
  await run(input, { sourceClient: new TestClient(), storage, runId: 'complete', now: () => time, logger: quiet });
  await run({ ...input, maxSourceRuns: 1 }, { sourceClient: new TestClient(), storage, runId: 'partial', now: () => time + 1000, logger: quiet });
  const result = await run(input, { sourceClient: new TestClient(), storage, runId: 'latest', now: () => time + 2000, logger: quiet });
  assert.deepEqual(result.report.changes.map((change) => change.baselineRunId), ['partial', 'complete']);
});

test('persistent version 2 history detects the observed AI and attached-source changes without raw source', async () => {
  const storage = new MemoryStorage();
  const input = { brand: { name: 'Notion', domains: ['notion.com', 'notion.so'] }, competitors: ['ClickUp'],
    queries: ['best team documentation tools'], maxTotalChargeUsd: 0.5 };
  const redditPage = 'https://www.reddit.com/r/ProductManagement/comments/documentation/';
  const gartnerPage = 'https://www.gartner.com/reviews/knowledge-management';
  const organicResults = [
    { position: 1, title: 'Documentation tools', url: redditPage },
    { position: 2, title: 'Knowledge software', url: gartnerPage },
    { position: 5, title: 'Notion and ClickUp for teams', url: 'https://medium.com/knowledge-tools' },
  ];
  const makeMode = (urls) => ({ text: 'Notion and ClickUp are options for team documentation.', sources: [
    { url: 'https://www.gartner.com/', section: 'citations' },
    { url: 'https://www.reddit.com/', section: 'citations' },
    ...urls.map((url) => ({ url, section: 'attached' })),
  ] });
  const previousLinks = Array.from({ length: 10 }, (_, i) => `https://tools.example.org/tool-${i}`);
  const currentLinks = ['https://www.notion.com/', ...previousLinks.slice(0, 5)];
  const start = Date.parse('2026-10-18T00:00:00Z');
  const first = await run(input, { sourceClient: new TestClient({ items: [{ organicResults, aiModeResult: makeMode(previousLinks) }] }),
    storage, runId: 'before-upgrade', now: () => start, logger: quiet });
  const saved = [...storage.stores.get(first.report.history.storeName).values()][0];
  assert.equal(saved.snapshots[0].rawSource, undefined);
  delete saved.snapshots[0].aiOwnedAttachedSource;
  const second = await run(input, { sourceClient: new TestClient({ items: [{ organicResults, aiModeResult: makeMode(currentLinks),
    aiOverview: { content: 'Notion is an option for knowledge management.', sources: [
      { url: redditPage }, { url: 'https://www.reddit.com/r/ITManagers/comments/knowledge/' }, { url: gartnerPage },
    ] },
  }] }), storage, runId: 'after-upgrade', now: () => start + 1000, logger: quiet });
  const change = second.report.changes[0];
  assert.equal(second.report.changeDetectionVersion, 2);
  assert.equal(second.report.history.baselineCount, 1);
  assert.equal(change.baselineRunId, 'before-upgrade');
  assert.equal(change.scoreDelta, 0);
  assert.equal(change.currentVisibilityScore, 68);
  assert.equal(change.aiResponseCountDelta, 1);
  assert.equal(change.aiCitationCountDelta, 3);
  assert.equal(change.citationCountDelta, 1);
  assert.equal(change.aiAttachedSourceCountDelta, -4);
  assert.equal(change.aiOwnedAttachedSourceChange, 'gained');
  assert.equal(change.aiOwnedCitationChange, 'unchanged');
  assert.deepEqual(change.aiAttachedSourceUrlsGained, ['https://www.notion.com/']);
  assert.equal(change.aiAttachedSourceUrlsLost.length, 5);
  assert.equal(change.changed, true);
  assert.equal(second.snapshots[0].rawSource, undefined);
});

test('only prior completed history is eligible; expired records in this namespace are pruned', async () => {
  const storage = new MemoryStorage();
  const config = normalizeInput({ ...exampleInput, historyRetentionDays: 1 });
  const engine = config.engines[0], market = config.markets[0], query = config.queries[0];
  const key = comparisonKey(config, { engine, market, query, sourceInput: buildSourceInput(config, query, market, engine) });
  const history = new History(config, storage, { runId: 'current', startedAt: '2026-10-18T00:00:00Z', actorId: storage.actorId });
  const store = await storage.openNamedStore(history.storeName);
  const old = `${history.prefix}${Date.parse('2026-10-10T00:00:00Z')}-old`;
  await store.saveJson(old, {});
  await store.saveJson('H1-unrelated-1-old', {});
  await store.saveJson(`${history.prefix}${Date.parse('2026-10-18T00:00:01Z')}-future`, { schemaVersion: 1, runId: 'future', completedAt: '2026-10-18T00:00:01Z', snapshots: [{ analysisVersion: 2, observationPresent: true, comparisonKey: key }] });
  assert.deepEqual(await history.load([key]), []);
  assert.equal(history.info.prunedRecords, 1);
  assert.equal(await store.loadJson(old), null);
  assert.notEqual(await store.loadJson('H1-unrelated-1-old'), null);
});

test('concurrent runs write independent records without a shared latest pointer', async () => {
  const storage = new MemoryStorage();
  const results = await Promise.all(['a', 'b'].map((runId) => run(exampleInput, { sourceClient: new TestClient(), storage, runId, logger: quiet })));
  const store = storage.stores.get(results[0].report.history.storeName);
  assert.equal(store.size, 2);
  assert.deepEqual([...store.values()].map((record) => record.runId).sort(), ['a', 'b']);
});

test('disabled history makes no persistent store requests', async () => {
  const storage = new MemoryStorage();
  storage.openNamedStore = async () => { throw new Error('must not open history'); };
  const result = await run({ ...exampleInput, historyEnabled: false }, { sourceClient: new TestClient(), storage, logger: quiet });
  assert.equal(result.report.history.enabled, false);
  assert.equal(result.report.changes[0].baselineRunId, null);
});

test('named history uses authenticated paginated key enumeration', async () => {
  const requests = [];
  const storage = new ApifyStorage({ env: {}, token: 'test-token', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.headers.authorization, 'Bearer test-token');
    const parsed = new URL(url);
    if (options.method === 'POST') { assert.equal(parsed.searchParams.get('name'), 'history-name'); return new Response(JSON.stringify({ data: { id: 'named-store' } })); }
    return new Response(JSON.stringify({ data: parsed.searchParams.has('exclusiveStartKey')
      ? { items: [{ key: 'b' }], isTruncated: false }
      : { items: [{ key: 'a' }], isTruncated: true, nextExclusiveStartKey: 'a' } }));
  } });
  const history = await storage.openNamedStore('history-name');
  assert.deepEqual(await history.listKeys(), ['a', 'b']);
  assert.equal(requests.length, 3);
  assert.equal(new URL(requests[2].url).searchParams.get('exclusiveStartKey'), 'a');
});

test('local keyed records and named history survive new storage instances', async () => {
  const directory = await mkdtemp(join(resolve('.'), 'test-output-history-'));
  try {
    const a = new LocalStorage({ directory });
    await a.saveJson('one', { value: 1 });
    await a.saveJson('two', { value: 2 });
    const named = await a.openNamedStore('persistent');
    await named.saveJson('key', { value: 3 });
    const b = new LocalStorage({ directory });
    assert.deepEqual(await b.loadJson('one'), { value: 1 });
    assert.deepEqual(await b.loadJson('two'), { value: 2 });
    assert.deepEqual(await (await b.openNamedStore('persistent')).loadJson('key'), { value: 3 });
    assert.deepEqual((await b.listKeys()).sort(), ['one', 'two']);
    await b.deleteJson('one');
    assert.equal(await b.loadJson('one'), null);
  } finally { await rm(directory, { recursive: true }); }
});
