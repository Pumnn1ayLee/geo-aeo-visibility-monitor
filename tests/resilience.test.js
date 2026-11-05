import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { run, runStatusMessage } from '../src/index.js';
import { MemoryStorage, TestClient, exampleInput, evidence, quiet } from './helpers.js';

const input = { ...exampleInput, monitoringPreset: 'google_web_and_ai', sourceTimeoutSeconds: 90, maxSourceRuns: 2 };

function channelClient({ aiStatus = 'SUCCEEDED', advance = () => {} } = {}) {
  const client = new TestClient();
  const original = client.runActor.bind(client);
  client.runActor = async (actor, sourceInput, options) => {
    const ai = sourceInput.aiModeSearch.enableAiMode;
    client.status = ai ? aiStatus : 'SUCCEEDED';
    client.items = ai ? [{ aiModeResult: { text: 'Example brand is one useful tool.' } }] : evidence;
    advance(ai ? options.timeoutSeconds * 1000 : 5000);
    return original(actor, sourceInput, options);
  };
  return client;
}

test('an AI source timeout preserves accessible web evidence and reports AI availability as unknown', async () => {
  const started = Date.parse('2026-11-05T14:00:00Z');
  let clock = started;
  const storage = new MemoryStorage();
  const client = channelClient({ aiStatus: 'TIMED-OUT', advance: (ms) => { clock += ms; } });
  const result = await run(input, { sourceClient: client, storage, logger: quiet, runId: 'resilient', now: () => clock,
    env: { ACTOR_TIMEOUT_AT: new Date(started + 300000).toISOString() } });
  assert.equal(result.report.status, 'partial');
  assert.ok(clock - started < 300000);
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls.map((call) => call.options.timeoutSeconds), [90, 90]);
  assert.equal(storage.items.length, 1);
  assert.equal(storage.items[0].monitoringChannel, 'web_search');
  assert.equal(storage.items[0].brandMentionedInAiResponse, null);
  assert.equal(result.report.aiBrandMentionRate, null);
  assert.equal(result.report.aiOwnedCitationRate, null);
  assert.equal(result.report.collection.plannedAiChecks, 1);
  assert.equal(result.report.collection.failedAiChecks, 1);
  assert.equal(result.errors[0].code, 'SOURCE_TIMEOUT');
  assert.equal(result.errors[0].sourceStatus, 'TIMED-OUT');
  assert.equal(result.errors[0].monitoringChannel, 'google_ai_mode');
  assert.equal((await storage.loadJson('SOURCE_ERRORS'))[0].code, 'SOURCE_TIMEOUT');
  assert.match(runStatusMessage(result.report), /PARTIAL: 1 successful checks, 1 source errors\. SOURCE_TIMEOUT/);
});

test('successful web and AI checks have distinct identities and independently retained history', async () => {
  const storage = new MemoryStorage();
  const now = Date.parse('2026-11-05T14:00:00Z');
  const first = await run(input, { sourceClient: channelClient(), storage, logger: quiet, runId: 'both', now: () => now, env: {} });
  assert.equal(first.snapshots.length, 2);
  assert.notEqual(first.snapshots[0].comparisonKey, first.snapshots[1].comparisonKey);
  assert.deepEqual(first.snapshots.map((snapshot) => snapshot.engine), ['google:web_search', 'google:ai_mode']);
  const second = await run(input, { sourceClient: channelClient({ aiStatus: 'TIMED-OUT' }), storage, logger: quiet, runId: 'ai-failed', now: () => now + 1000, env: {} });
  assert.equal(second.report.status, 'partial');
  const third = await run(input, { sourceClient: channelClient(), storage, logger: quiet, runId: 'recovered', now: () => now + 2000, env: {} });
  assert.deepEqual(third.report.changes.map((change) => change.baselineRunId), ['ai-failed', 'both']);
});

test('two-channel preset still respects source-run and aggregate-budget limits', async () => {
  for (const limits of [{ maxSourceRuns: 1 }, { maxSourceBudgetUsd: 0.1 }]) {
    const client = channelClient();
    const result = await run({ ...input, ...limits }, { sourceClient: client, storage: new MemoryStorage(), logger: quiet, env: {} });
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].input.aiModeSearch.enableAiMode, false);
    assert.equal(result.report.status, 'partial');
    assert.equal(result.report.skippedSourceRuns, 1);
    assert.equal(result.snapshots[0].aiResponseCount, 0);
  }
});

test('both channels failing remains a real failure with an empty dataset', async () => {
  const storage = new MemoryStorage();
  const result = await run(input, { sourceClient: new TestClient({ status: 'TIMED-OUT' }), storage, logger: quiet, env: {} });
  assert.equal(result.report.status, 'failed');
  assert.equal(result.report.errorCount, 2);
  assert.equal(storage.items.length, 0);
  assert.match(runStatusMessage(result.report), /FAILED: 0 successful checks, 2 source errors\. SOURCE_TIMEOUT/);
});

test('the exact failed official input keeps its settings and reports an upstream timeout honestly', async () => {
  const raw = { brand: { name: 'Example brand', aliases: [], domains: [] },
    queries: ['best project management software for small teams', 'Example brand alternatives'], monitoringPreset: 'google_ai_mode' };
  const client = new TestClient({ status: 'TIMED-OUT' });
  const result = await run(raw, { sourceClient: client, storage: new MemoryStorage(), logger: quiet, env: {} });
  assert.equal(result.report.status, 'failed');
  assert.equal(result.report.snapshotCount, 0);
  assert.equal(result.report.collection.plannedAiChecks, 2);
  assert.equal(result.report.collection.failedAiChecks, 2);
  assert.match(runStatusMessage(result.report), /SOURCE_TIMEOUT/);
  assert.equal(client.calls[0].options.timeoutSeconds, 300);
});

test('the actual Store-check pricing metadata fits without changing the parent fee guard', async () => {
  // Reduced public metadata from OKU91PmoaAfgeLqaH, with no customer token or personal data.
  const storage = new MemoryStorage();
  storage.runId = 'official-check';
  storage.getRunInfo = async () => ({ id: storage.runId, options: { maxTotalChargeUsd: 999999999, memoryMbytes: 1024 },
    pricingInfo: { pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: {
      'apify-actor-start': { eventPriceUsd: 0.00005 }, 'apify-default-dataset-item': { eventPriceUsd: 0.01 },
    } } }, chargedEventCounts: { 'apify-actor-start': 1, 'apify-default-dataset-item': storage.items.length },
  });
  const definition = JSON.parse(await readFile(new URL('../.actor/actor.json', import.meta.url), 'utf8'));
  const prefilled = Object.fromEntries(Object.entries(definition.input.properties)
    .filter(([, field]) => field.prefill !== undefined || field.default !== undefined)
    .map(([key, field]) => [key, field.prefill ?? field.default]));
  const result = await run(prefilled, { sourceClient: channelClient({ aiStatus: 'TIMED-OUT' }), storage, logger: quiet, env: {} });
  assert.equal(result.report.status, 'partial');
  assert.equal(result.report.billing.accountedEventChargeUsd, 0.01005);
  assert.equal(result.report.billing.deliveredSnapshotCount, 1);
  assert.equal(result.report.collection.failedAiChecks, 1);
});
